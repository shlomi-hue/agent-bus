import fs from "node:fs";
import path from "node:path";
import { McpClient, McpError } from "./mcp-client.js";
import { parseWait, parseRoomLog, parseInbox } from "./parse.js";
import { evaluateDm, evaluateRoomMessages, evaluateTask } from "./triggers.js";
import { TriggerQueue, RateLimiter, Backoff } from "./queue.js";
import { runProcess, killAllChildren } from "./runner.js";
import {
  buildCodexCommand,
  buildClaudeCommand,
  extractCodexSessionId,
  extractClaudeSessionId,
  isResumeFailure,
  writeClaudeMcpConfig,
  newClaudeSessionId,
  assessClaudeResult,
  readClaudeAuth,
  claudeAllowedTools,
} from "./agents.js";
import { buildPrompt, describeConversation } from "./prompt.js";
import { Waker, sleep, isoPlusMs, maxIso, resolveBinary, truncate } from "./util.js";
import { pruneDir } from "./logger.js";

const STATUS_LISTENING = "listening (agent-bus-listener)";
const STATUS_OFFLINE = "offline (agent-bus-listener stopped)";

export function childEnv({ cfg, agent, token, allTokenEnvNames = [], base = process.env, sessionKey }) {
  const env = { ...base };
  for (const name of allTokenEnvNames) delete env[name];
  delete env.AGENT_BUS_TOKEN;
  if (cfg.childPath) env.PATH = cfg.childPath;
  env.AGENT_BUS_URL = cfg.mcpUrl;
  env.AGENT_BUS_TOKEN = token;
  if (agent.tokenEnv) env[agent.tokenEnv] = token;
  env.AGENT_BUS_AGENT = agent.name;
  env.AGENT_BUS_LISTENER_RUN = "1";
  if (sessionKey) env.AGENT_BUS_SESSION_KEY = sessionKey;
  return env;
}

export class AgentLoop {
  /**
   * @param {object} o
   * @param {object} o.cfg normalized config
   * @param {object} o.agent agent config (name, cli, bin, tokenEnv, ...)
   * @param {string} o.token agent-bus token (never logged)
   * @param {import('./state.js').StateStore} o.store
   * @param {object} o.log logger child
   * @param {object} [o.client] McpClient (injectable)
   * @param {Function} [o.run] runProcess (injectable)
   * @param {boolean} [o.dryRun] never start CLIs
   */
  constructor({ cfg, agent, token, store, log, client, run = runProcess, dryRun = false, allTokenEnvNames = [] }) {
    this.cfg = cfg;
    this.agent = agent;
    this.name = agent.name;
    this.token = token;
    this.store = store;
    this.log = log;
    this.client = client ?? new McpClient({ url: cfg.mcpUrl, token, requestTimeoutMs: 30_000 });
    this.run = run;
    this.dryRun = dryRun;
    this.allTokenEnvNames = allTokenEnvNames;
    this.st = store.agent(this.name);
    this.queue = TriggerQueue.fromJSON(this.st.queue, { maxTriggersPerEntry: 50 });
    if (this.st.running) {
      // Crashed mid-run last time: put that work back so nothing marked read is lost.
      this.queue.requeue(this.st.running);
      this.st.running = null;
    }
    this.limiter = new RateLimiter({ max: cfg.maxRunsPerHour, windowMs: 3600_000, history: this.st.runHistory });
    this.backoff = new Backoff(cfg.backoff);
    this.pollWaker = new Waker();
    this.workWaker = new Waker();
    this.abort = new AbortController(); // CLI runs + sleeps: aborted immediately on stop
    this.netAbort = new AbortController(); // in-flight agent-bus requests: aborted only after a grace period
    this.stopping = false;
    this.current = null; // running entry
    this.lastPausedLog = 0;
    this.lastLimitLog = 0;
    this.idleWakes = 0;
  }

  get paused() {
    return fs.existsSync(this.cfg.pauseFile);
  }

