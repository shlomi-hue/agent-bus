import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { BusError } from "../errors.js";
import type { Agent, AgentSummary, Message, Room, Store, Task } from "../db/types.js";
import { mentionNames } from "./mentions.js";
import { transitionPlan } from "./plan-status.js";
import { parseResultPayload } from "./results.js";
import { sanitizeQuickAnswer } from "../chat/text.js";
import {
  ackMessageSchema,
  addMemberSchema,
  agentNameSchema,
  createRoomSchema,
  descriptionSchema,
  editPlanSchema,
  getPlanSchema,
  getThreadSchema,
  joinRoomSchema,
  listMyTasksSchema,
  postResultSchema,
  proposePlanSchema,
  readInboxSchema,
  readRoomSchema,
  replySchema,
  sendMessageSchema,
  sendRoomMessageSchema,
  setStatusSchema,
  updateTaskSchema,
  waitForMessagesSchema,
} from "./schemas.js";
import type { Plan, ResultCard } from "../db/types.js";

export type AfterMessage = (message: Message, tasks: Task[]) => Promise<void>;

export type Caller = { id: string; name: string; isHuman?: boolean };

export type WaitResult = {
  messages: Message[];
  tasks: Task[];
  rooms: string[];
  cursor: string;
  timedOut: boolean;
};

export function nextHop(parentHop: number, maxHops: number): number {
  const next = parentHop + 1;
  if (next > maxHops) {
    throw new BusError(
      "hop_limit",
      `Reply refused: this would be hop ${next}, and the maximum is ${maxHops}. Start a new thread with send_message if you still need to talk.`,
    );
  }
  return next;
}

export class AgentBus {
  constructor(
    private readonly store: Store,
    private readonly config: AppConfig,
    private readonly afterMessage?: AfterMessage,
  ) {}

  private async consume(agentId: string): Promise<void> {
    await this.store.addRateEvent(agentId);
    const since = new Date(Date.now() - this.config.rateLimitWindowSeconds * 1000).toISOString();
    const count = await this.store.countRateEvents(agentId, since);
    if (count > this.config.rateLimitMax) {
      throw new BusError(
        "rate_limited",
        `Rate limit exceeded: ${this.config.rateLimitMax} requests per ${this.config.rateLimitWindowSeconds} seconds.`,
      );
    }
  }

  async listAgents(caller: Caller): Promise<AgentSummary[]> {
    await this.consume(caller.id);
    return this.store.listAgents(false);
  }

  async setStatus(caller: Caller, raw: unknown): Promise<Agent> {
    const input = setStatusSchema().parse(raw);
    await this.consume(caller.id);
    const text = (input.text ?? "").trim();
    if (Buffer.byteLength(text, "utf8") > 200) {
      throw new BusError("validation", "text exceeds 200 bytes");
    }
    const agent = await this.store.setStatus(caller.id, input.status, text);
    if (!agent) throw new BusError("not_found", "Agent not found.");
    return agent;
  }

  async send(caller: Caller, raw: unknown): Promise<Message> {
    const input = sendMessageSchema(this.config).parse(raw);
    await this.consume(caller.id);
    const recipient = await this.store.getAgentByName(input.to);
    if (!recipient || recipient.revokedAt) {
      throw new BusError("not_found", `Unknown or unavailable agent "${input.to}".`);
    }
    if (recipient.id === caller.id) {
      throw new BusError("validation", "You cannot send a message to yourself.");
    }
    const threadId = input.thread_id ?? randomUUID();
    if (input.thread_id && (await this.store.getRoomById(threadId))) {
      throw new BusError("conflict", `Thread ${threadId} is a room. Use send_room_message.`);
    }
    if (input.thread_id && (await this.store.threadExists(threadId))) {
      throw new BusError(
        "conflict",
        `Thread ${threadId} already exists. Use reply to continue it.`,
      );
    }
    const message = await this.store.insertMessage({
      threadId,
      fromAgent: caller.id,
      toAgent: recipient.id,
      roomId: null,
      body: input.body,
      metadata: input.metadata ?? {},
      hopCount: 0,
      replyTo: null,
    });
    return this.settle(caller, message);
  }

