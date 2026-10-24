import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { loadConfig, loadTokens, LABEL, packageRoot } from "./config.js";
import { Logger, capFile } from "./logger.js";
import { StateStore, readStateFile } from "./state.js";
import { AgentLoop, planAgents, killAllChildren } from "./listener.js";
import { McpClient } from "./mcp-client.js";
import { parseRoomList, parseRoomLog, parseTaskList, parseWait } from "./parse.js";
import { evaluateDm, evaluateRoomMessages, evaluateTask } from "./triggers.js";
import { resolveBinary, isoPlusMs, fileExists } from "./util.js";
import { readClaudeAuth, claudeAllowedTools } from "./agents.js";

const EXPECTED_TOOLS = [
  "wait_for_messages",
  "read_inbox",
  "read_room",
  "list_my_tasks",
  "update_task",
  "set_status",
  "reply",
  "send_room_message",
  "propose_plan",
  "get_plan",
  "post_result",
  "ack_message",
  "get_thread",
];

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    if (a === "--config") opts.config = take();
    else if (a === "--agent") opts.agent = take();
    else if (a === "--token-env") opts.tokenEnv = take();
    else if (a === "--tokens-file") opts.tokensFile = take();
    else if (a === "--poll") opts.poll = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "-f" || a === "--follow") opts.follow = true;
    else if (a === "-n" || a === "--lines") opts.lines = Number(take());
    else if (a === "--verbose" || a === "-v") opts.verbose = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else opts._.push(a);
  }
  return opts;
}

const USAGE = `agent-bus-listener <command> [options]

Commands:
  start      Run the listener in the foreground (this is what launchd runs)
  status     LaunchAgent state, paused?, last run / queue per agent
  pause      Create the PAUSE kill-switch file (keeps polling, starts no CLI runs)
  resume     Remove the PAUSE file
  logs       Tail the listener log (-n N, -f to follow)
  test       Dry run: connect, list tools, show what WOULD trigger; never starts a CLI.
             Uses only non-consuming reads unless --poll is given (one wait_for_messages call,
             which marks newly arrived direct messages read for that agent).
  doctor     Check node, codex/claude paths, tokens (names only), MCP reachability, workspace
  health     Check node, Codex, and Claude Code (binary plus \`claude auth status\`). No MCP calls.

Options:
  --config <file>       config.json to use (default: next to the code, else ~/.agent-bus/listener/config.json)
  --agent <name>        limit test/doctor to one agent (for test: any agent name, e.g. grok)
  --token-env <NAME>    token variable for --agent when it is not in config (e.g. GROK_TOKEN)
  --tokens-file <file>  tokens.env to read (default from config)
  --dry-run             start: poll and log triggers but never run a CLI
`;

function loadAll(opts) {
  const overrides = {};
  if (opts.tokensFile) overrides.tokensFile = opts.tokensFile;
  const cfg = loadConfig({ file: opts.config, overrides });
  return cfg;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  const cmd = opts._[0];
  if (!cmd || opts.help) {
    process.stdout.write(USAGE);
    return cmd ? 0 : 1;
  }
  switch (cmd) {
    case "start":
      return cmdStart(opts);
    case "status":
      return cmdStatus(opts);
    case "pause":
      return cmdPause(opts, true);
    case "resume":
      return cmdPause(opts, false);
    case "logs":
      return cmdLogs(opts);
    case "test":
      return cmdTest(opts);
    case "doctor":
      return cmdDoctor(opts);
    case "health":
      return cmdHealth(opts);
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

// ------------------------------------------------------------------ start

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function acquirePidFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const old = Number(fs.readFileSync(file, "utf8").trim());
    if (old && old !== process.pid && pidAlive(old)) return old;
  } catch {
    /* none */
  }
  fs.writeFileSync(file, `${process.pid}\n`);
  return null;
}