  persist() {
    this.st.queue = this.queue.toJSON();
    this.st.runHistory = this.limiter.history;
    this.st.running = this.current;
    try {
      this.store.save();
    } catch (error) {
      this.log.error(`could not save state: ${error.message}`);
    }
  }

  async setStatus(status, text) {
    if (this.dryRun) return; // dry runs never write presence
    try {
      await this.client.callTool("set_status", { status, text: truncate(text, 190).split("\n")[0] }, { timeoutMs: 10_000 });
      this.st.status = { status, text, at: new Date().toISOString() };
    } catch (error) {
      this.log.warn(`set_status ${status} failed: ${error.message}`);
    }
  }

  /** Connect (with backoff) and establish the baseline cursor. */
  async connect() {
    while (!this.stopping) {
      try {
        await this.client.initialize({ signal: this.netAbort.signal, timeoutMs: 20_000 });
        this.backoff.reset();
        const serverNow = this.client.lastServerDate ?? new Date().toISOString();
        if (!this.st.cursor) {
          // First start: only react to things that arrive from now on (the backlog stays unread for the agent).
          this.st.cursor = isoPlusMs(serverNow, -2000);
          this.st.baselineAt = this.st.cursor;
          this.log.info(`first start: baseline cursor ${this.st.cursor} (older unread mail is left untouched)`);
        } else {
          const floor = new Date(Date.parse(serverNow) - this.cfg.maxCatchupHours * 3600_000).toISOString();
          if (Date.parse(this.st.cursor) < Date.parse(floor)) {
            this.log.warn(`cursor ${this.st.cursor} older than ${this.cfg.maxCatchupHours}h; clamping to ${floor}`);
            this.st.cursor = floor;
          }
          this.log.info(`resuming from cursor ${this.st.cursor}`);
        }
        this.persist();
        return true;
      } catch (error) {
        const delay = this.backoff.next();
        this.log.warn(`connect failed (${error.message}); retrying in ${Math.round(delay / 1000)}s`);
        await sleep(delay, this.abort.signal);
      }
    }
    return false;
  }

  async start() {
    this.log.info(`starting (cli=${this.agent.cli}${this.dryRun ? ", dry-run" : ""}, bin=${this.agent.resolvedBin ?? this.agent.bin ?? "-"})`);
    if (!(await this.connect())) return;
    await this.setStatus("available", STATUS_LISTENING);
    this.persist();
    await Promise.all([this.pollLoop(), this.workerLoop()]);
  }

  /**
   * Stop. An in-flight wait_for_messages is allowed to finish (up to graceMs). Older servers mark
   * returned direct messages read even if the response is lost; finishing the call lets us persist
   * those triggers. A server that honors mark_read false does not consume them.
   */
  async stop({ graceMs = (this.cfg.waitSeconds + 5) * 1000 } = {}) {
    if (this.stopping) return;
    this.stopping = true;
    this.abort.abort();
    this.pollWaker.wake();
    this.workWaker.wake();
    const t = setTimeout(() => this.netAbort.abort(), graceMs);
    t.unref?.();
  }

  async shutdownStatus() {
    await this.setStatus("away", STATUS_OFFLINE);
    this.persist();
  }

  // ---------------------------------------------------------------- polling

  async pollLoop() {
    let lastPollAt = 0;
    while (!this.stopping) {
      if (this.current) {
        const gap = this.cfg.pollIntervalWhileRunningSeconds * 1000 - (Date.now() - lastPollAt);
        if (gap > 0) {
          await this.pollWaker.wait(gap);
          continue;
        }
      }
      lastPollAt = Date.now();
      try {
        const result = await this.pollOnce();
        this.backoff.reset();
        if (this.stopping) break;
        if (!this.current) await this.maybeReconcile();
        if (result.immediate && result.newTriggers === 0) {
          this.idleWakes++;
          await this.pollWaker.wait(this.idleWakes > 5 ? 10_000 : this.cfg.minPollGapMs);
        } else {
          this.idleWakes = 0;
        }
      } catch (error) {
        if (this.stopping) break;
        let delay = this.backoff.next();
        if (error instanceof McpError && error.kind === "rate_limited") delay = Math.max(delay, 20_000);
        if (error instanceof McpError && error.kind === "auth") delay = this.cfg.backoff.maxMs;
        this.log.warn(`poll failed (${error.message}); backing off ${Math.round(delay / 1000)}s`);
        await this.pollWaker.wait(delay);
      }
    }
  }

