/**
 * Per-agent work queue keyed by conversation (session key). New triggers for a conversation that is
 * already queued are merged (coalesced) into that entry, so one CLI run handles all of them.
 */
export class TriggerQueue {
  constructor({ maxTriggersPerEntry = 50 } = {}) {
    this.entries = new Map();
    this.maxTriggersPerEntry = maxTriggersPerEntry;
  }

  get size() {
    return this.entries.size;
  }

  has(key) {
    return this.entries.has(key);
  }

  /** @returns {boolean} true when the trigger was new (not a duplicate). */
  add(trigger, now = Date.now()) {
    let entry = this.entries.get(trigger.key);
    if (!entry) {
      entry = { key: trigger.key, triggers: [], firstQueuedAt: now, lastQueuedAt: now, attempts: 0, notBefore: 0, dropped: 0 };
      this.entries.set(trigger.key, entry);
    }
    if (entry.triggers.some((t) => t.uid === trigger.uid)) return false;
    entry.triggers.push(trigger);
    entry.lastQueuedAt = now;
    if (entry.triggers.length > this.maxTriggersPerEntry) {
      const extra = entry.triggers.length - this.maxTriggersPerEntry;
      entry.triggers.splice(0, extra);
      entry.dropped += extra;
    }
    return true;
  }

  /** Next runnable entry: owner-triggered first, then oldest. Removes it from the queue. */
  take(now = Date.now()) {
    const ready = [...this.entries.values()].filter((e) => e.notBefore <= now);
    if (ready.length === 0) return null;
    ready.sort((a, b) => {
      const ao = a.triggers.some((t) => t.fromOwner) ? 0 : 1;
      const bo = b.triggers.some((t) => t.fromOwner) ? 0 : 1;
      return ao - bo || a.firstQueuedAt - b.firstQueuedAt;
    });
    const entry = ready[0];
    this.entries.delete(entry.key);
    return entry;
  }

  /** Put an entry back (after a failed run); merges with anything queued meanwhile. */
  requeue(entry, { notBefore = 0 } = {}) {
    const existing = this.entries.get(entry.key);
    if (!existing) {
      this.entries.set(entry.key, { ...entry, notBefore });
      return;
    }
    const uids = new Set(existing.triggers.map((t) => t.uid));
    existing.triggers = [...entry.triggers.filter((t) => !uids.has(t.uid)), ...existing.triggers];
    existing.firstQueuedAt = Math.min(existing.firstQueuedAt, entry.firstQueuedAt);
    existing.attempts = Math.max(existing.attempts, entry.attempts);
    existing.notBefore = Math.max(existing.notBefore, notBefore);
  }

  nextReadyAt() {
    let min = Infinity;
    for (const e of this.entries.values()) min = Math.min(min, e.notBefore);
    return min;
  }

  toJSON() {
    return [...this.entries.values()];
  }

  static fromJSON(list, opts) {
    const q = new TriggerQueue(opts);
    for (const e of Array.isArray(list) ? list : []) {
      if (e && typeof e.key === "string" && Array.isArray(e.triggers)) {
        q.entries.set(e.key, { attempts: 0, notBefore: 0, dropped: 0, ...e });
      }
    }
    return q;
  }
}

/** Sliding-window run limiter (max runs per window). */
export class RateLimiter {
  constructor({ max = 20, windowMs = 3600_000, history = [] } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.history = history.filter((t) => Number.isFinite(t));
  }
  prune(now = Date.now()) {
    this.history = this.history.filter((t) => t > now - this.windowMs);
  }
  canRun(now = Date.now()) {
    this.prune(now);
    return this.history.length < this.max;
  }
  record(now = Date.now()) {
    this.prune(now);
    this.history.push(now);
  }
  /** ms until the next slot frees (0 if available). */
  waitMs(now = Date.now()) {
    this.prune(now);
    if (this.history.length < this.max) return 0;
    return this.history[0] + this.windowMs - now;
  }
}

export class Backoff {
  constructor({ initialMs = 2000, maxMs = 300000, factor = 2, random = Math.random } = {}) {
    Object.assign(this, { initialMs, maxMs, factor, random });
    this.failures = 0;
  }
  next() {
    const base = Math.min(this.maxMs, this.initialMs * this.factor ** this.failures);
    this.failures++;
    // full jitter in [base/2, base]
    return Math.round(base / 2 + (this.random() * base) / 2);
  }
  reset() {
    this.failures = 0;
  }
}
