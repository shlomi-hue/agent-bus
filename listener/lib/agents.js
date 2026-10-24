import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

/**
 * Exact argv construction for the headless CLIs. The prompt is passed on stdin ("-" for codex,
 * implicit for `claude -p`), so message bodies never show up in `ps` and argv size is not a concern.
 *
 * codex (verified against codex-cli 0.163.0 `codex exec --help` / `codex exec resume --help`):
 *   new:    codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -C <ws> [-m M] [extra] -o <last.txt> -
 *   resume: codex exec -C <ws> resume --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox [-m M] [extra] -o <last.txt> <SESSION_ID> -
 *   (`resume` has no -C of its own, so -C goes on `exec` before the subcommand.)
 *   Session id: first JSONL event {"type":"thread.started","thread_id":"<uuid>"}.
 *
 * claude (verified against https://code.claude.com/docs/en/headless,
 * https://code.claude.com/docs/en/cli-reference, and https://code.claude.com/docs/en/permission-modes):
 *   print:    -p / --print. The prompt is stdin. There is no --cwd flag on `claude -p`;
 *             the process working directory is the session directory. --add-dir only adds extra dirs.
 *   output:   --output-format json  (one object: result, session_id, metadata).
 *             stream-json is newline-delimited and, for token deltas, also needs --verbose
 *             and --include-partial-messages. The listener uses json.
 *   safe:     --permission-mode dontAsk --permission-prompts none --allowedTools "A,B,C"
 *             (--permission-prompts requires Claude Code v2.1.259+)
 *             Bash is included only when agents.claude.allowBash is true.
 *   full:     --dangerously-skip-permissions  ONLY when dangerouslySkipPermissions is true.
 *             The CLI documents that flag as equivalent to --permission-mode bypassPermissions.
 *   mcp:      --strict-mcp-config --mcp-config <file>   (HTTP server, bearer header, mode 0600)
 *   model:    --model <alias or full id>
 *   turns:    --max-turns <n>   (print mode only; omitted when unset; no limit is the CLI default)
 *   session:  --session-id <uuid> | --resume <id>
 *   auth:     `claude auth status` exits 0 when logged in and 1 when not. JSON authMethod "none" means logged out.
 *   new:    claude -p --output-format json --permission-mode dontAsk --permission-prompts none
 *             --allowedTools "<list>" --strict-mcp-config --mcp-config <file> [--model M] [--max-turns N] [extra] --session-id <uuid>
 *   resume: the same, with --resume <SESSION_ID> instead of --session-id
 *   Session id: "session_id" on the JSON result (and on stream-json events).
 */

export function buildCodexCommand({ agent, workspace, sessionId = null, lastMessageFile }) {
  const common = ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"];
  const model = agent.model ? ["-m", String(agent.model)] : [];
  const out = lastMessageFile ? ["-o", lastMessageFile] : [];
  if (sessionId) {
    return { bin: agent.bin, args: ["exec", "-C", workspace, "resume", ...common, ...model, ...agent.extraArgs, ...out, sessionId, "-"] };
  }
  return { bin: agent.bin, args: ["exec", ...common, "-C", workspace, ...model, ...agent.extraArgs, ...out, "-"] };
}

/**
 * Effective --allowedTools list. Bare Bash and Bash(*) are omitted unless allowBash is true,
 * then Bash is appended once. Narrower rules such as Bash(git status *) stay as written.
 */
export function claudeAllowedTools(agent) {
  const tools = Array.isArray(agent.allowedTools) ? agent.allowedTools.map(String).filter(Boolean) : [];
  const withoutBareBash = tools.filter((tool) => tool !== "Bash" && tool !== "Bash(*)");
  if (agent.allowBash === true) return [...withoutBareBash, "Bash"];
  return withoutBareBash;
}

/**
 * Argv for one headless Claude Code run.
 * Working directory is not an argv flag: the caller sets the child cwd to the workspace.
 */
export function buildClaudeCommand({ agent, sessionId = null, newSessionId = null, mcpConfigPath }) {
  const args = ["-p", "--output-format", "json"];
  if (agent.dangerouslySkipPermissions === true) {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", agent.permissionMode || "dontAsk", "--permission-prompts", "none");
    const tools = claudeAllowedTools(agent);
    if (tools.length) args.push("--allowedTools", tools.join(","));
  }
  args.push("--strict-mcp-config");
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  if (agent.model) args.push("--model", String(agent.model));
  if (agent.maxTurns) args.push("--max-turns", String(agent.maxTurns));
  args.push(...(agent.extraArgs ?? []));
  if (sessionId) args.push("--resume", sessionId);
  else if (newSessionId) args.push("--session-id", newSessionId);
  return { bin: agent.bin, args };
}