  /**
   * One wait_for_messages long-poll. Returns {immediate, newTriggers}.
   * Asks the server not to mark direct messages read. Older servers ignore mark_read and still consume
   * them; the response text says so, and every DM is queued here or logged as skipped.
   */
  async pollOnce() {
    const started = Date.now();
    const since = this.st.cursor;
    const text = await this.client.callTool(
      "wait_for_messages",
      { since, timeout_seconds: this.cfg.waitSeconds, mark_read: false },
      { timeoutMs: (this.cfg.waitSeconds + 25) * 1000, signal: this.netAbort.signal },
    );
    const wake = parseWait(text);
    this.st.lastPollAt = new Date().toISOString();
    const stamps = [];
    let added = 0;
    const precise = typeof wake.cursor === "string" && /\.\d{6}Z$/.test(wake.cursor);

    const dmThreadBySourceId = new Map();
    for (const m of wake.messages) {
      stamps.push(m.createdAt);
      dmThreadBySourceId.set(m.id, m.threadId);
      added += this.consider(`dm:${m.id}`, () => {
        const res = evaluateDm(m, this.ctx());
        if (res.trigger) res.trigger.markedRead = wake.markedRead;
        return res;
      }, m);
    }

    for (const t of wake.tasks) {
      if (t.updatedAt) stamps.push(t.updatedAt);
      const prev = this.st.taskStatus[t.id];
      const res = evaluateTask(t, prev, this.ctx(), { dmThreadBySourceId });
      if (res.trigger) {
        if (t.threadId) res.trigger.threadId = t.threadId;
        if (t.updatedAt) res.trigger.createdAt = t.updatedAt;
      }
      this.st.taskStatus[t.id] = t.status;
      if (res.trigger) added += this.enqueue(res.trigger);
      else this.log.debug(`task ${t.id} skipped: ${res.skip}`);
    }

    const inlineByRoom = new Map();
    for (const message of wake.roomMessages) {
      const list = inlineByRoom.get(message.room) ?? [];
      list.push(message);
      inlineByRoom.set(message.room, list);
    }
    const roomNames = wake.roomMessagesInline
      ? [...new Set([...wake.rooms, ...inlineByRoom.keys()])]
      : wake.rooms;
    for (const room of roomNames) {
      let msgs = inlineByRoom.get(room) ?? [];
      const needRead = !wake.roomMessagesInline || wake.truncatedRooms.includes(room) || (wake.rooms.includes(room) && msgs.length === 0);
      if (needRead) {
        const roomSince = msgs.at(-1)?.createdAt
          ?? (this.st.roomCursors[room] ? (precise ? this.st.roomCursors[room] : isoPlusMs(this.st.roomCursors[room], 1)) : since);
        const extra = await this.readRoomSince(room, roomSince, { exact: precise });
        const seen = new Set(msgs.map((message) => message.id));
        msgs = [...msgs, ...extra.filter((message) => !seen.has(message.id))];
      }
      const fresh = msgs.filter((m) => !this.st.seen[`room:${m.id}`]);
      const res = evaluateRoomMessages(room, fresh, this.ctx(), this.st.lastAgentSpeaker[room] ?? null);
      this.st.lastAgentSpeaker[room] = res.lastAgentSpeaker;
      for (const m of fresh) this.st.seen[`room:${m.id}`] = Date.now();
      for (const t of res.triggers) added += this.enqueue(t);
      for (const s of res.skipped) this.log.debug(`room post ${s.id} skipped: ${s.reason}`);
      const lastStamp = maxIso(this.st.roomCursors[room], ...msgs.map((m) => m.createdAt));
      if (lastStamp) {
        this.st.roomCursors[room] = lastStamp;
        stamps.push(lastStamp);
      }
    }

    // A precise inline cursor already includes room posts at full resolution. Older servers truncate
    // to milliseconds and omit room timestamps, so keep the +1 ms workaround there.
    if (wake.roomMessagesInline && precise) {
      this.st.cursor = wake.cursor;
    } else {
      const next = maxIso(since, wake.cursor, ...stamps);
      if (next && Date.parse(next) > Date.parse(since)) this.st.cursor = isoPlusMs(next, 1);
    }
    if (added > 0) this.workWaker.wake();
    this.persist();
    return { immediate: Date.now() - started < 1000 && !wake.timedOut, newTriggers: added, wake };
  }

