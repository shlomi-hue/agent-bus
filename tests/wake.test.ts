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
import { callTool } from "../src/mcp/tools.js";

const SECRET = "webhook-secret-value";

async function agents() {
  const store = new MemoryStore();
  const config = loadConfig({ RATE_LIMIT_MAX: "100", WAIT_MAX_SECONDS: "2", ROOM_AGENT_CAP: "10" });
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
});
