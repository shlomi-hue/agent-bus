import { randomUUID } from "node:crypto";
import { BusError } from "../errors.js";
import type { PresenceStatus } from "./presence.js";
import type {
  Agent,
  AgentSummary,
  ChangeCursor,
  Delivery,
  DirectLogQuery,
  InboxQuery,
  Message,
  NewAgent,
  NewDelivery,
  NewMessage,
  NewPlan,
  NewResult,
  NewTask,
  Plan,
  PlanItem,
  PlanItemPatch,
  PlanQuery,
  PlanStatus,
  ResultCard,
  ResultQuery,
  ResultStatus,
  Room,
  RoomLogQuery,
  Store,
  Task,
  TaskPatch,
  TaskQuery,
  Webhook,
  WebhookPublic,
} from "./types.js";

function cloneMessage(message: Message): Message {
  return { ...message, metadata: { ...message.metadata } };
}

function summary(agent: Agent): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    isHuman: agent.isHuman,
    createdAt: agent.createdAt,
    revokedAt: agent.revokedAt,
    lastSeenAt: agent.lastSeenAt,
    presence: agent.presence,
    statusText: agent.statusText,
    statusUpdatedAt: agent.statusUpdatedAt,
  };
}

function freshAgent(input: NewAgent & { id?: string; createdAt?: string }): Agent {
  return {
    id: input.id ?? randomUUID(),
    name: input.name,
    description: input.description,
    tokenHash: input.tokenHash,
    isHuman: input.isHuman === true,
    createdAt: input.createdAt ?? new Date().toISOString(),
    revokedAt: null,
    lastSeenAt: null,
    presence: "available",
    statusText: "",
    statusUpdatedAt: null,
  };
}

export class MemoryStore implements Store {
  private readonly agents = new Map<string, Agent>();
  private readonly rooms = new Map<string, Room>();
  private readonly members = new Set<string>();
  private readonly messages: Message[] = [];
  private readonly tasks: Task[] = [];
  private readonly plans: Plan[] = [];
  private readonly results: ResultCard[] = [];
  private readonly webhooks = new Map<string, Webhook>();
  private readonly deliveries: Delivery[] = [];
  private readonly rateEvents: Array<{ agentId: string; createdAt: string }> = [];
  private clock = 0;
  private codeSeq = 100;

  async ping(): Promise<void> {}

  private now(): string {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return new Date(this.clock).toISOString();
  }

  private nextCode(): string {
    this.codeSeq += 1;
    return `AB-${this.codeSeq}`;
  }

  async findAgentByTokenHash(tokenHash: string): Promise<Agent | null> {
    for (const agent of this.agents.values()) {
      if (agent.tokenHash === tokenHash && agent.revokedAt === null) return { ...agent };
    }
    return null;
  }

  async getAgentByName(name: string): Promise<Agent | null> {
    for (const agent of this.agents.values()) {
      if (agent.name === name) return { ...agent };
    }
    return null;
  }

  async getAgentById(id: string): Promise<Agent | null> {
    const agent = this.agents.get(id);
    return agent ? { ...agent } : null;
  }

  async listAgents(includeRevoked: boolean): Promise<AgentSummary[]> {
    return [...this.agents.values()]
      .filter((agent) => includeRevoked || agent.revokedAt === null)
      .map(summary)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async insertAgent(input: NewAgent): Promise<Agent> {
    if (await this.getAgentByName(input.name)) {
      throw new BusError(
        "conflict",
        "That name or token is already registered. Revoke the agent before minting a new token.",
      );
    }
    const agent = freshAgent(input);
    this.agents.set(agent.id, agent);
    return { ...agent };
  }

  async restoreAgent(input: {
    name: string;
    description: string;
    tokenHash: string;
  }): Promise<Agent | null> {
    const existing = await this.getAgentByName(input.name);
    if (!existing || existing.revokedAt === null) return null;
    const updated: Agent = {
      ...existing,
      description: input.description,
      tokenHash: input.tokenHash,
      revokedAt: null,
    };
    this.agents.set(updated.id, updated);
    return { ...updated };
  }

  async revokeAgentByName(name: string): Promise<Agent | null> {
    const existing = await this.getAgentByName(name);
    if (!existing) return null;
    const updated: Agent = {
      ...existing,
      revokedAt: existing.revokedAt ?? new Date().toISOString(),
    };
    this.agents.set(updated.id, updated);
    return { ...updated };
  }

  async touchLastSeen(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.revokedAt) return;
    if (agent.lastSeenAt && Date.now() - Date.parse(agent.lastSeenAt) < 30_000) return;
    agent.lastSeenAt = new Date().toISOString();
  }

