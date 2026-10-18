import type { AgentSummary, Message, Plan, ResultCard, Store, Task } from "../db/types.js";
import { answerChoices, stripAnswers } from "../chat/text.js";

export type HomeAction = {
  id: string;
  label: string;
  style: "primary" | "secondary" | "ghost";
};

export type HomeItem = {
  id: string;
  kind: "approval" | "review" | "question" | "blocked";
  filter: "approval" | "question" | "blocked";
  title: string;
  actor: string;
  room: string | null;
  detail: string;
  createdAt: string;
  target: { type: "plan" | "result" | "task"; id: string; room: string | null; url?: string | null };
  actions: HomeAction[];
  choices: string[];
};

export type LiveCard = {
  name: string;
  isHuman: boolean;
  presence: AgentSummary["presence"];
  lastSeenAt: string | null;
  statusText: string;
  pill: string;
  tone: "accent" | "warn" | "neutral";
  since: string | null;
  taskCode: string | null;
  taskTitle: string | null;
  progress: number;
  waiting: boolean;
  lines: Array<{ at: string; text: string; current: boolean }>;
};

export type ActivityItem = {
  id: string;
  at: string;
  actor: string;
  actorHuman: boolean;
  text: string;
};

function preview(value: string, max = 80): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function estimateMinutes(value: string): number {
  const hours = value.match(/(\d+(?:\.\d+)?)\s*h/);
  const minutes = value.match(/(\d+)\s*m/);
  return Math.round((hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0));
}

function formatEstimate(minutes: number): string {
  if (minutes <= 0) return "";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  if (rest === 0) return `${hours}h`;
  return `${hours}h ${rest}m`;
}

export async function buildHome(
  store: Store,
  owner: AgentSummary,
  roomIds: string[],
): Promise<{ needsYou: HomeItem[]; live: LiveCard[]; activity: ActivityItem[] }> {
  const roomSet = new Set(roomIds);
  const [pendingPlans, pendingResults, ownerTaskRows, recentPlans, recentResults, recentTasks, agents] =
    await Promise.all([
      store.listPlans({ statuses: ["pending"], roomIds, limit: 50, order: "updated" }),
      store.listResults({ status: "pending", roomIds, limit: 50, order: "updated" }),
      store.listTasks({
        assigneeId: owner.id,
        statuses: ["open", "working", "blocked"],
        limit: 50,
        order: "updated",
      }),
      store.listPlans({ roomIds, limit: 20, order: "updated" }),
      store.listResults({ roomIds, limit: 20, order: "updated" }),
      store.listTasks({ roomIds, limit: 80, order: "updated" }),
      store.listAgents(false),
    ]);
  const ownerTasks = ownerTaskRows.filter((task) => task.roomId === null || roomSet.has(task.roomId));
  const sourceIds = [...new Set(ownerTasks.map((task) => task.sourceMessageId))];
  const sources = new Map<string, Message>();
  for (const message of await store.getMessages(sourceIds)) sources.set(message.id, message);

  const needsYou: HomeItem[] = [
    ...pendingPlans.map((plan) => planItem(plan)),
    ...pendingResults.map((result) => resultItem(result, recentTasks)),
    ...ownerTasks.map((task) => taskItem(task, sources.get(task.sourceMessageId) ?? null)),
  ].sort((a, b) => {
    const rank = { approval: 0, question: 1, blocked: 2 };
    return rank[a.filter] - rank[b.filter] || a.createdAt.localeCompare(b.createdAt);
  });

  const logs = new Map<string, Message[]>();
  for (const roomId of roomIds) {
    const messages = await store.listRoomMessages({ roomId, since: null, limit: 40 });
    for (const message of messages) {
      const list = logs.get(message.fromAgent) ?? [];
      list.push(message);
      logs.set(message.fromAgent, list);
    }
  }

  const live = agents
    .filter((agent) => !agent.isHuman && agent.revokedAt === null)
    .map((agent) => liveCard(agent, recentTasks, logs.get(agent.id) ?? []))
    .sort((a, b) => (b.since ?? "").localeCompare(a.since ?? ""))
    .slice(0, 3);

  const activity = activityItems(recentPlans, recentResults, recentTasks, logs, owner.name);
  return { needsYou, live, activity };
}

