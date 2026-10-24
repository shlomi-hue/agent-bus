import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MockAgentBus } from "./fixtures/mock-agent-bus.js";
import { FIXTURES, tmpdir, waitFor } from "./helpers.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-bus-listener");

function writeConfig(dir, url, extra = {}) {
  fs.writeFileSync(path.join(dir, "tokens.env"), "# test\nexport CODEX_TOKEN=tok-codex-123456\nCLAUDE_TOKEN='tok-claude-123456'\nGROK_TOKEN=tok-grok-123456\n", { mode: 0o600 }); // gitleaks:allow (fake test tokens)
  const cfg = {
    mcpUrl: url,
    tokensFile: path.join(dir, "tokens.env"),
    workspace: path.join(dir, "ws"),
    logDir: path.join(dir, "logs"),
    stateFile: path.join(dir, "state", "state.json"),
    pauseFile: path.join(dir, "state", "PAUSE"),
    runDir: path.join(dir, "state", "run"),
    waitSeconds: 1,
    reconcile: { enabled: false },
    agents: {
      codex: { bin: path.join(FIXTURES, "fake-codex.sh") },
      claude: { bin: path.join(dir, "no-such-claude") },
    },
    ...extra,
  };
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}

// async (the mock server lives in this process, so spawnSync would deadlock it)
function run(args, env = {}) {
  return new Promise((resolve) => {
    const c = spawn(BIN, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("start (foreground): runs codex for an owner DM, skips missing claude, SIGTERM kills the CLI group and sets offline", async (t) => {
  const dir = tmpdir();
  const bus = new MockAgentBus();
  const url = await bus.listen();
  t.after(() => bus.close());
  const config = writeConfig(dir, url);
  const pidfile = path.join(dir, "grandchild.pid");
  const child = spawn(BIN, ["start", "--config", config], {
    env: { ...process.env, FAKE_LOG: path.join(dir, "argv.log"), FAKE_SLEEP: "60", FAKE_CHILD_PIDFILE: pidfile },
    stdio: "ignore",
  });
  const exited = new Promise((r) => child.on("exit", (code, sig) => r({ code, sig })));
  await waitFor(() => bus.statuses.some((s) => s.agent === "codex" && s.status === "available"), { label: "listening" });
  const log = () => fs.readFileSync(path.join(dir, "logs", "listener.log"), "utf8");
  assert.match(log(), /claude: claude CLI not found/);
  bus.dm("owner", "codex", "do work");
  await waitFor(() => fs.existsSync(pidfile), { label: "CLI running" });
  const gpid = Number(fs.readFileSync(pidfile, "utf8"));
  assert.ok(bus.statuses.some((s) => s.status === "busy"));
  const t0 = Date.now();
  child.kill("SIGTERM");
  const { code } = await exited;
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 15000);
  await waitFor(() => {
    try {
      process.kill(gpid, 0);
      return /^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${gpid}/stat`, "utf8"));
    } catch {
      return true;
    }
  }, { label: "grandchild killed" });
  assert.ok(bus.statuses.some((s) => s.agent === "codex" && s.status === "away"), "offline status on shutdown");
  assert.ok(!fs.existsSync(path.join(dir, "state", "listener.pid")));
  // aborted work is persisted for the next start
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state", "state.json"), "utf8"));
  assert.equal(state.agents.codex.queue.length, 1);
  assert.ok(!log().includes("tok-codex-123456"));
});

test("test (dry run) is non-consuming by default and never starts a CLI", async (t) => {
  const dir = tmpdir();
  const bus = new MockAgentBus();
  const url = await bus.listen();
  t.after(() => bus.close());
  const config = writeConfig(dir, url);
  const dm = bus.dm("owner", "codex", "unread");
  bus.post("general", "owner", "@codex hi");
  const r = await run(["test", "--config", config], { FAKE_LOG: path.join(dir, "argv.log") });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /all expected tools present/);
  assert.match(r.stdout, /would trigger/);
  assert.match(r.stdout, /task:/);
  assert.equal(dm.readAt, null, "DM not consumed");
  assert.equal(bus.calls.filter((c) => c.name === "wait_for_messages" || c.name === "read_inbox").length, 0);
  assert.ok(!fs.existsSync(path.join(dir, "argv.log")));
  assert.ok(!r.stdout.includes("tok-"));
  const r2 = await run(["test", "--config", config, "--agent", "grok", "--token-env", "GROK_TOKEN", "--poll"]);
  assert.equal(r2.status, 0, r2.stdout);
  assert.match(r2.stdout, /wait_for_messages\(since .*\): timed out/);
});

test("pause / resume / status / doctor", async (t) => {
  const dir = tmpdir();
  const bus = new MockAgentBus();
  const url = await bus.listen();
  t.after(() => bus.close());
  const config = writeConfig(dir, url);
  assert.equal((await run(["pause", "--config", config])).status, 0);
  assert.ok(fs.existsSync(path.join(dir, "state", "PAUSE")));
  assert.match((await run(["status", "--config", config])).stdout, /Paused: YES/);
  assert.equal((await run(["resume", "--config", config])).status, 0);
  assert.ok(!fs.existsSync(path.join(dir, "state", "PAUSE")));
  assert.match((await run(["status", "--config", config])).stdout, /Paused: no/);
  const d = await run(["doctor", "--config", config]);
  assert.match(d.stdout, /OK\s+token names present — CODEX_TOKEN, CLAUDE_TOKEN, GROK_TOKEN/);
  assert.match(d.stdout, /OK\s+codex CLI/);
  assert.match(d.stdout, /WARN\s+claude CLI/);
  assert.match(d.stdout, /OK\s+MCP reachable/);
  assert.ok(!d.stdout.includes("tok-"), "doctor never prints token values");
  assert.equal((await run(["bogus"])).status, 2);
});

test("health: missing claude is a warning; present but logged out fails; logged in passes and never prints the token", async (t) => {
  const dir = tmpdir();
  const bus = new MockAgentBus();
  const url = await bus.listen();
  t.after(() => bus.close());
  const missing = writeConfig(dir, url);
  const skipped = await run(["health", "--config", missing]);
  assert.equal(skipped.status, 0, skipped.stdout);
  assert.match(skipped.stdout, /WARN\s+claude CLI/);
  assert.match(skipped.stdout, /OK\s+codex CLI/);
  assert.ok(!skipped.stdout.includes("tok-"));

  const authed = writeConfig(dir, url, {
    agents: {
      codex: { bin: path.join(FIXTURES, "fake-codex.sh") },
      claude: { bin: path.join(FIXTURES, "fake-claude.sh") },
    },
  });
  const ok = await run(["health", "--config", authed], { FAKE_AUTH: "ok", FAKE_LOG: path.join(dir, "health-ok.log") });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /OK\s+claude auth — logged in \(claude.ai\)/);
  assert.match(ok.stdout, /permission-mode dontAsk/);
  assert.match(ok.stdout, /allowlist Read, Edit, Write, mcp__agent_bus__\*/);
  assert.ok(!/allowlist.*\bBash\b/.test(ok.stdout));
  assert.ok(!ok.stdout.includes("tok-claude"));

  const loggedOut = await run(["health", "--config", authed], { FAKE_AUTH: "missing", FAKE_LOG: path.join(dir, "health-out.log") });
  assert.equal(loggedOut.status, 1, loggedOut.stdout);
  assert.match(loggedOut.stdout, /FAIL\s+claude auth/);
  assert.match(loggedOut.stdout, /not logged in/);
  assert.ok(!loggedOut.stdout.includes("tok-"));
});