  async setStatus(agentId: string, presence: PresenceStatus, statusText: string): Promise<Agent | null> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.revokedAt) return null;
    agent.presence = presence;
    agent.statusText = statusText;
    agent.statusUpdatedAt = new Date().toISOString();
    return { ...agent };
  }

  async insertTasks(inputs: NewTask[]): Promise<Task[]> {
    const created: Task[] = [];
    for (const input of inputs) {
      const slot = input.slot ?? "";
      const existing = this.tasks.find(
        (task) =>
          task.sourceMessageId === input.sourceMessageId &&
          task.assigneeId === input.assigneeId &&
          task.slot === slot,
      );
      if (existing) continue;
      const assignee = this.agents.get(input.assigneeId);
      const creator = this.agents.get(input.creatorId);
      if (!assignee || !creator) throw new BusError("not_found", "The sender or recipient does not exist.");
      const room = input.roomId ? this.rooms.get(input.roomId) : undefined;
      const now = this.now();
      const task: Task = {
        id: randomUUID(),
        assigneeId: assignee.id,
        assigneeName: assignee.name,
        creatorId: creator.id,
        creatorName: creator.name,
        creatorIsHuman: creator.isHuman,
        sourceMessageId: input.sourceMessageId,
        roomId: input.roomId,
        roomName: room?.name ?? null,
        threadId: input.threadId,
        status: "open",
        resultNote: "",
        resultLink: null,
        title: input.title ?? "",
        code: input.code && input.code.trim() !== "" ? input.code : this.nextCode(),
        slot,
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.push(task);
      created.push({ ...task });
    }
    return created;
  }

  async listTasks(query: TaskQuery): Promise<Task[]> {
    const rows = this.tasks
      .filter((task) => !query.assigneeId || task.assigneeId === query.assigneeId)
      .filter((task) => !query.creatorId || task.creatorId === query.creatorId)
      .filter((task) => !query.status || task.status === query.status)
      .filter((task) => !query.statuses || query.statuses.includes(task.status))
      .filter((task) => !query.roomId || task.roomId === query.roomId)
      .filter((task) => !query.roomIds || (task.roomId !== null && query.roomIds.includes(task.roomId)))
      .filter((task) => !query.messageIds || query.messageIds.includes(task.sourceMessageId))
      .filter((task) => !query.updatedAfter || task.updatedAt > query.updatedAfter)
      .sort((a, b) => compareRows(a, b, taskOrder(query)));
    return (query.limit ? rows.slice(0, query.limit) : rows).map((task) => ({ ...task }));
  }

  async getTask(id: string): Promise<Task | null> {
    const task = this.tasks.find((item) => item.id === id);
    return task ? { ...task } : null;
  }

  async updateTask(id: string, patch: TaskPatch): Promise<Task | null> {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) return null;
    task.status = patch.status;
    task.resultNote = patch.resultNote;
    task.resultLink = patch.resultLink;
    task.updatedAt = this.now();
    return { ...task };
  }

  async setWebhook(agentId: string, url: string, secret: string): Promise<Webhook> {
    if (!this.agents.get(agentId)) throw new BusError("not_found", "Unknown agent.");
    const webhook: Webhook = { agentId, url, secret, updatedAt: new Date().toISOString() };
    this.webhooks.set(agentId, webhook);
    return { ...webhook };
  }

  async clearWebhook(agentId: string): Promise<boolean> {
    return this.webhooks.delete(agentId);
  }

  async getWebhook(agentId: string): Promise<Webhook | null> {
    const webhook = this.webhooks.get(agentId);
    return webhook ? { ...webhook } : null;
  }

  async listWebhooks(): Promise<WebhookPublic[]> {
    return [...this.webhooks.values()]
      .map((webhook) => ({ agentId: webhook.agentId, url: webhook.url, updatedAt: webhook.updatedAt }))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  async enqueueDeliveries(rows: NewDelivery[]): Promise<void> {
    for (const row of rows) {
      const existing = this.deliveries.find(
        (item) => item.agentId === row.agentId && item.event === row.event && item.targetId === row.targetId,
      );
      if (existing) continue;
      const encoded = JSON.stringify(row.payload);
      if (Buffer.byteLength(encoded, "utf8") > 4096) {
        throw new BusError("validation", "The database rejected the row.");
      }
      this.deliveries.push({
        id: randomUUID(),
        agentId: row.agentId,
        event: row.event,
        targetId: row.targetId,
        payload: { ...row.payload },
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date().toISOString(),
        lastError: null,
        createdAt: new Date().toISOString(),
        deliveredAt: null,
      });
    }
  }

  async claimDueDeliveries(nowIso: string, limit: number, maxAttempts: number): Promise<Delivery[]> {
    const due = this.deliveries
      .filter(
        (item) =>
          (item.status === "pending" || item.status === "failed") &&
          item.nextAttemptAt <= nowIso &&
          item.attempts < maxAttempts,
      )
      .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))
      .slice(0, limit);
    for (const item of due) {
      item.status = "sending";
      item.attempts += 1;
    }
    return due.map((item) => ({ ...item, payload: { ...item.payload } }));
  }

  async finishDelivery(
    id: string,
    result: { status: "delivered" | "failed"; error: string | null; nextAttemptAt: string },
  ): Promise<void> {
    const item = this.deliveries.find((row) => row.id === id);
    if (!item) return;
    item.status = result.status;
    item.lastError = result.error;
    item.nextAttemptAt = result.nextAttemptAt;
    if (result.status === "delivered") item.deliveredAt = new Date().toISOString();
  }

  async listDeliveries(agentId: string): Promise<Delivery[]> {
    return this.deliveries
      .filter((item) => item.agentId === agentId)
      .map((item) => ({ ...item, payload: { ...item.payload } }));
  }

  async changeCursor(): Promise<ChangeCursor> {
    const latest = (values: string[]) => (values.length === 0 ? null : values.sort().at(-1) ?? null);
    return {
      messagesAt: latest(this.messages.map((message) => message.createdAt)),
      presenceAt: latest(
        [...this.agents.values()].flatMap((agent) =>
          [agent.lastSeenAt, agent.statusUpdatedAt].filter((value): value is string => Boolean(value)),
        ),
      ),
      tasksAt: latest(this.tasks.map((task) => task.updatedAt)),
      plansAt: latest(this.plans.map((plan) => plan.updatedAt)),
      resultsAt: latest(this.results.map((result) => result.updatedAt)),
    };
  }

  private clonePlan(plan: Plan): Plan {
    return { ...plan, items: plan.items.map((item) => ({ ...item })) };
  }

  private projectPlan(plan: Plan): Plan {
    const room = this.rooms.get(plan.roomId);
    const author = this.agents.get(plan.authorId);
    return this.clonePlan({
      ...plan,
      roomName: room?.name ?? plan.roomName,
      authorName: author?.name ?? plan.authorName,
      items: plan.items.map((item) => ({
        ...item,
        assigneeName: this.agents.get(item.assigneeId)?.name ?? item.assigneeName,
      })),
    });
  }

  async insertPlan(input: NewPlan): Promise<Plan> {
    const room = this.rooms.get(input.roomId);
    const author = this.agents.get(input.authorId);
    if (!room || !author) throw new BusError("not_found", "The room or agent does not exist.");
    if (input.title.trim() === "" || input.summary.trim() === "" || input.items.length === 0) {
      throw new BusError("validation", "The database rejected the row.");
    }
    const now = this.now();
    const plan: Plan = {
      id: randomUUID(),
      roomId: room.id,
      roomName: room.name,
      authorId: author.id,
      authorName: author.name,
      messageId: input.messageId,
      title: input.title,
      summary: input.summary,
      status: "pending",
      items: input.items.map((item, index) => {
        const assignee = this.agents.get(item.assigneeId);
        if (!assignee) throw new BusError("not_found", "The room or agent does not exist.");
        return {
          id: randomUUID(),
          planId: "",
          position: index + 1,
          code: this.nextCode(),
          title: item.title,
          assigneeId: assignee.id,
          assigneeName: assignee.name,
          estimate: item.estimate,
          dependsOn: item.dependsOn,
          taskId: null,
        };
      }),
      createdAt: now,
      updatedAt: now,
      decidedAt: null,
    };
    for (const item of plan.items) item.planId = plan.id;
    this.plans.push(plan);
    return this.clonePlan(plan);
  }

  async getPlan(id: string): Promise<Plan | null> {
    const plan = this.plans.find((item) => item.id === id);
    return plan ? this.projectPlan(plan) : null;
  }

  async listPlans(query: PlanQuery): Promise<Plan[]> {
    const rows = this.plans
      .filter((plan) => !query.roomId || plan.roomId === query.roomId)
      .filter((plan) => !query.roomIds || query.roomIds.includes(plan.roomId))
      .filter((plan) => !query.status || plan.status === query.status)
      .filter((plan) => !query.statuses || query.statuses.includes(plan.status))
      .filter((plan) => !query.messageIds || query.messageIds.includes(plan.messageId))
      .sort((a, b) => compareRows(a, b, query.order === "created" ? "created-desc" : "updated-desc"));
    return (query.limit ? rows.slice(0, query.limit) : rows).map((plan) => this.projectPlan(plan));
  }

  async updatePlan(
    id: string,
    patch: { status: Plan["status"]; decidedAt?: string | null },
    expected: PlanStatus[],
  ): Promise<Plan | null> {
    const plan = this.plans.find((item) => item.id === id);
    if (!plan || !expected.includes(plan.status)) return null;
    plan.status = patch.status;
    if (patch.decidedAt !== undefined) plan.decidedAt = patch.decidedAt;
    plan.updatedAt = this.now();
    return this.projectPlan(plan);
  }

  async replacePlanItems(planId: string, items: PlanItemPatch[]): Promise<Plan | null> {
    const plan = this.plans.find((item) => item.id === planId);
    if (!plan || plan.status !== "pending") return null;
    if (items.length === 0) throw new BusError("validation", "The database rejected the row.");
    const next: PlanItem[] = items.map((item, index) => {
      const assignee = this.agents.get(item.assigneeId);
      if (!assignee) throw new BusError("not_found", "The room or agent does not exist.");
      const previous = plan.items[index];
      return {
        id: previous?.id ?? randomUUID(),
        planId: plan.id,
        position: index + 1,
        code: previous?.code ?? this.nextCode(),
        title: item.title,
        assigneeId: assignee.id,
        assigneeName: assignee.name,
        estimate: item.estimate,
        dependsOn: item.dependsOn,
        taskId: previous?.taskId ?? null,
      };
    });
    plan.items = next;
    plan.updatedAt = this.now();
    return this.projectPlan(plan);
  }

  async attachPlanTasks(links: Array<{ itemId: string; taskId: string }>): Promise<void> {
    for (const link of links) {
      for (const plan of this.plans) {
        const item = plan.items.find((row) => row.id === link.itemId);
        if (!item) continue;
        item.taskId = link.taskId;
        plan.updatedAt = this.now();
      }
    }
  }

  async findPlanByTask(taskId: string): Promise<Plan | null> {
    const plan = this.plans.find((item) => item.items.some((row) => row.taskId === taskId));
    return plan ? this.projectPlan(plan) : null;
  }

  private cloneResult(result: ResultCard): ResultCard {
    return { ...result, payload: { ...result.payload } };
  }

  async insertResult(input: NewResult): Promise<ResultCard> {
    const room = this.rooms.get(input.roomId);
    const author = this.agents.get(input.authorId);
    if (!room || !author) throw new BusError("not_found", "The room or agent does not exist.");
    const encoded = JSON.stringify(input.payload);
    if (Buffer.byteLength(encoded, "utf8") > 12000) {
      throw new BusError("validation", "The database rejected the row.");
    }
    const now = this.now();
    const result: ResultCard = {
      id: randomUUID(),
      roomId: room.id,
      roomName: room.name,
      messageId: input.messageId,
      taskId: input.taskId,
      planId: input.planId,
      authorId: author.id,
      authorName: author.name,
      kind: input.kind,
      payload: { ...input.payload },
      status: "pending",
      decisionNote: "",
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.results.push(result);
    return this.cloneResult(result);
  }

  async getResult(id: string): Promise<ResultCard | null> {
    const result = this.results.find((item) => item.id === id);
    return result ? this.cloneResult(result) : null;
  }

  async listResults(query: ResultQuery): Promise<ResultCard[]> {
    const rows = this.results
      .filter((result) => !query.roomId || result.roomId === query.roomId)
      .filter((result) => !query.roomIds || query.roomIds.includes(result.roomId))
      .filter((result) => !query.status || result.status === query.status)
      .filter((result) => !query.statuses || query.statuses.includes(result.status))
      .filter((result) => !query.messageIds || query.messageIds.includes(result.messageId))
      .filter((result) => !query.authorId || result.authorId === query.authorId)
      .filter((result) => !query.planId || result.planId === query.planId)
      .sort((a, b) => compareRows(a, b, resultOrder(query)));
    return (query.limit ? rows.slice(0, query.limit) : rows).map((result) => this.cloneResult(result));
  }

  async decideResult(
    id: string,
    status: ResultStatus,
    note: string,
    expected: ResultStatus[],
  ): Promise<ResultCard | null> {
    const result = this.results.find((item) => item.id === id);
    if (!result || !expected.includes(result.status)) return null;
    result.status = status;
    result.decisionNote = note;
    result.decidedAt = this.now();
    result.updatedAt = result.decidedAt;
    return this.cloneResult(result);
  }

  async markHuman(name: string): Promise<Agent | null> {
    const existing = await this.getAgentByName(name);
    if (!existing) return null;
    const updated: Agent = { ...existing, isHuman: true };
    this.agents.set(updated.id, updated);
    return { ...updated };
  }

  async createRoom(name: string): Promise<Room> {
    if (await this.getRoomByName(name)) {
      throw new BusError("conflict", `Room "${name}" already exists.`);
    }
    const room: Room = { id: randomUUID(), name, createdAt: new Date().toISOString() };
    this.rooms.set(room.id, room);
    return { ...room };
  }

  async getRoomByName(name: string): Promise<Room | null> {
    for (const room of this.rooms.values()) {
      if (room.name === name) return { ...room };
    }
    return null;
  }

  async getRoomById(id: string): Promise<Room | null> {
    const room = this.rooms.get(id);
    return room ? { ...room } : null;
  }

  async listRoomsForAgent(agentId: string): Promise<Room[]> {
    const rooms: Room[] = [];
    for (const room of this.rooms.values()) {
      if (this.members.has(memberKey(room.id, agentId))) rooms.push({ ...room });
    }
    return rooms.sort((a, b) => a.name.localeCompare(b.name));
  }

  async addRoomMember(roomId: string, agentId: string): Promise<void> {
    if (!this.rooms.has(roomId) || !this.agents.has(agentId)) {
      throw new BusError("not_found", "The room or agent does not exist.");
    }
    this.members.add(memberKey(roomId, agentId));
  }

  async isRoomMember(roomId: string, agentId: string): Promise<boolean> {
    return this.members.has(memberKey(roomId, agentId));
  }

  async listRoomMembers(roomId: string): Promise<AgentSummary[]> {
    const members: AgentSummary[] = [];
    for (const agent of this.agents.values()) {
      if (agent.revokedAt) continue;
      if (this.members.has(memberKey(roomId, agent.id))) members.push(summary(agent));
    }
    return members.sort((a, b) => a.name.localeCompare(b.name));
  }

  private project(input: NewMessage): Message {
    const from = this.agents.get(input.fromAgent);
    if (!from) throw new BusError("not_found", "The sender or recipient does not exist.");
    const room = input.roomId ? this.rooms.get(input.roomId) : undefined;
    if (input.roomId && !room) throw new BusError("not_found", "The sender or recipient does not exist.");
    const to = input.toAgent ? this.agents.get(input.toAgent) : undefined;
    if (input.toAgent && !to) throw new BusError("not_found", "The sender or recipient does not exist.");
    return {
      id: randomUUID(),
      threadId: input.threadId,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      fromName: from.name,
      toName: to?.name ?? null,
      fromIsHuman: from.isHuman,
      roomId: input.roomId,
      roomName: room?.name ?? null,
      body: input.body,
      metadata: { ...input.metadata },
      createdAt: this.now(),
      readAt: null,
      ackedAt: null,
      hopCount: input.hopCount,
      replyTo: input.replyTo,
    };
  }

  async insertMessage(input: NewMessage): Promise<Message> {
    const isRoom = input.roomId !== null;
    const isDirect = input.toAgent !== null;
    if (isRoom === isDirect) {
      throw new BusError("validation", "The database rejected the row.");
    }
    if (input.toAgent && input.fromAgent === input.toAgent) {
      throw new BusError("validation", "The database rejected the row.");
    }
    const message = this.project(input);
    this.messages.push(message);
    return cloneMessage(message);
  }

  async threadExists(threadId: string): Promise<boolean> {
    return this.messages.some((message) => message.threadId === threadId);
  }

  async listInbox(query: InboxQuery): Promise<Message[]> {
    return this.messages
      .filter((message) => message.roomId === null && message.toAgent === query.toAgent)
      .filter((message) => !query.unreadOnly || message.readAt === null)
      .filter((message) => !query.since || message.createdAt >= query.since)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, query.limit)
      .map(cloneMessage);
  }

  async listRoomMessages(query: RoomLogQuery): Promise<Message[]> {
    return page(
      this.messages.filter(
        (message) =>
          message.roomId === query.roomId && (!query.since || message.createdAt > query.since),
      ),
      query.since,
      query.limit,
    );
  }

  async findPlanApproval(roomId: string, planId: string): Promise<Message | null> {
    const message = this.messages.find((item) => item.roomId === roomId && isPlanApproval(item, planId));
    return message ? cloneMessage(message) : null;
  }

  async listDirectMessages(query: DirectLogQuery): Promise<Message[]> {
    return page(
      this.messages.filter(
        (message) =>
          message.roomId === null &&
          ((message.fromAgent === query.agentId && message.toAgent === query.otherId) ||
            (message.fromAgent === query.otherId && message.toAgent === query.agentId)) &&
          (!query.since || message.createdAt > query.since),
      ),
      query.since,
      query.limit,
    );
  }

  async markRead(toAgent: string, ids: string[]): Promise<void> {
    const wanted = new Set(ids);
    const now = new Date().toISOString();
    for (const message of this.messages) {
      if (message.toAgent === toAgent && wanted.has(message.id) && message.readAt === null) {
        message.readAt = now;
      }
    }
  }

  async ackMessage(toAgent: string, id: string): Promise<Message | null> {
    const message = this.messages.find((item) => item.id === id && item.toAgent === toAgent);
    if (!message) return null;
    const now = new Date().toISOString();
    message.ackedAt = message.ackedAt ?? now;
    message.readAt = message.readAt ?? now;
    return cloneMessage(message);
  }

  async getMessage(id: string): Promise<Message | null> {
    const message = this.messages.find((item) => item.id === id);
    return message ? cloneMessage(message) : null;
  }

  async getMessages(ids: string[]): Promise<Message[]> {
    const wanted = new Set(ids);
    return this.messages.filter((message) => wanted.has(message.id)).map(cloneMessage);
  }

  async deleteMessage(id: string): Promise<void> {
    for (let index = this.results.length - 1; index >= 0; index -= 1) {
      if (this.results[index]?.messageId === id) this.results.splice(index, 1);
    }
    for (let index = this.plans.length - 1; index >= 0; index -= 1) {
      if (this.plans[index]?.messageId === id) this.plans.splice(index, 1);
    }
    for (let index = this.tasks.length - 1; index >= 0; index -= 1) {
      if (this.tasks[index]?.sourceMessageId === id) this.tasks.splice(index, 1);
    }
    const index = this.messages.findIndex((message) => message.id === id);
    if (index >= 0) this.messages.splice(index, 1);
  }

  async listThread(threadId: string): Promise<Message[]> {
    return this.messages
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(cloneMessage);
  }

  async countRateEvents(agentId: string, sinceIso: string): Promise<number> {
    return this.rateEvents.filter((event) => event.agentId === agentId && event.createdAt >= sinceIso)
      .length;
  }

  async addRateEvent(agentId: string): Promise<void> {
    this.rateEvents.push({ agentId, createdAt: new Date().toISOString() });
  }

  async pruneRateEvents(olderThanIso: string): Promise<number> {
    const before = this.rateEvents.length;
    const kept = this.rateEvents.filter((event) => event.createdAt >= olderThanIso);
    this.rateEvents.splice(0, this.rateEvents.length, ...kept);
    return before - kept.length;
  }
}

