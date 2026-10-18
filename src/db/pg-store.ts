import pg from "pg";
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
  SqlClient,
  Store,
  Task,
  TaskPatch,
  TaskQuery,
  TaskStatus,
  Webhook,
  WebhookPublic,
} from "./types.js";
import { asMetadata, one, toIso, toIsoOrNull } from "./values.js";

const MESSAGE_SELECT = `
  select
    m.id,
    m.thread_id,
    m.from_agent,
    m.to_agent,
    fa.name as from_name,
    ta.name as to_name,
    fa.is_human as from_is_human,
    m.room_id,
    r.name as room_name,
    m.body,
    m.metadata,
    m.created_at,
    m.read_at,
    m.acked_at,
    m.hop_count,
    m.reply_to
  from public.messages m
  join public.agents fa on fa.id = m.from_agent
  left join public.agents ta on ta.id = m.to_agent
  left join public.rooms r on r.id = m.room_id
`;

const AGENT_COLUMNS =
  "id, name, description, token_hash, is_human, created_at, revoked_at, last_seen_at, presence, status_text, status_updated_at";

type AgentRow = {
  id: string;
  name: string;
  description: string;
  token_hash: string;
  is_human: boolean | string | number | null;
  created_at: Date | string;
  revoked_at: Date | string | null;
  last_seen_at: Date | string | null;
  presence: string | null;
  status_text: string | null;
  status_updated_at: Date | string | null;
};

type RoomRow = {
  id: string;
  name: string;
  created_at: Date | string;
};

type MessageRow = {
  id: string;
  thread_id: string;
  from_agent: string;
  to_agent: string | null;
  from_name: string;
  to_name: string | null;
  from_is_human: boolean | string | number | null;
  room_id: string | null;
  room_name: string | null;
  body: string;
  metadata: unknown;
  created_at: Date | string;
  read_at: Date | string | null;
  acked_at: Date | string | null;
  hop_count: number;
  reply_to: string | null;
};

function asBoolean(value: unknown): boolean {
  if (value === true || value === "t" || value === "true" || value === 1) return true;
  return false;
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

const TASK_SELECT = `
  select
    t.id,
    t.assignee_id,
    assignee.name as assignee_name,
    t.creator_id,
    creator.name as creator_name,
    creator.is_human as creator_is_human,
    t.source_message_id,
    t.room_id,
    room.name as room_name,
    t.thread_id,
    t.status,
    t.result_note,
    t.result_link,
    t.title,
    t.code,
    t.slot,
    t.created_at,
    t.updated_at
  from public.tasks t
  join public.agents assignee on assignee.id = t.assignee_id
  join public.agents creator on creator.id = t.creator_id
  left join public.rooms room on room.id = t.room_id
`;

type TaskRow = {
  id: string;
  assignee_id: string;
  assignee_name: string;
  creator_id: string;
  creator_name: string;
  creator_is_human: boolean | string | number | null;
  source_message_id: string;
  room_id: string | null;
  room_name: string | null;
  thread_id: string;
  status: string;
  result_note: string;
  result_link: string | null;
  title: string | null;
  code: string | null;
  slot: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type WebhookRow = {
  agent_id: string;
  url: string;
  secret: string;
  updated_at: Date | string;
};

type DeliveryRow = {
  id: string;
  agent_id: string;
  event: string;
  target_id: string;
  payload: unknown;
  status: string;
  attempts: number;
  next_attempt_at: Date | string;
  last_error: string | null;
  created_at: Date | string;
  delivered_at: Date | string | null;
};

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorIsHuman: asBoolean(row.creator_is_human),
    sourceMessageId: row.source_message_id,
    roomId: row.room_id,
    roomName: row.room_name,
    threadId: row.thread_id,
    status: row.status as TaskStatus,
    resultNote: row.result_note,
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
    fromName: row.from_name,
    toName: row.to_name,
    fromIsHuman: asBoolean(row.from_is_human),
    roomId: row.room_id,
    roomName: row.room_name,
    body: row.body,
    metadata: asMetadata(row.metadata),
    createdAt: toIso(row.created_at),
    readAt: toIsoOrNull(row.read_at),
    ackedAt: toIsoOrNull(row.acked_at),
    hopCount: Number(row.hop_count),
    replyTo: row.reply_to,
  };
}

export class PgStore implements Store {
  constructor(private readonly db: SqlClient) {}

  async ping(): Promise<void> {
    await this.db.query("select 1 as ok");
  }

