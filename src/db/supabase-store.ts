import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { BusError, dbErrorCode, rethrowConstraint } from "../errors.js";
import { asPresence, type PresenceStatus } from "./presence.js";
import type {
  Agent,
  AgentSummary,
  ChangeCursor,
  Delivery,
  DeliveryEvent,
  DeliveryStatus,
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
  ResultKind,
  ResultQuery,
  ResultStatus,
  Room,
  RoomLogQuery,
  Store,
  Task,
  TaskPatch,
  TaskQuery,
  TaskStatus,
  Webhook,
  WebhookPublic,
} from "./types.js";
import { asMetadata, toIso, toIsoOrNull } from "./values.js";

const AGENT_COLUMNS =
  "id, name, description, token_hash, is_human, created_at, revoked_at, last_seen_at, presence, status_text, status_updated_at";

const MESSAGE_COLUMNS = `
  id,
  thread_id,
  from_agent,
  to_agent,
  room_id,
  body,
  metadata,
  created_at,
  read_at,
  acked_at,
  hop_count,
  reply_to,
  from_ref:agents!messages_from_agent_fkey(name, is_human),
  to_ref:agents!messages_to_agent_fkey(name),
  room_ref:rooms!messages_room_id_fkey(name)
`;

type AgentRow = {
  id: string;
  name: string;
  description: string;
  token_hash: string;
  is_human: boolean | null;
  created_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  presence: string | null;
  status_text: string | null;
  status_updated_at: string | null;
};

type RoomRow = {
  id: string;
  name: string;
  created_at: string;
};

type MessageRow = {
  id: string;
  thread_id: string;
  from_agent: string;
  to_agent: string | null;
  room_id: string | null;
  body: string;
  metadata: unknown;
  created_at: string;
  read_at: string | null;
  acked_at: string | null;
  hop_count: number;
  reply_to: string | null;
  from_ref: { name: string; is_human: boolean | null } | null;
  to_ref: { name: string } | null;
  room_ref: { name: string } | null;
};

function asBoolean(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

function raise(error: { message: string; code?: string }): never {
  const wrapped = new Error(error.message) as Error & { code?: string };
  wrapped.code = error.code;
  throw wrapped;
}

function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tokenHash: row.token_hash,
    isHuman: asBoolean(row.is_human),
    createdAt: toIso(row.created_at),
    revokedAt: toIsoOrNull(row.revoked_at),
    lastSeenAt: toIsoOrNull(row.last_seen_at),
    presence: asPresence(row.presence),
    statusText: row.status_text ?? "",
    statusUpdatedAt: toIsoOrNull(row.status_updated_at),
  };
}

function mapRoom(row: RoomRow): Room {
  return { id: row.id, name: row.name, createdAt: toIso(row.created_at) };
}

function summarize(agent: Agent): AgentSummary {
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

const TASK_COLUMNS = `
  id,
  assignee_id,
  creator_id,
  source_message_id,
  room_id,
  thread_id,
  status,
  result_note,
  result_link,
  title,
  code,
  slot,
  created_at,
  updated_at,
  assignee:agents!tasks_assignee_fkey(name),
  creator:agents!tasks_creator_fkey(name, is_human),
  room:rooms!tasks_room_fkey(name)
`;

type Named = { name: string; is_human?: boolean | null } | Array<{ name: string; is_human?: boolean | null }> | null;

type TaskRow = {
  id: string;
  assignee_id: string;
  creator_id: string;
  source_message_id: string;
  room_id: string | null;
  thread_id: string;
  status: string;
  result_note: string;
  result_link: string | null;
  title: string | null;
  code: string | null;
  slot: string | null;
  created_at: string;
  updated_at: string;
  assignee: Named;
  creator: Named;
  room: { name: string } | Array<{ name: string }> | null;
};

type SupabasePlanRow = {
  id: string;
  room_id: string;
  author_id: string;
  message_id: string;
  title: string;
  summary: string;
  status: string;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  room: TaskRow["room"];
  author: Named;
};

type SupabasePlanItemRow = {
  id: string;
  plan_id: string;
  position: number;
  code: string | null;
  title: string;
  assignee_id: string;
  estimate: string | null;
  depends_on: string | null;
  task_id: string | null;
  assignee: Named;
};

type SupabaseResultRow = {
  id: string;
  room_id: string;
  message_id: string;
  task_id: string | null;
  plan_id: string | null;
  author_id: string;
  kind: string;
  payload: unknown;
  status: string;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  room: TaskRow["room"];
  author: Named;
};

type WebhookRow = {
  agent_id: string;
  url: string;
  secret: string;
  updated_at: string;
};

type DeliveryRow = {
  id: string;
  agent_id: string;
  event: string;
  target_id: string;
  payload: unknown;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
};

function firstName(value: Named): { name: string; isHuman: boolean } {
  const row = Array.isArray(value) ? value[0] : value;
  return { name: row?.name ?? "unknown", isHuman: asBoolean(row?.is_human) };
}

function roomName(value: TaskRow["room"]): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row?.name ?? null;
}