function memberKey(roomId: string, agentId: string): string {
  return `${roomId}:${agentId}`;
}

type Stamp = { id: string; createdAt: string; updatedAt: string };
type RowOrder = "created-asc" | "created-desc" | "updated-desc";

function compareRows(a: Stamp, b: Stamp, order: RowOrder): number {
  if (order === "created-asc") return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  if (order === "created-desc") return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  return b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id);
}

function taskOrder(query: TaskQuery): RowOrder {
  if (query.order === "updated" || (query.limit && query.order !== "created")) return "updated-desc";
  if (query.order === "created" && query.limit) return "created-desc";
  return "created-asc";
}

function resultOrder(query: ResultQuery): RowOrder {
  if (query.order === "updated" || (query.limit && query.order !== "created")) return "updated-desc";
  if (query.order === "created" && query.limit) return "created-desc";
  return "created-asc";
}

function isPlanApproval(message: Message, planId: string): boolean {
  return (
    message.metadata.kind === "plan_decision" &&
    message.metadata.planId === planId &&
    message.body.startsWith("Approved the plan ")
  );
}

function page(messages: Message[], since: string | null, limit: number): Message[] {
  const ordered = [...messages].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const slice = since ? ordered.slice(0, limit) : ordered.slice(Math.max(0, ordered.length - limit));
  return slice.map(cloneMessage);
}