  async readInbox(caller: Caller, raw: unknown): Promise<{ messages: Message[]; tasks: Task[] }> {
    const input = readInboxSchema(this.config).parse(raw ?? {});
    await this.consume(caller.id);
    const messages = await this.store.listInbox({
      toAgent: caller.id,
      unreadOnly: input.unread_only,
      limit: input.limit,
      since: input.since ?? null,
    });
    await this.store.markRead(
      caller.id,
      messages.map((message) => message.id),
    );
    const tasks = await this.store.listTasks({
      assigneeId: caller.id,
      statuses: ["open", "working"],
    });
    return { messages, tasks };
  }

  async ack(caller: Caller, raw: unknown): Promise<Message> {
    const input = ackMessageSchema().parse(raw);
    await this.consume(caller.id);
    const message = await this.store.ackMessage(caller.id, input.id);
    if (!message) throw new BusError("not_found", "Message not found.");
    return message;
  }

  async reply(caller: Caller, raw: unknown): Promise<Message> {
    const input = replySchema(this.config).parse(raw);
    await this.consume(caller.id);
    const original = await this.store.getMessage(input.message_id);
    if (!original) throw new BusError("not_found", "Message not found.");
    if (original.toAgent !== caller.id) {
      throw new BusError("forbidden", "You can only reply to a message that was sent to you.");
    }
    const recipient = await this.store.getAgentById(original.fromAgent);
    if (!recipient || recipient.revokedAt) {
      throw new BusError("not_found", "Recipient is unavailable.");
    }
    const hopCount = nextHop(original.hopCount, this.config.maxHops);
    const message = await this.store.insertMessage({
      threadId: original.threadId,
      fromAgent: caller.id,
      toAgent: recipient.id,
      roomId: null,
      body: input.body,
      metadata: {},
      hopCount,
      replyTo: original.id,
    });
    return this.settle(caller, message);
  }

  async getThread(caller: Caller, raw: unknown): Promise<Message[]> {
    const input = getThreadSchema().parse(raw);
    await this.consume(caller.id);
    const messages = await this.store.listThread(input.thread_id);
    const roomId = messages.find((message) => message.roomId)?.roomId;
    if (roomId) {
      if (!(await this.store.isRoomMember(roomId, caller.id))) {
        throw new BusError("not_found", "Thread not found.");
      }
      return messages;
    }
    const participant = messages.some(
      (message) => message.fromAgent === caller.id || message.toAgent === caller.id,
    );
    if (!participant) throw new BusError("not_found", "Thread not found.");
    return messages;
  }

  async createRoom(caller: Caller, raw: unknown): Promise<Room> {
    const input = createRoomSchema().parse(raw);
    await this.consume(caller.id);
    const room = await this.store.createRoom(input.name);
    await this.store.addRoomMember(room.id, caller.id);
    return room;
  }

  async listRooms(caller: Caller): Promise<Room[]> {
    await this.consume(caller.id);
    return this.store.listRoomsForAgent(caller.id);
  }

  async joinRoom(caller: Caller, raw: unknown): Promise<Room> {
    const input = joinRoomSchema().parse(raw);
    await this.consume(caller.id);
    const room = await this.requireRoom(input.room);
    await this.store.addRoomMember(room.id, caller.id);
    return room;
  }

  async addMember(caller: Caller, raw: unknown): Promise<Room> {
    const input = addMemberSchema().parse(raw);
    await this.consume(caller.id);
    const room = await this.requireRoom(input.room);
    await this.requireMember(room, caller.id);
    const agent = await this.store.getAgentByName(input.agent);
    if (!agent || agent.revokedAt) {
      throw new BusError("not_found", `Unknown or unavailable agent "${input.agent}".`);
    }
    await this.store.addRoomMember(room.id, agent.id);
    return room;
  }

