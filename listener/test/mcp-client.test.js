import { test } from "node:test";
import assert from "node:assert/strict";
import { McpClient, McpError, parseSse, extractRpcResponse } from "../lib/mcp-client.js";
import { MockAgentBus } from "./fixtures/mock-agent-bus.js";

test("parseSse handles comments, multi-line data, CRLF", () => {
  const ev = parseSse(': ping\r\n\r\nevent: message\r\ndata: {"a":\r\ndata: 1}\r\nid: 7\r\n\r\n');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data, '{"a":\n1}');
  assert.equal(ev[0].id, "7");
});

test("extractRpcResponse picks the matching id from SSE with notifications", () => {
  const body = `data: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\ndata: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\n\n`;
  assert.deepEqual(extractRpcResponse(body, "text/event-stream", 4).result, { ok: true });
  assert.throws(() => extractRpcResponse(body, "text/event-stream", 5), McpError);
  assert.deepEqual(extractRpcResponse('[{"jsonrpc":"2.0","id":2,"result":1}]', "application/json", 2).result, 1);
});

for (const sse of [true, false]) {
  test(`initialize + tools/list + tools/call over ${sse ? "SSE" : "JSON"}`, async (t) => {
    const bus = new MockAgentBus({ sse });
    const url = await bus.listen();
    t.after(() => bus.close());
    const c = new McpClient({ url, token: bus.tokens.grok });
    await c.initialize();
    assert.equal(c.protocolVersion, "2025-06-18");
    assert.ok(c.lastServerDate);
    const tools = await c.listTools();
    assert.ok(tools.some((x) => x.name === "wait_for_messages"));
    const text = await c.callTool("list_rooms", {});
    assert.match(text, /general/);
  });
}

test("stateful server: Mcp-Session-Id is captured, echoed, and re-initialized after 404", async (t) => {
  const bus = new MockAgentBus({ stateful: true });
  const url = await bus.listen();
  t.after(() => bus.close());
  const c = new McpClient({ url, token: bus.tokens.grok });
  await c.initialize();
  const first = c.sessionId;
  assert.ok(first);
  await c.callTool("list_rooms", {});
  bus.sessions.clear(); // server forgets the session
  const text = await c.callTool("list_rooms", {});
  assert.match(text, /general/);
  assert.notEqual(c.sessionId, first);
});

test("tool errors, rate limit and auth errors are classified", async (t) => {
  const bus = new MockAgentBus();
  const url = await bus.listen();
  t.after(() => bus.close());
  const c = new McpClient({ url, token: bus.tokens.grok });
  await c.initialize();
  bus.failNext.push({ toolError: "Rate limit exceeded: 30 requests per 60 seconds." });
  await assert.rejects(c.callTool("list_rooms", {}), (e) => e.kind === "rate_limited" && e.retryable);
  await assert.rejects(c.callTool("nope", {}), (e) => e.kind === "tool");
  bus.failNext.push({ status: 503 });
  await assert.rejects(c.callTool("list_rooms", {}), (e) => e.kind === "http" && e.retryable);
  const bad = new McpClient({ url, token: "wrong-token-xxxxxxxx" });
  await assert.rejects(bad.initialize(), (e) => e.kind === "auth" && !String(e.message).includes("wrong-token"));
});

test("network errors are retryable; abort signal cancels a long-poll", async (t) => {
  const c = new McpClient({ url: "http://127.0.0.1:9/mcp", token: "x".repeat(20) });
  await assert.rejects(c.initialize({ timeoutMs: 2000 }), (e) => e.kind === "network" || e.kind === "timeout");
  const bus = new MockAgentBus();
  const url = await bus.listen();
  t.after(() => bus.close());
  const c2 = new McpClient({ url, token: bus.tokens.grok });
  await c2.initialize();
  const ac = new AbortController();
  const p = c2.callTool("wait_for_messages", { since: new Date().toISOString(), timeout_seconds: 5 }, { signal: ac.signal, timeoutMs: 10000 });
  setTimeout(() => ac.abort(), 100);
  const t0 = Date.now();
  await assert.rejects(p);
  assert.ok(Date.now() - t0 < 2000);
});