  async readRoomSince(room, since, { exact = false } = {}) {
    const all = [];
    let cursor = since;
    for (let page = 0; page < 5; page++) {
      const text = await this.client.callTool("read_room", { room, since: cursor, limit: 100 }, { timeoutMs: 20_000, signal: this.netAbort.signal });
      const msgs = parseRoomLog(text);
      all.push(...msgs);
      if (msgs.length < 100) break;
      const last = maxIso(...msgs.map((m) => m.createdAt));
      cursor = exact && typeof last === "string" && /\.\d{6}Z$/.test(last) ? last : isoPlusMs(last, 1);
    }
    return all;
  }

  ctx() {
    return {
      self: this.name,
      ownerNames: this.cfg.ownerNames,
      ownerRoomPosts: this.cfg.ownerRoomPosts,
      ignoreTaskStatusNotices: this.cfg.ignoreTaskStatusNotices,
    };
  }

  consider(uid, evaluate, msg) {
    if (this.st.seen[uid]) return 0;
    this.st.seen[uid] = Date.now();
    const res = evaluate();
    if (res.trigger) return this.enqueue(res.trigger);
    this.log.info(`skip ${uid} from ${msg?.from ?? "?"}: ${res.skip}`);
    return 0;
  }

  enqueue(trigger) {
    this.st.seen[trigger.uid] = Date.now();
    const isNew = this.queue.add(trigger);
    if (isNew) {
      this.log.info(`trigger ${trigger.uid} -> ${trigger.key}: ${trigger.reason}${this.current?.key === trigger.key ? " (queued behind the running session)" : ""}`);
    }
    return isNew ? 1 : 0;
  }