  async sendRoom(caller: Caller, raw: unknown): Promise<Message> {
    const input = sendRoomMessageSchema(this.config).parse(raw);
    await this.consume(caller.id);
    const room = await this.requireRoom(input.room);
    await this.requireMember(room, caller.id);
    await this.assertRoomOpen(caller, room.id, room.name);
    const quick = input.metadata?.kind === "quick_answer";
    const body = quick ? sanitizeQuickAnswer(input.body) : input.body;
    if (quick && body === "") throw new BusError("validation", "That answer is empty after it is made safe.");
    const message = await this.store.insertMessage({
      threadId: room.id,
      fromAgent: caller.id,
      toAgent: null,
      roomId: room.id,
      body,
      metadata: quick ? { kind: "quick_answer" } : {},
      hopCount: 0,
      replyTo: null,
    });
    return this.settle(caller, message);
  }

  async listMyTasks(caller: Caller, raw: unknown): Promise<Task[]> {
    const input = listMyTasksSchema().parse(raw ?? {});
    await this.consume(caller.id);
    return this.store.listTasks({
      assigneeId: caller.id,
      status: input.status,
    });
  }

  async updateTask(
    caller: Caller,
    raw: unknown,
  ): Promise<{ task: Task; posted: boolean; skipped?: string }> {
    const input = updateTaskSchema().parse(raw);
    await this.consume(caller.id);
    const existing = await this.store.getTask(input.id);
    if (!existing) throw new BusError("not_found", "Task not found.");
    if (existing.assigneeId !== caller.id && existing.creatorId !== caller.id) {
      throw new BusError("forbidden", "Only the assignee or the creator can update this task.");
    }
    const note = (input.result ?? existing.resultNote).trim();
    if (Buffer.byteLength(note, "utf8") > 2000) {
      throw new BusError("validation", "result exceeds 2000 bytes");
    }
    const link =
      input.link === undefined ? existing.resultLink : input.link.trim() === "" ? null : resultLink(input.link.trim());
    const task = await this.store.updateTask(existing.id, {
      status: input.status,
      resultNote: note,
      resultLink: link,
    });
    if (!task) throw new BusError("not_found", "Task not found.");
    try {
      await this.syncPlanProgress(task.id);
    } catch (error) {
      console.error("plan sync failed", error instanceof Error ? error.name : "unknown");
    }
    try {
      await this.postTaskStatus(caller, task);
      return { task, posted: true };
    } catch (error) {
      if (error instanceof BusError && (error.code === "hop_limit" || error.code === "rate_limited")) {
        return { task, posted: false, skipped: error.message };
      }
      throw error;
    }
  }

  async proposePlan(caller: Caller, raw: unknown): Promise<{ plan: Plan; message: Message }> {
    const input = proposePlanSchema().parse(raw);
    await this.consume(caller.id);
    const room = await this.requireRoom(input.room);
    await this.requireMember(room, caller.id);
    const items = [];
    for (const task of input.tasks) {
      const assignee = await this.store.getAgentByName(task.assignee);
      if (!assignee || assignee.revokedAt) {
        throw new BusError("not_found", `Unknown or unavailable agent "${task.assignee}".`);
      }
      if (!(await this.store.isRoomMember(room.id, assignee.id))) {
        throw new BusError(
          "validation",
          `${assignee.name} is not a member of #${room.name}. Add them to the room before proposing a plan.`,
        );
      }
      items.push({
        title: task.title,
        assigneeId: assignee.id,
        estimate: task.estimate ?? "",
        dependsOn: task.depends_on ?? "",
      });
    }
    const note = input.note?.trim() || `Proposed a plan: ${input.title}`;
    this.assertBody(note);
    const message = await this.insertRoom(caller, room.id, note, { kind: "plan" });
    try {
      const plan = await this.store.insertPlan({
        roomId: room.id,
        authorId: caller.id,
        messageId: message.id,
        title: input.title,
        summary: input.summary,
        items,
      });
      await this.notify(message, []);
      return { plan, message };
    } catch (error) {
      await this.store.deleteMessage(message.id);
      throw error;
    }
  }

  async getPlan(caller: Caller, raw: unknown): Promise<Plan> {
    const input = getPlanSchema().parse(raw ?? {});
    await this.consume(caller.id);
    if (!input.id && !input.room) throw new BusError("validation", "Pass id or room.");
    if (input.id) {
      const plan = await this.store.getPlan(input.id);
      if (!plan) throw new BusError("not_found", "Plan not found.");
      await this.requireMember({ id: plan.roomId, name: plan.roomName, createdAt: plan.createdAt }, caller.id);
      return plan;
    }
    const room = await this.requireRoom(input.room ?? "");
    await this.requireMember(room, caller.id);
    const plans = await this.store.listPlans({ roomId: room.id, limit: 1, order: "created" });
    const plan = plans[0];
    if (!plan) throw new BusError("not_found", `No plan in room "${room.name}".`);
    return plan;
  }

