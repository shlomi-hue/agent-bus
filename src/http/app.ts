import { fontInter, fontJetbrains } from "../generated/chat-assets.js";
import { chatContentSecurityPolicy } from "./chat-page.js";
import { createMcpHandler } from "mcp-handler";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { hashToken, parseBearer, bearerMatches } from "../auth/tokens.js";
import type { Caller } from "../bus/service.js";
import { dispatchDue } from "../wake/deliver.js";
import { createAgentBus } from "../wake/hook.js";
import { loadConfig, type AppConfig } from "../config.js";
import { createStoreFromEnv } from "../db/create-store.js";
import type { Store } from "../db/types.js";
import { registerTools, SERVER_INSTRUCTIONS } from "../mcp/tools.js";
import { mountChat } from "./chat.js";
import { homePage } from "./home.js";

export type CreateAppOptions = {
  store?: Store;
  config?: AppConfig;
  env?: NodeJS.ProcessEnv;
};

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: "unauthorized",
      message: "A valid agent bearer token is required.",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="agent-bus"',
        "cache-control": "no-store",
      },
    },
  );
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig(env);
  let storePromise: Promise<Store> | undefined = options.store
    ? Promise.resolve(options.store)
    : undefined;

  function getStore(): Promise<Store> {
    if (!storePromise) storePromise = Promise.resolve(createStoreFromEnv(env));
    return storePromise;
  }

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    const path = new URL(c.req.url).pathname;
    if (path === "/chat" || path.startsWith("/chat/")) {
      c.header("content-security-policy", chatContentSecurityPolicy());
    }
  });

  app.get("/", (c) => c.html(homePage()));
  app.get("/favicon.ico", (c) => c.body(null, 204));

  app.get("/chat/fonts/:file", (c) => {
    const file = c.req.param("file");
    if (file !== "inter.woff2" && file !== "jetbrains-mono.woff2") {
      return c.json({ error: "not_found" }, 404);
    }
    const encoded = file === "inter.woff2" ? fontInter : fontJetbrains;
    const bytes = Buffer.from(encoded, "base64");
    return c.body(bytes, 200, {
      "content-type": "font/woff2",
      "cache-control": "public, max-age=86400",
    });
  });

  app.on(["GET", "HEAD"], "/health", async (c) => {
    try {
      await (await getStore()).ping();
      return c.json({ ok: true, service: "agent-bus", database: "up" });
    } catch (error) {
      const unconfigured = error instanceof Error && error.message.startsWith("Set DATABASE_URL");
      return c.json(
        {
          ok: false,
          service: "agent-bus",
          database: unconfigured ? "unconfigured" : "down",
        },
        503,
      );
    }
  });

  app.get("/api/cron/keep-warm", async (c) => {
    const secret = env.CRON_SECRET;
    if (!bearerMatches(c.req.header("authorization"), secret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    try {
      const store = await getStore();
      await store.ping();
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const pruned = await store.pruneRateEvents(cutoff);
      let deliveries = { delivered: 0, failed: 0 };
      try {
        deliveries = await dispatchDue(store, {
          ownerNotifyUrl: env.OWNER_NOTIFY_URL,
          ownerNotifySecret: env.OWNER_NOTIFY_SECRET,
        });
      } catch (error) {
        console.error("wake drain failed", error instanceof Error ? error.name : "unknown");
      }
      return c.json({ ok: true, pruned, deliveries });
    } catch (error) {
      console.error("keep-warm failed", error instanceof Error ? error.name : "unknown");
      return c.json({ ok: false }, 503);
    }
  });

  app.use("/mcp", bodyLimit({ maxSize: 256 * 1024 }));

  app.all("/mcp", async (c) => {
    let store: Store;
    try {
      store = await getStore();
    } catch (error) {
      console.error("store unavailable", error instanceof Error ? error.name : "unknown");
      return c.json({ error: "unavailable" }, 503);
    }
    const token = parseBearer(c.req.header("authorization"));
    if (!token) return unauthorized();
    const agent = await store.findAgentByTokenHash(hashToken(token));
    if (!agent) return unauthorized();
    try {
      await store.touchLastSeen(agent.id);
    } catch (error) {
      console.error("last_seen update failed", error instanceof Error ? error.name : "unknown");
    }
    const bus = createAgentBus(store, config, env);
    const caller: Caller = { id: agent.id, name: agent.name, isHuman: agent.isHuman };
    const mcp = createMcpHandler(
      (server) => {
        registerTools(server, bus, caller, config);
      },
      {
        serverInfo: { name: "agent-bus", version: "1.0.0" },
        instructions: SERVER_INSTRUCTIONS,
      },
    );
    try {
      return await mcp(c.req.raw);
    } catch (error) {
      console.error("mcp request failed", error instanceof Error ? error.name : "unknown");
      return c.json({ error: "internal_error" }, 500);
    }
  });

  mountChat(app, { getStore, config, env });

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
