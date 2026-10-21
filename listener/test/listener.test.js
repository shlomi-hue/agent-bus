import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentLoop, planAgents } from "../lib/listener.js";
import { StateStore } from "../lib/state.js";
import { Logger } from "../lib/logger.js";
import { MockAgentBus } from "./fixtures/mock-agent-bus.js";
import { testConfig, tmpdir, waitFor, readArgvLog, memLog } from "./helpers.js";

async function setup(t, { agent = "codex", cfg: over = {}, env = {}, seed, protocol = 1 } = {}) {
  const dir = tmpdir();
  const bus = new MockAgentBus({ protocol });
  const url = await bus.listen();
  const cfg = testConfig(dir, { mcpUrl: url, ...over });
  const argvLog = path.join(dir, "argv.log");
  Object.assign(process.env, { FAKE_LOG: argvLog, FAKE_SLEEP: "", FAKE_EXIT: "0", FAKE_BAD_SESSIONS: "", ...env });
  const logger = new Logger({ file: path.join(cfg.logDir, "listener.log"), secrets: Object.values(bus.tokens) });
  const store = new StateStore(cfg.stateFile).load();
  if (seed) seed(store.agent(agent), bus);
  store.save();
  const agentCfg = cfg.agents[agent];
  agentCfg.resolvedBin = agentCfg.bin;
  const loop = new AgentLoop({ cfg, agent: agentCfg, token: bus.tokens[agent], store, log: logger.child(agent), allTokenEnvNames: ["CODEX_TOKEN", "CLAUDE_TOKEN", "GROK_TOKEN"] });
  const done = loop.start();
  t.after(async () => {
    await loop.stop();
    await done;
    await bus.close();
  });
  await waitFor(() => bus.statuses.some((s) => s.agent === agent && s.status === "available"), { label: "listening status" });
  const runs = () => readArgvLog(argvLog).filter((a) => a[0] !== "--version");
  const stdins = () =>
    fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("argv.log.stdin"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs, text: fs.readFileSync(path.join(dir, f), "utf8") }))
      .sort((a, b) => a.t - b.t)
      .map((x) => x.text);
  return { dir, bus, cfg, loop, store, argvLog, runs, stdins, logFile: path.join(cfg.logDir, "listener.log") };
}