  async tasksForPlan(plan: Plan): Promise<Task[]> {
    const rows = await Promise.all(
      plan.items.map((item) => (item.taskId ? this.store.getTask(item.taskId) : Promise.resolve(null))),
    );
    return rows.filter((task): task is Task => task !== null);
  }

  async editPlan(caller: Caller, planId: string, raw: unknown): Promise<Plan> {
    const input = editPlanSchema().parse(raw);
    await this.consume(caller.id);
    await this.requireOwner(caller);
    const plan = await this.requirePendingPlan(caller, planId);
    const items = [];
    for (const task of input.tasks) {
      const assignee = await this.store.getAgentByName(task.assignee);
      if (!assignee || assignee.revokedAt) {
        throw new BusError("not_found", `Unknown or unavailable agent "${task.assignee}".`);
      }
      if (!(await this.store.isRoomMember(plan.roomId, assignee.id))) {
        throw new BusError(
          "validation",
          `${assignee.name} is not a member of #${plan.roomName}. Add them to the room before editing the plan.`,
        );
      }
      items.push({
        title: task.title,
        assigneeId: assignee.id,
        estimate: task.estimate ?? "",
        dependsOn: task.depends_on ?? "",
      });
    }
    const updated = await this.store.replacePlanItems(plan.id, items);
    if (!updated) throw await this.planConflict(plan.id, "edit", plan.status);
    return updated;
  }

  async decidePlan(
    caller: Caller,
    planId: string,
    event: "approve" | "reject" | "pause" | "resume",
  ): Promise<{ plan: Plan; tasks: Task[] }> {
    await this.consume(caller.id);
    await this.requireOwner(caller);
    const plan = await this.store.getPlan(planId);
    if (!plan) throw new BusError("not_found", "Plan not found.");
    await this.requireMember({ id: plan.roomId, name: plan.roomName, createdAt: plan.createdAt }, caller.id);
    if (event === "approve") return this.approvePlan(caller, plan);
    if (event === "reject") return this.rejectPlan(caller, plan);
    const expected = event === "pause" ? (["executing"] as const) : (["paused"] as const);
    const next = event === "pause" ? "paused" : "executing";
    const saved = await this.store.updatePlan(plan.id, { status: next }, [...expected]);
    if (!saved) throw await this.planConflict(plan.id, event, plan.status);
    const tasks = await this.tasksForPlan(saved);
    const body =
      event === "pause"
        ? `Paused the plan "${plan.title}". Assignees should stop until the plan resumes.`
        : `Resumed the plan "${plan.title}". Assignees can continue.`;
    const message = await this.insertRoom(caller, plan.roomId, body, { kind: "plan_decision", planId: plan.id });
    await this.notify(message, tasks);
    return { plan: saved, tasks };
  }

  async postResult(caller: Caller, raw: unknown): Promise<{ result: ResultCard; message: Message }> {
    const input = postResultSchema().parse(raw);
    await this.consume(caller.id);
    const room = await this.requireRoom(input.room);
    await this.requireMember(room, caller.id);
    const payload = parseResultPayload(input.kind, input.payload);
    if (input.task_id) {
      const task = await this.store.getTask(input.task_id);
      if (!task || task.roomId !== room.id) throw new BusError("not_found", "Task not found in that room.");
      const linked = input.plan_id
        ? await this.store.getPlan(input.plan_id)
        : await this.store.findPlanByTask(task.id);
      if (input.plan_id && (!linked || linked.roomId !== room.id)) {
        throw new BusError("not_found", "Plan not found in that room.");
      }
      if (task.assigneeId !== caller.id && linked?.authorId !== caller.id) {
        throw new BusError("forbidden", "Only the task assignee or the plan author can post a result for this task.");
      }
    } else if (input.plan_id) {
      const plan = await this.store.getPlan(input.plan_id);
      if (!plan || plan.roomId !== room.id) throw new BusError("not_found", "Plan not found in that room.");
    }
    const message = await this.insertRoom(caller, room.id, input.note?.trim() || resultIntro(input.kind, payload), {
      kind: "result",
    });
    try {
      const result = await this.store.insertResult({
        roomId: room.id,
        messageId: message.id,
        taskId: input.task_id ?? null,
        planId: input.plan_id ?? null,
        authorId: caller.id,
        kind: input.kind,
        payload,
      });
      await this.notify(message, []);
      return { result, message };
    } catch (error) {
      await this.store.deleteMessage(message.id);
      throw error;
    }
  }

