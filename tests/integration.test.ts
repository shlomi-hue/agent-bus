import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { hashToken, mintToken } from "../src/auth/tokens.js";
import { AgentBus } from "../src/bus/service.js";
import { loadConfig } from "../src/config.js";
import { applyMigrations } from "../src/db/migrate.js";
import { PgStore } from "../src/db/pg-store.js";
import type { SqlClient } from "../src/db/types.js";
import { callTool } from "../src/mcp/tools.js";

function client(db: PGlite): SqlClient {
  return {
    async query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const result = await db.query<T>(sql, params);
      return { rows: result.rows };
    },
    async exec(sql) {
      await db.exec(sql);
    },
  };
}

async function database(): Promise<{ db: PGlite; store: PgStore; sql: SqlClient }> {
  const db = new PGlite();
  const sql = client(db);
  const directory = join(process.cwd(), "supabase/migrations");
  const applied = await applyMigrations(sql, directory);
  expect(applied).toEqual([
    "20261015120000_init",
    "20261016150000_rooms",
    "20261017100000_presence",
    "20261017100100_tasks",
    "20261017100200_webhooks",
    "20261018120000_plans_results",
    "20261018140100_drop_tasks_source_assignee_unique",
  ]);
  expect(await applyMigrations(sql, directory)).toEqual([]);
  return { db, store: new PgStore(sql), sql };
}

