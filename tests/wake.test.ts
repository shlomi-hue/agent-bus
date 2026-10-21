import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashToken, mintToken } from "../src/auth/tokens.js";
import { AgentBus } from "../src/bus/service.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/db/memory-store.js";
import { dispatchDue } from "../src/wake/deliver.js";
import { createAgentBus } from "../src/wake/hook.js";
import { planDeliveries } from "../src/wake/plan.js";
import { signPayload } from "../src/wake/sign.js";
import { formatWait } from "../src/bus/format.js";
import { callTool } from "../src/mcp/tools.js";

const SECRET = "webhook-secret-value";

async function agents() {
  const store = new MemoryStore();
  const config = loadConfig({
    OWNER_NAME: "owner",
    RATE_LIMIT_MAX: "100",
    WAIT_MAX_SECONDS: "2",
    ROOM_AGENT_CAP: "10",
  });
  const owner = await store.insertAgent({
    name: "owner",
    description: "",
    tokenHash: hashToken(mintToken()),
    isHuman: true,
  });
  const codex = await store.insertAgent({
    name: "codex",
    description: "",
    tokenHash: hashToken(mintToken()),
  });
  await store.createRoom("general");
  const room = await store.getRoomByName("general");
  if (!room) throw new Error("room missing");
  await store.addRoomMember(room.id, owner.id);
  await store.addRoomMember(room.id, codex.id);
  return { store, config, owner, codex, room };
}