  async findAgentByTokenHash(tokenHash: string): Promise<Agent | null> {
    const result = await this.db.query<AgentRow>(
      `select ${AGENT_COLUMNS}
       from public.agents
       where token_hash = $1 and revoked_at is null`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? mapAgent(row) : null;
  }

  async getAgentByName(name: string): Promise<Agent | null> {
    const result = await this.db.query<AgentRow>(
      `select ${AGENT_COLUMNS}
       from public.agents where name = $1`,
      [name],
    );
    const row = result.rows[0];
    return row ? mapAgent(row) : null;
  }

  async getAgentById(id: string): Promise<Agent | null> {
    const result = await this.db.query<AgentRow>(
      `select ${AGENT_COLUMNS}
       from public.agents where id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapAgent(row) : null;
  }

  async listAgents(includeRevoked: boolean): Promise<AgentSummary[]> {
    const result = await this.db.query<AgentRow>(
      `select ${AGENT_COLUMNS}
       from public.agents
       where ($1::boolean = true or revoked_at is null)
       order by name asc`,
      [includeRevoked],
    );
    return result.rows.map((row) => summarize(mapAgent(row)));
  }

  async insertAgent(input: NewAgent): Promise<Agent> {
    try {
      const result = await this.db.query<AgentRow>(
        `insert into public.agents (name, description, token_hash, is_human)
         values ($1, $2, $3, $4)
         returning ${AGENT_COLUMNS}`,
        [input.name, input.description, input.tokenHash, input.isHuman === true],
      );
      return mapAgent(one(result.rows, "insert agent"));
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
      const result = await this.db.query<AgentRow>(
        `update public.agents
         set token_hash = $2, description = $3, revoked_at = null
         where name = $1 and revoked_at is not null
         returning ${AGENT_COLUMNS}`,
        [input.name, input.tokenHash, input.description],
      );
      const row = result.rows[0];
      return row ? mapAgent(row) : null;
    } catch (error) {
      rethrowConstraint(error);
    }
  }

  async revokeAgentByName(name: string): Promise<Agent | null> {
    const result = await this.db.query<AgentRow>(
      `update public.agents
       set revoked_at = coalesce(revoked_at, now())
       where name = $1
       returning ${AGENT_COLUMNS}`,
      [name],
    );
    const row = result.rows[0];
    return row ? mapAgent(row) : null;
  }

  async markHuman(name: string): Promise<Agent | null> {
    const result = await this.db.query<AgentRow>(
      `update public.agents set is_human = true where name = $1 returning ${AGENT_COLUMNS}`,
      [name],
    );
    const row = result.rows[0];
    return row ? mapAgent(row) : null;
  }

  async createRoom(name: string): Promise<Room> {
    try {
      const result = await this.db.query<RoomRow>(
        `insert into public.rooms (name) values ($1) returning id, name, created_at`,
        [name],
      );
      return mapRoom(one(result.rows, "insert room"));
    } catch (error) {
      if (dbErrorCode(error) === "23505") {
        throw new BusError("conflict", `Room "${name}" already exists.`);
      }
      rethrowConstraint(error);
    }
  }

  async getRoomByName(name: string): Promise<Room | null> {
    const result = await this.db.query<RoomRow>(
      `select id, name, created_at from public.rooms where name = $1`,
      [name],
    );
    const row = result.rows[0];
    return row ? mapRoom(row) : null;
  }

  async getRoomById(id: string): Promise<Room | null> {
    const result = await this.db.query<RoomRow>(
      `select id, name, created_at from public.rooms where id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapRoom(row) : null;
  }

  async listRoomsForAgent(agentId: string): Promise<Room[]> {
    const result = await this.db.query<RoomRow>(
      `select r.id, r.name, r.created_at
       from public.rooms r
       join public.room_members m on m.room_id = r.id
       where m.agent_id = $1
       order by r.name asc`,
      [agentId],
    );
    return result.rows.map(mapRoom);
  }

  async addRoomMember(roomId: string, agentId: string): Promise<void> {
    try {
      await this.db.query(
        `insert into public.room_members (room_id, agent_id) values ($1, $2)
         on conflict do nothing`,
        [roomId, agentId],
      );
    } catch (error) {
      rethrowConstraint(error);
    }
  }

  async isRoomMember(roomId: string, agentId: string): Promise<boolean> {
    const result = await this.db.query<{ present: boolean }>(
      `select exists(
         select 1 from public.room_members where room_id = $1 and agent_id = $2
       ) as present`,
      [roomId, agentId],
    );
    return asBoolean(one(result.rows, "room member").present);
  }

  async listRoomMembers(roomId: string): Promise<AgentSummary[]> {
    const result = await this.db.query<
      Omit<AgentRow, "token_hash"> & { token_hash?: string }
    >(
      `select a.id, a.name, a.description, a.is_human, a.created_at, a.revoked_at,
              a.last_seen_at, a.presence, a.status_text, a.status_updated_at
       from public.room_members m
       join public.agents a on a.id = m.agent_id
       where m.room_id = $1 and a.revoked_at is null
       order by a.name asc`,
      [roomId],
    );
    return result.rows.map((row) => summarize(mapAgent({ ...row, token_hash: "" })));
  }

  async findPlanApproval(roomId: string, planId: string): Promise<Message | null> {
    const result = await this.db.query<MessageRow>(
      `${MESSAGE_SELECT}
       where m.room_id = $1
         and m.metadata->>'kind' = 'plan_decision'
         and m.metadata->>'planId' = $2
         and m.body like 'Approved the plan %'
       order by m.created_at asc
       limit 1`,
      [roomId, planId],
    );
    const row = result.rows[0];
    return row ? mapMessage(row) : null;
  }

  async listRoomMessages(query: RoomLogQuery): Promise<Message[]> {
    if (query.since) {
      const result = await this.db.query<MessageRow>(
        `${MESSAGE_SELECT}
         where m.room_id = $1 and m.created_at > $2::timestamptz
         order by m.created_at asc, m.id asc
         limit $3`,
        [query.roomId, query.since, query.limit],
      );
      return result.rows.map(mapMessage);
    }
    const result = await this.db.query<MessageRow>(
      `${MESSAGE_SELECT}
       where m.id in (
         select id from public.messages
         where room_id = $1
         order by created_at desc, id desc
         limit $2
       )
       order by m.created_at asc, m.id asc`,
      [query.roomId, query.limit],
    );
    return result.rows.map(mapMessage);
  }

  async listDirectMessages(query: DirectLogQuery): Promise<Message[]> {
    if (query.since) {
      const result = await this.db.query<MessageRow>(
        `${MESSAGE_SELECT}
         where m.room_id is null
           and (
             (m.from_agent = $1 and m.to_agent = $2)
             or (m.from_agent = $2 and m.to_agent = $1)
           )
           and m.created_at > $3::timestamptz
         order by m.created_at asc, m.id asc
         limit $4`,
        [query.agentId, query.otherId, query.since, query.limit],
      );
      return result.rows.map(mapMessage);
    }
    const result = await this.db.query<MessageRow>(
      `${MESSAGE_SELECT}
       where m.id in (
         select id from public.messages
         where room_id is null
           and (
             (from_agent = $1 and to_agent = $2)
             or (from_agent = $2 and to_agent = $1)
           )
         order by created_at desc, id desc
         limit $3
       )
       order by m.created_at asc, m.id asc`,
      [query.agentId, query.otherId, query.limit],
    );
    return result.rows.map(mapMessage);
  }

  async insertMessage(input: NewMessage): Promise<Message> {
    try {
      const result = await this.db.query<MessageRow>(
        `with inserted as (
           insert into public.messages
             (thread_id, from_agent, to_agent, room_id, body, metadata, hop_count, reply_to)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           returning *
         )
         ${MESSAGE_SELECT.replace("from public.messages m", "from inserted m")}`,
        [
          input.threadId,
          input.fromAgent,
          input.toAgent,
          input.roomId,
          input.body,
          JSON.stringify(input.metadata),
          input.hopCount,
          input.replyTo,
        ],
      );
      return mapMessage(one(result.rows, "insert message"));
    } catch (error) {
      rethrowConstraint(error);
    }
  }

  async threadExists(threadId: string): Promise<boolean> {
    const result = await this.db.query<{ present: boolean }>(
      `select exists(select 1 from public.messages where thread_id = $1) as present`,
      [threadId],
    );
    return asBoolean(one(result.rows, "thread exists").present);
  }

  async listInbox(query: InboxQuery): Promise<Message[]> {
    const result = await this.db.query<MessageRow>(
      `${MESSAGE_SELECT}
       where m.room_id is null
         and m.to_agent = $1
         and ($2::boolean = false or m.read_at is null)
         and ($3::timestamptz is null or m.created_at >= $3)
       order by m.created_at asc, m.id asc
       limit $4`,
      [query.toAgent, query.unreadOnly, query.since, query.limit],
    );
    return result.rows.map(mapMessage);
  }

  async markRead(toAgent: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query(
      `update public.messages
       set read_at = now()
       where to_agent = $1 and read_at is null and id = any($2::uuid[])`,
      [toAgent, ids],
    );
  }

  async ackMessage(toAgent: string, id: string): Promise<Message | null> {
    const result = await this.db.query<MessageRow>(
      `with updated as (
         update public.messages
         set acked_at = coalesce(acked_at, now()),
             read_at = coalesce(read_at, now())
         where id = $1 and to_agent = $2
         returning *
       )
       ${MESSAGE_SELECT.replace("from public.messages m", "from updated m")}`,
      [id, toAgent],
    );
    const row = result.rows[0];
    return row ? mapMessage(row) : null;
  }

  async getMessage(id: string): Promise<Message | null> {
    const result = await this.db.query<MessageRow>(`${MESSAGE_SELECT} where m.id = $1`, [id]);
    const row = result.rows[0];
    return row ? mapMessage(row) : null;
  }

  async getMessages(ids: string[]): Promise<Message[]> {
    if (ids.length === 0) return [];
    const result = await this.db.query<MessageRow>(`${MESSAGE_SELECT} where m.id = any($1::uuid[])`, [ids]);
    return result.rows.map(mapMessage);
  }

  async deleteMessage(id: string): Promise<void> {
    await this.db.query(
      `delete from public.results
       where message_id = $1
          or plan_id in (select id from public.plans where message_id = $1)`,
      [id],
    );
    await this.db.query(`delete from public.plans where message_id = $1`, [id]);
    await this.db.query(`delete from public.tasks where source_message_id = $1`, [id]);
    await this.db.query(`delete from public.messages where id = $1`, [id]);
  }

  async listThread(threadId: string): Promise<Message[]> {
    const result = await this.db.query<MessageRow>(
      `${MESSAGE_SELECT}
       where m.thread_id = $1
       order by m.created_at asc, m.id asc`,
      [threadId],
    );
    return result.rows.map(mapMessage);
  }

  async countRateEvents(agentId: string, sinceIso: string): Promise<number> {
    const result = await this.db.query<{ count: number }>(
      `select count(*)::int as count
       from public.rate_events
       where agent_id = $1 and created_at >= $2::timestamptz`,
      [agentId, sinceIso],
    );
    return Number(one(result.rows, "rate count").count);
  }

  async addRateEvent(agentId: string): Promise<void> {
    await this.db.query(`insert into public.rate_events (agent_id) values ($1)`, [agentId]);
  }

  async touchLastSeen(agentId: string): Promise<void> {
    await this.db.query(
      `update public.agents
       set last_seen_at = now()
       where id = $1
         and revoked_at is null
         and (last_seen_at is null or last_seen_at < now() - interval '30 seconds')`,
      [agentId],
    );
  }

  async setStatus(agentId: string, presence: PresenceStatus, statusText: string): Promise<Agent | null> {
    const result = await this.db.query<AgentRow>(
      `update public.agents
       set presence = $2, status_text = $3, status_updated_at = now()
       where id = $1 and revoked_at is null
       returning ${AGENT_COLUMNS}`,
      [agentId, presence, statusText],
    );
    const row = result.rows[0];
    return row ? mapAgent(row) : null;
  }

  async insertTasks(inputs: NewTask[]): Promise<Task[]> {
    const created: Task[] = [];
    for (const input of inputs) {
      const result = await this.db.query<{ id: string }>(
        `insert into public.tasks
           (assignee_id, creator_id, source_message_id, room_id, thread_id, slot, title, code)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict on constraint tasks_source_assignee_slot_unique do nothing
         returning id`,
        [
          input.assigneeId,
          input.creatorId,
          input.sourceMessageId,
          input.roomId,
          input.threadId,
          input.slot ?? "",
          input.title ?? "",
          input.code && input.code.trim() !== "" ? input.code : null,
        ],
      );
      const id = result.rows[0]?.id;
      if (!id) continue;
      const task = await this.getTask(id);
      if (task) created.push(task);
    }
    return created;
  }

  async listTasks(query: TaskQuery): Promise<Task[]> {
    const clauses = ["true"];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace("$?", `$${params.length}`));
    };
    if (query.assigneeId) add("t.assignee_id = $?", query.assigneeId);
    if (query.creatorId) add("t.creator_id = $?", query.creatorId);
    if (query.status) add("t.status = $?", query.status);
    if (query.statuses) add("t.status = any($?::text[])", query.statuses);
    if (query.roomId) add("t.room_id = $?", query.roomId);
    if (query.roomIds) {
      if (query.roomIds.length === 0) return [];
      add("t.room_id = any($?::uuid[])", query.roomIds);
    }
    if (query.messageIds) add("t.source_message_id = any($?::uuid[])", query.messageIds);
    if (query.updatedAfter) add("t.updated_at > $?::timestamptz", query.updatedAfter);
    const order =
      query.order === "updated" || (query.limit && query.order !== "created")
        ? "t.updated_at desc, t.id desc"
        : query.order === "created" && query.limit
          ? "t.created_at desc, t.id desc"
          : "t.created_at asc, t.id asc";
    const bound = query.limit ? [...params, query.limit] : params;
    const limitSql = query.limit ? ` limit $${params.length + 1}` : "";
    const result = await this.db.query<TaskRow>(
      `${TASK_SELECT} where ${clauses.join(" and ")} order by ${order}${limitSql}`,
      bound,
    );
    return result.rows.map(mapTask);
  }

