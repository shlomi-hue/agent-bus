import fs from "node:fs";
import path from "node:path";

const VERSION = 1;
const MAX_SEEN = 5000;
const SEEN_TTL_MS = 14 * 24 * 3600_000;

/** Atomic JSON write: temp file + fsync + rename (+ dir fsync). */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(path.dirname(file), "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* directory fsync unsupported on some platforms */
  }
}

export function emptyAgentState() {
  return {
    cursor: null, // since for wait_for_messages (ISO)
    roomCursors: {}, // room -> ISO of last room message seen
    lastAgentSpeaker: {}, // room -> last non-owner author
    seen: {}, // message/trigger uid -> epoch ms
    taskStatus: {}, // task id -> last status seen
    sessions: {}, // session key -> { id, cli, createdAt, updatedAt, runs }
    queue: [], // persisted TriggerQueue entries
    runHistory: [], // run start epoch ms (rate limit)
    chain: {}, // session key -> consecutive agent-only runs
    lastRun: null,
    lastPollAt: null,
    lastReconcileAt: null,
    status: null,
  };
}

export class StateStore {
  constructor(file, { log } = {}) {
    this.file = file;
    this.log = log;
    this.data = { version: VERSION, updatedAt: null, agents: {} };
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object") {
        this.data = { version: VERSION, ...parsed };
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.file, backup);
        } catch {
          /* ignore */
        }
        this.log?.warn(`state file unreadable (${error.message}); moved aside to ${backup} and starting fresh`);
      }
    }
    return this;
  }

  agent(name) {
    if (!this.data.agents[name]) this.data.agents[name] = emptyAgentState();
    const a = this.data.agents[name];
    const fresh = emptyAgentState();
    for (const k of Object.keys(fresh)) if (a[k] === undefined) a[k] = fresh[k];
    return a;
  }

  save() {
    for (const a of Object.values(this.data.agents)) pruneSeen(a);
    this.data.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.file, this.data);
  }
}

export function pruneSeen(agentState, now = Date.now()) {
  const entries = Object.entries(agentState.seen ?? {}).filter(([, t]) => now - t < SEEN_TTL_MS);
  entries.sort((a, b) => b[1] - a[1]);
  agentState.seen = Object.fromEntries(entries.slice(0, MAX_SEEN));
  const tasks = Object.entries(agentState.taskStatus ?? {});
  if (tasks.length > MAX_SEEN) agentState.taskStatus = Object.fromEntries(tasks.slice(-MAX_SEEN));
}

/** Read-only peek used by `status` (no locking, tolerant). */
export function readStateFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