function mapTaskRow(row: TaskRow): Task {
  const assignee = firstName(row.assignee);
  const creator = firstName(row.creator);
  return {
    id: row.id,
    assigneeId: row.assignee_id,
    assigneeName: assignee.name,
    creatorId: row.creator_id,
    creatorName: creator.name,
    creatorIsHuman: creator.isHuman,
    sourceMessageId: row.source_message_id,
    roomId: row.room_id,
    roomName: roomName(row.room),
    threadId: row.thread_id,
    status: row.status as TaskStatus,
    resultNote: row.result_note ?? "",
    resultLink: row.result_link,
    title: row.title ?? "",
    code: row.code ?? "",
    slot: row.slot ?? "",
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapWebhook(row: WebhookRow): Webhook {
  return {
    agentId: row.agent_id,
    url: row.url,
    secret: row.secret,
    updatedAt: toIso(row.updated_at),
  };
}

function mapDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    agentId: row.agent_id,
    event: row.event as DeliveryEvent,
    targetId: row.target_id,
    payload: asMetadata(row.payload),
    status: row.status as DeliveryStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: toIso(row.next_attempt_at),
    lastError: row.last_error,
    createdAt: toIso(row.created_at),
    deliveredAt: toIsoOrNull(row.delivered_at),
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    threadId: row.thread_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    fromName: row.from_ref?.name ?? "unknown",
    toName: row.to_ref?.name ?? null,
    fromIsHuman: asBoolean(row.from_ref?.is_human),
    roomId: row.room_id,
    roomName: row.room_ref?.name ?? null,
    body: row.body,
    metadata: asMetadata(row.metadata),
    createdAt: toIso(row.created_at),
    readAt: toIsoOrNull(row.read_at),
    ackedAt: toIsoOrNull(row.acked_at),
    hopCount: Number(row.hop_count),
    replyTo: row.reply_to,
  };
}

export class SupabaseStore implements Store {
  constructor(private readonly client: SupabaseClient) {}

  async ping(): Promise<void> {
    const { error } = await this.client.from("agents").select("id").limit(1);
    if (error) raise(error);
  }

  async findAgentByTokenHash(tokenHash: string): Promise<Agent | null> {
    const { data, error } = await this.client
      .from("agents")
      .select(AGENT_COLUMNS)
      .eq("token_hash", tokenHash)
      .is("revoked_at", null)
      .maybeSingle();
    if (error) raise(error);
    return data ? mapAgent(data as AgentRow) : null;
  }

  async getAgentByName(name: string): Promise<Agent | null> {
    const { data, error } = await this.client
      .from("agents")
      .select(AGENT_COLUMNS)
      .eq("name", name)
      .maybeSingle();
    if (error) raise(error);
    return data ? mapAgent(data as AgentRow) : null;
  }

  async getAgentById(id: string): Promise<Agent | null> {
    const { data, error } = await this.client
      .from("agents")
      .select(AGENT_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) raise(error);
    return data ? mapAgent(data as AgentRow) : null;
  }

  async listAgents(includeRevoked: boolean): Promise<AgentSummary[]> {
    let query = this.client
      .from("agents")
      .select(AGENT_COLUMNS)
      .order("name", { ascending: true });
    if (!includeRevoked) query = query.is("revoked_at", null);
    const { data, error } = await query;
    if (error) raise(error);
    return ((data ?? []) as AgentRow[]).map((row) => summarize(mapAgent(row)));
  }

  async insertAgent(input: NewAgent): Promise<Agent> {
    try {
      const { data, error } = await this.client
        .from("agents")
        .insert({
          name: input.name,
          description: input.description,
          token_hash: input.tokenHash,
          is_human: input.isHuman === true,
        })
        .select(AGENT_COLUMNS)
        .single();
      if (error) raise(error);
      return mapAgent(data as AgentRow);
    } catch (error) {
      rethrowConstraint(error);
    }
  }

  async restoreAgent(input: {
    name: string;
    description: string;
    tokenHash: string;
  }): Promise<Agent | null> {
    try {
      const { data, error } = await this.client
        .from("agents")
        .update({
          token_hash: input.tokenHash,
          description: input.description,
          revoked_at: null,
        })
        .eq("name", input.name)
        .not("revoked_at", "is", null)
        .select(AGENT_COLUMNS)
        .maybeSingle();
      if (error) raise(error);
      return data ? mapAgent(data as AgentRow) : null;
    } catch (error) {
      rethrowConstraint(error);
    }
  }

  async revokeAgentByName(name: string): Promise<Agent | null> {
    const existing = await this.getAgentByName(name);
    if (!existing) return null;
    if (existing.revokedAt) return existing;
    const { data, error } = await this.client
      .from("agents")
      .update({ revoked_at: new Date().toISOString() })
      .eq("name", name)
      .select(AGENT_COLUMNS)
      .single();
    if (error) raise(error);
    return mapAgent(data as AgentRow);
  }