  async getTask(id: string): Promise<Task | null> {
    const result = await this.db.query<TaskRow>(`${TASK_SELECT} where t.id = $1`, [id]);
    const row = result.rows[0];
    return row ? mapTask(row) : null;
  }

  async updateTask(id: string, patch: TaskPatch): Promise<Task | null> {
    const result = await this.db.query<{ id: string }>(
      `update public.tasks
       set status = $2, result_note = $3, result_link = $4, updated_at = now()
       where id = $1
       returning id`,
      [id, patch.status, patch.resultNote, patch.resultLink],
    );
    const updated = result.rows[0]?.id;
    return updated ? this.getTask(updated) : null;
  }

  async setWebhook(agentId: string, url: string, secret: string): Promise<Webhook> {
    const result = await this.db.query<WebhookRow>(
      `insert into public.agent_webhooks (agent_id, url, secret)
       values ($1, $2, $3)
       on conflict (agent_id) do update
         set url = excluded.url, secret = excluded.secret, updated_at = now()
       returning agent_id, url, secret, updated_at`,
      [agentId, url, secret],
    );
    return mapWebhook(one(result.rows, "webhook"));
  }

  async clearWebhook(agentId: string): Promise<boolean> {
    const result = await this.db.query<{ agent_id: string }>(
      `delete from public.agent_webhooks where agent_id = $1 returning agent_id`,
      [agentId],
    );
    return result.rows.length > 0;
  }