describe("wake-ups", () => {
  it("signs a minimal payload and retries a failed post without blocking the write", async () => {
    const { store, config, owner, codex } = await agents();
    await store.setWebhook(codex.id, "https://example.com/hook", SECRET);
    const calls: Array<{ body: string; signature: string | null; timestamp: string | null; status: number }> = [];
    let failuresLeft = 2;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      const status = failuresLeft > 0 ? 503 : 200;
      if (failuresLeft > 0) failuresLeft -= 1;
      calls.push({
        body: String(init?.body ?? ""),
        signature: headers.get("x-agent-bus-signature"),
        timestamp: headers.get("x-agent-bus-timestamp"),
        status,
      });
      return new Response(status === 200 ? "ok" : "no", { status });
    };
    const bus = new AgentBus(store, config, async () => {
      throw new Error("delivery store is down");
    });
    const message = await bus.send(
      { id: owner.id, name: owner.name, isHuman: true },
      { to: "codex", body: `please look at the login ${"tail ".repeat(40)}` },
    );
    expect(message.id).toBeTruthy();
    const rows = await planDeliveries({
      store,
      message,
      tasks: [],
      ownerName: "owner",
    });
    expect(rows).toHaveLength(1);
    await store.enqueueDeliveries(rows);
    const result = await dispatchDue(store, { fetchImpl, sleep: async () => {} });
    expect(result).toEqual({ delivered: 1, failed: 2 });
    expect(calls.map((call) => call.status)).toEqual([503, 503, 200]);
    const last = calls[2];
    if (!last?.timestamp) throw new Error("missing timestamp");
    const expected = createHmac("sha256", SECRET).update(`${last.timestamp}.${last.body}`).digest("hex");
    expect(last.signature).toBe(`sha256=${expected}`);
    expect(signPayload(SECRET, last.timestamp, last.body)).toBe(expected);
    expect(last.body).not.toContain(SECRET);
    const parsed = JSON.parse(last.body) as { preview: string; event: string };
    expect(parsed.event).toBe("dm");
    expect(parsed.preview.length).toBeLessThanOrEqual(160);
    const log = await store.listDeliveries(codex.id);
    expect(log.some((row) => row.status === "delivered")).toBe(true);
    expect(log.some((row) => row.attempts >= 1)).toBe(true);
  });

  it("notifies the owner only when an agent mentions them and the env URL is set", async () => {
    const { store, config, owner, codex } = await agents();
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response("ok", { status: 200 });
    };
    const previous = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const bus = createAgentBus(store, config, {
        OWNER_NOTIFY_URL: "https://ntfy.example/agent-bus",
        OWNER_NOTIFY_SECRET: SECRET,
      });
      await bus.send(
        { id: codex.id, name: codex.name, isHuman: false },
        { to: "owner", body: "@owner the build is red" },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      globalThis.fetch = previous;
    }
    expect(urls).toContain("https://ntfy.example/agent-bus");
    const ownerLog = await store.listDeliveries(owner.id);
    expect(ownerLog.some((row) => row.event === "owner_notify")).toBe(true);

    urls.length = 0;
    const quiet = createAgentBus(store, config, {});
    await quiet.send(
      { id: owner.id, name: owner.name, isHuman: true },
      { to: "codex", body: "@owner pinging myself does not notify" },
    );
    await dispatchDue(store, { fetchImpl, sleep: async () => {}, ownerNotifyUrl: undefined });
    expect(urls).not.toContain("https://ntfy.example/agent-bus");
  });

  it("returns from wait_for_messages when a direct message arrives, and times out otherwise", async () => {
    const { store, config, owner, codex } = await agents();
    const bus = new AgentBus(store, config);
    const caller = { id: codex.id, name: codex.name, isHuman: false };
    const since = new Date().toISOString();
    const pending = bus.waitForMessages(caller, { since, timeout_seconds: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await bus.send({ id: owner.id, name: owner.name, isHuman: true }, { to: "codex", body: "wake up" });
    const woke = await pending;
    expect(woke.timedOut).toBe(false);
    expect(woke.messages.map((message) => message.body)).toContain("wake up");

    const idle = await callTool(
      bus,
      caller,
      "wait_for_messages",
      { since: new Date(Date.now() + 60_000).toISOString(), timeout_seconds: 1 },
      config,
    );
    expect(idle.isError).toBeUndefined();
    expect(idle.content[0]?.text).toContain("No new messages");
  });

  it("peeks without consuming, round-trips the cursor, and inlines room posts", async () => {
    const { store, config, owner, codex, room } = await agents();
    const bus = new AgentBus(store, config);
    const human = { id: owner.id, name: owner.name, isHuman: true };
    const caller = { id: codex.id, name: codex.name, isHuman: false };
    const since = "2020-01-01T00:00:00.000Z";
    await bus.send(human, { to: "codex", body: "still unread" });
    await bus.sendRoom(human, { room: room.name, body: "hello in the room" });

    const peeked = await callTool(
      bus,
      caller,
      "wait_for_messages",
      { since, timeout_seconds: 1, mark_read: false },
      config,
    );
    const text = peeked.content[0]?.text ?? "";
    expect(peeked.isError).toBeUndefined();
    expect(text).toContain("mark_read: false");
    expect(text).toContain("room_messages: inline");
    expect(text).toContain("were not marked read");
    expect(text).toContain("sender_kind: human");
    expect(text).toContain('from: "owner" in room "general"');
    expect(text).toContain("type: post");
    expect(text).toContain("created_at:");
    expect(text).toContain("Call read_room for each");
    const cursor = text.match(/Pass since (\S+) on the next/)?.[1];
    expect(cursor).toMatch(/\.\d{6}Z$/);
    const direct = await store.listInbox({ toAgent: codex.id, unreadOnly: true, limit: 10, since: null });
    expect(direct.map((message) => message.body)).toContain("still unread");

    const again = await bus.waitForMessages(caller, { since: cursor, timeout_seconds: 1, mark_read: false });
    expect(again.timedOut).toBe(true);
    expect(again.messages).toHaveLength(0);
    expect(again.roomMessages).toHaveLength(0);

    const consumed = await callTool(bus, caller, "read_inbox", {}, config);
    expect(consumed.content[0]?.text).toContain("These messages are now marked read");
    const hidden = await callTool(bus, caller, "read_inbox", { mark_read: false }, config);
    expect(hidden.content[0]?.text).toContain("no unread messages");
    const kept = await callTool(
      bus,
      caller,
      "read_inbox",
      { unread_only: false, mark_read: false },
      config,
    );
    expect(kept.content[0]?.text).toContain("were not marked read");
    expect(kept.content[0]?.text).toContain("still unread");
    const stillThere = await store.listInbox({ toAgent: codex.id, unreadOnly: true, limit: 10, since: null });
    expect(stillThere).toHaveLength(0);
    const readable = await store.listInbox({ toAgent: codex.id, unreadOnly: false, limit: 10, since: null });
    expect(readable[0]?.readAt).toBeTruthy();
  });

  it("labels task-status room notices and does not skip a later room when a page is full", async () => {
    const { store, config, owner, codex, room } = await agents();
    const bus = new AgentBus(store, config);
    const human = { id: owner.id, name: owner.name, isHuman: true };
    const caller = { id: codex.id, name: codex.name, isHuman: false };
    await bus.sendRoom(human, { room: room.name, body: "@codex ship the cursor" });
    const open = await store.listTasks({ assigneeId: codex.id });
    const task = open[0];
    if (!task) throw new Error("task missing");
    const first = await bus.waitForMessages(caller, {
      since: "2020-01-01T00:00:00.000Z",
      timeout_seconds: 1,
      mark_read: false,
    });
    expect(first.roomMessages.some((message) => message.body.includes("@codex"))).toBe(true);
    expect(first.tasks.map((item) => item.id)).toContain(task.id);
    expect(first.cursor.endsWith("Z")).toBe(true);

    await bus.updateTask(caller, { id: task.id, status: "working" });
    const second = await bus.waitForMessages(caller, { since: first.cursor, timeout_seconds: 1, mark_read: false });
    expect(second.roomMessages.map((message) => message.metadata.kind)).toContain("task_status");
    const notice = second.roomMessages.find((message) => message.metadata.kind === "task_status");
    expect(notice?.threadId).toBe(room.id);
    const rendered = formatWait("codex", second);
    expect(rendered).toContain("type: task_status");
    expect(rendered).toContain(`updated ${second.tasks[0]?.updatedAt} thread ${second.tasks[0]?.threadId}`);

    const other = await store.createRoom("later");
    await store.addRoomMember(other.id, owner.id);
    await store.addRoomMember(other.id, codex.id);
    for (let index = 0; index < 21; index += 1) {
      await bus.sendRoom(human, { room: room.name, body: `page ${index}` });
    }
    await bus.sendRoom(human, { room: "later", body: "after the full page" });
    const paged = await bus.waitForMessages(caller, { since: second.cursor, timeout_seconds: 1, mark_read: false });
    expect(paged.truncatedRooms).toContain("general");
    expect(paged.roomMessages.some((message) => message.body === "after the full page")).toBe(false);
    expect(paged.roomMessages).toHaveLength(20);
    const rest = await bus.waitForMessages(caller, { since: paged.cursor, timeout_seconds: 1, mark_read: false });
    expect(rest.roomMessages.map((message) => message.body)).toContain("page 20");
    expect(rest.roomMessages.map((message) => message.body)).toContain("after the full page");
  });
});