  /** Find direct messages that are still unacked but were never dispatched (e.g. read by someone else). */
  async maybeReconcile() {
    const rc = this.cfg.reconcile;
    if (!rc?.enabled) return;
    const last = this.st.lastReconcileAt ? Date.parse(this.st.lastReconcileAt) : 0;
    if (Date.now() - last < rc.intervalSeconds * 1000) return;
    this.st.lastReconcileAt = new Date().toISOString();
    const floor = maxIso(this.st.baselineAt, new Date(Date.now() - rc.windowHours * 3600_000).toISOString());
    try {
      const text = await this.client.callTool("read_inbox", { unread_only: false, since: floor, limit: 100, mark_read: false }, { timeoutMs: 20_000, signal: this.netAbort.signal });
      let added = 0;
      for (const m of parseInbox(text)) {
        if (m.acked || this.st.seen[`dm:${m.id}`]) continue;
        if (Date.now() - Date.parse(m.createdAt) < rc.graceSeconds * 1000) continue;
        added += this.consider(`dm:${m.id}`, () => {
          const res = evaluateDm(m, this.ctx());
          if (res.trigger) res.trigger.reason += " (unacked; found by reconcile)";
          return res;
        }, m);
      }
      if (added > 0) {
        this.log.info(`reconcile queued ${added} unacked direct message(s)`);
        this.workWaker.wake();
      }
      this.persist();
    } catch (error) {
      this.log.warn(`reconcile failed: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------- work

  async workerLoop() {
    while (!this.stopping) {
      if (this.queue.size === 0) {
        await this.workWaker.wait(60_000);
        continue;
      }
      if (this.paused) {
        if (Date.now() - this.lastPausedLog > 300_000) {
          this.log.info(`PAUSE file present (${this.cfg.pauseFile}); not starting runs. ${this.queue.size} conversation(s) queued.`);
          this.lastPausedLog = Date.now();
        }
        await this.workWaker.wait(5000);
        continue;
      }
      const limitWait = this.limiter.waitMs();
      if (limitWait > 0) {
        if (Date.now() - this.lastLimitLog > 300_000) {
          this.log.warn(`run rate limit reached (${this.cfg.maxRunsPerHour}/hour); next slot in ${Math.ceil(limitWait / 60000)} min. ${this.queue.size} queued.`);
          this.lastLimitLog = Date.now();
        }
        await this.workWaker.wait(Math.min(limitWait, 60_000));
        continue;
      }
      const entry = this.queue.take();
      if (!entry) {
        await this.workWaker.wait(Math.max(100, Math.min(this.queue.nextReadyAt() - Date.now(), 60_000)));
        continue;
      }
      await this.processEntry(entry);
      // After a run, poll again right away for anything that arrived meanwhile.
      this.pollWaker.wake();
    }
  }

  async processEntry(entry) {
    const agentOnly = entry.triggers.every((t) => !t.fromOwner);
    const chain = this.st.chain[entry.key] ?? 0;
    if (agentOnly && chain >= this.cfg.maxAgentOnlyRunsPerThread) {
      this.log.warn(
        `loop guard: ${chain} consecutive agent-only runs in ${entry.key}; dropping ${entry.triggers.length} agent trigger(s) until the owner posts there`,
      );
      this.persist();
      return { skipped: "loop-guard" };
    }
    if (this.dryRun || this.agent.cli === "none") {
      this.log.info(`[dry-run] would run ${this.agent.cli} for ${entry.key} with ${entry.triggers.length} trigger(s)`);
      this.persist();
      return { skipped: "dry-run" };
    }
    this.current = entry;
    this.limiter.record();
    this.persist();
    let outcome;
    try {
      await this.setStatus("busy", `working on ${describeConversation(entry.key)}`);
      outcome = await this.runCli(entry);
    } catch (error) {
      outcome = { ok: false, error: error.message };
      this.log.error(`run for ${entry.key} crashed: ${error.stack ?? error.message}`);
    } finally {
      this.current = null;
    }
    this.st.chain[entry.key] = agentOnly ? chain + 1 : 0;
    this.st.lastRun = {
      key: entry.key,
      at: new Date().toISOString(),
      ok: outcome.ok,
      code: outcome.code ?? null,
      timedOut: Boolean(outcome.timedOut),
      durationMs: outcome.durationMs ?? null,
      sessionId: outcome.sessionId ?? null,
      triggers: entry.triggers.length,
      log: outcome.logFile ?? null,
    };
    if (!outcome.ok && !this.stopping) {
      entry.attempts = (entry.attempts ?? 0) + 1;
      if (entry.attempts < this.cfg.maxAttempts) {
        const delay = Math.min(30 * 60_000, 60_000 * 2 ** (entry.attempts - 1));
        this.queue.requeue(entry, { notBefore: Date.now() + delay });
        this.log.warn(`run for ${entry.key} failed (attempt ${entry.attempts}/${this.cfg.maxAttempts}); retrying in ${Math.round(delay / 1000)}s`);
      } else {
        this.log.error(`run for ${entry.key} failed ${entry.attempts} times; dropping ${entry.triggers.length} trigger(s). See ${outcome.logFile ?? "logs"}`);
      }
    } else if (!outcome.ok && this.stopping) {
      this.queue.requeue(entry);
    }
    if (!this.stopping) await this.setStatus("available", STATUS_LISTENING);
    this.persist();
    return outcome;
  }

  runLogPath(entry) {
    const dir = path.join(this.cfg.logDir, "runs");
    fs.mkdirSync(dir, { recursive: true });
    pruneDir(dir, this.cfg.log.keepRunLogs ?? 100, (n) => n.endsWith(".log"));
    const safeKey = entry.key.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60);
    return path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${this.name}-${safeKey}.log`);
  }

  async runCli(entry) {
    const cli = this.agent.cli;
    const bin = this.agent.resolvedBin ?? this.agent.bin;
    const session = this.st.sessions[entry.key]?.cli === cli ? this.st.sessions[entry.key] : null;
    const logFile = this.runLogPath(entry);
    const redact = (s) => this.log.redact?.(s) ?? s;
    const writeLog = (s) => {
      try {
        fs.appendFileSync(logFile, redact(s), { mode: 0o600 });
      } catch {
        /* ignore */
      }
    };
    fs.mkdirSync(this.cfg.workspace, { recursive: true });
    fs.mkdirSync(this.cfg.runDir, { recursive: true, mode: 0o700 });

    let mcpConfigPath = null;
    const attempts = session ? [session.id, null] : [null];
    let last = null;
    try {
      if (cli === "claude") {
        mcpConfigPath = writeClaudeMcpConfig({ runDir: this.cfg.runDir, serverName: this.agent.mcpServerName ?? "agent_bus", url: this.cfg.mcpUrl, token: this.token });
      }
      for (const resumeId of attempts) {
        const prompt = buildPrompt({
          agentName: this.name,
          entry,
          workspace: this.cfg.workspace,
          ownerNames: this.cfg.ownerNames,
          resumed: Boolean(resumeId),
          maxBodyChars: this.cfg.prompt.maxBodyChars,
          maxItems: this.cfg.prompt.maxItems,
          access: cli === "claude" ? claudeAccess(this.agent) : { kind: "codex" },
        });
        let cmd;
        let newSessionId = null;
        const lastMessageFile = path.join(this.cfg.runDir, `${this.name}-last-${process.pid}.txt`);
        if (cli === "codex") {
          cmd = buildCodexCommand({ agent: { ...this.agent, bin }, workspace: this.cfg.workspace, sessionId: resumeId, lastMessageFile });
        } else {
          newSessionId = resumeId ? null : newClaudeSessionId();
          cmd = buildClaudeCommand({ agent: { ...this.agent, bin }, sessionId: resumeId, newSessionId, mcpConfigPath });
        }
        this.log.info(`run ${cli} for ${entry.key} (${resumeId ? `resume ${resumeId}` : "new session"}, ${entry.triggers.length} trigger(s)) log=${logFile}`);
        writeLog(`# ${new Date().toISOString()} agent=${this.name} key=${entry.key}\n# argv: ${JSON.stringify([cmd.bin, ...cmd.args])}\n# --- prompt ---\n${prompt}\n# --- output ---\n`);
        const result = await this.run({
          bin: cmd.bin,
          args: cmd.args,
          cwd: this.cfg.workspace,
          env: childEnv({ cfg: this.cfg, agent: this.agent, token: this.token, allTokenEnvNames: this.allTokenEnvNames, sessionKey: entry.key }),
          input: prompt,
          timeoutMs: this.cfg.runTimeoutMinutes * 60_000,
          killGraceMs: this.cfg.killGraceSeconds * 1000,
          signal: this.abort.signal,
          onStdout: (c) => writeLog(c),
          onStderr: (c) => writeLog(c),
        });
        last = { result, newSessionId, lastMessageFile };
        if (resumeId && isResumeFailure(cli, result)) {
          this.log.warn(`resume of ${resumeId} failed for ${entry.key}; starting a fresh session`);
          writeLog(`\n# resume failed (exit ${result.code}); retrying with a fresh session\n`);
          delete this.st.sessions[entry.key];
          continue;
        }
        break;
      }
    } finally {
      if (mcpConfigPath) fs.rmSync(mcpConfigPath, { force: true });
    }

    const { result, newSessionId, lastMessageFile } = last;
    let sessionId = cli === "codex" ? extractCodexSessionId(result.stdout) : extractClaudeSessionId(result.stdout);
    if (!sessionId && newSessionId && result.code === 0) sessionId = newSessionId;
    if (sessionId) {
      const prev = this.st.sessions[entry.key];
      this.st.sessions[entry.key] = {
        id: sessionId,
        cli,
        createdAt: prev?.id === sessionId ? prev.createdAt : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runs: (prev?.id === sessionId ? prev.runs ?? 0 : 0) + 1,
      };
    }
    let ok = result.code === 0 && !result.timedOut && !result.error;
    if (cli === "claude" && ok) {
      const assessed = assessClaudeResult(result.stdout);
      if (!assessed.ok) {
        ok = false;
        this.log.warn(`claude result for ${entry.key} rejected (${assessed.reason})`);
      }
    }
    let lastMessage = "";
    try {
      lastMessage = fs.readFileSync(lastMessageFile, "utf8");
      fs.rmSync(lastMessageFile, { force: true });
    } catch {
      /* not produced */
    }
    writeLog(`\n# exit=${result.code} signal=${result.signal ?? "-"} timedOut=${result.timedOut} durationMs=${result.durationMs}${result.error ? ` error=${result.error}` : ""}\n`);
    if (lastMessage) writeLog(`# --- last message ---\n${lastMessage}\n`);
    const summary = `${cli} for ${entry.key} finished: exit=${result.code}${result.timedOut ? " (TIMED OUT, process group killed)" : ""} in ${Math.round(result.durationMs / 1000)}s session=${sessionId ?? "-"}`;
    if (ok) this.log.info(summary);
    else this.log.warn(`${summary}${result.error ? ` error=${result.error}` : ""}`);
    return { ok, code: result.code, timedOut: result.timedOut, durationMs: result.durationMs, sessionId, logFile };
  }
}

/** Resolve which agents can run on this machine. */
export function planAgents(cfg, tokens, log) {
  const plans = [];
  for (const agent of Object.values(cfg.agents)) {
    if (!agent.enabled) {
      log.info(`${agent.name}: disabled in config`);
      continue;
    }
    const token = tokens[agent.tokenEnv];
    if (!token) {
      log.warn(`${agent.name}: ${agent.tokenEnv} not found in ${cfg.tokensFile}; skipping`);
      continue;
    }
    if (agent.cli !== "none") {
      const searchPath = [cfg.childPath, process.env.PATH].filter(Boolean).join(":");
      const resolved = resolveBinary(agent.bin, searchPath);
      if (!resolved) {
        log.warn(`${agent.name}: ${agent.cli} CLI not found (bin "${agent.bin}"); skipping ${agent.name}. See README "Enabling claude" / health.`);
        continue;
      }
      if (agent.cli === "claude") {
        const auth = readClaudeAuth(resolved, { env: { ...process.env, PATH: searchPath } });
        if (!auth.loggedIn) {
          log.warn(`${agent.name}: Claude Code at ${resolved} is not authenticated (${auth.detail}); skipping ${agent.name}`);
          continue;
        }
        log.info(`${agent.name}: Claude Code authenticated (${auth.detail})`);
      }
      agent.resolvedBin = resolved;
    }
    plans.push({ agent, token });
  }
  return plans;
}

function claudeAccess(agent) {
  return {
    kind: "claude",
    bypass: agent.dangerouslySkipPermissions === true,
    permissionMode: agent.permissionMode || "dontAsk",
    allowedTools: claudeAllowedTools(agent),
    mcpServerName: agent.mcpServerName || "agent_bus",
  };
}

export { killAllChildren };
