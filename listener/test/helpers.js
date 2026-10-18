import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeConfig, deepMerge, DEFAULTS } from "../lib/config.js";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function tmpdir(prefix = "abl-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testConfig(dir, overrides = {}) {
  const base = {
    mcpUrl: "http://127.0.0.1:1/mcp",
    tokensFile: path.join(dir, "tokens.env"),
    workspace: path.join(dir, "ws"),
    logDir: path.join(dir, "logs"),
    stateFile: path.join(dir, "state.json"),
    pauseFile: path.join(dir, "PAUSE"),
    runDir: path.join(dir, "run"),
    waitSeconds: 1,
    pollIntervalWhileRunningSeconds: 1,
    minPollGapMs: 50,
    killGraceSeconds: 1,
    backoff: { initialMs: 50, maxMs: 500, factor: 2 },
    reconcile: { enabled: false },
    agents: {
      codex: { enabled: true, cli: "codex", bin: path.join(FIXTURES, "fake-codex.sh"), tokenEnv: "CODEX_TOKEN" },
      claude: { enabled: true, cli: "claude", bin: path.join(FIXTURES, "fake-claude.sh"), tokenEnv: "CLAUDE_TOKEN" },
    },
  };
  return normalizeConfig(deepMerge(deepMerge(DEFAULTS, base), overrides));
}

export async function waitFor(fn, { timeout = 10000, interval = 25, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Parse the fake CLI argv log into an array of argv arrays. */
export function readArgvLog(file) {
  if (!fs.existsSync(file)) return [];
  const runs = [];
  let cur = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line === "ARGV") cur = [];
    else if (line === "END" && cur) {
      runs.push(cur);
      cur = null;
    } else if (cur) cur.push(line);
  }
  return runs;
}

export function memLog() {
  const lines = [];
  const mk = (lvl) => (m, e) => lines.push(`${lvl} ${m}${e ? ` ${JSON.stringify(e)}` : ""}`);
  return { lines, debug: mk("debug"), info: mk("info"), warn: mk("warn"), error: mk("error"), redact: (s) => s };
}