function planItem(plan: Plan): HomeItem {
  const names = [...new Set(plan.items.map((item) => item.assigneeName))];
  const minutes = plan.items.reduce((sum, item) => sum + estimateMinutes(item.estimate), 0);
  const estimate = formatEstimate(minutes);
  return {
    id: `plan:${plan.id}`,
    kind: "approval",
    filter: "approval",
    title: `Approve plan · ${plan.title}`,
    actor: plan.authorName,
    room: plan.roomName,
    detail: `${plan.items.length} task${plan.items.length === 1 ? "" : "s"} across ${names.join(", ")}${
      estimate ? ` · est. ${estimate}` : ""
    }`,
    createdAt: plan.createdAt,
    target: { type: "plan", id: plan.id, room: plan.roomName },
    actions: [
      { id: "reject", label: "Reject", style: "ghost" },
      { id: "review", label: "Review", style: "secondary" },
      { id: "approve", label: "Approve", style: "primary" },
    ],
    choices: [],
  };
}

function resultItem(result: ResultCard, tasks: Task[]): HomeItem {
  const task = tasks.find((item) => item.id === result.taskId);
  const payload = result.payload;
  const title = typeof payload.title === "string" ? payload.title : "";
  const number = typeof payload.number === "number" ? payload.number : null;
  const headline =
    result.kind === "pr"
      ? `Review PR${number ? ` #${number}` : ""}${title ? ` · ${title}` : ""}`
      : result.kind === "tests"
        ? "Review test results"
        : result.kind === "file"
          ? `Review file${typeof payload.name === "string" ? ` · ${payload.name}` : ""}`
          : result.kind === "screenshot"
            ? `Review screenshot${typeof payload.name === "string" ? ` · ${payload.name}` : ""}`
            : `Review note${title ? ` · ${title}` : ""}`;
  const bits: string[] = [];
  if (typeof payload.additions === "number") bits.push(`+${payload.additions}`);
  if (typeof payload.deletions === "number") bits.push(`−${payload.deletions}`);
  if (typeof payload.checksPassed === "number" && typeof payload.checksTotal === "number") {
    bits.push(`${payload.checksPassed}/${payload.checksTotal} checks`);
  }
  if (typeof payload.failed === "number") bits.push(`${payload.failed} failed`);
  if (task?.code) bits.push(task.code);
  const url = typeof payload.url === "string" ? payload.url : null;
  return {
    id: `result:${result.id}`,
    kind: "review",
    filter: "approval",
    title: headline,
    actor: result.authorName,
    room: result.roomName,
    detail: bits.join(" · "),
    createdAt: result.createdAt,
    target: { type: "result", id: result.id, room: result.roomName, url },
    actions: [
      { id: "changes", label: "Request changes", style: "ghost" },
      ...(url ? [{ id: "diff", label: "Diff", style: "secondary" as const }] : [{ id: "review", label: "Review", style: "secondary" as const }]),
      { id: "approve", label: "Approve", style: "primary" },
    ],
    choices: [],
  };
}

function taskItem(task: Task, source: Message | null): HomeItem {
  const body = source ? stripAnswers(source.body) : task.title || task.resultNote;
  const choices = source ? answerChoices(source.body) : [];
  const question = task.status !== "blocked" && (body.includes("?") || choices.length > 0);
  const readable = body.replace(/@[a-z][a-z0-9_-]{0,63}/gi, "").replace(/\s+/g, " ").trim();
  const title = task.status === "blocked"
    ? `Blocked · ${task.code || task.id.slice(0, 8)} ${task.title || preview(readable, 60)}`
    : question
      ? preview(readable, 90)
      : task.title || preview(readable, 90);
  const detail = task.resultNote || (question ? `${task.code} is paused until you answer` : task.code);
  return {
    id: `task:${task.id}`,
    kind: task.status === "blocked" ? "blocked" : "question",
    filter: task.status === "blocked" ? "blocked" : "question",
    title,
    actor: task.creatorName,
    room: task.roomName,
    detail,
    createdAt: task.updatedAt,
    target: { type: "task", id: task.id, room: task.roomName },
    actions:
      task.status === "blocked"
        ? [
            { id: "open", label: "Open task", style: "ghost" },
            { id: "resolve", label: "Mark resolved", style: "secondary" },
          ]
        : [
            ...choices.map((choice) => ({ id: `answer:${choice}`, label: choice, style: "secondary" as const })),
            { id: "reply", label: "Reply", style: "ghost" },
          ],
    choices,
  };
}

