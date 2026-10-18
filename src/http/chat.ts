import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z, ZodError } from "zod";
import type { Caller } from "../bus/service.js";
import { createAgentBus } from "../wake/hook.js";
import { agentNameSchema } from "../bus/schemas.js";
import type { AppConfig } from "../config.js";
import type { ChangeCursor, Message, Plan, ResultCard, Store, Task, TaskStatus } from "../db/types.js";
import { buildHome } from "./home-feed.js";
import { assertWebhookSecret, assertWebhookUrl } from "../wake/url.js";
import { BusError } from "../errors.js";
import { chatAppSource } from "../generated/chat-app.js";
import { chatPage, loginPage, unconfiguredPage } from "./chat-page.js";
import {
  clearSessionCookie,
  cookieIsSecure,
  passwordConfigured,
  passwordsMatch,
  readCookie,
  readSession,
  SESSION_COOKIE,
  sessionCookie,
  signSession,
} from "./session.js";

type ChatDeps = {
  getStore: () => Promise<Store>;
  config: AppConfig;
  env: NodeJS.ProcessEnv;
};

function statusFor(error: BusError): number {
  switch (error.code) {
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "rate_limited":
    case "hop_limit":
      return 429;
    default:
      return 400;
  }
}

function view(html: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

export function mountChat(app: Hono, deps: ChatDeps): void {
  app.use("/chat/api/*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") return next();
    const site = c.req.header("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "none") {
      return c.json({ error: "Cross-site request blocked." }, 403);
    }
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) {
      return c.json({ error: "Cross-site request blocked." }, 403);
    }
    if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "PATCH") {
      const type = (c.req.header("content-type") ?? "").toLowerCase();
      if (!type.includes("application/json")) {
        return c.json({ error: "Content-Type must be application/json." }, 415);
      }
    }
    return next();
  });

  app.get("/chat", async (c) => {
    const password = deps.env.OWNER_PASSWORD;
    if (!passwordConfigured(password)) return view(unconfiguredPage());
    const subject = readSession(
      readCookie(c.req.header("cookie"), SESSION_COOKIE),
      password,
    );
    if (subject !== deps.config.ownerName) return view(loginPage());
    const store = await deps.getStore();
    const owner = await store.getAgentByName(deps.config.ownerName);
    if (!owner || !owner.isHuman || owner.revokedAt) return view(loginPage());
    return view(chatPage());
  });

  app.post("/chat/login", async (c) => {
    const password = deps.env.OWNER_PASSWORD;
    if (!passwordConfigured(password)) {
      return view(unconfiguredPage(), 503);
    }
    const body = await c.req.parseBody();
    const provided = typeof body.password === "string" ? body.password : "";
    if (!passwordsMatch(provided, password)) {
      return view(loginPage("That password does not match."), 401);
    }
    const store = await deps.getStore();
    const owner = await store.getAgentByName(deps.config.ownerName);
    if (!owner || owner.revokedAt) {
      return view(
        loginPage(
          `No active agent named ${deps.config.ownerName}. Run npm run admin -- ensure-owner.`,
        ),
        409,
      );
    }
    if (!owner.isHuman) {
      return view(
        loginPage(
          `Agent ${deps.config.ownerName} is not marked human. Run npm run admin -- ensure-owner.`,
        ),
        409,
      );
    }
    const token = signSession(deps.config.ownerName, password);
    return view(chatPage(), 303, {
      location: "/chat",
      "set-cookie": sessionCookie(token, cookieIsSecure(deps.env)),
    });
  });

  app.post("/chat/logout", () => {
    return view(loginPage(), 303, {
      location: "/chat",
      "set-cookie": clearSessionCookie(cookieIsSecure(deps.env)),
    });
  });

  app.get("/chat/app.js", (c) => {
    return c.body(chatAppSource, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
    });
  });

  app.get("/chat/api/state", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    const roomRows = await opened.store.listRoomsForAgent(opened.owner.id);
    const rooms = await Promise.all(
      roomRows.map(async (room) => {
        const [members, latest] = await Promise.all([
          opened.store.listRoomMembers(room.id),
          opened.store.listRoomMessages({ roomId: room.id, since: null, limit: 1 }),
        ]);
        return {
          id: room.id,
          name: room.name,
          members: members.map(publicPerson),
          latestAt: latest.at(-1)?.createdAt ?? null,
        };
      }),
    );
    const agents = await opened.store.listAgents(false);
    const people = await Promise.all(
      agents.map(async (agent) => {
        const latest =
          agent.id === opened.owner.id
            ? []
            : await opened.store.listDirectMessages({
                agentId: opened.owner.id,
                otherId: agent.id,
                since: null,
                limit: 1,
              });
        return {
          ...publicPerson(agent),
          latestAt: latest.at(-1)?.createdAt ?? null,
        };
      }),
    );
    return c.json({
      owner: publicPerson(opened.owner),
      roomAgentCap: deps.config.roomAgentCap,
      rooms,
      agents: people,
    });
  });

  app.get("/chat/api/messages", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    try {
      const roomName = c.req.query("room");
      const dmName = c.req.query("dm");
      const since = c.req.query("since") ?? null;
      if (since && Number.isNaN(Date.parse(since))) {
        return c.json({ error: "since must be an ISO-8601 timestamp" }, 400);
      }
      const limit = Math.min(deps.config.inboxMaxLimit, 50);
      if (roomName && dmName) return c.json({ error: "Pass room or dm, not both." }, 400);
      if (roomName) {
        const name = agentNameSchema.parse(roomName);
        const room = await opened.store.getRoomByName(name);
        if (!room) return c.json({ error: `Unknown room "${name}".` }, 404);
        if (!(await opened.store.isRoomMember(room.id, opened.owner.id))) {
          return c.json({ error: `You are not a member of room "${name}".` }, 403);
        }
        const messages = await opened.store.listRoomMessages({
          roomId: room.id,
          since,
          limit,
        });
        return c.json({ messages: await withCards(opened.store, messages) });
      }
      if (dmName) {
        const name = agentNameSchema.parse(dmName);
        const other = await opened.store.getAgentByName(name);
        if (!other || other.revokedAt) return c.json({ error: `Unknown agent "${name}".` }, 404);
        const messages = await opened.store.listDirectMessages({
          agentId: opened.owner.id,
          otherId: other.id,
          since,
          limit,
        });
        return c.json({ messages: await withCards(opened.store, messages) });
      }
      return c.json({ error: "Pass room or dm." }, 400);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/chat/api/messages", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    try {
      const payload = await c.req.json();
      const bus = createAgentBus(opened.store, deps.config, deps.env);
      const message =
        payload && typeof payload === "object" && "room" in payload
          ? await bus.sendRoom(opened.caller, payload)
          : await bus.send(opened.caller, {
              to: payload && typeof payload === "object" && "dm" in payload ? payload.dm : undefined,
              body: payload && typeof payload === "object" && "body" in payload ? payload.body : undefined,
            });
      const [decorated] = await withCards(opened.store, [message]);
      return c.json({ message: decorated ?? publicMessage(message) }, 201);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/chat/api/tasks", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    const status = c.req.query("status");
    const agent = c.req.query("agent");
    if (status && !isTaskStatus(status)) return c.json({ error: "Unknown status." }, 400);
    const assignee = agent ? await opened.store.getAgentByName(agent) : null;
    if (agent && (!assignee || assignee.revokedAt)) return c.json({ error: `Unknown agent "${agent}".` }, 404);
    const tasks = await visibleTasks(opened.store, opened.owner.id, {
      status: status as TaskStatus | undefined,
      assigneeId: assignee?.id,
    });
    return c.json({ tasks: tasks.map(publicTask) });
  });

  app.post("/chat/api/tasks/:id", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    try {
      const payload = await c.req.json();
      const bus = createAgentBus(opened.store, deps.config, deps.env);
      const updated = await bus.updateTask(opened.caller, {
        id: c.req.param("id"),
        status: payload && typeof payload === "object" ? payload.status : undefined,
        result: payload && typeof payload === "object" ? payload.result : undefined,
        link: payload && typeof payload === "object" ? payload.link : undefined,
      });
      return c.json({
        task: publicTask(updated.task),
        posted: updated.posted,
        skipped: updated.skipped ?? null,
      });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/chat/api/webhooks", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    const [agents, hooks] = await Promise.all([
      opened.store.listAgents(false),
      opened.store.listWebhooks(),
    ]);
    const byAgent = new Map(hooks.map((hook) => [hook.agentId, hook.url]));
    return c.json({
      webhooks: agents.map((agent) => ({
        name: agent.name,
        url: byAgent.get(agent.id) ?? null,
        configured: byAgent.has(agent.id),
      })),
    });
  });

  app.post("/chat/api/webhooks", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    try {
      const payload = await c.req.json();
      const name = agentNameSchema.parse(payload?.name);
      const agent = await opened.store.getAgentByName(name);
      if (!agent || agent.revokedAt) return c.json({ error: `Unknown agent "${name}".` }, 404);
      const saved = await opened.store.setWebhook(
        agent.id,
        assertWebhookUrl(String(payload?.url ?? "")),
        assertWebhookSecret(String(payload?.secret ?? "")),
      );
      return c.json({ name: agent.name, url: saved.url, configured: true });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.delete("/chat/api/webhooks", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    try {
      const name = agentNameSchema.parse(c.req.query("name"));
      const agent = await opened.store.getAgentByName(name);
      if (!agent) return c.json({ error: `Unknown agent "${name}".` }, 404);
      await opened.store.clearWebhook(agent.id);
      return c.json({ name: agent.name, configured: false });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/chat/api/home", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    try {
      const rooms = await opened.store.listRoomsForAgent(opened.owner.id);
      const home = await buildHome(
        opened.store,
        opened.owner,
        rooms.map((room) => room.id),
      );
      return c.json(home);
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/chat/api/plans/:id", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    try {
      const id = z.uuid().parse(c.req.param("id"));
      const plan = await opened.store.getPlan(id);
      if (!plan) return c.json({ error: "Plan not found." }, 404);
      if (!(await opened.store.isRoomMember(plan.roomId, opened.owner.id))) {
        return c.json({ error: "Plan not found." }, 404);
      }
      return c.json({ plan: await publicPlan(opened.store, plan) });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/chat/api/plans/:id", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    try {
      const id = z.uuid().parse(c.req.param("id"));
      const payload = await c.req.json();
      const bus = createAgentBus(opened.store, deps.config, deps.env);
      const plan = await bus.editPlan(opened.caller, id, payload);
      return c.json({ plan: await publicPlan(opened.store, plan) });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/chat/api/plans/:id/:action", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    const action = c.req.param("action");
    if (action !== "approve" && action !== "reject" && action !== "pause" && action !== "resume") {
      return c.json({ error: "Unknown action." }, 404);
    }
    try {
      const id = z.uuid().parse(c.req.param("id"));
      const bus = createAgentBus(opened.store, deps.config, deps.env);
      const decided = await bus.decidePlan(opened.caller, id, action);
      return c.json({
        plan: await publicPlan(opened.store, decided.plan),
        tasks: decided.tasks.map(publicTask),
      });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/chat/api/results/:id/:action", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps);
    if (opened instanceof Response) return opened;
    const action = c.req.param("action");
    if (action !== "approve" && action !== "changes" && action !== "undo") {
      return c.json({ error: "Unknown action." }, 404);
    }
    try {
      const payload = action === "approve" ? {} : await c.req.json().catch(() => ({}));
      const note =
        payload && typeof payload === "object" && "note" in payload && typeof payload.note === "string"
          ? payload.note
          : "";
      const decision = action === "approve" ? "approved" : action === "changes" ? "changes_requested" : "pending";
      const id = z.uuid().parse(c.req.param("id"));
      const bus = createAgentBus(opened.store, deps.config, deps.env);
      const result = await bus.decideResult(opened.caller, id, decision, note);
      return c.json({ result: publicResult(result) });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.get("/chat/api/events", async (c) => {
    const opened = await openOwner(c.req.header("cookie"), deps, { touch: false });
    if (opened instanceof Response) return opened;
    const holdMs = clampNumber(deps.env.CHAT_SSE_MS, 8_000, 200, 20_000);
    const pollMs = clampNumber(deps.env.CHAT_SSE_POLL_MS, 1_000, 50, 5_000);
    const initial = c.req.query("since") ?? packCursor(await opened.store.changeCursor());
    return streamSSE(c, async (stream) => {
      const deadline = Date.now() + holdMs;
      let cursor = initial;
      while (Date.now() < deadline) {
        const next = packCursor(await opened.store.changeCursor());
        if (next !== cursor) {
          await stream.writeSSE({ event: "update", data: JSON.stringify({ cursor: next }) });
          return;
        }
        cursor = next;
        await stream.sleep(pollMs);
      }
      await stream.writeSSE({ event: "bye", data: JSON.stringify({ cursor }) });
    });
  });
}

async function openOwner(
  cookieHeader: string | undefined,
  deps: ChatDeps,
  options: { touch?: boolean } = {},
) {
  const password = deps.env.OWNER_PASSWORD;
  if (!passwordConfigured(password)) {
    return Response.json({ error: "Chat is not configured." }, { status: 503 });
  }
  const subject = readSession(readCookie(cookieHeader, SESSION_COOKIE), password);
  if (subject !== deps.config.ownerName) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  const store = await deps.getStore();
  const owner = await store.getAgentByName(deps.config.ownerName);
  if (!owner || !owner.isHuman || owner.revokedAt) {
    return Response.json({ error: "Sign in required." }, { status: 401 });
  }
  if (options.touch !== false) {
    try {
      await store.touchLastSeen(owner.id);
    } catch (error) {
      console.error("last_seen update failed", error instanceof Error ? error.name : "unknown");
    }
  }
  const fresh = (await store.getAgentByName(owner.name)) ?? owner;
  const caller: Caller = { id: fresh.id, name: fresh.name, isHuman: true };
  return { store, owner: fresh, caller };
}

function publicPerson(agent: {
  id: string;
  name: string;
  isHuman: boolean;
  presence: "available" | "busy" | "away";
  statusText: string;
  lastSeenAt: string | null;
}) {
  return {
    id: agent.id,
    name: agent.name,
    isHuman: agent.isHuman,
    presence: agent.presence,
    statusText: agent.statusText,
    lastSeenAt: agent.lastSeenAt,
  };
}

const TASK_STATUSES: TaskStatus[] = ["open", "working", "done", "blocked"];

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as string[]).includes(value);
}

async function visibleTasks(
  store: Store,
  ownerId: string,
  filter: { status?: TaskStatus; assigneeId?: string },
): Promise<Task[]> {
  const [tasks, rooms] = await Promise.all([
    store.listTasks({ status: filter.status, assigneeId: filter.assigneeId }),
    store.listRoomsForAgent(ownerId),
  ]);
  const roomIds = new Set(rooms.map((room) => room.id));
  return tasks.filter(
    (task) =>
      task.creatorId === ownerId ||
      task.assigneeId === ownerId ||
      (task.roomId !== null && roomIds.has(task.roomId)),
  );
}

async function withCards(store: Store, messages: Message[]) {
  if (messages.length === 0) return [];
  const ids = messages.map((message) => message.id);
  const [tasks, plans, results] = await Promise.all([
    store.listTasks({ messageIds: ids }),
    store.listPlans({ messageIds: ids }),
    store.listResults({ messageIds: ids }),
  ]);
  const decoratedPlans = await Promise.all(plans.map((plan) => publicPlan(store, plan)));
  return messages.map((message) => ({
    ...publicMessage(message),
    tasks: tasks.filter((task) => task.sourceMessageId === message.id).map(publicTask),
    plan: decoratedPlans.find((plan) => plan.messageId === message.id) ?? null,
    result: results.find((result) => result.messageId === message.id)
      ? publicResult(results.find((result) => result.messageId === message.id) as ResultCard)
      : null,
  }));
}

async function publicPlan(store: Store, plan: Plan) {
  const tasks = await store.listTasks({ messageIds: [plan.messageId] });
  return {
    id: plan.id,
    room: plan.roomName,
    author: plan.authorName,
    messageId: plan.messageId,
    title: plan.title,
    summary: plan.summary,
    status: plan.status,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    decidedAt: plan.decidedAt,
    items: plan.items.map((item) => {
      const task = tasks.find((row) => row.id === item.taskId || row.slot === item.id);
      return {
        id: item.id,
        position: item.position,
        code: item.code,
        title: item.title,
        assignee: item.assigneeName,
        estimate: item.estimate,
        dependsOn: item.dependsOn,
        taskId: item.taskId,
        taskStatus: task?.status ?? null,
        resultNote: task?.resultNote ?? "",
        updatedAt: task?.updatedAt ?? null,
      };
    }),
  };
}

function publicResult(result: ResultCard) {
  return {
    id: result.id,
    room: result.roomName,
    messageId: result.messageId,
    author: result.authorName,
    taskId: result.taskId,
    planId: result.planId,
    kind: result.kind,
    payload: result.payload,
    status: result.status,
    decisionNote: result.decisionNote,
    decidedAt: result.decidedAt,
    createdAt: result.createdAt,
  };
}

function publicTask(task: Task) {
  return {
    id: task.id,
    assigneeName: task.assigneeName,
    creatorName: task.creatorName,
    status: task.status,
    resultNote: task.resultNote,
    resultLink: task.resultLink,
    sourceMessageId: task.sourceMessageId,
    roomName: task.roomName,
    title: task.title,
    code: task.code,
    updatedAt: task.updatedAt,
  };
}

function packCursor(cursor: ChangeCursor): string {
  return [
    cursor.messagesAt ?? "",
    cursor.presenceAt ?? "",
    cursor.tasksAt ?? "",
    cursor.plansAt ?? "",
    cursor.resultsAt ?? "",
  ].join("|");
}

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function publicMessage(message: Message) {
  return {
    id: message.id,
    fromName: message.fromName,
    fromIsHuman: message.fromIsHuman,
    toName: message.toName,
    roomName: message.roomName,
    body: message.body,
    createdAt: message.createdAt,
    kind: typeof message.metadata.kind === "string" ? message.metadata.kind : null,
  };
}

function fail(c: { json: (body: unknown, status?: number) => Response }, error: unknown): Response {
  if (error instanceof ZodError) {
    const message = error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    return c.json({ error: message }, 400);
  }
  if (error instanceof BusError) return c.json({ error: error.message }, statusFor(error));
  console.error("chat request failed", error instanceof Error ? error.name : "unknown");
  return c.json({ error: "The request failed." }, 500);
}
