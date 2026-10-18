import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runProcess, activeChildren } from "../lib/runner.js";
import { FIXTURES, tmpdir, waitFor } from "./helpers.js";

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return !/^\d+ \(.*\) Z/.test(stat);
  } catch {
    return true;
  }
}

test("passes stdin, captures stdout, returns exit code", async () => {
  const dir = tmpdir();
  const log = path.join(dir, "argv.log");
  const r = await runProcess({ bin: path.join(FIXTURES, "fake-codex.sh"), args: ["exec", "--json", "-"], cwd: dir, env: { ...process.env, FAKE_LOG: log, FAKE_EXIT: "3" }, input: "hello prompt" });
  assert.equal(r.code, 3);
  assert.match(r.stdout, /thread\.started/);
  const stdinFile = fs.readdirSync(dir).find((f) => f.startsWith("argv.log.stdin"));
  assert.equal(fs.readFileSync(path.join(dir, stdinFile), "utf8"), "hello prompt");
});

test("timeout kills the whole process group (including grandchildren)", async () => {
  const dir = tmpdir();
  const pidfile = path.join(dir, "child.pid");
  const t0 = Date.now();
  const r = await runProcess({
    bin: path.join(FIXTURES, "fake-codex.sh"),
    args: ["exec", "-"],
    cwd: dir,
    env: { ...process.env, FAKE_SLEEP: "60", FAKE_CHILD_PIDFILE: pidfile },
    timeoutMs: 800,
    killGraceMs: 500,
  });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 5000, "returned promptly");
  const gpid = Number(fs.readFileSync(pidfile, "utf8"));
  await waitFor(() => !alive(gpid), { timeout: 3000, label: "grandchild to die" });
  assert.equal(activeChildren.size, 0);
});

test("abort signal terminates the run", async () => {
  const dir = tmpdir();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const r = await runProcess({ bin: path.join(FIXTURES, "fake-codex.sh"), args: ["exec", "-"], cwd: dir, env: { ...process.env, FAKE_SLEEP: "30" }, signal: ac.signal, killGraceMs: 300 });
  assert.equal(r.aborted, true);
});

test("missing binary resolves with an error instead of throwing", async () => {
  const r = await runProcess({ bin: "/nonexistent/codex", args: [], cwd: tmpdir() });
  assert.ok(r.error);
});