  async decideResult(
    caller: Caller,
    resultId: string,
    decision: "approved" | "changes_requested" | "pending",
    note: string,
  ): Promise<ResultCard> {
    await this.consume(caller.id);
    await this.requireOwner(caller);
    const result = await this.store.getResult(resultId);
    if (!result) throw new BusError("not_found", "Result not found.");
    await this.requireMember(
      { id: result.roomId, name: result.roomName, createdAt: result.createdAt },
      caller.id,
    );
    const expected = decision === "pending" ? (["approved", "changes_requested"] as const) : (["pending"] as const);
    const text = note.trim();
    if (Buffer.byteLength(text, "utf8") > 2000) throw new BusError("validation", "note exceeds 2000 bytes");
    const saved = await this.store.decideResult(result.id, decision, text, [...expected]);
    if (!saved) {
      const latest = await this.store.getResult(result.id);
      const status = latest?.status ?? result.status;
      throw new BusError(
        "conflict",
        decision === "pending"
          ? `Cannot undo a result that is ${status}.`
          : `Cannot review a result that is ${status}.`,
      );
    }
    if (result.authorId !== caller.id) {
      const verb =
        decision === "approved"
          ? "approved"
          : decision === "changes_requested"
            ? "requested changes on"
            : "undid the review of";
      const body = `${caller.name} ${verb} your ${result.kind} result in #${result.roomName}.${
        text ? ` Note: ${text}` : ""
      }`;
      await this.tell(caller, result.authorId, body, { kind: "result_decision", resultId: result.id });
    }
    return saved;
  }

