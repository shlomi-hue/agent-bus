import fs from "node:fs";
import path from "node:path";

/**
 * Size-capped rotating file logger with secret redaction.
 * listener.log -> listener.log.1 -> ... -> listener.log.<files-1>
 */
export class Logger {
  constructor({ file, maxBytes = 5 * 1024 * 1024, files = 3, console: toConsole = false, secrets = [] } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.files = Math.max(1, files);
    this.toConsole = toConsole;
    this.secrets = new Set();
    for (const s of secrets) this.addSecret(s);
    if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  addSecret(value) {
    if (typeof value === "string" && value.length >= 8) this.secrets.add(value);
  }

  redact(text) {
    let out = String(text);
    for (const s of this.secrets) out = out.split(s).join("[REDACTED]");
    // Defensive: bearer headers that might show up in error text.
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[REDACTED]");
    return out;
  }

  rotateIfNeeded() {
    if (!this.file) return;
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;
    for (let i = this.files - 1; i >= 1; i--) {
      const src = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const dst = `${this.file}.${i}`;
      try {
        fs.renameSync(src, dst);
      } catch {
        /* missing file is fine */
      }
    }
    if (this.files === 1) {
      try {
        fs.truncateSync(this.file, 0);
      } catch {
        /* ignore */
      }
    }
  }

  write(level, scope, msg, extra) {
    const ts = new Date().toISOString();
    let line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
    if (extra !== undefined) {
      line += ` ${typeof extra === "string" ? extra : safeJson(extra)}`;
    }
    line = this.redact(line);
    if (this.file) {
      this.rotateIfNeeded();
      try {
        fs.appendFileSync(this.file, `${line}\n`);
      } catch {
        /* never crash on logging */
      }
    }
    if (this.toConsole) {
      (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
    }
  }

  child(scope) {
    return {
      redact: (t) => this.redact(t),
      debug: (m, e) => (process.env.AGENT_BUS_LISTENER_DEBUG ? this.write("debug", scope, m, e) : undefined),
      info: (m, e) => this.write("info", scope, m, e),
      warn: (m, e) => this.write("warn", scope, m, e),
      error: (m, e) => this.write("error", scope, m, e),
    };
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Truncate a file we cannot rotate (e.g. launchd's stdout/stderr targets) once it gets too big. */
export function capFile(file, maxBytes) {
  try {
    if (fs.statSync(file).size > maxBytes) fs.truncateSync(file, 0);
  } catch {
    /* ignore */
  }
}

/** Keep only the newest `keep` files in dir matching filter. */
export function pruneDir(dir, keep, filter = () => true) {
  try {
    const entries = fs
      .readdirSync(dir)
      .filter(filter)
      .map((name) => ({ name, t: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const e of entries.slice(keep)) fs.rmSync(path.join(dir, e.name), { force: true });
  } catch {
    /* ignore */
  }
}

/** A logger that discards everything (tests). */
export const nullLog = { debug() {}, info() {}, warn() {}, error() {} };
