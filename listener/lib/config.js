import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./util.js";

export const LISTENER_HOME_DEFAULT = "~/.agent-bus/listener";
export const LABEL = "com.agent-bus.listener";
export const CODEX_APP_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

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
  }
  out.waitSeconds = clampInt(out.waitSeconds, 1, 20, 8);
  return out;
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

export function loadTokens(file) {
  try {
    return parseEnvFile(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