async function cmdStart(opts) {
  const cfg = loadAll(opts);
  fs.mkdirSync(cfg.logDir, { recursive: true });
  for (const f of ["launchd.out.log", "launchd.err.log"]) capFile(path.join(cfg.logDir, f), cfg.log.launchdMaxBytes);
  const tokens = loadTokens(cfg.tokensFile);
  const logger = new Logger({
    file: path.join(cfg.logDir, "listener.log"),
    maxBytes: cfg.log.maxBytes,
    files: cfg.log.files,
    console: Boolean(process.stdout.isTTY || opts.verbose),
    secrets: Object.values(tokens),
  });
  const log = logger.child("main");
  const pidFile = path.join(path.dirname(cfg.stateFile), "listener.pid");
  const other = acquirePidFile(pidFile);
  if (other) {
    log.error(`another listener is already running (pid ${other}); exiting`);
    return 1;
  }
  log.info(`agent-bus-listener starting pid=${process.pid} node=${process.version} config=${cfg.configFile ?? "(defaults)"} workspace=${cfg.workspace}`);
  if (!fs.existsSync(cfg.tokensFile)) log.error(`tokens file not found: ${cfg.tokensFile}`);
  fs.mkdirSync(cfg.workspace, { recursive: true });
  if (fs.existsSync(cfg.pauseFile)) log.warn(`PAUSE file present (${cfg.pauseFile}): polling only, no CLI runs until it is removed`);

  const store = new StateStore(cfg.stateFile, { log }).load();
  const plans = planAgents(cfg, tokens, log);
  if (plans.length === 0) {
    log.error("no runnable agents (check tokens and CLI paths with `agent-bus-listener doctor`); exiting");
    fs.rmSync(pidFile, { force: true });
    return 0; // clean exit: launchd KeepAlive(SuccessfulExit=false) will not respawn-loop
  }
  const allTokenEnvNames = Object.values(cfg.agents).map((a) => a.tokenEnv).filter(Boolean);
  const loops = plans.map(
    ({ agent, token }) => new AgentLoop({ cfg, agent, token, store, log: logger.child(agent.name), dryRun: Boolean(opts.dryRun), allTokenEnvNames }),
  );

  let shuttingDown = false;
  let running = [];
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received; shutting down`);
    await Promise.all(loops.map((l) => l.stop()));
    await killAllChildren(cfg.killGraceSeconds * 1000);
    // let in-flight long-polls finish so DMs they mark read are persisted to the queue
    await Promise.race([Promise.all(running), new Promise((r) => setTimeout(r, (cfg.waitSeconds + 6) * 1000))]);
    await Promise.race([Promise.all(loops.map((l) => l.shutdownStatus())), new Promise((r) => setTimeout(r, 5000))]);
    try {
      store.save();
    } catch {
      /* ignore */
    }
    fs.rmSync(pidFile, { force: true });
    log.info("stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  process.on("uncaughtException", (error) => {
    log.error(`uncaught exception: ${error.stack ?? error.message}`);
    void killAllChildren(1000).finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (error) => {
    log.error(`unhandled rejection: ${error?.stack ?? error}`);
  });

  running = loops.map((l) => l.start().catch((error) => log.error(`${l.name} loop crashed: ${error.stack ?? error.message}`)));
  await Promise.all(running);
  if (!shuttingDown) await shutdown("loops-ended");
  return 0;
}

// ------------------------------------------------------------------ status / pause / logs

function launchctlState() {
  if (process.platform !== "darwin") return { available: false, text: "launchctl not available (not macOS)" };
  const uid = process.getuid();
  const r = spawnSync("launchctl", ["print", `gui/${uid}/${LABEL}`], { encoding: "utf8" });
  if (r.status !== 0) return { available: true, loaded: false, text: "not loaded" };
  const state = /^\s*state = (.+)$/m.exec(r.stdout)?.[1] ?? "unknown";
  const pid = /^\s*pid = (\d+)$/m.exec(r.stdout)?.[1] ?? null;
  const lastExit = /last exit code = (.+)$/m.exec(r.stdout)?.[1] ?? null;
  return { available: true, loaded: true, state, pid, lastExit, text: `loaded, state=${state}${pid ? ` pid=${pid}` : ""}${lastExit ? ` last exit=${lastExit}` : ""}` };
}

function cmdStatus(opts) {
  const cfg = loadAll(opts);
  const lc = launchctlState();
  const pidFile = path.join(path.dirname(cfg.stateFile), "listener.pid");
  let pid = null;
  try {
    pid = Number(fs.readFileSync(pidFile, "utf8").trim()) || null;
  } catch {
    /* none */
  }
  const state = readStateFile(cfg.stateFile);
  const out = {
    launchAgent: lc.text,
    process: pid ? `${pid} (${pidAlive(pid) ? "alive" : "not running"})` : "no pid file",
    paused: fs.existsSync(cfg.pauseFile),
    pauseFile: cfg.pauseFile,
    stateFile: cfg.stateFile,
    stateUpdatedAt: state?.updatedAt ?? null,
    agents: {},
  };
  for (const [name, a] of Object.entries(state?.agents ?? {})) {
    out.agents[name] = {
      lastPollAt: a.lastPollAt,
      cursor: a.cursor,
      queued: (a.queue ?? []).map((e) => `${e.key} (${e.triggers.length} trigger(s)${e.attempts ? `, ${e.attempts} failed attempt(s)` : ""})`),
      running: a.running ? a.running.key : null,
      lastRun: a.lastRun,
      runsLastHour: (a.runHistory ?? []).filter((t) => t > Date.now() - 3600_000).length,
      sessions: Object.keys(a.sessions ?? {}).length,
      presence: a.status,
    };
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }
  const lines = [
    `LaunchAgent (${LABEL}): ${out.launchAgent}`,
    `Listener process: ${out.process}`,
    `Paused: ${out.paused ? `YES (${cfg.pauseFile} exists)` : "no"}`,
    `State: ${cfg.stateFile}${out.stateUpdatedAt ? ` (updated ${out.stateUpdatedAt})` : " (none yet)"}`,
  ];
  for (const [name, a] of Object.entries(out.agents)) {
    lines.push(`\n[${name}]`);
    lines.push(`  last poll: ${a.lastPollAt ?? "never"}   cursor: ${a.cursor ?? "-"}`);
    lines.push(`  running: ${a.running ?? "no"}   runs in last hour: ${a.runsLastHour}/${cfg.maxRunsPerHour}   sessions: ${a.sessions}`);
    lines.push(`  queued: ${a.queued.length ? a.queued.join("; ") : "none"}`);
    if (a.lastRun) {
      lines.push(`  last run: ${a.lastRun.at} ${a.lastRun.key} ${a.lastRun.ok ? "ok" : "FAILED"} exit=${a.lastRun.code}${a.lastRun.timedOut ? " (timeout)" : ""} ${a.lastRun.durationMs != null ? `${Math.round(a.lastRun.durationMs / 1000)}s` : ""}`);
      if (a.lastRun.log) lines.push(`  run log: ${a.lastRun.log}`);
    } else lines.push("  last run: never");
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function cmdPause(opts, pause) {
  const cfg = loadAll(opts);
  if (pause) {
    fs.mkdirSync(path.dirname(cfg.pauseFile), { recursive: true });
    fs.writeFileSync(cfg.pauseFile, `paused ${new Date().toISOString()}\n`);
    process.stdout.write(`Paused: ${cfg.pauseFile} created. The listener keeps polling but starts no CLI runs (a run already in progress finishes).\n`);
  } else {
    fs.rmSync(cfg.pauseFile, { force: true });
    process.stdout.write(`Resumed: ${cfg.pauseFile} removed. Queued work will start within a few seconds.\n`);
  }
  return 0;
}

function cmdLogs(opts) {
  const cfg = loadAll(opts);
  const file = path.join(cfg.logDir, "listener.log");
  if (!fs.existsSync(file)) {
    process.stderr.write(`no log yet at ${file}\n`);
    return 1;
  }
  const args = ["-n", String(opts.lines || 100)];
  if (opts.follow) args.push("-F");
  args.push(file);
  return new Promise((resolve) => {
    const child = spawn("tail", args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

// ------------------------------------------------------------------ test (dry run)

function testTargets(cfg, tokens, opts) {
  if (opts.agent) {
    const agent = cfg.agents[opts.agent] ?? { name: opts.agent, cli: "none", tokenEnv: opts.tokenEnv ?? `${opts.agent.toUpperCase()}_TOKEN` };
    if (opts.tokenEnv) agent.tokenEnv = opts.tokenEnv;
    return [{ agent, token: tokens[agent.tokenEnv] }];
  }
  return Object.values(cfg.agents)
    .filter((a) => a.enabled)
    .map((agent) => ({ agent, token: tokens[agent.tokenEnv] }));
}

async function cmdTest(opts) {
  const cfg = loadAll(opts);
  const tokens = loadTokens(cfg.tokensFile);
  const p = (s = "") => process.stdout.write(`${s}\n`);
  const state = readStateFile(cfg.stateFile);
  let failures = 0;
  p(`agent-bus-listener test (dry run; no CLI is started; state is not modified)`);
  p(`MCP: ${cfg.mcpUrl}`);
  for (const { agent, token } of testTargets(cfg, tokens, opts)) {
    p(`\n[${agent.name}] token ${agent.tokenEnv}: ${token ? "present" : "MISSING"}`);
    if (!token) {
      failures++;
      continue;
    }
    const st = state?.agents?.[agent.name] ?? {};
    if (!st.cursor) p("  (no listener state yet: this lists everything currently open; a real first start only reacts to items newer than its start time)");
    const ctx = { self: agent.name, ownerNames: cfg.ownerNames, ownerRoomPosts: cfg.ownerRoomPosts, ignoreTaskStatusNotices: cfg.ignoreTaskStatusNotices };
    const client = new McpClient({ url: cfg.mcpUrl, token });
    try {
      const t0 = Date.now();
      const init = await client.initialize({ timeoutMs: 20_000 });
      p(`  initialize: ok in ${Date.now() - t0} ms (server ${init?.serverInfo?.name ?? "?"} ${init?.serverInfo?.version ?? ""}, protocol ${client.protocolVersion}, session ${client.sessionId ? "stateful" : "stateless"})`);
      const tools = await client.listTools({ timeoutMs: 20_000 });
      const names = tools.map((t) => t.name);
      const missing = EXPECTED_TOOLS.filter((n) => !names.includes(n));
      p(`  tools/list: ${names.length} tools${missing.length ? `; MISSING: ${missing.join(", ")}` : "; all expected tools present"}`);
      if (missing.length) failures++;
      const sinceDefault = st.cursor ?? isoPlusMs(client.lastServerDate ?? new Date().toISOString(), -3600_000);
      const rooms = parseRoomList(await client.callTool("list_rooms", {}));
      p(`  list_rooms: ${rooms.length} room(s)${rooms.length ? `: ${rooms.map((r) => r.name).join(", ")}` : ""}`);
      const tasks = parseTaskList(await client.callTool("list_my_tasks", { status: "open" }));
      p(`  list_my_tasks(open): ${tasks.length}`);
      const would = [];
      for (const t of tasks) {
        const r = evaluateTask(t, st.taskStatus?.[t.id], ctx);
        if (r.trigger) would.push(r.trigger);
      }
      for (const room of rooms) {
        const since = st.roomCursors?.[room.name] ? isoPlusMs(st.roomCursors[room.name], 1) : sinceDefault;
        const msgs = parseRoomLog(await client.callTool("read_room", { room: room.name, since, limit: 50 }));
        const r = evaluateRoomMessages(room.name, msgs, ctx, st.lastAgentSpeaker?.[room.name] ?? null);
        p(`  read_room #${room.name} since ${since}: ${msgs.length} post(s), ${r.triggers.length} would trigger`);
        would.push(...r.triggers);
      }
      if (opts.poll) {
        const since = st.cursor ?? new Date().toISOString();
        const t1 = Date.now();
        const text = await client.callTool("wait_for_messages", { since, timeout_seconds: 2, mark_read: false }, { timeoutMs: 30_000 });
        const w = parseWait(text);
        const inline = w.roomMessagesInline ? `, inline room posts ${w.roomMessages.length}` : "";
        p(`  wait_for_messages(since ${since}, 2s): ${w.timedOut ? "timed out (no new items)" : "woke"} in ${Date.now() - t1} ms; cursor ${w.cursor}; ${w.messages.length} DM(s), ${w.tasks.length} task(s), rooms [${w.rooms.join(", ")}]${inline}`);
        for (const m of w.messages) {
          const r = evaluateDm(m, ctx);
          if (r.trigger) would.push(r.trigger);
        }
      } else {
        p("  wait_for_messages: skipped (non-consuming mode; pass --poll to exercise the long-poll)");
        p("  direct messages: not peeked (agent-bus has no non-consuming inbox read)");
      }
      p(`  would trigger ${would.length} item(s):`);
      for (const t of would) p(`    - ${t.uid} -> ${t.key}: ${t.reason}`);
    } catch (error) {
      failures++;
      p(`  ERROR: ${error.message}`);
    }
  }
  p(failures ? `\nFAILED (${failures} problem(s))` : "\nOK");
  return failures ? 1 : 0;
}

