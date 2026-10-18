import type { PresenceStatus } from "./presence.js";

export type { PresenceStatus };

export type Agent = {
  id: string;
  name: string;
  description: string;
  tokenHash: string;
  isHuman: boolean;
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  presence: PresenceStatus;
  statusText: string;
  statusUpdatedAt: string | null;
};

export type AgentSummary = Omit<Agent, "tokenHash">;

export type Message = {
  id: string;
  threadId: string;
  fromAgent: string;
  toAgent: string | null;
  fromName: string;
  toName: string | null;
  fromIsHuman: boolean;
  roomId: string | null;
  roomName: string | null;
  body: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
  ackedAt: string | null;
  hopCount: number;
  replyTo: string | null;
};

export type NewMessage = {
  threadId: string;
  fromAgent: string;
  toAgent: string | null;
  roomId: string | null;
  body: string;
  metadata: Record<string, unknown>;
  hopCount: number;
  replyTo: string | null;
};

export type NewAgent = {
  name: string;
  description: string;
  tokenHash: string;
  isHuman?: boolean;
};

export type Room = {
  id: string;
  name: string;
  createdAt: string;
};

export type RoomLogQuery = {
  roomId: string;
  since: string | null;
  limit: number;
};

export type DirectLogQuery = {
  agentId: string;
  otherId: string;
  since: string | null;
  limit: number;
};

export type InboxQuery = {
  toAgent: string;
  unreadOnly: boolean;
  limit: number;
  since: string | null;
};

export type TaskStatus = "open" | "working" | "done" | "blocked";

export type Task = {
  id: string;
  assigneeId: string;
  assigneeName: string;
  creatorId: string;
  creatorName: string;
  creatorIsHuman: boolean;
  sourceMessageId: string;
  roomId: string | null;
  roomName: string | null;
  threadId: string;
  status: TaskStatus;
  resultNote: string;
  resultLink: string | null;
  title: string;
  code: string;
  slot: string;
  createdAt: string;
  updatedAt: string;
};

export type NewTask = {
  assigneeId: string;
  creatorId: string;
  sourceMessageId: string;
  roomId: string | null;
  threadId: string;
  title?: string;
  code?: string;
  slot?: string;
};

export type PlanStatus = "pending" | "approved" | "rejected" | "executing" | "done" | "paused";

export type PlanItem = {
  id: string;
  planId: string;
  position: number;
  code: string;
  title: string;
  assigneeId: string;
  assigneeName: string;
  estimate: string;
  dependsOn: string;
  taskId: string | null;
};

export type Plan = {
  id: string;
  roomId: string;
  roomName: string;
  authorId: string;
  authorName: string;
  messageId: string;
  title: string;
  summary: string;
  status: PlanStatus;
  items: PlanItem[];
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
};

export type NewPlanItem = {
  title: string;
  assigneeId: string;
  estimate: string;
  dependsOn: string;
};

export type NewPlan = {
  roomId: string;
  authorId: string;
  messageId: string;
  title: string;
  summary: string;
  items: NewPlanItem[];
};

export type PlanItemPatch = {
  title: string;
  assigneeId: string;
  estimate: string;
  dependsOn: string;
};

export type ListOrder = "updated" | "created";

export type PlanQuery = {
  roomId?: string;
  roomIds?: string[];
  status?: PlanStatus;
  statuses?: PlanStatus[];
  messageIds?: string[];
  limit?: number;
  order?: ListOrder;
};

export type ResultKind = "pr" | "tests" | "file" | "screenshot" | "text";
export type ResultStatus = "pending" | "approved" | "changes_requested";