test("owner DM -> codex run (new session) -> next DM on same thread resumes that session", async (t) => {
  const { bus, cfg, loop, runs, stdins } = await setup(t);
  const m1 = bus.dm("owner", "codex", "please build the thing");
  await waitFor(() => runs().length === 1 && loop.st.sessions[`dm:${m1.threadId}`], { label: "first run" });
  const first = runs()[0];
  assert.deepEqual(first.slice(0, 6), ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", cfg.workspace]);
  assert.equal(first.at(-1), "-");
  assert.match(stdins()[0], /please build the thing/);
  assert.match(stdins()[0], new RegExp(`Direct message id ${m1.id}`));
  const sid = loop.st.sessions[`dm:${m1.threadId}`].id;
  assert.ok(sid);
  assert.ok(m1.readAt, "listener's wait marked it read (content went into the prompt)");

  bus.dm("owner", "codex", "and now the follow-up", { threadId: m1.threadId, hop: 1 });
  await waitFor(() => runs().length === 2, { label: "second run" });
  const second = runs()[1];
  assert.deepEqual(second.slice(0, 4), ["exec", "-C", cfg.workspace, "resume"]);
  assert.equal(second.at(-2), sid);
  await waitFor(() => loop.st.sessions[`dm:${m1.threadId}`].runs === 2, { label: "session runs=2" });

  const statuses = bus.statuses.map((s) => s.status);
  assert.ok(statuses.includes("busy"));
  assert.ok(bus.statuses.some((s) => s.status === "busy" && /working on direct-message thread/.test(s.text)));
  // never steals unread mail through read_inbox(unread_only=true)
  assert.equal(bus.callsTo("codex", "read_inbox").filter((c) => c.args.unread_only !== false).length, 0);
});

test("resume failure falls back to a fresh session", async (t) => {
  const thread = "aaaaaaaa-0000-4000-8000-000000000001";
  const { bus, loop, runs } = await setup(t, {
    env: { FAKE_BAD_SESSIONS: "dead-session-id" },
    seed: (st) => {
      st.sessions[`dm:${thread}`] = { id: "dead-session-id", cli: "codex", runs: 3 };
    },
  });
  bus.dm("owner", "codex", "hello again", { threadId: thread });
  await waitFor(() => runs().length === 2 && loop.st.lastRun, { label: "resume + fresh" });
  assert.ok(runs()[0].includes("resume"));
  assert.ok(!runs()[1].includes("resume"));
  const s = loop.st.sessions[`dm:${thread}`];
  assert.notEqual(s.id, "dead-session-id");
  assert.equal(s.runs, 1);
  assert.equal(loop.st.lastRun.ok, true);
});

test("triggers arriving during a run are coalesced into ONE follow-up run", async (t) => {
  const { bus, runs, stdins, loop } = await setup(t, { env: { FAKE_SLEEP: "1.5" } });
  const m1 = bus.dm("owner", "codex", "first");
  await waitFor(() => runs().length === 1, { label: "run 1 started" });
  bus.dm("owner", "codex", "second", { threadId: m1.threadId });
  bus.dm("owner", "codex", "third", { threadId: m1.threadId });
  await waitFor(() => runs().length === 2, { timeout: 15000, label: "run 2" });
  await waitFor(() => !loop.current && loop.queue.size === 0, { label: "idle" });
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(runs().length, 2, "exactly one follow-up run");
  const p2 = stdins()[1];
  assert.match(p2, /second/);
  assert.match(p2, /third/);
  assert.doesNotMatch(p2, /\bfirst\b/);
});

test("other agents: chatter ignored, @mention / DM trigger, own posts ignored", async (t) => {
  const { bus, runs, stdins } = await setup(t);
  bus.post("general", "claude", "I will refactor the parser");
  bus.post("general", "codex", "ok");
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(runs().length, 0);
  bus.post("general", "claude", "@codex please review my PR");
  await waitFor(() => runs().length === 1, { label: "mention run" });
  assert.match(stdins()[0], /room #general/);
  assert.match(stdins()[0], /please review my PR/);
  assert.match(stdins()[0], /Task /, "the mention's task is coalesced into the same room run");
});

test("owner reply in a room after codex spoke triggers (reply-to-me)", async (t) => {
  const { bus, runs } = await setup(t);
  bus.post("general", "codex", "deployed");
  await new Promise((r) => setTimeout(r, 1200));
  bus.post("general", "owner", "great, now update the docs");
  await waitFor(() => runs().length === 1, { label: "owner reply run" });
});

test("PAUSE file: keeps polling but starts no runs until removed", async (t) => {
  const { bus, cfg, runs, loop } = await setup(t);
  fs.writeFileSync(cfg.pauseFile, "");
  bus.dm("owner", "codex", "while paused");
  await waitFor(() => loop.queue.size === 1, { label: "queued" });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(runs().length, 0);
  fs.rmSync(cfg.pauseFile);
  loop.workWaker.wake();
  await waitFor(() => runs().length === 1, { label: "run after resume" });
});

test("rate limit: max runs per hour", async (t) => {
  const { bus, runs, loop } = await setup(t, { cfg: { maxRunsPerHour: 1 } });
  bus.dm("owner", "codex", "one");
  bus.dm("owner", "codex", "two (other thread)");
  await waitFor(() => runs().length === 1 && !loop.current, { label: "first run" });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(runs().length, 1);
  assert.equal(loop.queue.size, 1, "second conversation stays queued");
});

test("loop guard: consecutive agent-only runs in one thread are capped", async (t) => {
  const { bus, runs, loop } = await setup(t, { cfg: { maxAgentOnlyRunsPerThread: 1 } });
  const m = bus.dm("claude", "codex", "ping from claude");
  await waitFor(() => runs().length === 1 && !loop.current, { label: "first agent run" });
  bus.dm("claude", "codex", "ping again", { threadId: m.threadId, hop: 2 });
  await waitFor(() => fs.readFileSync(path.join(loop.cfg.logDir, "listener.log"), "utf8").includes("loop guard"), { label: "guard log" });
  assert.equal(runs().length, 1);
  bus.dm("owner", "codex", "owner resets the guard", { threadId: m.threadId });
  await waitFor(() => runs().length === 2, { label: "owner run" });
});

test("run timeout kills the CLI and schedules a retry", async (t) => {
  const { bus, loop } = await setup(t, { cfg: { runTimeoutMinutes: 0.01 }, env: { FAKE_SLEEP: "30" } });
  const m = bus.dm("owner", "codex", "slow job");
  await waitFor(() => loop.st.lastRun, { timeout: 15000, label: "timed out run" });
  assert.equal(loop.st.lastRun.timedOut, true);
  assert.equal(loop.st.lastRun.ok, false);
  const e = loop.queue.entries.get(`dm:${m.threadId}`);
  assert.equal(e.attempts, 1);
  assert.ok(e.notBefore > Date.now());
});

test("first start does not consume the existing backlog; restart resumes from cursor", async (t) => {
  const dir = tmpdir();
  const bus = new MockAgentBus();
  const url = await bus.listen();
  t.after(() => bus.close());
  const old = bus.dm("owner", "codex", "old unread mail");
  await new Promise((r) => setTimeout(r, 3500)); // older than the baseline slack (2s + 1s Date-header precision)
  const cfg = testConfig(dir, { mcpUrl: url });
  process.env.FAKE_LOG = path.join(dir, "argv.log");
  const store = new StateStore(cfg.stateFile).load();
  cfg.agents.codex.resolvedBin = cfg.agents.codex.bin;
  let loop = new AgentLoop({ cfg, agent: cfg.agents.codex, token: bus.tokens.codex, store, log: memLog() });
  let done = loop.start();
  let cleanup = async () => {
    await loop.stop();
    await done;
  };
  t.after(() => cleanup());
  await waitFor(() => bus.callsTo("codex", "wait_for_messages").length >= 2, { label: "polling" });
  assert.equal(old.readAt, null, "backlog left unread for the agent");
  await loop.stop();
  await done;
  // message arrives while the listener is down
  const missed = bus.dm("owner", "codex", "sent while listener was down");
  const store2 = new StateStore(cfg.stateFile).load();
  loop = new AgentLoop({ cfg, agent: cfg.agents.codex, token: bus.tokens.codex, store: store2, log: memLog() });
  done = loop.start();
  await waitFor(() => readArgvLog(process.env.FAKE_LOG).length === 1, { label: "catch-up run" });
  assert.ok(missed.readAt);
  assert.equal(old.readAt, null);
});

test("protocol 2 peeks without consuming and uses inline room posts", async (t) => {
  const { bus, runs, stdins } = await setup(t, { protocol: 2 });
  const dm = bus.dm("owner", "codex", "peek me");
  await waitFor(() => runs().length === 1, { label: "dm run" });
  assert.equal(dm.readAt, null, "mark_read false leaves the DM unread");
  assert.match(stdins()[0], /NOT marked read/);
  assert.equal(bus.callsTo("codex", "wait_for_messages").at(-1).args.mark_read, false);
  bus.post("general", "claude", "@codex look here");
  await waitFor(() => runs().length === 2, { label: "mention run" });
  assert.equal(bus.callsTo("codex", "read_room").length, 0, "inline room posts skip read_room");
  assert.match(stdins()[1], /look here/);
  const precise = bus.callsTo("codex", "wait_for_messages").some((call) => /\.\d{6}Z$/.test(call.args.since ?? ""));
  assert.equal(precise, true);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(runs().length, 2, "the same posts are not delivered again");
});

test("crash recovery: persisted queue / running entry is re-run on start", async (t) => {
  const { runs } = await setup(t, {
    seed: (st) => {
      st.running = { key: "dm:t-crash", triggers: [{ uid: "dm:x", kind: "dm", key: "dm:t-crash", id: "x", threadId: "t-crash", from: "owner", fromOwner: true, body: "recovered", reason: "r" }], firstQueuedAt: 1, attempts: 0, notBefore: 0 };
    },
  });
  await waitFor(() => runs().length === 1, { label: "recovered run" });
});

test("reconcile: unacked DM consumed elsewhere is dispatched after grace", async (t) => {
  const { bus, runs, stdins } = await setup(t, { cfg: { reconcile: { enabled: true, intervalSeconds: 0, graceSeconds: 0, windowHours: 6 } } });
  const m = bus.dm("owner", "codex", "read by someone else, never acked");
  m.readAt = new Date().toISOString(); // e.g. an interactive session read it first
  await waitFor(() => runs().length === 1, { label: "reconcile run" });
  assert.match(stdins()[0], /found by reconcile/);
});

test("claude: per-run MCP config (0600, deleted after), --session-id then --resume, no token in logs", async (t) => {
  const { bus, runs, loop, argvLog, cfg, logFile } = await setup(t, { agent: "claude" });
  const m = bus.dm("owner", "claude", "hi claude");
  await waitFor(() => runs().length === 1 && loop.st.sessions[`dm:${m.threadId}`], { label: "claude run" });
  const a = runs()[0];
  assert.deepEqual(a.slice(0, 5), ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--mcp-config"]);
  const sidIdx = a.indexOf("--session-id");
  assert.ok(sidIdx > 0);
  const sid = a[sidIdx + 1];
  assert.equal(loop.st.sessions[`dm:${m.threadId}`].id, sid);
  const raw = fs.readFileSync(argvLog, "utf8");
  assert.match(raw, /MCPCONFIG mode=600/);
  assert.match(raw, /MCPCONFIG has-auth/);
  assert.equal(fs.readdirSync(cfg.runDir).filter((f) => f.startsWith("claude-mcp")).length, 0, "config removed after run");
  bus.dm("owner", "claude", "follow up", { threadId: m.threadId });
  await waitFor(() => runs().length === 2, { label: "claude resume" });
  assert.equal(runs()[1][runs()[1].indexOf("--resume") + 1], sid);
  // secrets never in logs
  const token = bus.tokens.claude;
  const logs = [logFile, ...fs.readdirSync(path.join(cfg.logDir, "runs")).map((f) => path.join(cfg.logDir, "runs", f))];
  for (const f of logs) assert.ok(!fs.readFileSync(f, "utf8").includes(token), `token leaked into ${f}`);
});

test("planAgents skips claude when its CLI is missing, and agents without tokens", () => {
  const dir = tmpdir();
  const cfg = testConfig(dir, { agents: { claude: { bin: "/nope/claude" } } });
  const log = memLog();
  const plans = planAgents(cfg, { CODEX_TOKEN: "x".repeat(10), CLAUDE_TOKEN: "y".repeat(10) }, log);
  assert.deepEqual(plans.map((p) => p.agent.name), ["codex"]);
  assert.ok(log.lines.some((l) => /claude: claude CLI not found/.test(l)));
  const plans2 = planAgents(cfg, {}, memLog());
  assert.equal(plans2.length, 0);
});