  async waitForMessages(caller: Caller, raw: unknown): Promise<WaitResult> {
    const input = waitForMessagesSchema(this.config).parse(raw ?? {});
    await this.consume(caller.id);
    const timeoutMs = (input.timeout_seconds ?? this.config.waitMaxSeconds) * 1000;
    const deadline = Date.now() + timeoutMs;
    if (!input.since) {
      const snapshot = await this.collectWait(caller, null);
      if (snapshot.messages.length > 0 || snapshot.tasks.length > 0) {
        await this.store.markRead(
          caller.id,
          snapshot.messages.map((message) => message.id),
        );
        return { ...snapshot, timedOut: false };
      }
    }
    const since = input.since ?? new Date().toISOString();
    while (Date.now() <= deadline) {
      const snapshot = await this.collectWait(caller, since);
      if (snapshot.messages.length > 0 || snapshot.tasks.length > 0 || snapshot.rooms.length > 0) {
        await this.store.markRead(
          caller.id,
          snapshot.messages.map((message) => message.id),
        );
        return { ...snapshot, timedOut: false };
      }
      if (Date.now() + 200 > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { messages: [], tasks: [], rooms: [], cursor: since, timedOut: true };
  }

  private async collectWait(caller: Caller, since: string | null): Promise<Omit<WaitResult, "timedOut">> {
    const inbox = await this.store.listInbox({
      toAgent: caller.id,
      unreadOnly: true,
      limit: this.config.inboxDefaultLimit,
      since: null,
    });
    const messages = since ? inbox.filter((message) => message.createdAt > since) : inbox;
    const tasks = await this.store.listTasks({
      assigneeId: caller.id,
      statuses: ["open", "working"],
      updatedAfter: since,
    });
    const rooms: string[] = [];
    if (since) {
      for (const room of await this.store.listRoomsForAgent(caller.id)) {
        const fresh = await this.store.listRoomMessages({ roomId: room.id, since, limit: 1 });
        if (fresh.length > 0) rooms.push(room.name);
      }
    }
    const stamps = [
      ...messages.map((message) => message.createdAt),
      ...tasks.map((task) => task.updatedAt),
      since,
    ].filter((value): value is string => Boolean(value));
    stamps.sort();
    return {
      messages,
      tasks,
      rooms,
      cursor: stamps.at(-1) ?? new Date().toISOString(),
    };
  }

  async readRoom(caller: Caller, raw: unknown): Promise<Message[]> {
    const input = readRoomSchema(this.config).parse(raw ?? {});
    await this.consume(caller.id);
    const room = await this.requireRoom(input.room);
    await this.requireMember(room, caller.id);
    return this.store.listRoomMessages({
      roomId: room.id,
      since: input.since ?? null,
      limit: input.limit,
    });
  }

  private async settle(caller: Caller, message: Message): Promise<Message> {
    if (message.metadata.kind === "task_status" || message.metadata.kind === "quick_answer") return message;
    let tasks: Task[] = [];
    try {
      tasks = await this.tasksFromMentions(caller, message);
    } catch (error) {
      console.error("mention tasks failed", error instanceof Error ? error.name : "unknown");
    }
    if (this.afterMessage) {
      try {
        await this.afterMessage(message, tasks);
      } catch (error) {
        console.error("wake hook failed", error instanceof Error ? error.name : "unknown");
      }
    }
    return message;
  }

  private async tasksFromMentions(caller: Caller, message: Message): Promise<Task[]> {
    const names = mentionNames(message.body).filter((name) => name !== caller.name);
    const inputs = [];
    for (const name of names) {
      const agent = await this.store.getAgentByName(name);
      if (!agent || agent.revokedAt) continue;
      inputs.push({
        assigneeId: agent.id,
        creatorId: caller.id,
        sourceMessageId: message.id,
        roomId: message.roomId,
        threadId: message.threadId,
        title: mentionTitle(message.body, name),
      });
    }
    if (inputs.length === 0) return [];
    return this.store.insertTasks(inputs);
  }

  private async postTaskStatus(caller: Caller, task: Task): Promise<void> {
    const body = `${caller.name} set the task for ${task.assigneeName} to ${task.status}.${
      task.resultNote ? ` Note: ${task.resultNote}` : ""
    }${task.resultLink ? ` Link: ${task.resultLink}` : ""}`;
    if (task.roomId) {
      await this.assertRoomOpen(caller, task.roomId, task.roomName ?? "room");
      await this.store.insertMessage({
        threadId: task.threadId,
        fromAgent: caller.id,
        toAgent: null,
        roomId: task.roomId,
        body,
        metadata: { kind: "task_status", taskId: task.id },
        hopCount: 0,
        replyTo: null,
      });
      return;
    }
    const thread = await this.store.listThread(task.threadId);
    const latest = thread.at(-1);
    const hopCount = latest ? nextHop(latest.hopCount, this.config.maxHops) : 0;
    const otherId = caller.id === task.assigneeId ? task.creatorId : task.assigneeId;
    if (otherId === caller.id) return;
    await this.store.insertMessage({
      threadId: task.threadId,
      fromAgent: caller.id,
      toAgent: otherId,
      roomId: null,
      body,
      metadata: { kind: "task_status", taskId: task.id },
      hopCount,
      replyTo: latest?.id ?? null,
    });
  }

  private async approvePlan(caller: Caller, plan: Plan): Promise<{ plan: Plan; tasks: Task[] }> {
    let current = plan;
    let resumed = current.status === "executing";
    if (resumed && !current.items.some((item) => !item.taskId)) {
      throw new BusError("conflict", "Cannot approve a plan that is executing.");
    }
    if (!resumed) {
      const saved = await this.store.updatePlan(
        plan.id,
        { status: "executing", decidedAt: new Date().toISOString() },
        ["pending", "approved"],
      );
      if (!saved) {
        const latest = await this.store.getPlan(plan.id);
        if (latest?.status === "executing" && latest.items.some((item) => !item.taskId)) {
          current = latest;
          resumed = true;
        } else {
          throw new BusError("conflict", `Cannot approve a plan that is ${latest?.status ?? "missing"}.`);
        }
      } else {
        current = (await this.store.getPlan(saved.id)) ?? saved;
      }
    }
    const missing = current.items.filter((item) => !item.taskId);
    const filled = await this.ensurePlanTasks(caller, current, missing);
    const finished = (await this.store.getPlan(current.id)) ?? current;
    const tasks = await this.tasksForPlan(finished);
    if (!resumed) {
      const names = [...new Set(finished.items.map((item) => item.assigneeName))];
      const message = await this.insertRoom(
        caller,
        current.roomId,
        `Approved the plan "${current.title}". Dispatched ${tasks.length} task(s) to ${names.join(", ")}.`,
        { kind: "plan_decision", planId: current.id },
      );
      await this.notify(message, tasks);
    } else if (filled.length > 0) {
      const seed = await this.store.getMessage(current.messageId);
      if (seed) {
        await this.notify(
          {
            ...seed,
            fromAgent: caller.id,
            fromName: caller.name,
            fromIsHuman: caller.isHuman ?? true,
            metadata: { kind: "plan_dispatch", planId: current.id },
          },
          filled,
        );
      }
    }
    return { plan: finished, tasks };
  }

  private async ensurePlanTasks(caller: Caller, plan: Plan, items: Plan["items"]): Promise<Task[]> {
    const filled: Task[] = [];
    for (const item of items) {
      const inserted = await this.store.insertTasks([
        {
          assigneeId: item.assigneeId,
          creatorId: caller.id,
          sourceMessageId: plan.messageId,
          roomId: plan.roomId,
          threadId: plan.roomId,
          title: item.title,
          code: item.code,
          slot: item.id,
        },
      ]);
      const task =
        inserted[0] ??
        (await this.store.listTasks({ messageIds: [plan.messageId] })).find((row) => row.slot === item.id);
      if (!task) throw new BusError("conflict", "Could not create the plan task.");
      await this.store.attachPlanTasks([{ itemId: item.id, taskId: task.id }]);
      filled.push(task);
    }
    return filled;
  }

  private async planConflict(id: string, action: string, fallback: string): Promise<BusError> {
    const latest = await this.store.getPlan(id);
    return new BusError("conflict", `Cannot ${action} a plan that is ${latest?.status ?? fallback}.`);
  }

  private async rejectPlan(caller: Caller, plan: Plan): Promise<{ plan: Plan; tasks: Task[] }> {
    const saved = await this.store.updatePlan(
      plan.id,
      { status: "rejected", decidedAt: new Date().toISOString() },
      ["pending"],
    );
    if (!saved) throw await this.planConflict(plan.id, "reject", plan.status);
    await this.insertRoom(caller, plan.roomId, `Rejected the plan "${plan.title}".`, {
      kind: "plan_decision",
      planId: plan.id,
    });
    if (plan.authorId !== caller.id) {
      await this.tell(caller, plan.authorId, `${caller.name} rejected the plan "${plan.title}" in #${plan.roomName}.`, {
        kind: "plan_decision",
        planId: plan.id,
      });
    }
    return { plan: saved, tasks: [] };
  }

  private async requirePendingPlan(caller: Caller, planId: string): Promise<Plan> {
    const plan = await this.store.getPlan(planId);
    if (!plan) throw new BusError("not_found", "Plan not found.");
    await this.requireMember({ id: plan.roomId, name: plan.roomName, createdAt: plan.createdAt }, caller.id);
    if (plan.status !== "pending") {
      throw new BusError("conflict", `Cannot edit a plan that is ${plan.status}.`);
    }
    return plan;
  }

  private async requireOwner(caller: Caller): Promise<void> {
    const owner = await this.store.getAgentByName(this.config.ownerName);
    if (!owner || caller.id !== owner.id) {
      throw new BusError("forbidden", "Only the owner can do that.");
    }
  }

  private async syncPlanProgress(taskId: string): Promise<void> {
    const linked = await this.store.findPlanByTask(taskId);
    if (!linked) return;
    const current = await this.store.getPlan(linked.id);
    if (!current) return;
    const rows = await Promise.all(
      current.items.map((item) => (item.taskId ? this.store.getTask(item.taskId) : Promise.resolve(null))),
    );
    if (rows.length === 0 || rows.some((row) => !row)) return;
    const allDone = rows.every((row) => row?.status === "done");
    if (allDone && (current.status === "executing" || current.status === "paused")) {
      const next = transitionPlan(current.status, "complete");
      await this.store.updatePlan(current.id, { status: next }, [current.status]);
      return;
    }
    if (!allDone && current.status === "done") {
      const next = transitionPlan(current.status, "reopen");
      await this.store.updatePlan(current.id, { status: next }, ["done"]);
    }
  }

  private assertBody(body: string): void {
    if (Buffer.byteLength(body, "utf8") > this.config.maxBodyBytes) {
      throw new BusError("validation", `body exceeds ${this.config.maxBodyBytes} bytes`);
    }
  }

  private async insertRoom(
    caller: Caller,
    roomId: string,
    body: string,
    metadata: Record<string, unknown>,
  ): Promise<Message> {
    const room = await this.store.getRoomById(roomId);
    await this.assertRoomOpen(caller, roomId, room?.name ?? "room");
    return this.store.insertMessage({
      threadId: roomId,
      fromAgent: caller.id,
      toAgent: null,
      roomId,
      body,
      metadata,
      hopCount: 0,
      replyTo: null,
    });
  }

  private async tell(
    caller: Caller,
    toAgent: string,
    body: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (toAgent === caller.id) return;
    const message = await this.store.insertMessage({
      threadId: randomUUID(),
      fromAgent: caller.id,
      toAgent,
      roomId: null,
      body,
      metadata,
      hopCount: 0,
      replyTo: null,
    });
    await this.notify(message, []);
  }

  private async notify(message: Message, tasks: Task[]): Promise<void> {
    if (!this.afterMessage) return;
    try {
      await this.afterMessage(message, tasks);
    } catch (error) {
      console.error("wake hook failed", error instanceof Error ? error.name : "unknown");
    }
  }

  private async requireRoom(name: string): Promise<Room> {
    const room = await this.store.getRoomByName(name);
    if (!room) throw new BusError("not_found", `Unknown room "${name}".`);
    return room;
  }

  private async requireMember(room: Room, agentId: string): Promise<void> {
    if (!(await this.store.isRoomMember(room.id, agentId))) {
      throw new BusError("forbidden", `You are not a member of room "${room.name}".`);
    }
  }

  private async assertRoomOpen(caller: Caller, roomId: string, roomName: string): Promise<void> {
    if (caller.isHuman) return;
    const cap = this.config.roomAgentCap;
    const recent = await this.store.listRoomMessages({ roomId, since: null, limit: cap });
    if (recent.length < cap) return;
    if (recent.every((message) => !message.fromIsHuman)) {
      throw new BusError(
        "hop_limit",
        `Room "${roomName}" is paused after ${cap} agent messages in a row. A human has to post before agents can continue.`,
      );
    }
  }
}

function mentionTitle(body: string, name: string): string {
  const stripped = body
    .replace(new RegExp(`@${name}\\b`, "gi"), "")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, 200);
}

function resultIntro(kind: string, payload: Record<string, unknown>): string {
  const title = typeof payload.title === "string" ? payload.title : "";
  const name = typeof payload.name === "string" ? payload.name : "";
  if (kind === "pr") return `Posted a pull request${title ? `: ${title}` : ""}.`;
  if (kind === "tests") return "Posted test results.";
  if (kind === "file") return `Posted a file${name ? `: ${name}` : ""}.`;
  if (kind === "screenshot") return `Posted a screenshot${name ? `: ${name}` : ""}.`;
  return `Posted a note${title ? `: ${title}` : ""}.`;
}

function resultLink(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BusError("validation", "result link must be an http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BusError("validation", "result link must be an http(s) URL");
  }
  if (url.username || url.password) {
    throw new BusError("validation", "result link must not include credentials");
  }
  return url.toString();
}

export function parseAgentRegistration(
  name: string,
  description: string,
  maxDescriptionLength: number,
): { name: string; description: string } {
  return {
    name: agentNameSchema.parse(name),
    description: descriptionSchema(maxDescriptionLength).parse(description),
  };
}
