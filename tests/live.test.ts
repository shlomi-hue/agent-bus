import { describe, expect, it } from "vitest";
import { hashToken, mintToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/db/memory-store.js";
import { createApp } from "../src/http/app.js";
import { signSession } from "../src/http/session.js";
import { createAgentBus } from "../src/wake/hook.js";

const PASSWORD = "owner-password-value";

async function harness() {
  const store = new MemoryStore();
  const config = loadConfig({ OWNER_NAME: "owner", RATE_LIMIT_MAX: "100" });
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
  const app = createApp({
    store,
    config,
    env: {
      OWNER_PASSWORD: PASSWORD,
      OWNER_NAME: "owner",
      CHAT_SSE_MS: "250",
      CHAT_SSE_POLL_MS: "50",
    },
  });
  const cookie = `ab_session=${signSession("owner", PASSWORD)}`;
  return { store, config, app, owner, codex, cookie };
}

describe("live chat", () => {
  it("streams a bounded event when the log changes and falls closed without a session", async () => {
    const { app, cookie, config, store, owner } = await harness();
    const denied = await app.request("/chat/api/events");
    expect(denied.status).toBe(401);

    const idle = await app.request("/chat/api/events", { headers: { cookie } });
    expect(idle.headers.get("content-type")).toContain("text/event-stream");
    expect(await idle.text()).toContain("event: bye");

    const bus = createAgentBus(store, config, {});
    await bus.sendRoom({ id: owner.id, name: "owner", isHuman: true }, { room: "general", body: "@codex take a look" });
    const live = await app.request("/chat/api/events?since=%7C%7C", { headers: { cookie } });
    const body = await live.text();
    expect(body).toContain("event: update");
    expect(body).not.toContain("take a look");
  });

  it("lists mention tasks, posts a status, and never returns a webhook secret", async () => {
    const { app, cookie, store, codex } = await harness();
    const secret = "webhook-secret-value";
    const saved = await app.request("/chat/api/webhooks", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "codex", url: "https://example.com/hook", secret }),
    });
    expect(saved.status).toBe(200);
    const listed = await app.request("/chat/api/webhooks", { headers: { cookie } });
    const hooks = (await listed.json()) as { webhooks: Array<{ name: string; configured: boolean }> };
    expect(hooks.webhooks.find((hook) => hook.name === "codex")?.configured).toBe(true);
    expect(JSON.stringify(hooks)).not.toContain(secret);

    const posted = await app.request("/chat/api/messages", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ room: "general", body: "@codex please check the login" }),
    });
    expect(posted.status).toBe(201);
    const created = (await posted.json()) as { message: { tasks: Array<{ id: string; status: string }> } };
    expect(created.message.tasks[0]?.status).toBe("open");

    const tasks = await app.request("/chat/api/tasks?agent=codex&status=open", { headers: { cookie } });
    const body = (await tasks.json()) as { tasks: Array<{ id: string; assigneeName: string }> };
    expect(body.tasks).toHaveLength(1);
    const updated = await app.request(`/chat/api/tasks/${body.tasks[0]?.id}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ status: "working", result: "reading it" }),
    });
    expect(updated.status).toBe(200);
    const taskBody = (await updated.json()) as { task: { status: string }; posted: boolean };
    expect(taskBody.task.status).toBe("working");
    expect(taskBody.posted).toBe(true);
    expect((await store.getAgentById(codex.id))?.name).toBe("codex");

    const page = await app.request("/chat", { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain("Tasks");
    expect(html).toContain("Wake-ups");
  });
});
