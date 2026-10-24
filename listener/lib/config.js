import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./util.js";

export const LISTENER_HOME_DEFAULT = "~/.agent-bus/listener";
export const LABEL = "com.agent-bus.listener";
export const CODEX_APP_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

/**
 * Claude Code --permission-mode values that are not a full bypass.
 * `bypassPermissions` is rejected unless agents.claude.dangerouslySkipPermissions is true
 * (that flag selects --dangerously-skip-permissions, which the CLI treats as the same mode).
 * https://code.claude.com/docs/en/cli-reference
 * https://code.claude.com/docs/en/permission-modes
 */
export const CLAUDE_PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "plan", "auto", "dontAsk", "manual"]);

/**
 * Default --allowedTools list for --permission-mode dontAsk.
 * Bash is not included. Set agents.claude.allowBash to add it.
 * `mcp__agent_bus__*` is the documented allow glob for every tool on the server named agent_bus.
 * https://code.claude.com/docs/en/permissions
 */
export const DEFAULT_CLAUDE_ALLOWED_TOOLS = Object.freeze(["Read", "Edit", "Write", "mcp__agent_bus__*"]);

export const DEFAULTS = Object.freeze({
  mcpUrl: "https://your-app.vercel.app/mcp",
  tokensFile: "~/.agent-bus/tokens.env",
  ownerNames: ["owner"],
  workspace: "~/agent-workspace",
  logDir: "~/.agent-bus/logs",
  stateFile: "~/.agent-bus/listener/state.json",
  pauseFile: "~/.agent-bus/listener/PAUSE",
  runDir: "~/.agent-bus/listener/run",
  /** PATH handed to the CLIs (launchd starts with a minimal PATH). */
  childPath: "",
  /** wait_for_messages timeout per call. The server caps it (WAIT_MAX_SECONDS, default 8). */
  waitSeconds: 8,
  /** Minimum gap between polls while a CLI run is active (keeps the server rate budget for the agent). */
  pollIntervalWhileRunningSeconds: 30,
  /** Minimum gap between two polls when the previous one returned immediately with nothing new. */
  minPollGapMs: 1000,
  runTimeoutMinutes: 15,
  killGraceSeconds: 10,
  maxRunsPerHour: 20,
  /** Runs attempted for the same queued triggers before they are dropped (CLI crash / non-zero exit). */
  maxAttempts: 3,
  /** Consecutive runs in one thread that were triggered only by other agents, before the listener stops waking for that thread until the owner speaks. */
  maxAgentOnlyRunsPerThread: 5,
  /** Owner room posts without an @mention: "mention-only" | "reply-to-me" | "all". */
  ownerRoomPosts: "reply-to-me",
  /** Ignore agent-authored task status notices ("x set the task for y to working.") for open/working. */
  ignoreTaskStatusNotices: true,
  /** On restart after a long downtime, never look back further than this. */
  maxCatchupHours: 24,
  backoff: { initialMs: 2000, maxMs: 300000, factor: 2 },
  reconcile: { enabled: true, intervalSeconds: 300, graceSeconds: 600, windowHours: 6 },
  prompt: { maxBodyChars: 6000, maxItems: 25 },
  log: { maxBytes: 5 * 1024 * 1024, files: 3, keepRunLogs: 100, launchdMaxBytes: 5 * 1024 * 1024 },
  agents: {
    codex: {
      enabled: true,
      cli: "codex",
      bin: CODEX_APP_BIN,
      tokenEnv: "CODEX_TOKEN",
      model: null,
      extraArgs: [],
    },
    claude: {
      enabled: true,
      cli: "claude",
      bin: "claude",
      tokenEnv: "CLAUDE_TOKEN",
      model: null,
      /** Positive integer, or null to omit --max-turns (Claude Code's own default: no limit). */
      maxTurns: null,
      /** Safe headless mode. Full bypass is dangerouslySkipPermissions, not this field. */
      permissionMode: "dontAsk",
      allowedTools: [...DEFAULT_CLAUDE_ALLOWED_TOOLS],
      /** When true, the effective allowlist includes Bash. A "Bash" entry in allowedTools is ignored unless this is true. */
      allowBash: false,
      /** When true, the runner passes --dangerously-skip-permissions and ignores the allowlist. */
      dangerouslySkipPermissions: false,
      mcpServerName: "agent_bus",
      extraArgs: [],
    },
  },
});

