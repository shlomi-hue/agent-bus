import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
 * claude (verified against Claude Code 2.1.197 `claude --help`):
 *   new:    claude -p --output-format json --dangerously-skip-permissions --mcp-config <file> [--model M] [extra] --session-id <uuid>
 *   resume: claude -p --output-format json --dangerously-skip-permissions --mcp-config <file> [--model M] [extra] --resume <SESSION_ID>
 *   Session id: "session_id" in the final JSON result.
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

export function buildClaudeCommand({ agent, sessionId = null, newSessionId = null, mcpConfigPath }) {
  const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  if (agent.model) args.push("--model", String(agent.model));
  args.push(...agent.extraArgs);
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
