import { serve } from "@hono/node-server";
import { loadDotEnv } from "./env.js";

loadDotEnv();

const { createApp } = await import("./http/app.js");

function portFrom(value: string | undefined): number {
  const port = Number(value ?? "43123");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return port;
}

const port = portFrom(process.env.PORT);
const hostname = process.env.HOST ?? "0.0.0.0";
const app = createApp();

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`agent-bus listening on http://127.0.0.1:${info.port}`);
  console.log(`MCP endpoint http://127.0.0.1:${info.port}/mcp`);
});