export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? structuredClone(base) : over;
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Locate config.json: explicit path, $AGENT_BUS_LISTENER_CONFIG, next to the package, or ~/.agent-bus/listener. */
export function findConfigFile(explicit) {
  const candidates = [
    explicit,
    process.env.AGENT_BUS_LISTENER_CONFIG,
    path.join(packageRoot(), "config.json"),
    expandHome(`${LISTENER_HOME_DEFAULT}/config.json`),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function loadConfig({ file, overrides = {}, home = os.homedir() } = {}) {
  const configFile = file === undefined ? findConfigFile() : file;
  let fromFile = {};
  if (configFile) {
    const raw = fs.readFileSync(configFile, "utf8");
    try {
      fromFile = JSON.parse(raw);
    } catch (error) {
      throw new Error(`config.json is not valid JSON (${configFile}): ${error.message}`);
    }
  }
  const merged = deepMerge(deepMerge(DEFAULTS, fromFile), overrides);
  return normalizeConfig(merged, { home, configFile });
}

export function normalizeConfig(cfg, { home = os.homedir(), configFile = null } = {}) {
  const out = structuredClone(cfg);
  for (const key of ["tokensFile", "workspace", "logDir", "stateFile", "pauseFile", "runDir"]) {
    out[key] = expandHome(out[key], home);
  }
  out.configFile = configFile;
  if (!Array.isArray(out.ownerNames) || out.ownerNames.length === 0) out.ownerNames = ["owner"];
  if (!["mention-only", "reply-to-me", "all"].includes(out.ownerRoomPosts)) out.ownerRoomPosts = "reply-to-me";
  for (const [name, agent] of Object.entries(out.agents ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`invalid agent name in config: ${name}`);
    agent.name = name;
    if (agent.bin) agent.bin = expandHome(agent.bin, home);
    agent.extraArgs = Array.isArray(agent.extraArgs) ? agent.extraArgs.map(String) : [];
    if (!["codex", "claude", "none"].includes(agent.cli)) throw new Error(`agent ${name}: cli must be codex, claude or none`);
    if (agent.cli === "claude") normalizeClaudeAgent(name, agent);
  }
  out.waitSeconds = clampInt(out.waitSeconds, 1, 20, 8);
  return out;
}

function normalizeClaudeAgent(name, agent) {
  agent.dangerouslySkipPermissions = agent.dangerouslySkipPermissions === true;
  agent.allowBash = agent.allowBash === true;
  agent.mcpServerName = agent.mcpServerName || "agent_bus";
  if (!/^[A-Za-z0-9_-]+$/.test(agent.mcpServerName)) {
    throw new Error(`agent ${name}: mcpServerName must be letters, numbers, underscore, or hyphen`);
  }
  if (agent.maxTurns == null || agent.maxTurns === "") agent.maxTurns = null;
  else {
    const n = Number(agent.maxTurns);
    if (!Number.isInteger(n) || n < 1) throw new Error(`agent ${name}: maxTurns must be a positive integer or null`);
    agent.maxTurns = n;
  }
  agent.allowedTools = Array.isArray(agent.allowedTools) ? agent.allowedTools.map(String) : [...DEFAULT_CLAUDE_ALLOWED_TOOLS];
  for (const tool of agent.allowedTools) {
    if (tool.includes(",")) throw new Error(`agent ${name}: allowedTools entries cannot contain commas (${tool})`);
  }
  if (agent.dangerouslySkipPermissions) return;
  const mode = agent.permissionMode || "dontAsk";
  if (mode === "bypassPermissions") {
    throw new Error(`agent ${name}: permissionMode "bypassPermissions" requires dangerouslySkipPermissions: true`);
  }
  if (!CLAUDE_PERMISSION_MODES.includes(mode)) {
    throw new Error(`agent ${name}: permissionMode must be one of ${CLAUDE_PERMISSION_MODES.join(", ")}`);
  }
  agent.permissionMode = mode;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Parse KEY=value lines (optional `export `, quotes, # comments). Never logs values. */
export function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function envFlag(env, key) {
  return env?.[key] === "1";
}

/** First install: example config plus detected paths. Claude stays enabled so a later install of the CLI is picked up. */
export function freshConfig(example, env) {
  const cfg = structuredClone(example);
  cfg.workspace = env.WORKSPACE;
  cfg.childPath = env.CHILD_PATH;
  cfg.agents.codex.bin = env.CODEX_BIN;
  cfg.agents.claude.bin = envFlag(env, "CLAUDE_FOUND") && env.CLAUDE_BIN ? env.CLAUDE_BIN : "claude";
  cfg.agents.claude.enabled = true;
  cfg.agents.claude.dangerouslySkipPermissions = false;
  return cfg;
}

/**
 * Rebuild from the example, then put the previous Codex agent object back.
 * Claude permission choices (allowlist, model, bypass flag) are kept; the bin is refreshed when Claude was found.
 */
export function reconfigurePreservingCodex(prev, example, env) {
  const cfg = freshConfig(example, env);
  if (prev?.agents?.codex) {
    cfg.agents.codex = structuredClone(prev.agents.codex);
    if (envFlag(env, "CODEX_EXPLICIT") && env.CODEX_BIN) cfg.agents.codex.bin = env.CODEX_BIN;
  }
  if (prev?.agents?.claude) {
    const keep = ["model", "extraArgs", "allowedTools", "allowBash", "permissionMode", "dangerouslySkipPermissions", "maxTurns", "enabled", "mcpServerName", "tokenEnv"];
    for (const key of keep) {
      if (prev.agents.claude[key] !== undefined) cfg.agents.claude[key] = structuredClone(prev.agents.claude[key]);
    }
  }
  if (envFlag(env, "CLAUDE_EXPLICIT") && envFlag(env, "CLAUDE_FOUND") && env.CLAUDE_BIN) cfg.agents.claude.bin = env.CLAUDE_BIN;
  return cfg;
}

/** Turn Claude on without touching the Codex agent object. */
export function enableClaudeAgent(prev, example, env) {
  const cfg = structuredClone(prev ?? example);
  const prevCodex = cfg.agents?.codex ? structuredClone(cfg.agents.codex) : structuredClone(example.agents.codex);
  const prevClaude = cfg.agents?.claude ? structuredClone(cfg.agents.claude) : {};
  const base = structuredClone(example.agents.claude);
  const found = envFlag(env, "CLAUDE_FOUND") && env.CLAUDE_BIN;
  cfg.agents = { ...(cfg.agents ?? {}) };
  cfg.agents.codex = prevCodex;
  cfg.agents.claude = {
    ...base,
    ...prevClaude,
    enabled: true,
    bin: found ? env.CLAUDE_BIN : prevClaude.bin || base.bin || "claude",
  };
  if (found) {
    const dir = env.CLAUDE_BIN.slice(0, env.CLAUDE_BIN.lastIndexOf("/"));
    if (dir && typeof cfg.childPath === "string" && !cfg.childPath.split(":").includes(dir)) {
      cfg.childPath = `${dir}:${cfg.childPath}`;
    }
  }
  return cfg;
}

/** Turn Claude off. Codex is copied through unchanged. */
export function disableClaudeAgent(prev, example) {
  const cfg = structuredClone(prev ?? example);
  const prevCodex = cfg.agents?.codex ? structuredClone(cfg.agents.codex) : structuredClone(example.agents.codex);
  const prevClaude = cfg.agents?.claude ? structuredClone(cfg.agents.claude) : structuredClone(example.agents.claude);
  cfg.agents = { ...(cfg.agents ?? {}), codex: prevCodex, claude: { ...prevClaude, enabled: false } };
  return cfg;
}

/**
 * Durable MCP document for interactive `claude` sessions.
 * The token is an env reference, never a literal. `.mcp.json` expands ${CLAUDE_TOKEN}.
 * https://code.claude.com/docs/en/mcp
 */
export function claudeMcpTemplate({ url, serverName = "agent_bus" }) {
  return {
    mcpServers: {
      [serverName]: {
        type: "http",
        url,
        headers: { Authorization: "Bearer ${CLAUDE_TOKEN}" },
      },
    },
  };
}

export function loadTokens(file) {
  try {
    return parseEnvFile(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
