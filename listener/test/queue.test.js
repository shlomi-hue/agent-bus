import { test } from "node:test";
import assert from "node:assert/strict";
import { TriggerQueue, RateLimiter, Backoff } from "../lib/queue.js";

const tr = (key, uid, fromOwner = false) => ({ key, uid, fromOwner });

test("coalesces triggers per conversation and dedupes", () => {
  const q = new TriggerQueue();
  assert.equal(q.add(tr("room:a", "1"), 1), true);
  assert.equal(q.add(tr("room:a", "2"), 2), true);
  assert.equal(q.add(tr("room:a", "2"), 3), false);
  q.add(tr("dm:x", "3"), 4);
  assert.equal(q.size, 2);
  const e = q.take(10);
  assert.equal(e.key, "room:a");
  assert.deepEqual(e.triggers.map((t) => t.uid), ["1", "2"]);
});

test("owner-triggered conversations run first", () => {
  const q = new TriggerQueue();
  q.add(tr("room:a", "1"), 1);
  q.add(tr("dm:o", "2", true), 2);
  assert.equal(q.take(10).key, "dm:o");
});

test("requeue merges with triggers that arrived during the run and honors notBefore", () => {
  const q = new TriggerQueue();
  q.add(tr("room:a", "1"), 1);
  const e = q.take(5);
  q.add(tr("room:a", "2"), 6);
  e.attempts = 1;
  q.requeue(e, { notBefore: 100 });
  assert.equal(q.take(50), null);
  const again = q.take(100);
  assert.deepEqual(again.triggers.map((t) => t.uid), ["1", "2"]);
  assert.equal(again.attempts, 1);
});

test("caps triggers per entry", () => {
  const q = new TriggerQueue({ maxTriggersPerEntry: 2 });
  for (let i = 0; i < 5; i++) q.add(tr("k", String(i)), i);
  const e = q.take(10);
  assert.deepEqual(e.triggers.map((t) => t.uid), ["3", "4"]);
  assert.equal(e.dropped, 3);
});

test("round-trips through JSON", () => {
  const q = new TriggerQueue();
  q.add(tr("k", "1"), 1);
  const q2 = TriggerQueue.fromJSON(JSON.parse(JSON.stringify(q.toJSON())));
  assert.equal(q2.take(5).triggers[0].uid, "1");
});

test("rate limiter: max N per window", () => {
  const rl = new RateLimiter({ max: 2, windowMs: 1000 });
  rl.record(0);
  rl.record(100);
  assert.equal(rl.canRun(200), false);
  assert.equal(rl.waitMs(200), 800);
  assert.equal(rl.canRun(1001), true);
});

test("backoff grows exponentially with cap and resets", () => {
  const b = new Backoff({ initialMs: 100, maxMs: 1000, factor: 2, random: () => 1 });
  assert.deepEqual([b.next(), b.next(), b.next(), b.next(), b.next()], [100, 200, 400, 800, 1000]);
  b.reset();
  assert.equal(b.next(), 100);
});
