import { describe, expect, it } from "vitest";
import { hashToken, mintToken } from "../src/auth/tokens.js";
import { AgentBus } from "../src/bus/service.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/db/memory-store.js";
import { createApp } from "../src/http/app.js";
import { signSession } from "../src/http/session.js";
import { callTool } from "../src/mcp/tools.js";

const PASSWORD = "owner-password-value";

describe("presence", () => {
  it("records last_seen on an authenticated MCP call and updates status", async () => {
    const store = new MemoryStore();
    const token = mintToken();
    const codex = await store.insertAgent({
      name: "codex",
      description: "",
      tokenHash: hashToken(token),
    });
    expect(codex.lastSeenAt).toBeNull();
    const app = createApp({
      store,
      config: loadConfig({}),
      env: { CRON_SECRET: "cron-secret-value" },
    });
    const response = await app.request("/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(response.status).toBe(200);
    const seen = await store.getAgentById(codex.id);
    expect(seen?.lastSeenAt).toBeTruthy();

    const bus = new AgentBus(store, loadConfig({}));
    const caller = { id: codex.id, name: codex.name, isHuman: false };
    const updated = await callTool(
      bus,
      caller,
      "set_status",
      { status: "busy", text: "reviewing the diff" },
      loadConfig({}),
    );
    expect(updated.isError).toBeUndefined();
    expect(updated.content[0]?.text).toContain("busy");
    expect(updated.content[0]?.text).toContain("reviewing the diff");
    const after = await store.getAgentById(codex.id);
    expect(after?.presence).toBe("busy");
    expect(after?.statusText).toBe("reviewing the diff");

    const rejected = await callTool(bus, caller, "set_status", { status: "offline" }, loadConfig({}));
    expect(rejected.isError).toBe(true);
  });

  it("returns presence on the owner chat state", async () => {
    const store = new MemoryStore();
    const owner = await store.insertAgent({
      name: "owner",
      description: "",
      tokenHash: hashToken(mintToken()),
      isHuman: true,
    });
    await store.setStatus(owner.id, "away", "at lunch");
    await store.insertAgent({
      name: "codex",
      description: "",
      tokenHash: hashToken(mintToken()),
      isHuman: false,
    });
    const app = createApp({
      store,
      config: loadConfig({ OWNER_NAME: "owner" }),
      env: { OWNER_PASSWORD: PASSWORD },
    });
    const cookie = `ab_session=${signSession("owner", PASSWORD)}`;
    const response = await app.request("/chat/api/state", { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      owner: { presence: string; statusText: string; lastSeenAt: string | null };
      agents: Array<{ name: string; presence: string; statusText: string; lastSeenAt: string | null }>;
    };
    expect(body.owner.presence).toBe("away");
    expect(body.owner.statusText).toBe("at lunch");
    expect(body.owner.lastSeenAt).toBeTruthy();
    const codex = body.agents.find((agent) => agent.name === "codex");
    expect(codex?.presence).toBe("available");
    expect(codex?.statusText).toBe("");
    expect(codex?.lastSeenAt).toBeNull();
  });
});
