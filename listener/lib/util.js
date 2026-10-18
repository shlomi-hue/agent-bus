import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export function expandHome(p, home = os.homedir()) {
  if (typeof p !== "string" || p === "") return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p.replaceAll("$HOME", home);
}

/** Sleep that resolves early when the signal aborts. Never rejects. */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** A re-armable wake-up: wait() resolves on the next wake() or after ms. */
export class Waker {
  constructor() {
    this._resolvers = new Set();
  }
  wait(ms) {
    return new Promise((resolve) => {
      const entry = () => {
        clearTimeout(timer);
        this._resolvers.delete(entry);
        resolve();
      };
      const timer = setTimeout(entry, Math.max(0, ms));
      this._resolvers.add(entry);
    });
  }
  wake() {
    for (const r of [...this._resolvers]) r();
  }
}

export function isoPlusMs(iso, ms) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t + ms).toISOString();
}

export function maxIso(...values) {
  let best = null;
  let bestT = -Infinity;
  for (const v of values.flat()) {
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) continue;
    if (t > bestT) {
      bestT = t;
      best = v;
    }
  }
  return best;
}

export function fileExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve a binary: absolute/relative path, else search PATH entries. */
export function resolveBinary(bin, searchPath = process.env.PATH ?? "") {
  if (!bin) return null;
  if (bin.includes("/")) return isExecutable(bin) ? bin : null;
  for (const dir of searchPath.split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export function truncate(text, max) {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... truncated ${text.length - max} characters by agent-bus-listener ...]`;
}

export function jitter(ms, ratio = 0.2) {
  return Math.round(ms * (1 - ratio + Math.random() * ratio * 2));
}
