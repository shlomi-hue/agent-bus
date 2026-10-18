import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { hashToken, mintToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/db/memory-store.js";
import { createApp } from "../src/http/app.js";
import { signSession } from "../src/http/session.js";

const PASSWORD = "owner-password-value";

async function harness() {
  const store = new MemoryStore();
  const owner = await store.insertAgent({
    name: "owner",
    description: "Human owner of this bus",
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
  const app = createApp({
    store,
    config: loadConfig({ OWNER_NAME: "owner", RATE_LIMIT_MAX: "100" }),
    env: { OWNER_PASSWORD: PASSWORD, CRON_SECRET: "cron-secret-value" },
  });
  return { app, store, owner, codex, room };
}

function cookiePair(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  return header.split(";")[0] ?? "";
}

async function login(app: ReturnType<typeof createApp>, password: string) {
  return app.request("/chat/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }).toString(),
  });
}

describe("owner chat", () => {
  it("serves the prebuilt chat bundle", async () => {
    const built = await readFile(new URL("../dist/chat/app.js", import.meta.url), "utf8");
    expect(built.length).toBeGreaterThan(1000);
    expect(built).toContain("ab-seen:");

    const store = new MemoryStore();
    const app = createApp({ store, config: loadConfig({}), env: {} });
    const response = await app.request("/chat/app.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(await response.text()).toBe(built);
  });

  it("hides the form until OWNER_PASSWORD is set", async () => {
    const store = new MemoryStore();
    const app = createApp({ store, config: loadConfig({}), env: {} });
    const page = await app.request("/chat");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Chat is not configured");
    const posted = await login(app, PASSWORD);
    expect(posted.status).toBe(503);
  });

  it("rejects a wrong password and a forged session", async () => {
    const { app } = await harness();
    const wrong = await login(app, "not-the-password");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await wrong.text()).toContain("does not match");

    const state = await app.request("/chat/api/state");
    expect(state.status).toBe(401);

    const forged = signSession("owner", "different-password-value");
    const rejected = await app.request("/chat/api/state", {
      headers: { cookie: `ab_session=${forged}` },
    });
    expect(rejected.status).toBe(401);

    const other = signSession("codex", PASSWORD);
    const mismatched = await app.request("/chat/api/messages?room=general", {
      headers: { cookie: `ab_session=${other}` },
    });
    expect(mismatched.status).toBe(401);
  });

  it("signs the owner in with an httpOnly cookie and posts as the human", async () => {
    const { app, store, codex } = await harness();
    const signed = await login(app, PASSWORD);
    expect(signed.status).toBe(303);
    expect(signed.headers.get("location")).toBe("/chat");
    const setCookie = signed.headers.get("set-cookie") ?? "";
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    expect(setCookie).not.toContain(PASSWORD);
    const cookie = cookiePair(signed);

    const page = await app.request("/chat", { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Write a message");
    expect(html).not.toContain(PASSWORD);

    const rooms = await app.request("/chat/api/state", { headers: { cookie } });
    expect(rooms.status).toBe(200);
    const state = (await rooms.json()) as {
      rooms: Array<{ name: string; members: Array<{ name: string }> }>;
      owner: { name: string };
      roomAgentCap: number;
    };
    expect(state.owner.name).toBe("owner");
    expect(state.roomAgentCap).toBeGreaterThan(0);
    expect(state.rooms.map((room) => room.name)).toContain("general");
    expect(state.rooms.find((room) => room.name === "general")?.members.map((member) => member.name)).toContain(
      "owner",
    );

    await store.createRoom("secret");
    const forbidden = await app.request("/chat/api/messages?room=secret", { headers: { cookie } });
    expect(forbidden.status).toBe(403);
    const forbiddenPost = await app.request("/chat/api/messages", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ room: "secret", body: "nope" }),
    });
    expect(forbiddenPost.status).toBe(403);

    const posted = await app.request("/chat/api/messages", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ room: "general", body: "hello from the owner" }),
    });
    expect(posted.status).toBe(201);
    const body = (await posted.json()) as { message: { fromName: string; fromIsHuman: boolean; body: string } };
    expect(body.message.fromName).toBe("owner");
    expect(body.message.fromIsHuman).toBe(true);
    expect(body.message.body).toBe("hello from the owner");

    const log = await app.request("/chat/api/messages?room=general", { headers: { cookie } });
    expect(log.status).toBe(200);
    const messages = (await log.json()) as { messages: Array<{ body: string }> };
    expect(messages.messages.map((message) => message.body)).toContain("hello from the owner");

    const dm = await app.request("/chat/api/messages", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ dm: "codex", body: "ping codex" }),
    });
    expect(dm.status).toBe(201);
    const thread = await app.request("/chat/api/messages?dm=codex", { headers: { cookie } });
    const direct = (await thread.json()) as { messages: Array<{ body: string; toName: string | null }> };
    expect(direct.messages.some((message) => message.body === "ping codex" && message.toName === "codex")).toBe(
      true,
    );
    expect(codex.name).toBe("codex");

    const gone = await app.request("/chat/logout", { method: "POST", headers: { cookie } });
    expect(gone.status).toBe(303);
    expect(gone.headers.get("set-cookie")?.toLowerCase()).toContain("max-age=0");
  });

  it("tells a signed-in password that the human row is missing", async () => {
    const store = new MemoryStore();
    const app = createApp({
      store,
      config: loadConfig({}),
      env: { OWNER_PASSWORD: PASSWORD },
    });
    const response = await login(app, PASSWORD);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("ensure-owner");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