export type ResultCard = {
  id: string;
  roomId: string;
  roomName: string;
  messageId: string;
  taskId: string | null;
  planId: string | null;
  authorId: string;
  authorName: string;
  kind: ResultKind;
  payload: Record<string, unknown>;
  status: ResultStatus;
  decisionNote: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NewResult = {
  roomId: string;
  messageId: string;
  taskId: string | null;
  planId: string | null;
  authorId: string;
  kind: ResultKind;
  payload: Record<string, unknown>;
};

export type ResultQuery = {
  roomId?: string;
  roomIds?: string[];
  status?: ResultStatus;
  statuses?: ResultStatus[];
  messageIds?: string[];
  authorId?: string;
  planId?: string;
  limit?: number;
  order?: ListOrder;
};

export type TaskQuery = {
  assigneeId?: string;
  creatorId?: string;
  status?: TaskStatus;
  statuses?: TaskStatus[];
  roomId?: string;
  roomIds?: string[];
  messageIds?: string[];
  updatedAfter?: string | null;
  limit?: number;
  order?: ListOrder;
};

export type TaskPatch = {
  status: TaskStatus;
  resultNote: string;
  resultLink: string | null;
};

export type Webhook = {
  agentId: string;
  url: string;
  secret: string;
  updatedAt: string;
};

export type WebhookPublic = {
  agentId: string;
  url: string;
  updatedAt: string;
};

export type DeliveryEvent = "dm" | "mention" | "task" | "owner_notify";
export type DeliveryStatus = "pending" | "sending" | "delivered" | "failed";

export type Delivery = {
  id: string;
  agentId: string;
  event: DeliveryEvent;
  targetId: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
};

export type NewDelivery = {
  agentId: string;
  event: DeliveryEvent;
  targetId: string;
  payload: Record<string, unknown>;
};

export type ChangeCursor = {
  messagesAt: string | null;
  presenceAt: string | null;
  tasksAt: string | null;
  plansAt: string | null;
  resultsAt: string | null;
};

export interface Store {
  ping(): Promise<void>;
  findAgentByTokenHash(tokenHash: string): Promise<Agent | null>;
  getAgentByName(name: string): Promise<Agent | null>;
  getAgentById(id: string): Promise<Agent | null>;
  listAgents(includeRevoked: boolean): Promise<AgentSummary[]>;
  insertAgent(input: NewAgent): Promise<Agent>;
  restoreAgent(input: { name: string; description: string; tokenHash: string }): Promise<Agent | null>;
  revokeAgentByName(name: string): Promise<Agent | null>;
  markHuman(name: string): Promise<Agent | null>;
  touchLastSeen(agentId: string): Promise<void>;
  setStatus(agentId: string, presence: PresenceStatus, statusText: string): Promise<Agent | null>;
  insertTasks(inputs: NewTask[]): Promise<Task[]>;
  listTasks(query: TaskQuery): Promise<Task[]>;
  getTask(id: string): Promise<Task | null>;
  updateTask(id: string, patch: TaskPatch): Promise<Task | null>;
  insertPlan(input: NewPlan): Promise<Plan>;
  getPlan(id: string): Promise<Plan | null>;
  listPlans(query: PlanQuery): Promise<Plan[]>;
  updatePlan(
    id: string,
    patch: { status: PlanStatus; decidedAt?: string | null },
    expected: PlanStatus[],
  ): Promise<Plan | null>;
  replacePlanItems(planId: string, items: PlanItemPatch[]): Promise<Plan | null>;
  attachPlanTasks(links: Array<{ itemId: string; taskId: string }>): Promise<void>;
  findPlanByTask(taskId: string): Promise<Plan | null>;
  insertResult(input: NewResult): Promise<ResultCard>;
  getResult(id: string): Promise<ResultCard | null>;
  listResults(query: ResultQuery): Promise<ResultCard[]>;
  decideResult(
    id: string,
    status: ResultStatus,
    note: string,
    expected: ResultStatus[],
  ): Promise<ResultCard | null>;
  setWebhook(agentId: string, url: string, secret: string): Promise<Webhook>;
  clearWebhook(agentId: string): Promise<boolean>;
  getWebhook(agentId: string): Promise<Webhook | null>;
  listWebhooks(): Promise<WebhookPublic[]>;
  enqueueDeliveries(rows: NewDelivery[]): Promise<void>;
  claimDueDeliveries(nowIso: string, limit: number, maxAttempts: number): Promise<Delivery[]>;
  finishDelivery(
    id: string,
    result: { status: "delivered" | "failed"; error: string | null; nextAttemptAt: string },
  ): Promise<void>;
  listDeliveries(agentId: string): Promise<Delivery[]>;
  changeCursor(): Promise<ChangeCursor>;
  createRoom(name: string): Promise<Room>;
  getRoomByName(name: string): Promise<Room | null>;
  getRoomById(id: string): Promise<Room | null>;
  listRoomsForAgent(agentId: string): Promise<Room[]>;
  addRoomMember(roomId: string, agentId: string): Promise<void>;
  isRoomMember(roomId: string, agentId: string): Promise<boolean>;
  listRoomMembers(roomId: string): Promise<AgentSummary[]>;
  listRoomMessages(query: RoomLogQuery): Promise<Message[]>;
  findPlanApproval(roomId: string, planId: string): Promise<Message | null>;
  listDirectMessages(query: DirectLogQuery): Promise<Message[]>;
  insertMessage(input: NewMessage): Promise<Message>;
  threadExists(threadId: string): Promise<boolean>;
  listInbox(query: InboxQuery): Promise<Message[]>;
  markRead(toAgent: string, ids: string[]): Promise<void>;
  ackMessage(toAgent: string, id: string): Promise<Message | null>;
  getMessage(id: string): Promise<Message | null>;
  getMessages(ids: string[]): Promise<Message[]>;
  deleteMessage(id: string): Promise<void>;
  listThread(threadId: string): Promise<Message[]>;
  countRateEvents(agentId: string, sinceIso: string): Promise<number>;
  addRateEvent(agentId: string): Promise<void>;
  pruneRateEvents(olderThanIso: string): Promise<number>;
}

export interface SqlClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}