  async markHuman(name: string): Promise<Agent | null> {
    const { data, error } = await this.client
      .from("agents")
      .update({ is_human: true })
      .eq("name", name)
      .select(AGENT_COLUMNS)
      .maybeSingle();
    if (error) raise(error);
    return data ? mapAgent(data as AgentRow) : null;
  }

  async createRoom(name: string): Promise<Room> {
    try {
      const { data, error } = await this.client
        .from("rooms")
        .insert({ name })
        .select("id, name, created_at")
        .single();
      if (error) raise(error);
      return mapRoom(data as RoomRow);
    } catch (error) {
      if (dbErrorCode(error) === "23505") {
        throw new BusError("conflict", `Room "${name}" already exists.`);
      }
      rethrowConstraint(error);
    }
  }

  async getRoomByName(name: string): Promise<Room | null> {
    const { data, error } = await this.client
      .from("rooms")
      .select("id, name, created_at")
      .eq("name", name)
      .maybeSingle();
    if (error) raise(error);
    return data ? mapRoom(data as RoomRow) : null;
  }

  async getRoomById(id: string): Promise<Room | null> {
    const { data, error } = await this.client
      .from("rooms")
      .select("id, name, created_at")
      .eq("id", id)
      .maybeSingle();
    if (error) raise(error);
    return data ? mapRoom(data as RoomRow) : null;
  }

  async listRoomsForAgent(agentId: string): Promise<Room[]> {
    const { data, error } = await this.client
      .from("room_members")
      .select("room:rooms(id, name, created_at)")
      .eq("agent_id", agentId);
    if (error) raise(error);
    const rooms = ((data ?? []) as unknown as Array<{ room: RoomRow | RoomRow[] | null }>)
      .flatMap((row) => {
        if (!row.room) return [];
        return Array.isArray(row.room) ? row.room : [row.room];
      })
      .map(mapRoom);
    return rooms.sort((a, b) => a.name.localeCompare(b.name));
  }

  async addRoomMember(roomId: string, agentId: string): Promise<void> {
    try {
      const { error } = await this.client.from("room_members").upsert(
        { room_id: roomId, agent_id: agentId },
        { onConflict: "room_id,agent_id", ignoreDuplicates: true },
      );
      if (error) raise(error);
    } catch (error) {
      rethrowConstraint(error);
    }
  }

  async isRoomMember(roomId: string, agentId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("room_members")
      .select("agent_id")
      .eq("room_id", roomId)
      .eq("agent_id", agentId)
      .maybeSingle();
    if (error) raise(error);
    return data !== null;
  }

  async listRoomMembers(roomId: string): Promise<AgentSummary[]> {
    const { data, error } = await this.client
      .from("room_members")
      .select(
        "agent:agents!room_members_agent_fkey(id, name, description, is_human, created_at, revoked_at, last_seen_at, presence, status_text, status_updated_at)",
      )
      .eq("room_id", roomId);
    if (error) raise(error);
    const members = ((data ?? []) as unknown as Array<{ agent: AgentRow | AgentRow[] | null }>)
      .flatMap((row) => {
        if (!row.agent) return [];
        return Array.isArray(row.agent) ? row.agent : [row.agent];
      })
      .map((row) => summarize(mapAgent({ ...row, token_hash: "" })))
      .filter((agent) => agent.revokedAt === null);
    return members.sort((a, b) => a.name.localeCompare(b.name));
  }