// ------------------------------------------------------------------ doctor

async function cmdDoctor(opts) {
  const results = [];
  const check = (ok, label, detail = "") => {
    results.push(ok);
    process.stdout.write(`${ok === true ? "OK  " : ok === "warn" ? "WARN" : "FAIL"}  ${label}${detail ? ` \u2014 ${detail}` : ""}\n`);
  };
  let cfg;
  try {
    cfg = loadAll(opts);
    check(true, "config", cfg.configFile ?? "no config.json found; using defaults");
  } catch (error) {
    check(false, "config", error.message);
    return 1;
  }
  const major = Number(process.versions.node.split(".")[0]);
  check(major >= 20 ? true : false, "node", `${process.execPath} ${process.version}${major >= 20 ? "" : " (need >= 20)"}`);
  const searchPath = [cfg.childPath, process.env.PATH].filter(Boolean).join(":");
  const tokens = fileExists(cfg.tokensFile) ? loadTokens(cfg.tokensFile) : {};
  if (fileExists(cfg.tokensFile)) {
    const mode = fs.statSync(cfg.tokensFile).mode & 0o777;
    check(mode & 0o077 ? "warn" : true, "tokens file", `${cfg.tokensFile} (mode ${mode.toString(8)})${mode & 0o077 ? "; consider chmod 600" : ""}`);
    check(true, "token names present", Object.keys(tokens).join(", ") || "(none)");
  } else check(false, "tokens file", `${cfg.tokensFile} not found`);
  for (const agent of Object.values(cfg.agents)) {
    if (!agent.enabled) {
      check("warn", `${agent.name}`, "disabled in config");
      continue;
    }
    check(tokens[agent.tokenEnv] ? true : false, `${agent.name} token`, `${agent.tokenEnv} ${tokens[agent.tokenEnv] ? "present" : "missing"}`);
    if (agent.cli === "none") continue;
    const bin = resolveBinary(agent.bin, searchPath);
    if (!bin) {
      check(agent.cli === "claude" ? "warn" : false, `${agent.name} CLI`, `"${agent.bin}" not found${agent.cli === "claude" ? " (claude will be skipped; see README to enable)" : ""}`);
      continue;
    }
    const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, PATH: searchPath } });
    check(v.status === 0 ? true : "warn", `${agent.name} CLI`, `${bin} ${(v.stdout || v.stderr || "").trim().split("\n")[0]}`);
    if (agent.cli === "claude") {
      const auth = readClaudeAuth(bin, { env: { ...process.env, PATH: searchPath } });
      check(auth.loggedIn ? true : false, `${agent.name} auth`, auth.detail);
    }
  }
  const codexCfg = path.join(os.homedir(), ".codex", "config.toml");
  if (cfg.agents.codex?.enabled) {
    const text = fileExists(codexCfg) ? fs.readFileSync(codexCfg, "utf8") : "";
    check(/agent[_-]bus/.test(text) ? true : "warn", "codex agent-bus MCP config", fileExists(codexCfg) ? (/agent[_-]bus/.test(text) ? `${codexCfg} mentions agent_bus` : `${codexCfg} has no agent_bus MCP server`) : `${codexCfg} missing`);
  }
  check(fileExists(cfg.workspace) ? true : "warn", "workspace", `${cfg.workspace}${fileExists(cfg.workspace) ? "" : " (will be created on start)"}`);
  try {
    fs.mkdirSync(cfg.logDir, { recursive: true });
    fs.accessSync(cfg.logDir, fs.constants.W_OK);
    check(true, "logs dir", cfg.logDir);
  } catch (error) {
    check(false, "logs dir", `${cfg.logDir}: ${error.message}`);
  }
  check(fs.existsSync(cfg.pauseFile) ? "warn" : true, "kill switch", fs.existsSync(cfg.pauseFile) ? `PAUSED (${cfg.pauseFile} exists)` : "not paused");
  const plist = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  check(fileExists(plist) ? true : "warn", "LaunchAgent plist", fileExists(plist) ? plist : `${plist} not installed`);
  const lc = launchctlState();
  if (lc.available) check(lc.loaded ? true : "warn", "launchctl", lc.text);
  // MCP reachability: initialize + tools/list only (non-consuming).
  const probe = Object.values(cfg.agents).map((a) => ({ a, t: tokens[a.tokenEnv] })).find((x) => x.t) ?? (opts.agent && tokens[opts.tokenEnv ?? ""] ? { a: { name: opts.agent }, t: tokens[opts.tokenEnv] } : null);
  if (probe) {
    try {
      const client = new McpClient({ url: cfg.mcpUrl, token: probe.t });
      const t0 = Date.now();
      await client.initialize({ timeoutMs: 20_000 });
      const tools = await client.listTools({ timeoutMs: 20_000 });
      check(true, "MCP reachable", `${cfg.mcpUrl} as ${probe.a.name}: ${tools.length} tools in ${Date.now() - t0} ms`);
    } catch (error) {
      check(false, "MCP reachable", `${cfg.mcpUrl}: ${error.message}`);
    }
  } else check(false, "MCP reachable", "no token available to probe with");
  process.stdout.write(`\npackage: ${packageRoot()}\n`);
  return results.includes(false) ? 1 : 0;
}