function liveCard(agent: AgentSummary, tasks: Task[], messages: Message[]): LiveCard {
  const mine = tasks
    .filter((task) => task.assigneeId === agent.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const current =
    mine.find((task) => task.status === "working") ??
    mine.find((task) => task.status === "blocked") ??
    mine.find((task) => task.status === "open") ??
    null;
  const waiting = /wait/i.test(agent.statusText) || agent.presence === "away";
  const source = `${agent.statusText} ${current?.resultNote ?? ""}`;
  const percent = source.match(/(\d{1,3})\s*%/);
  const progress = percent
    ? Math.min(100, Number(percent[1]))
    : current?.status === "done"
      ? 100
      : current?.status === "working"
        ? 45
        : current?.status === "blocked"
          ? 60
          : agent.presence === "busy"
            ? 30
            : 0;
  const lines = messages
    .slice(-4)
    .map((message, index, all) => ({
      at: message.createdAt,
      text: preview(stripAnswers(message.body), 72),
      current: index === all.length - 1,
    }));
  if (lines.length === 0 && agent.statusText) {
    lines.push({ at: agent.statusUpdatedAt ?? new Date().toISOString(), text: agent.statusText, current: true });
  }
  const pill = agent.statusText
    ? agent.statusText.split("·")[0]?.trim().slice(0, 28) || agent.presence
    : current?.status === "working"
      ? "Working"
      : agent.presence;
  return {
    name: agent.name,
    isHuman: false,
    presence: agent.presence,
    lastSeenAt: agent.lastSeenAt,
    statusText: agent.statusText,
    pill,
    tone: waiting ? "warn" : agent.presence === "busy" || current?.status === "working" ? "accent" : "neutral",
    since: agent.statusUpdatedAt ?? current?.updatedAt ?? agent.lastSeenAt,
    taskCode: current?.code || null,
    taskTitle: current?.title || null,
    progress: waiting ? Math.max(progress, 40) : progress,
    waiting,
    lines,
  };
}

function activityItems(
  plans: Plan[],
  results: ResultCard[],
  tasks: Task[],
  logs: Map<string, Message[]>,
  ownerName: string,
): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const plan of plans) {
    items.push({
      id: `plan:${plan.id}`,
      at: plan.createdAt,
      actor: plan.authorName,
      actorHuman: false,
      text: `posted a plan in #${plan.roomName} · ${plan.title}`,
    });
  }
  for (const result of results) {
    const title = typeof result.payload.title === "string" ? result.payload.title : result.kind;
    items.push({
      id: `result:${result.id}`,
      at: result.createdAt,
      actor: result.authorName,
      actorHuman: false,
      text:
        result.kind === "pr"
          ? `opened ${title}`
          : `posted a ${result.kind} result in #${result.roomName} · ${title}`,
    });
  }
  for (const task of tasks) {
    if (task.status === "blocked") {
      items.push({
        id: `blocked:${task.id}`,
        at: task.updatedAt,
        actor: task.assigneeName,
        actorHuman: false,
        text: `is blocked on ${task.code} ${task.title || "a task"}${task.resultNote ? ` · ${preview(task.resultNote, 48)}` : ""}`,
      });
    }
    if (task.status === "done") {
      items.push({
        id: `done:${task.id}`,
        at: task.updatedAt,
        actor: task.assigneeName,
        actorHuman: task.assigneeName === ownerName,
        text: `finished ${task.code} ${task.title || "a task"}`,
      });
    }
  }
  for (const messages of logs.values()) {
    for (const message of messages) {
      if (message.metadata.kind === "plan" || message.metadata.kind === "result") continue;
      items.push({
        id: `msg:${message.id}`,
        at: message.createdAt,
        actor: message.fromName,
        actorHuman: message.fromIsHuman,
        text: message.roomName
          ? `in #${message.roomName} · ${preview(stripAnswers(message.body), 72)}`
          : preview(stripAnswers(message.body), 72),
      });
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
}