  async findPlanApproval(roomId: string, planId: string): Promise<Message | null> {
    const { data, error } = await this.client
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .eq("room_id", roomId)
      .contains("metadata", { kind: "plan_decision", planId })
      .like("body", "Approved the plan %")
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) raise(error);
    const row = ((data ?? []) as unknown as MessageRow[])[0];
    return row ? mapMessage(row) : null;
  }

  async listRoomMessages(query: RoomLogQuery): Promise<Message[]> {
    let request = this.client.from("messages").select(MESSAGE_COLUMNS).eq("room_id", query.roomId).limit(query.limit);
    if (query.since) {
      request = request.gt("created_at", query.since).order("created_at", { ascending: true });
      const { data, error } = await request;
      if (error) raise(error);
      return ((data ?? []) as unknown as MessageRow[]).map(mapMessage);
    }
    request = request.order("created_at", { ascending: false });
    const { data, error } = await request;
    if (error) raise(error);
    return ((data ?? []) as unknown as MessageRow[]).map(mapMessage).reverse();
  }

  async listDirectMessages(query: DirectLogQuery): Promise<Message[]> {
    let request = this.client
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .is("room_id", null)
      .or(
        `and(from_agent.eq.${query.agentId},to_agent.eq.${query.otherId}),and(from_agent.eq.${query.otherId},to_agent.eq.${query.agentId})`,
      )
      .limit(query.limit);
    if (query.since) {
      request = request.gt("created_at", query.since).order("created_at", { ascending: true });
      const { data, error } = await request;
      if (error) raise(error);
      return ((data ?? []) as unknown as MessageRow[]).map(mapMessage);
    }
    request = request.order("created_at", { ascending: false });
    const { data, error } = await request;
    if (error) raise(error);
    return ((data ?? []) as unknown as MessageRow[]).map(mapMessage).reverse();
  }

  private async messageById(id: string): Promise<Message | null> {
    const { data, error } = await this.client
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) raise(error);
    return data ? mapMessage(data as unknown as MessageRow) : null;
  }

  async insertMessage(input: NewMessage): Promise<Message> {
    try {
      const { data, error } = await this.client
        .from("messages")
        .insert({
          thread_id: input.threadId,
          from_agent: input.fromAgent,
          to_agent: input.toAgent,
          room_id: input.roomId,
          body: input.body,
          metadata: input.metadata,
          hop_count: input.hopCount,
          reply_to: input.replyTo,
        })
        .select("id")
        .single();
      if (error) raise(error);
      const message = await this.messageById((data as { id: string }).id);
      if (!message) throw new Error("Inserted message could not be read back");
      return message;
    } catch (error) {
      rethrowConstraint(error);
    }
  }

  async threadExists(threadId: string): Promise<boolean> {
    const { count, error } = await this.client
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", threadId);
    if (error) raise(error);
    return (count ?? 0) > 0;
  }

  async listInbox(query: InboxQuery): Promise<Message[]> {
    let request = this.client
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .is("room_id", null)
      .eq("to_agent", query.toAgent)
      .order("created_at", { ascending: true })
      .limit(query.limit);
    if (query.unreadOnly) request = request.is("read_at", null);
    if (query.since) request = request.gte("created_at", query.since);
    const { data, error } = await request;
    if (error) raise(error);
    return ((data ?? []) as unknown as MessageRow[]).map(mapMessage);
  }

  async markRead(toAgent: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.client
      .from("messages")
      .update({ read_at: new Date().toISOString() })
      .eq("to_agent", toAgent)
      .is("read_at", null)
      .in("id", ids);
    if (error) raise(error);
  }

  async ackMessage(toAgent: string, id: string): Promise<Message | null> {
    const existing = await this.getMessage(id);
    if (!existing || existing.toAgent !== toAgent) return null;
    const now = new Date().toISOString();
    const { error } = await this.client
      .from("messages")
      .update({
        acked_at: existing.ackedAt ?? now,
        read_at: existing.readAt ?? now,
      })
      .eq("id", id)
      .eq("to_agent", toAgent);
    if (error) raise(error);
    return this.getMessage(id);
  }

  async getMessage(id: string): Promise<Message | null> {
    return this.messageById(id);
  }

  async getMessages(ids: string[]): Promise<Message[]> {
    if (ids.length === 0) return [];
    const { data, error } = await this.client.from("messages").select(MESSAGE_COLUMNS).in("id", ids);
    if (error) raise(error);
    return ((data ?? []) as unknown as MessageRow[]).map(mapMessage);
  }

  async deleteMessage(id: string): Promise<void> {
    const plans = await this.client.from("plans").select("id").eq("message_id", id);
    if (plans.error) raise(plans.error);
    const planIds = ((plans.data ?? []) as Array<{ id: string }>).map((row) => row.id);
    const removed = await this.client.from("results").delete().eq("message_id", id);
    if (removed.error) raise(removed.error);
    if (planIds.length > 0) {
      const linked = await this.client.from("results").delete().in("plan_id", planIds);
      if (linked.error) raise(linked.error);
      const dropped = await this.client.from("plans").delete().in("id", planIds);
      if (dropped.error) raise(dropped.error);
    }
    const tasks = await this.client.from("tasks").delete().eq("source_message_id", id);
    if (tasks.error) raise(tasks.error);
    const message = await this.client.from("messages").delete().eq("id", id);
    if (message.error) raise(message.error);
  }

  async listThread(threadId: string): Promise<Message[]> {
    const { data, error } = await this.client
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true });
    if (error) raise(error);
    return ((data ?? []) as unknown as MessageRow[]).map(mapMessage);
  }

  async countRateEvents(agentId: string, sinceIso: string): Promise<number> {
    const { count, error } = await this.client
      .from("rate_events")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .gte("created_at", sinceIso);
    if (error) raise(error);
    return count ?? 0;
  }

  async addRateEvent(agentId: string): Promise<void> {
    const { error } = await this.client.from("rate_events").insert({ agent_id: agentId });
    if (error) raise(error);
  }

  async touchLastSeen(agentId: string): Promise<void> {
    const current = await this.getAgentById(agentId);
    if (!current || current.revokedAt) return;
    if (current.lastSeenAt && Date.now() - Date.parse(current.lastSeenAt) < 30_000) return;
    const { error } = await this.client
      .from("agents")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", agentId)
      .is("revoked_at", null);
    if (error) raise(error);
  }

  async setStatus(agentId: string, presence: PresenceStatus, statusText: string): Promise<Agent | null> {
    const { data, error } = await this.client
      .from("agents")
      .update({
        presence,
        status_text: statusText,
        status_updated_at: new Date().toISOString(),
      })
      .eq("id", agentId)
      .is("revoked_at", null)
      .select(AGENT_COLUMNS)
      .maybeSingle();
    if (error) raise(error);
    return data ? mapAgent(data as AgentRow) : null;
  }

  async insertTasks(inputs: NewTask[]): Promise<Task[]> {
    if (inputs.length === 0) return [];
    const { data, error } = await this.client
      .from("tasks")
      .upsert(
        inputs.map((input) => ({
          assignee_id: input.assigneeId,
          creator_id: input.creatorId,
          source_message_id: input.sourceMessageId,
          room_id: input.roomId,
          thread_id: input.threadId,
          slot: input.slot ?? "",
          title: input.title ?? "",
          ...(input.code && input.code.trim() !== "" ? { code: input.code } : {}),
        })),
        { onConflict: "source_message_id,assignee_id,slot", ignoreDuplicates: true },
      )
      .select("id");
    if (error) raise(error);
    const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
    const tasks: Task[] = [];
    for (const id of ids) {
      const task = await this.getTask(id);
      if (task) tasks.push(task);
    }
    return tasks;
  }

  async listTasks(query: TaskQuery): Promise<Task[]> {
    if (query.roomIds && query.roomIds.length === 0) return [];
    const newest = query.order === "updated" || (query.limit !== undefined && query.order !== "created");
    const createdDesc = query.order === "created" && query.limit !== undefined;
    let request = this.client
      .from("tasks")
      .select(TASK_COLUMNS)
      .order(newest ? "updated_at" : "created_at", { ascending: !newest && !createdDesc });
    if (query.assigneeId) request = request.eq("assignee_id", query.assigneeId);
    if (query.creatorId) request = request.eq("creator_id", query.creatorId);
    if (query.status) request = request.eq("status", query.status);
    if (query.statuses) request = request.in("status", query.statuses);
    if (query.roomId) request = request.eq("room_id", query.roomId);
    if (query.roomIds) request = request.in("room_id", query.roomIds);
    if (query.messageIds) request = request.in("source_message_id", query.messageIds);
    if (query.updatedAfter) request = request.gt("updated_at", query.updatedAfter);
    if (query.limit) request = request.limit(query.limit);
    const { data, error } = await request;
    if (error) raise(error);
    return ((data ?? []) as unknown as TaskRow[]).map(mapTaskRow);
  }

  async getTask(id: string): Promise<Task | null> {
    const { data, error } = await this.client.from("tasks").select(TASK_COLUMNS).eq("id", id).maybeSingle();
    if (error) raise(error);
    return data ? mapTaskRow(data as unknown as TaskRow) : null;
  }

  async updateTask(id: string, patch: TaskPatch): Promise<Task | null> {
    const { data, error } = await this.client
      .from("tasks")
      .update({
        status: patch.status,
        result_note: patch.resultNote,
        result_link: patch.resultLink,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) raise(error);
    if (!data) return null;
    return this.getTask(id);
  }

  async setWebhook(agentId: string, url: string, secret: string): Promise<Webhook> {
    const { data, error } = await this.client
      .from("agent_webhooks")
      .upsert(
        { agent_id: agentId, url, secret, updated_at: new Date().toISOString() },
        { onConflict: "agent_id" },
      )
      .select("agent_id, url, secret, updated_at")
      .single();
    if (error) raise(error);
    return mapWebhook(data as WebhookRow);
  }

  async clearWebhook(agentId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("agent_webhooks")
      .delete()
      .eq("agent_id", agentId)
      .select("agent_id");
    if (error) raise(error);
    return (data ?? []).length > 0;
  }

  async getWebhook(agentId: string): Promise<Webhook | null> {
    const { data, error } = await this.client
      .from("agent_webhooks")
      .select("agent_id, url, secret, updated_at")
      .eq("agent_id", agentId)
      .maybeSingle();
    if (error) raise(error);
    return data ? mapWebhook(data as WebhookRow) : null;
  }

  async listWebhooks(): Promise<WebhookPublic[]> {
    const { data, error } = await this.client
      .from("agent_webhooks")
      .select("agent_id, url, updated_at")
      .order("agent_id", { ascending: true });
    if (error) raise(error);
    return ((data ?? []) as Array<{ agent_id: string; url: string; updated_at: string }>).map((row) => ({
      agentId: row.agent_id,
      url: row.url,
      updatedAt: toIso(row.updated_at),
    }));
  }

  async enqueueDeliveries(rows: NewDelivery[]): Promise<void> {
    if (rows.length === 0) return;
    const { error } = await this.client.from("webhook_deliveries").upsert(
      rows.map((row) => ({
        agent_id: row.agentId,
        event: row.event,
        target_id: row.targetId,
        payload: row.payload,
      })),
      { onConflict: "agent_id,event,target_id", ignoreDuplicates: true },
    );
    if (error) raise(error);
  }

  async claimDueDeliveries(nowIso: string, limit: number, maxAttempts: number): Promise<Delivery[]> {
    const { data, error } = await this.client
      .from("webhook_deliveries")
      .select(
        "id, agent_id, event, target_id, payload, status, attempts, next_attempt_at, last_error, created_at, delivered_at",
      )
      .in("status", ["pending", "failed"])
      .lte("next_attempt_at", nowIso)
      .lt("attempts", maxAttempts)
      .order("next_attempt_at", { ascending: true })
      .limit(limit);
    if (error) raise(error);
    const claimed: Delivery[] = [];
    for (const row of (data ?? []) as unknown as DeliveryRow[]) {
      const nextAttempts = Number(row.attempts) + 1;
      const { data: updated, error: updateError } = await this.client
        .from("webhook_deliveries")
        .update({ status: "sending", attempts: nextAttempts })
        .eq("id", row.id)
        .in("status", ["pending", "failed"])
        .select(
          "id, agent_id, event, target_id, payload, status, attempts, next_attempt_at, last_error, created_at, delivered_at",
        )
        .maybeSingle();
      if (updateError) raise(updateError);
      if (updated) claimed.push(mapDelivery(updated as unknown as DeliveryRow));
    }
    return claimed;
  }

  async finishDelivery(
    id: string,
    result: { status: "delivered" | "failed"; error: string | null; nextAttemptAt: string },
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      status: result.status,
      last_error: result.error,
      next_attempt_at: result.nextAttemptAt,
    };
    if (result.status === "delivered") patch.delivered_at = new Date().toISOString();
    const { error } = await this.client.from("webhook_deliveries").update(patch).eq("id", id);
    if (error) raise(error);
  }

  async listDeliveries(agentId: string): Promise<Delivery[]> {
    const { data, error } = await this.client
      .from("webhook_deliveries")
      .select(
        "id, agent_id, event, target_id, payload, status, attempts, next_attempt_at, last_error, created_at, delivered_at",
      )
      .eq("agent_id", agentId)
      .order("created_at", { ascending: true });
    if (error) raise(error);
    return ((data ?? []) as unknown as DeliveryRow[]).map(mapDelivery);
  }

  async changeCursor(): Promise<ChangeCursor> {
    const [messages, agents, tasks, plans, results] = await Promise.all([
      this.client.from("messages").select("created_at").order("created_at", { ascending: false }).limit(1),
      this.client.from("agents").select("last_seen_at, status_updated_at").limit(200),
      this.client.from("tasks").select("updated_at").order("updated_at", { ascending: false }).limit(1),
      this.client.from("plans").select("updated_at").order("updated_at", { ascending: false }).limit(1),
      this.client.from("results").select("updated_at").order("updated_at", { ascending: false }).limit(1),
    ]);
    if (messages.error) raise(messages.error);
    if (agents.error) raise(agents.error);
    if (tasks.error) raise(tasks.error);
    if (plans.error) raise(plans.error);
    if (results.error) raise(results.error);
    const presenceValues = ((agents.data ?? []) as Array<{ last_seen_at: string | null; status_updated_at: string | null }>)
      .flatMap((row) => [row.last_seen_at, row.status_updated_at])
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      messagesAt: toIsoOrNull((messages.data?.[0] as { created_at?: string } | undefined)?.created_at ?? null),
      presenceAt: presenceValues.at(-1) ? toIso(presenceValues.at(-1) as string) : null,
      tasksAt: toIsoOrNull((tasks.data?.[0] as { updated_at?: string } | undefined)?.updated_at ?? null),
      plansAt: toIsoOrNull((plans.data?.[0] as { updated_at?: string } | undefined)?.updated_at ?? null),
      resultsAt: toIsoOrNull((results.data?.[0] as { updated_at?: string } | undefined)?.updated_at ?? null),
    };
  }

  async insertPlan(input: NewPlan): Promise<Plan> {
    const { data, error } = await this.client
      .from("plans")
      .insert({
        room_id: input.roomId,
        author_id: input.authorId,
        message_id: input.messageId,
        title: input.title,
        summary: input.summary,
      })
      .select("id")
      .single();
    if (error) raise(error);
    const id = (data as { id: string }).id;
    if (input.items.length > 0) {
      const { error: itemError } = await this.client.from("plan_items").insert(
        input.items.map((item, index) => ({
          plan_id: id,
          position: index + 1,
          title: item.title,
          assignee_id: item.assigneeId,
          estimate: item.estimate,
          depends_on: item.dependsOn,
        })),
      );
      if (itemError) {
        await this.client.from("plans").delete().eq("id", id);
        raise(itemError);
      }
    }
    const plan = await this.getPlan(id);
    if (!plan) throw new BusError("not_found", "The room or agent does not exist.");
    return plan;
  }

  async getPlan(id: string): Promise<Plan | null> {
    const plans = await this.loadPlans({ id });
    return plans[0] ?? null;
  }

  async listPlans(query: PlanQuery): Promise<Plan[]> {
    return this.loadPlans(query);
  }

  async updatePlan(
    id: string,
    patch: { status: PlanStatus; decidedAt?: string | null },
    expected: PlanStatus[],
  ): Promise<Plan | null> {
    const update: Record<string, unknown> = {
      status: patch.status,
      updated_at: new Date().toISOString(),
    };
    if (patch.decidedAt !== undefined) update.decided_at = patch.decidedAt;
    const { data, error } = await this.client
      .from("plans")
      .update(update)
      .eq("id", id)
      .in("status", expected)
      .select("id")
      .maybeSingle();
    if (error) raise(error);
    if (!data) return null;
    return this.getPlan(id);
  }

  async replacePlanItems(planId: string, items: PlanItemPatch[]): Promise<Plan | null> {
    const claimed = await this.client
      .from("plans")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", planId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimed.error) raise(claimed.error);
    if (!claimed.data) return null;
    const existing = await this.getPlan(planId);
    if (!existing) return null;
    const extras = existing.items.filter((item) => item.position > items.length).map((item) => item.id);
    if (extras.length > 0) {
      const { error } = await this.client.from("plan_items").delete().in("id", extras);
      if (error) raise(error);
    }
    for (const [index, item] of items.entries()) {
      const previous = existing.items[index];
      if (previous) {
        const { error } = await this.client
          .from("plan_items")
          .update({
            title: item.title,
            assignee_id: item.assigneeId,
            estimate: item.estimate,
            depends_on: item.dependsOn,
          })
          .eq("id", previous.id);
        if (error) raise(error);
      } else {
        const { error } = await this.client.from("plan_items").insert({
          plan_id: planId,
          position: index + 1,
          title: item.title,
          assignee_id: item.assigneeId,
          estimate: item.estimate,
          depends_on: item.dependsOn,
        });
        if (error) raise(error);
      }
    }
    const { error } = await this.client
      .from("plans")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", planId);
    if (error) raise(error);
    return this.getPlan(planId);
  }

  async attachPlanTasks(links: Array<{ itemId: string; taskId: string }>): Promise<void> {
    for (const link of links) {
      const { data, error } = await this.client
        .from("plan_items")
        .update({ task_id: link.taskId })
        .eq("id", link.itemId)
        .select("plan_id")
        .maybeSingle();
      if (error) raise(error);
      const planId = (data as { plan_id?: string } | null)?.plan_id;
      if (!planId) continue;
      const touched = await this.client
        .from("plans")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", planId);
      if (touched.error) raise(touched.error);
    }
  }

  async findPlanByTask(taskId: string): Promise<Plan | null> {
    const { data, error } = await this.client
      .from("plan_items")
      .select("plan_id")
      .eq("task_id", taskId)
      .limit(1)
      .maybeSingle();
    if (error) raise(error);
    const planId = (data as { plan_id?: string } | null)?.plan_id;
    return planId ? this.getPlan(planId) : null;
  }

  async insertResult(input: NewResult): Promise<ResultCard> {
    const { data, error } = await this.client
      .from("results")
      .insert({
        room_id: input.roomId,
        message_id: input.messageId,
        task_id: input.taskId,
        plan_id: input.planId,
        author_id: input.authorId,
        kind: input.kind,
        payload: input.payload,
      })
      .select("id")
      .single();
    if (error) raise(error);
    const result = await this.getResult((data as { id: string }).id);
    if (!result) throw new BusError("not_found", "The room or agent does not exist.");
    return result;
  }

  async getResult(id: string): Promise<ResultCard | null> {
    const rows = await this.loadResults({ id });
    return rows[0] ?? null;
  }

  async listResults(query: ResultQuery): Promise<ResultCard[]> {
    return this.loadResults(query);
  }

  async decideResult(
    id: string,
    status: ResultStatus,
    note: string,
    expected: ResultStatus[],
  ): Promise<ResultCard | null> {
    const now = new Date().toISOString();
    const { data, error } = await this.client
      .from("results")
      .update({ status, decision_note: note, decided_at: now, updated_at: now })
      .eq("id", id)
      .in("status", expected)
      .select("id")
      .maybeSingle();
    if (error) raise(error);
    if (!data) return null;
    return this.getResult(id);
  }

  private async loadPlans(query: PlanQuery & { id?: string }): Promise<Plan[]> {
    if (query.roomIds && query.roomIds.length === 0) return [];
    let request = this.client
      .from("plans")
      .select(
        "id, room_id, author_id, message_id, title, summary, status, created_at, updated_at, decided_at, room:rooms!plans_room_fkey(name), author:agents!plans_author_fkey(name)",
      )
      .order(query.order === "created" ? "created_at" : "updated_at", { ascending: false });
    if (query.id) request = request.eq("id", query.id);
    if (query.roomId) request = request.eq("room_id", query.roomId);
    if (query.roomIds) request = request.in("room_id", query.roomIds);
    if (query.status) request = request.eq("status", query.status);
    if (query.statuses) request = request.in("status", query.statuses);
    if (query.messageIds) request = request.in("message_id", query.messageIds);
    if (query.limit) request = request.limit(query.limit);
    const { data, error } = await request;
    if (error) raise(error);
    const rows = (data ?? []) as unknown as SupabasePlanRow[];
    if (rows.length === 0) return [];
    const { data: itemData, error: itemError } = await this.client
      .from("plan_items")
      .select(
        "id, plan_id, position, code, title, assignee_id, estimate, depends_on, task_id, assignee:agents!plan_items_assignee_fkey(name)",
      )
      .in(
        "plan_id",
        rows.map((row) => row.id),
      )
      .order("position", { ascending: true });
    if (itemError) raise(itemError);
    const grouped = new Map<string, PlanItem[]>();
    for (const row of (itemData ?? []) as unknown as SupabasePlanItemRow[]) {
      const list = grouped.get(row.plan_id) ?? [];
      list.push({
        id: row.id,
        planId: row.plan_id,
        position: Number(row.position),
        code: row.code ?? "",
        title: row.title,
        assigneeId: row.assignee_id,
        assigneeName: firstName(row.assignee).name,
        estimate: row.estimate ?? "",
        dependsOn: row.depends_on ?? "",
        taskId: row.task_id,
      });
      grouped.set(row.plan_id, list);
    }
    return rows.map((row) => ({
      id: row.id,
      roomId: row.room_id,
      roomName: roomName(row.room as TaskRow["room"]) ?? "",
      authorId: row.author_id,
      authorName: firstName(row.author).name,
      messageId: row.message_id,
      title: row.title,
      summary: row.summary,
      status: row.status as PlanStatus,
      items: grouped.get(row.id) ?? [],
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      decidedAt: toIsoOrNull(row.decided_at),
    }));
  }

  private async loadResults(query: ResultQuery & { id?: string }): Promise<ResultCard[]> {
    if (query.roomIds && query.roomIds.length === 0) return [];
    const newest = query.order === "updated" || (query.limit !== undefined && query.order !== "created");
    const createdDesc = query.order === "created" && query.limit !== undefined;
    let request = this.client
      .from("results")
      .select(
        "id, room_id, message_id, task_id, plan_id, author_id, kind, payload, status, decision_note, decided_at, created_at, updated_at, room:rooms!results_room_fkey(name), author:agents!results_author_fkey(name)",
      )
      .order(newest ? "updated_at" : "created_at", { ascending: !newest && !createdDesc });
    if (query.id) request = request.eq("id", query.id);
    if (query.roomId) request = request.eq("room_id", query.roomId);
    if (query.roomIds) request = request.in("room_id", query.roomIds);
    if (query.status) request = request.eq("status", query.status);
    if (query.statuses) request = request.in("status", query.statuses);
    if (query.messageIds) request = request.in("message_id", query.messageIds);
    if (query.authorId) request = request.eq("author_id", query.authorId);
    if (query.planId) request = request.eq("plan_id", query.planId);
    if (query.limit) request = request.limit(query.limit);
    const { data, error } = await request;
    if (error) raise(error);
    return ((data ?? []) as unknown as SupabaseResultRow[]).map((row) => ({
      id: row.id,
      roomId: row.room_id,
      roomName: roomName(row.room as TaskRow["room"]) ?? "",
      messageId: row.message_id,
      taskId: row.task_id,
      planId: row.plan_id,
      authorId: row.author_id,
      authorName: firstName(row.author).name,
      kind: row.kind as ResultKind,
      payload: asMetadata(row.payload),
      status: row.status as ResultStatus,
      decisionNote: row.decision_note ?? "",
      decidedAt: toIsoOrNull(row.decided_at),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    }));
  }

  async pruneRateEvents(olderThanIso: string): Promise<number> {
    const { data, error } = await this.client
      .from("rate_events")
      .delete()
      .lt("created_at", olderThanIso)
      .select("id");
    if (error) raise(error);
    return data?.length ?? 0;
  }
}

/**
 * New Supabase secret keys (`sb_secret_...`) are not JWTs. supabase-js still
 * copies the key into `Authorization: Bearer`, and the Data API rejects that
 * as an invalid JWT. Keep the key on `apikey` only. Legacy service_role JWTs
 * stay on both headers.
 */
export function serviceRoleFetch(serviceRoleKey: string, baseFetch: typeof fetch = fetch): typeof fetch {
  const stripBearer = serviceRoleKey.startsWith("sb_secret_") || serviceRoleKey.startsWith("sb_publishable_");
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (stripBearer && headers.get("authorization") === `Bearer ${serviceRoleKey}`) {
      headers.delete("authorization");
    }
    return baseFetch(input, { ...init, headers });
  };
}

export function createSupabaseStore(url: string, serviceRoleKey: string): SupabaseStore {
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: serviceRoleFetch(serviceRoleKey) },
  });
  return new SupabaseStore(client);
}