describe("postgres integration", () => {
  it("enables RLS, indexes the inbox, and blocks a granted reader", async () => {
    const { db, sql } = await database();
    const security = await sql.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity
       from pg_class
       where relname in (
         'agent_webhooks', 'agents', 'messages', 'plan_items', 'plans', 'rate_events',
         'results', 'room_members', 'rooms', 'schema_migrations', 'tasks', 'webhook_deliveries'
       )
       order by relname`,
    );
    expect(security.rows.map((row) => row.relname)).toEqual([
      "agent_webhooks",
      "agents",
      "messages",
      "plan_items",
      "plans",
      "rate_events",
      "results",
      "room_members",
      "rooms",
      "schema_migrations",
      "tasks",
      "webhook_deliveries",
    ]);
    expect(security.rows.every((row) => row.relrowsecurity === true || String(row.relrowsecurity) === "t")).toBe(
      true,
    );

    const indexes = await sql.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'messages'`,
    );
    const names = indexes.rows.map((row) => row.indexname);
    expect(names).toContain("messages_inbox_idx");
    expect(names).toContain("messages_inbox_unread_idx");
    expect(names).toContain("messages_thread_created_idx");
    expect(names).toContain("messages_room_created_idx");

    const migration = readFileSync(
      join(process.cwd(), "supabase/migrations/20261015120000_init.sql"),
      "utf8",
    );
    expect(migration).toContain("messages_inbox_unread_idx");
    expect(migration).toContain("enable row level security");

    await db.exec(`
      insert into public.agents (name, description, token_hash)
      values ('codex', '', repeat('a', 64));
    `);
    const codex = await sql.query<{ id: string }>(`select id from public.agents where name = 'codex'`);
    const claudeHash = "b".repeat(64);
    await sql.query(
      `insert into public.agents (name, description, token_hash) values ('claude', '', $1)`,
      [claudeHash],
    );
    const claude = await sql.query<{ id: string }>(`select id from public.agents where name = 'claude'`);
    await sql.query(
      `insert into public.messages (thread_id, from_agent, to_agent, body, hop_count)
       values (gen_random_uuid(), $1, $2, 'secret body', 0)`,
      [codex.rows[0]?.id, claude.rows[0]?.id],
    );

    await db.exec(`
      create role agent_bus_reader nologin;
      grant usage on schema public to agent_bus_reader;
      grant select on public.messages to agent_bus_reader;
    `);
    await db.exec("set role agent_bus_reader");
    const visible = await sql.query<{ count: number }>(
      "select count(*)::int as count from public.messages",
    );
    expect(Number(visible.rows[0]?.count)).toBe(0);
    await db.exec("reset role");

    await expect(
      sql.query(
        `insert into public.messages (thread_id, from_agent, to_agent, body, hop_count)
         values (gen_random_uuid(), $1, $2, $3, 0)`,
        [codex.rows[0]?.id, claude.rows[0]?.id, "z".repeat(16_385)],
      ),
    ).rejects.toThrow();
  });

  it("runs the mailbox through the real schema", async () => {
    const { store } = await database();
    const config = loadConfig({ MAX_HOPS: "2", RATE_LIMIT_MAX: "50" });
    const bus = new AgentBus(store, config);
    const codexToken = mintToken();
    const claudeToken = mintToken();
    const codex = await store.insertAgent({
      name: "codex",
      description: "codex",
      tokenHash: hashToken(codexToken),
    });
    const claude = await store.insertAgent({
      name: "claude",
      description: "claude",
      tokenHash: hashToken(claudeToken),
    });

    expect((await store.findAgentByTokenHash(hashToken(codexToken)))?.id).toBe(codex.id);
    expect(codex.tokenHash).not.toBe(codexToken);

    const sent = await callTool(
      bus,
      { id: codex.id, name: "codex" },
      "send_message",
      { to: "claude", body: "status?", metadata: { kind: "ping" } },
      config,
    );
    expect(sent.isError).toBeUndefined();

    const inbox = await callTool(bus, { id: claude.id, name: "claude" }, "read_inbox", {}, config);
    const inboxText = inbox.content[0]?.text ?? "";
    expect(inboxText).toContain('UNTRUSTED MESSAGE from agent "codex"');
    expect(inboxText).toContain("status?");
    const messageId = inboxText.match(/id: ([0-9a-f-]{36})/)?.[1] ?? "";
    const threadId = inboxText.match(/thread: ([0-9a-f-]{36})/)?.[1] ?? "";

    const empty = await callTool(bus, { id: claude.id, name: "claude" }, "read_inbox", {}, config);
    expect(empty.content[0]?.text).toContain("no unread messages");

    const reply = await callTool(
      bus,
      { id: claude.id, name: "claude" },
      "reply",
      { message_id: messageId, body: "all quiet" },
      config,
    );
    expect(reply.isError).toBeUndefined();
    expect(reply.content[0]?.text).toContain('to "codex"');
    expect(reply.content[0]?.text).toContain("hop 1");

    const back = await callTool(
      bus,
      { id: codex.id, name: "codex" },
      "read_inbox",
      { unread_only: true },
      config,
    );
    const replyId = back.content[0]?.text.match(/id: ([0-9a-f-]{36})/)?.[1] ?? "";
    const second = await callTool(
      bus,
      { id: codex.id, name: "codex" },
      "reply",
      { message_id: replyId, body: "thanks" },
      config,
    );
    expect(second.content[0]?.text).toContain("hop 2");
    const secondId = second.content[0]?.text.match(/message ([0-9a-f-]{36})/)?.[1] ?? "";
    const stopped = await callTool(
      bus,
      { id: claude.id, name: "claude" },
      "reply",
      { message_id: secondId, body: "and again" },
      config,
    );
    expect(stopped.isError).toBe(true);
    expect(stopped.content[0]?.text).toMatch(/hop 3/);

    const acked = await callTool(
      bus,
      { id: claude.id, name: "claude" },
      "ack_message",
      { id: messageId },
      config,
    );
    expect(acked.isError).toBeUndefined();

    const thread = await callTool(
      bus,
      { id: codex.id, name: "codex" },
      "get_thread",
      { thread_id: threadId },
      config,
    );
    expect(thread.content[0]?.text).toContain("3 message(s)");

    const duplicate = store.insertAgent({
      name: "codex",
      description: "",
      tokenHash: hashToken(mintToken()),
    });
    await expect(duplicate).rejects.toMatchObject({ code: "conflict" });

    await store.revokeAgentByName("claude");
    expect(await store.findAgentByTokenHash(hashToken(claudeToken))).toBeNull();
    const afterRevoke = await callTool(
      bus,
      { id: codex.id, name: "codex" },
      "send_message",
      { to: "claude", body: "you there?" },
      config,
    );
    expect(afterRevoke.isError).toBe(true);

    const pruned = await store.pruneRateEvents(new Date(Date.now() + 60_000).toISOString());
    expect(pruned).toBeGreaterThan(0);
    await store.ping();
  });

  it("enforces room membership and the agent-run cap in SQL", async () => {
    const { store, sql } = await database();
    const config = loadConfig({ ROOM_AGENT_CAP: "2", RATE_LIMIT_MAX: "100" });
    const bus = new AgentBus(store, config);
    const codex = await store.insertAgent({
      name: "codex",
      description: "",
      tokenHash: hashToken(mintToken()),
    });
    const claude = await store.insertAgent({
      name: "claude",
      description: "",
      tokenHash: hashToken(mintToken()),
    });
    const owner = await store.insertAgent({
      name: "owner",
      description: "owner",
      tokenHash: hashToken(mintToken()),
      isHuman: true,
    });
    const caller = (agent: { id: string; name: string }, isHuman = false) => ({
      id: agent.id,
      name: agent.name,
      isHuman,
    });

    expect(
      (await callTool(bus, caller(codex), "create_room", { name: "general" }, config)).isError,
    ).toBeUndefined();
    expect(
      (await callTool(bus, caller(claude), "join_room", { room: "general" }, config)).isError,
    ).toBeUndefined();
    const outsider = await callTool(
      bus,
      caller(owner, true),
      "read_room",
      { room: "general" },
      config,
    );
    expect(outsider.isError).toBe(true);
    expect(outsider.content[0]?.text).toContain("not a member");

    expect(
      (await callTool(bus, caller(codex), "send_room_message", { room: "general", body: "one" }, config))
        .isError,
    ).toBeUndefined();
    expect(
      (await callTool(bus, caller(claude), "send_room_message", { room: "general", body: "two" }, config))
        .isError,
    ).toBeUndefined();
    const paused = await callTool(
      bus,
      caller(codex),
      "send_room_message",
      { room: "general", body: "three" },
      config,
    );
    expect(paused.isError).toBe(true);

    expect(
      (await callTool(bus, caller(owner, true), "join_room", { room: "general" }, config)).isError,
    ).toBeUndefined();
    expect(
      (
        await callTool(
          bus,
          caller(owner, true),
          "send_room_message",
          { room: "general", body: "go ahead" },
          config,
        )
      ).isError,
    ).toBeUndefined();
    expect(
      (await callTool(bus, caller(codex), "send_room_message", { room: "general", body: "four" }, config))
        .isError,
    ).toBeUndefined();

    const room = await store.getRoomByName("general");
    await expect(
      sql.query(
        `insert into public.messages (thread_id, from_agent, to_agent, room_id, body, hop_count)
         values ($1, $2, $3, $1, 'both targets', 0)`,
        [room?.id, codex.id, claude.id],
      ),
    ).rejects.toThrow();

    const direct = await callTool(
      bus,
      caller(codex),
      "send_message",
      { to: "claude", body: "still a direct message" },
      config,
    );
    expect(direct.isError).toBeUndefined();
    const inbox = await callTool(bus, caller(claude), "read_inbox", {}, config);
    expect(inbox.content[0]?.text).toContain("still a direct message");
    expect(inbox.content[0]?.text).not.toContain("go ahead");
  });
});