  async getWebhook(agentId: string): Promise<Webhook | null> {
    const result = await this.db.query<WebhookRow>(
      `select agent_id, url, secret, updated_at from public.agent_webhooks where agent_id = $1`,
      [agentId],
    );
    const row = result.rows[0];
    return row ? mapWebhook(row) : null;
  }

  async listWebhooks(): Promise<WebhookPublic[]> {
    const result = await this.db.query<WebhookRow>(
      `select agent_id, url, secret, updated_at from public.agent_webhooks order by agent_id asc`,
    );
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      url: row.url,
      updatedAt: toIso(row.updated_at),
    }));
  }

  async enqueueDeliveries(rows: NewDelivery[]): Promise<void> {
    for (const row of rows) {
      await this.db.query(
        `insert into public.webhook_deliveries (agent_id, event, target_id, payload)
         values ($1, $2, $3, $4::jsonb)
         on conflict on constraint webhook_deliveries_unique do nothing`,
        [row.agentId, row.event, row.targetId, JSON.stringify(row.payload)],
      );
    }
  }

  async claimDueDeliveries(nowIso: string, limit: number, maxAttempts: number): Promise<Delivery[]> {
    const result = await this.db.query<DeliveryRow>(
      `update public.webhook_deliveries
       set status = 'sending', attempts = attempts + 1
       where id in (
         select id from public.webhook_deliveries
         where status in ('pending', 'failed')
           and next_attempt_at <= $1::timestamptz
           and attempts < $2
         order by next_attempt_at asc
         limit $3
       )
       returning id, agent_id, event, target_id, payload, status, attempts, next_attempt_at, last_error, created_at, delivered_at`,
      [nowIso, maxAttempts, limit],
    );
    return result.rows.map(mapDelivery);
  }

  async finishDelivery(
    id: string,
    result: { status: "delivered" | "failed"; error: string | null; nextAttemptAt: string },
  ): Promise<void> {
    await this.db.query(
      `update public.webhook_deliveries
       set status = $2,
           last_error = $3,
           next_attempt_at = $4::timestamptz,
           delivered_at = case when $2 = 'delivered' then now() else delivered_at end
       where id = $1`,
      [id, result.status, result.error, result.nextAttemptAt],
    );
  }

  async listDeliveries(agentId: string): Promise<Delivery[]> {
    const result = await this.db.query<DeliveryRow>(
      `select id, agent_id, event, target_id, payload, status, attempts, next_attempt_at, last_error, created_at, delivered_at
       from public.webhook_deliveries
       where agent_id = $1
       order by created_at asc`,
      [agentId],
    );
    return result.rows.map(mapDelivery);
  }

  async changeCursor(): Promise<ChangeCursor> {
    const result = await this.db.query<{
      messages_at: Date | string | null;
      presence_at: Date | string | null;
      tasks_at: Date | string | null;
      plans_at: Date | string | null;
      results_at: Date | string | null;
    }>(
      `select
         (select max(created_at) from public.messages) as messages_at,
         (select max(greatest(last_seen_at, status_updated_at)) from public.agents) as presence_at,
         (select max(updated_at) from public.tasks) as tasks_at,
         (select max(updated_at) from public.plans) as plans_at,
         (select max(updated_at) from public.results) as results_at`,
    );
    const row = one(result.rows, "change cursor");
    return {
      messagesAt: toIsoOrNull(row.messages_at),
      presenceAt: toIsoOrNull(row.presence_at),
      tasksAt: toIsoOrNull(row.tasks_at),
      plansAt: toIsoOrNull(row.plans_at),
      resultsAt: toIsoOrNull(row.results_at),
    };
  }

  async insertPlan(input: NewPlan): Promise<Plan> {
    const created = await this.db.query<{ id: string }>(
      `insert into public.plans (room_id, author_id, message_id, title, summary)
       values ($1, $2, $3, $4, $5)
       returning id`,
      [input.roomId, input.authorId, input.messageId, input.title, input.summary],
    );
    const id = one(created.rows, "plan").id;
    try {
      for (const [index, item] of input.items.entries()) {
        await this.db.query(
          `insert into public.plan_items (plan_id, position, title, assignee_id, estimate, depends_on)
           values ($1, $2, $3, $4, $5, $6)`,
          [id, index + 1, item.title, item.assigneeId, item.estimate, item.dependsOn],
        );
      }
    } catch (error) {
      await this.db.query(`delete from public.plans where id = $1`, [id]);
      throw error;
    }
    const plan = await this.getPlan(id);
    if (!plan) throw new BusError("not_found", "The room or agent does not exist.");
    return plan;
  }

  async getPlan(id: string): Promise<Plan | null> {
    const plans = await this.loadPlans("p.id = $1", [id]);
    return plans[0] ?? null;
  }

  async listPlans(query: PlanQuery): Promise<Plan[]> {
    const clauses = ["true"];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace("$?", `$${params.length}`));
    };
    if (query.roomId) add("p.room_id = $?", query.roomId);
    if (query.status) add("p.status = $?", query.status);
    if (query.statuses) add("p.status = any($?::text[])", query.statuses);
    if (query.roomIds) {
      if (query.roomIds.length === 0) return [];
      add("p.room_id = any($?::uuid[])", query.roomIds);
    }
    if (query.messageIds) add("p.message_id = any($?::uuid[])", query.messageIds);
    return this.loadPlans(clauses.join(" and "), params, { order: query.order, limit: query.limit });
  }

  async updatePlan(
    id: string,
    patch: { status: PlanStatus; decidedAt?: string | null },
    expected: PlanStatus[],
  ): Promise<Plan | null> {
    const decided = patch.decidedAt === undefined ? null : patch.decidedAt;
    const touchDecision = patch.decidedAt !== undefined;
    const result = await this.db.query<{ id: string }>(
      `update public.plans
       set status = $2,
           updated_at = now(),
           decided_at = case when $4::boolean then $3::timestamptz else decided_at end
       where id = $1 and status = any($5::text[])
       returning id`,
      [id, patch.status, decided, touchDecision, expected],
    );
    const updated = result.rows[0]?.id;
    return updated ? this.getPlan(updated) : null;
  }

  async replacePlanItems(planId: string, items: PlanItemPatch[]): Promise<Plan | null> {
    const claimed = await this.db.query<{ id: string }>(
      `update public.plans set updated_at = now() where id = $1 and status = 'pending' returning id`,
      [planId],
    );
    if (!claimed.rows[0]) return null;
    const existing = await this.getPlan(planId);
    if (!existing) return null;
    await this.db.query(`delete from public.plan_items where plan_id = $1 and position > $2`, [
      planId,
      items.length,
    ]);
    for (const [index, item] of items.entries()) {
      const previous = existing.items[index];
      if (previous) {
        await this.db.query(
          `update public.plan_items
           set title = $2, assignee_id = $3, estimate = $4, depends_on = $5
           where id = $1`,
          [previous.id, item.title, item.assigneeId, item.estimate, item.dependsOn],
        );
      } else {
        await this.db.query(
          `insert into public.plan_items (plan_id, position, title, assignee_id, estimate, depends_on)
           values ($1, $2, $3, $4, $5, $6)`,
          [planId, index + 1, item.title, item.assigneeId, item.estimate, item.dependsOn],
        );
      }
    }
    await this.db.query(`update public.plans set updated_at = now() where id = $1`, [planId]);
    return this.getPlan(planId);
  }

  async attachPlanTasks(links: Array<{ itemId: string; taskId: string }>): Promise<void> {
    for (const link of links) {
      await this.db.query(
        `update public.plan_items set task_id = $2 where id = $1`,
        [link.itemId, link.taskId],
      );
      await this.db.query(
        `update public.plans set updated_at = now()
         where id = (select plan_id from public.plan_items where id = $1)`,
        [link.itemId],
      );
    }
  }

  async findPlanByTask(taskId: string): Promise<Plan | null> {
    const plans = await this.loadPlans(
      `p.id = (select plan_id from public.plan_items where task_id = $1 limit 1)`,
      [taskId],
    );
    return plans[0] ?? null;
  }

  async insertResult(input: NewResult): Promise<ResultCard> {
    const created = await this.db.query<{ id: string }>(
      `insert into public.results (room_id, message_id, task_id, plan_id, author_id, kind, payload)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       returning id`,
      [
        input.roomId,
        input.messageId,
        input.taskId,
        input.planId,
        input.authorId,
        input.kind,
        JSON.stringify(input.payload),
      ],
    );
    const result = await this.getResult(one(created.rows, "result").id);
    if (!result) throw new BusError("not_found", "The room or agent does not exist.");
    return result;
  }

  async getResult(id: string): Promise<ResultCard | null> {
    const rows = await this.loadResults("r.id = $1", [id]);
    return rows[0] ?? null;
  }

  async listResults(query: ResultQuery): Promise<ResultCard[]> {
    const clauses = ["true"];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      clauses.push(sql.replace("$?", `$${params.length}`));
    };
    if (query.roomId) add("r.room_id = $?", query.roomId);
    if (query.status) add("r.status = $?", query.status);
    if (query.statuses) add("r.status = any($?::text[])", query.statuses);
    if (query.messageIds) add("r.message_id = any($?::uuid[])", query.messageIds);
    if (query.authorId) add("r.author_id = $?", query.authorId);
    if (query.planId) add("r.plan_id = $?", query.planId);
    if (query.roomIds) {
      if (query.roomIds.length === 0) return [];
      add("r.room_id = any($?::uuid[])", query.roomIds);
    }
    return this.loadResults(clauses.join(" and "), params, { order: query.order, limit: query.limit });
  }

  async decideResult(
    id: string,
    status: ResultStatus,
    note: string,
    expected: ResultStatus[],
  ): Promise<ResultCard | null> {
    const result = await this.db.query<{ id: string }>(
      `update public.results
       set status = $2, decision_note = $3, decided_at = now(), updated_at = now()
       where id = $1 and status = any($4::text[])
       returning id`,
      [id, status, note, expected],
    );
    const updated = result.rows[0]?.id;
    return updated ? this.getResult(updated) : null;
  }

  private async loadPlans(
    where: string,
    params: unknown[],
    options: { order?: "updated" | "created"; limit?: number } = {},
  ): Promise<Plan[]> {
    const orderSql = options.order === "created" ? "p.created_at desc, p.id desc" : "p.updated_at desc, p.id desc";
    const bound = options.limit ? [...params, options.limit] : params;
    const limitSql = options.limit ? ` limit $${params.length + 1}` : "";
    const result = await this.db.query<PlanRow>(
      `select p.id, p.room_id, room.name as room_name, p.author_id, author.name as author_name,
              p.message_id, p.title, p.summary, p.status, p.created_at, p.updated_at, p.decided_at
       from public.plans p
       join public.rooms room on room.id = p.room_id
       join public.agents author on author.id = p.author_id
       where ${where}
       order by ${orderSql}${limitSql}`,
      bound,
    );
    if (result.rows.length === 0) return [];
    const ids = result.rows.map((row) => row.id);
    const items = await this.db.query<PlanItemRow>(
      `select i.id, i.plan_id, i.position, i.code, i.title, i.assignee_id, assignee.name as assignee_name,
              i.estimate, i.depends_on, i.task_id
       from public.plan_items i
       join public.agents assignee on assignee.id = i.assignee_id
       where i.plan_id = any($1::uuid[])
       order by i.position asc`,
      [ids],
    );
    const grouped = new Map<string, PlanItem[]>();
    for (const row of items.rows) {
      const list = grouped.get(row.plan_id) ?? [];
      list.push(mapPlanItem(row));
      grouped.set(row.plan_id, list);
    }
    return result.rows.map((row) => mapPlan(row, grouped.get(row.id) ?? []));
  }

  private async loadResults(
    where: string,
    params: unknown[],
    options: { order?: "updated" | "created"; limit?: number } = {},
  ): Promise<ResultCard[]> {
    const orderSql =
      options.order === "updated" || (options.limit && options.order !== "created")
        ? "r.updated_at desc, r.id desc"
        : options.order === "created" && options.limit
          ? "r.created_at desc, r.id desc"
          : "r.created_at asc, r.id asc";
    const bound = options.limit ? [...params, options.limit] : params;
    const limitSql = options.limit ? ` limit $${params.length + 1}` : "";
    const result = await this.db.query<ResultRow>(
      `select r.id, r.room_id, room.name as room_name, r.message_id, r.task_id, r.plan_id,
              r.author_id, author.name as author_name, r.kind, r.payload, r.status,
              r.decision_note, r.decided_at, r.created_at, r.updated_at
       from public.results r
       join public.rooms room on room.id = r.room_id
       join public.agents author on author.id = r.author_id
       where ${where}
       order by ${orderSql}${limitSql}`,
      bound,
    );
    return result.rows.map(mapResult);
  }

  async pruneRateEvents(olderThanIso: string): Promise<number> {
    const result = await this.db.query<{ count: number }>(
      `with deleted as (
         delete from public.rate_events
         where created_at < $1::timestamptz
         returning 1
       )
       select count(*)::int as count from deleted`,
      [olderThanIso],
    );
    return Number(one(result.rows, "prune rate events").count);
  }
}