/** Local readiness. Does not call agent-bus. A missing Claude binary is a warning; a present but logged-out CLI fails. */
function cmdHealth(opts) {
  let cfg;
  try {
    cfg = loadAll(opts);
  } catch (error) {
    process.stdout.write(`FAIL  config \u2014 ${error.message}\n`);
    return 1;
  }
  let failed = false;
  const line = (ok, label, detail = "") => {
    if (ok === false) failed = true;
    process.stdout.write(`${ok === true ? "OK  " : ok === "warn" ? "WARN" : "FAIL"}  ${label}${detail ? ` \u2014 ${detail}` : ""}\n`);
  };
  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 20, "node", `${process.execPath} ${process.version}${major >= 20 ? "" : " (need >= 20)"}`);
  const searchPath = [cfg.childPath, process.env.PATH].filter(Boolean).join(":");
  const tokens = fileExists(cfg.tokensFile) ? loadTokens(cfg.tokensFile) : {};
  if (!fileExists(cfg.tokensFile)) line(false, "tokens file", `${cfg.tokensFile} not found`);
  else line(true, "token names present", Object.keys(tokens).join(", ") || "(none)");
  let sawAgent = false;
  for (const agent of Object.values(cfg.agents)) {
    if (opts.agent && agent.name !== opts.agent) continue;
    sawAgent = true;
    if (!agent.enabled) {
      line("warn", agent.name, "disabled in config");
      continue;
    }
    line(tokens[agent.tokenEnv] ? true : false, `${agent.name} token`, `${agent.tokenEnv} ${tokens[agent.tokenEnv] ? "present" : "missing"}`);
    if (agent.cli === "none") continue;
    const bin = resolveBinary(agent.bin, searchPath);
    if (!bin) {
      line(agent.cli === "claude" ? "warn" : false, `${agent.name} CLI`, `"${agent.bin}" not found${agent.cli === "claude" ? " (claude will be skipped until it is installed)" : ""}`);
      continue;
    }
    const v = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, PATH: searchPath } });
    const version = (v.stdout || v.stderr || "").trim().split("\n")[0];
    line(v.status === 0, `${agent.name} CLI`, `${bin} ${version}`);
    if (agent.cli === "claude") {
      const auth = readClaudeAuth(bin, { env: { ...process.env, PATH: searchPath } });
      line(auth.loggedIn, `${agent.name} auth`, auth.detail);
      if (agent.dangerouslySkipPermissions === true) line("warn", `${agent.name} permissions`, "dangerouslySkipPermissions is on (--dangerously-skip-permissions)");
      else line(true, `${agent.name} permissions`, `--permission-mode ${agent.permissionMode || "dontAsk"}; allowlist ${claudeAllowedTools(agent).join(", ") || "(empty)"}`);
    }
  }
  if (!sawAgent) line(false, "agents", opts.agent ? `no agent named ${opts.agent}` : "none configured");
  return failed ? 1 : 0;
}
