import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { StateStore, writeJsonAtomic, pruneSeen } from "../lib/state.js";
import { tmpdir, memLog } from "./helpers.js";

test("state persists across instances, atomically, with 0600 perms", () => {
  const dir = tmpdir();
  const file = path.join(dir, "sub", "state.json");
  const s = new StateStore(file).load();
  const a = s.agent("codex");
  a.cursor = "2026-10-18T00:00:00.000Z";
  a.sessions["room:general"] = { id: "abc", cli: "codex" };
  s.save();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"], "no temp files left behind");
  const s2 = new StateStore(file).load();
  assert.equal(s2.agent("codex").cursor, "2026-10-18T00:00:00.000Z");
  assert.equal(s2.agent("codex").sessions["room:general"].id, "abc");
});

test("corrupt state is moved aside, not fatal", () => {
  const dir = tmpdir();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "{not json");
  const log = memLog();
  const s = new StateStore(file, { log }).load();
  assert.equal(s.agent("codex").cursor, null);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("state.json.corrupt-")));
  assert.ok(log.lines.some((l) => l.includes("unreadable")));
});

test("writeJsonAtomic replaces content", () => {
  const dir = tmpdir();
  const f = path.join(dir, "x.json");
  writeJsonAtomic(f, { a: 1 });
  writeJsonAtomic(f, { a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { a: 2 });
});

test("seen map is pruned by age and size", () => {
  const now = Date.now();
  const a = { seen: { old: now - 30 * 24 * 3600_000, fresh: now }, taskStatus: {} };
  pruneSeen(a, now);
  assert.deepEqual(Object.keys(a.seen), ["fresh"]);
});