type PlanRow = {
  id: string;
  room_id: string;
  room_name: string;
  author_id: string;
  author_name: string;
  message_id: string;
  title: string;
  summary: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
  decided_at: Date | string | null;
};

type PlanItemRow = {
  id: string;
  plan_id: string;
  position: number;
  code: string | null;
  title: string;
  assignee_id: string;
  assignee_name: string;
  estimate: string;
  depends_on: string;
  task_id: string | null;
};

type ResultRow = {
  id: string;
  room_id: string;
  room_name: string;
  message_id: string;
  task_id: string | null;
  plan_id: string | null;
  author_id: string;
  author_name: string;
  kind: string;
  payload: unknown;
  status: string;
  decision_note: string;
  decided_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function mapPlanItem(row: PlanItemRow): PlanItem {
  return {
    id: row.id,
    planId: row.plan_id,
    position: Number(row.position),
    code: row.code ?? "",
    title: row.title,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    estimate: row.estimate,
    dependsOn: row.depends_on,
    taskId: row.task_id,
  };
}

function mapPlan(row: PlanRow, items: PlanItem[]): Plan {
  return {
    id: row.id,
    roomId: row.room_id,
    roomName: row.room_name,
    authorId: row.author_id,
    authorName: row.author_name,
    messageId: row.message_id,
    title: row.title,
    summary: row.summary,
    status: row.status as PlanStatus,
    items,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    decidedAt: toIsoOrNull(row.decided_at),
  };
}

function mapResult(row: ResultRow): ResultCard {
  return {
    id: row.id,
    roomId: row.room_id,
    roomName: row.room_name,
    messageId: row.message_id,
    taskId: row.task_id,
    planId: row.plan_id,
    authorId: row.author_id,
    authorName: row.author_name,
    kind: row.kind as ResultKind,
    payload: asMetadata(row.payload),
    status: row.status as ResultStatus,
    decisionNote: row.decision_note ?? "",
    decidedAt: toIsoOrNull(row.decided_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function sslForConnection(connectionString: string): pg.ConnectionConfig["ssl"] {
  const url = new URL(connectionString);
  const mode = url.searchParams.get("sslmode");
  if (mode === "disable") return undefined;
  const host = url.hostname;
  if (mode === "require" || host.includes("supabase.co") || host.includes("supabase.com")) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

export function createPgPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    ssl: sslForConnection(connectionString),
  });
}

export function poolClient(pool: pg.Pool): SqlClient {
  return {
    query: (sql, params = []) => pool.query(sql, params),
    exec: async (sql) => {
      await pool.query(sql);
    },
  };
}