const ID_KEYS = ["thread_id", "threadId", "session_id", "sessionId", "conversation_id", "conversationId"];
const UUIDISH = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function findId(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return null;
  for (const k of ID_KEYS) {
    if (typeof obj[k] === "string" && obj[k]) return obj[k];
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findId(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function parseJsonLines(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* not JSON */
    }
  }
  return out;
}

/**
 * Session id from `codex exec --json`. Current shape is {"type":"thread.started","thread_id":...};
 * older builds emitted session_configured / session.created with session_id. Be defensive.
 */
export function extractCodexSessionId(stdout) {
  const events = parseJsonLines(stdout);
  const preferred = events.find((e) => e.type === "thread.started" && typeof e.thread_id === "string");
  if (preferred) return preferred.thread_id;
  for (const e of events) {
    const type = String(e.type ?? e.msg?.type ?? "");
    if (/session|thread/i.test(type)) {
      const id = findId(e);
      if (id && UUIDISH.test(id)) return id;
    }
  }
  return null;
}

export function extractClaudeSessionId(stdout) {
  const events = parseJsonLines(stdout);
  for (let i = events.length - 1; i >= 0; i--) {
    const id = events[i].session_id ?? events[i].sessionId;
    if (typeof id === "string" && id) return id;
  }
  // --output-format json may be pretty-printed on one object spanning lines
  try {
    const whole = JSON.parse(String(stdout).trim());
    if (typeof whole?.session_id === "string") return whole.session_id;
  } catch {
    /* ignore */
  }
  return null;
}

/** Did a run actually start doing work (vs. failing at startup)? */
export function codexTurnStarted(stdout) {
  return parseJsonLines(stdout).some((e) => e.type === "turn.started" || e.type === "thread.started");
}

/**
 * A resume attempt failed in a way that a fresh session would fix (unknown/expired session).
 * Codex: exits 1 with "thread/resume failed: no rollout found for thread id ..." and no events.
 * Claude: exits 1 with "No conversation found with session ID: ...".
 */
export function isResumeFailure(cli, result) {
  if (result.timedOut || result.aborted) return false;
  if (result.code === 0) return false;
  const text = `${result.stderr}\n${result.stdout}`;
  if (cli === "codex") {
    if (/no rollout found|thread\/resume|session not found|thread not found|could not find (session|thread)/i.test(text)) return true;
    return !codexTurnStarted(result.stdout) && /resume/i.test(text);
  }
  if (cli === "claude") {
    return /No conversation found|session .*not found|Invalid session/i.test(text);
  }
  return false;
}

export function claudeResult(stdout) {
  const events = parseJsonLines(stdout);
  const result = [...events].reverse().find((e) => e.type === "result");
  if (result) return result;
  try {
    return JSON.parse(String(stdout).trim());
  } catch {
    return null;
  }
}

/**
 * --output-format json is one object with `result` and `session_id`.
 * stream-json ends with a `type: "result"` event (`subtype: "success"` or an error subtype).
 * A non-object, or an object that is neither shape, is a parse failure.
 */
export function assessClaudeResult(stdout) {
  const result = claudeResult(stdout);
  if (!result || typeof result !== "object" || Array.isArray(result)) return { ok: false, reason: "json-parse", result: null };
  if (result.is_error === true) return { ok: false, reason: "is_error", result };
  if (typeof result.subtype === "string" && result.subtype !== "success") return { ok: false, reason: result.subtype, result };
  if (result.type === "result" || Object.prototype.hasOwnProperty.call(result, "result") || typeof result.session_id === "string") {
    return { ok: true, reason: "ok", result };
  }
  return { ok: false, reason: "json-shape", result };
}

function parseAuthJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* a banner line may precede the object */
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      return JSON.parse(t);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * `claude auth status` (https://code.claude.com/docs/en/cli-reference).
 * Exit 0 means logged in. Exit 1 means not. authMethod "none" is logged out even if the status is odd.
 * The returned detail never includes stdout, stderr, or tokens.
 */
export function readClaudeAuth(bin, { env = process.env, timeoutMs = 20_000 } = {}) {
  const r = spawnSync(bin, ["auth", "status"], { encoding: "utf8", timeout: timeoutMs, env });
  if (r.error) {
    const timedOut = r.error.code === "ETIMEDOUT";
    return { loggedIn: false, authMethod: null, status: r.status ?? null, detail: timedOut ? "claude auth status timed out" : "claude auth status failed to start" };
  }
  const parsed = parseAuthJson(r.stdout) ?? parseAuthJson(r.stderr);
  const authMethod = typeof parsed?.authMethod === "string" ? parsed.authMethod : null;
  const loggedIn = r.status === 0 && authMethod !== "none";
  let detail;
  if (loggedIn) detail = `logged in${authMethod ? ` (${authMethod})` : ""}`;
  else if (r.status === 1 || authMethod === "none") detail = "not logged in. Run `claude auth login` once; headless -p runs reuse that login";
  else detail = `claude auth status exited ${r.status ?? "null"}`;
  return { loggedIn, authMethod, status: r.status ?? null, detail };
}

/** Write the per-run Claude MCP config (0600) and return its path. Token is never logged. */
export function writeClaudeMcpConfig({ runDir, serverName = "agent_bus", url, token }) {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const file = path.join(runDir, `claude-mcp-${process.pid}-${randomUUID()}.json`);
  const config = { mcpServers: { [serverName]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return file;
}

export function newClaudeSessionId() {
  return randomUUID();
}
