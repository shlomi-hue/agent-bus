/**
 * Minimal MCP Streamable HTTP client (JSON-RPC 2.0 over POST), zero dependencies.
 * Handles application/json and text/event-stream response bodies and the Mcp-Session-Id header.
 */

export const PROTOCOL_VERSION = "2025-06-18";

export class McpError extends Error {
  constructor(message, { kind = "protocol", status, retryable = false, code } = {}) {
    super(message);
    this.name = "McpError";
    this.kind = kind; // network | http | auth | protocol | rpc | tool | rate_limited | timeout
    this.status = status;
    this.retryable = retryable;
    this.code = code;
  }
}

/** Parse an SSE body into an array of {event, data, id} records. */
export function parseSse(text) {
  const events = [];
  const blocks = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split(/\n\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "message";
    let id;
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "event") event = value;
      else if (field === "id") id = value;
    }
    if (data.length > 0) events.push({ event, id, data: data.join("\n") });
  }
  return events;
}

/** Extract the JSON-RPC message answering `id` from a response body (JSON or SSE). */
export function extractRpcResponse(body, contentType, id) {
  const ct = (contentType ?? "").toLowerCase();
  let candidates = [];
  if (ct.includes("text/event-stream")) {
    for (const ev of parseSse(body)) {
      try {
        candidates.push(JSON.parse(ev.data));
      } catch {
        /* skip non-JSON keepalives */
      }
    }
  } else {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new McpError(`response is not JSON (content-type ${ct || "none"})`, { kind: "protocol", retryable: true });
    }
    candidates = Array.isArray(parsed) ? parsed : [parsed];
  }
  const flat = candidates.flatMap((c) => (Array.isArray(c) ? c : [c]));
  const match = flat.find((m) => m && m.jsonrpc === "2.0" && m.id === id && ("result" in m || "error" in m));
  if (!match) throw new McpError(`no JSON-RPC response with id ${id} in body`, { kind: "protocol", retryable: true });
  return match;
}

export function toolText(result) {
  return (result?.content ?? [])
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

export class McpClient {
  constructor({ url, token, clientName = "agent-bus-listener", clientVersion = "1.0.0", fetchImpl = globalThis.fetch, requestTimeoutMs = 30000 }) {
    if (!url) throw new Error("McpClient: url required");
    if (!token) throw new Error("McpClient: token required");
    this.url = url;
    this._token = token; // never logged
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.fetch = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sessionId = null;
    this.protocolVersion = null;
    this.initialized = false;
    this.serverInfo = null;
    this.instructions = null;
    this.lastServerDate = null;
    this._nextId = 1;
  }

  headers() {
    const h = {
      authorization: `Bearer ${this._token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    if (this.protocolVersion) h["mcp-protocol-version"] = this.protocolVersion;
    return h;
  }

  async _post(payload, { timeoutMs = this.requestTimeoutMs, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
    const onAbort = () => ctrl.abort(new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    let res;
    let body;
    try {
      res = await this.fetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify(payload), signal: ctrl.signal });
      body = await res.text();
    } catch (error) {
      const timedOut = ctrl.signal.aborted && !signal?.aborted;
      throw new McpError(timedOut ? `request timed out after ${timeoutMs} ms` : `network error: ${error?.cause?.code ?? error?.message ?? error}`, {
        kind: timedOut ? "timeout" : "network",
        retryable: !signal?.aborted,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    const date = res.headers.get("date");
    if (date && !Number.isNaN(Date.parse(date))) this.lastServerDate = new Date(Date.parse(date)).toISOString();
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 401 || res.status === 403) {
      throw new McpError(`authentication failed (HTTP ${res.status}); check the agent token`, { kind: "auth", status: res.status, retryable: true });
    }
    if (res.status === 404 && this.sessionId) {
      // Session expired on the server: caller should re-initialize.
      this.sessionId = null;
      this.initialized = false;
      throw new McpError("MCP session expired (HTTP 404)", { kind: "http", status: 404, retryable: true, code: "session_expired" });
    }
    if (res.status === 429) throw new McpError("HTTP 429 rate limited", { kind: "rate_limited", status: 429, retryable: true });
    if (res.status >= 500) throw new McpError(`server error HTTP ${res.status}`, { kind: "http", status: res.status, retryable: true });
    if (res.status === 202 || res.status === 204) return { status: res.status, body: "", contentType: "" };
    if (res.status < 200 || res.status >= 300) {
      throw new McpError(`unexpected HTTP ${res.status}: ${body.slice(0, 200)}`, { kind: "http", status: res.status, retryable: false });
    }
    return { status: res.status, body, contentType: res.headers.get("content-type") ?? "" };
  }

  async request(method, params, opts = {}) {
    const id = this._nextId++;
    const res = await this._post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, opts);
    if (!res.body) throw new McpError(`empty response to ${method}`, { kind: "protocol", retryable: true });
    const msg = extractRpcResponse(res.body, res.contentType, id);
    if (msg.error) {
      const notInit = /not initialized|session/i.test(msg.error.message ?? "");
      if (notInit) this.initialized = false;
      throw new McpError(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`, { kind: "rpc", code: msg.error.code, retryable: notInit });
    }
    return msg.result;
  }

  async notify(method, params, opts = {}) {
    await this._post({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, opts);
  }

  async initialize(opts = {}) {
    this.sessionId = null;
    this.protocolVersion = null;
    const result = await this.request(
      "initialize",
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: this.clientName, version: this.clientVersion } },
      opts,
    );
    this.protocolVersion = result?.protocolVersion ?? PROTOCOL_VERSION;
    this.serverInfo = result?.serverInfo ?? null;
    this.instructions = result?.instructions ?? null;
    try {
      await this.notify("notifications/initialized", undefined, opts);
    } catch (error) {
      if (!(error instanceof McpError) || error.kind === "auth") throw error;
      // Stateless servers may reject/ignore the notification; not fatal.
    }
    this.initialized = true;
    return result;
  }

  async ensureInitialized(opts) {
    if (!this.initialized) await this.initialize(opts);
  }

  async listTools(opts = {}) {
    await this.ensureInitialized(opts);
    const result = await this.request("tools/list", {}, opts);
    return result?.tools ?? [];
  }

  /**
   * Call a tool and return its text. Tool-level errors (isError) become McpError kind "tool"
   * (or "rate_limited" when the agent-bus rate limiter answered).
   */
  async callTool(name, args = {}, opts = {}) {
    await this.ensureInitialized(opts);
    let result;
    try {
      result = await this.request("tools/call", { name, arguments: args }, opts);
    } catch (error) {
      if (error instanceof McpError && (error.code === "session_expired" || (error.kind === "rpc" && error.retryable))) {
        await this.initialize(opts);
        result = await this.request("tools/call", { name, arguments: args }, opts);
      } else {
        throw error;
      }
    }
    const text = toolText(result);
    if (result?.isError) {
      const limited = /rate limit/i.test(text);
      throw new McpError(`tool ${name} failed: ${text.slice(0, 300)}`, { kind: limited ? "rate_limited" : "tool", retryable: limited });
    }
    return text;
  }

  /** Best-effort session close for stateful servers. */
  async close() {
    if (!this.sessionId) return;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      await this.fetch(this.url, { method: "DELETE", headers: this.headers(), signal: ctrl.signal }).catch(() => {});
      clearTimeout(t);
    } finally {
      this.sessionId = null;
      this.initialized = false;
    }
  }
}
