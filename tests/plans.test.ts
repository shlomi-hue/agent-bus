import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashToken, mintToken } from "../src/auth/tokens.js";
import { transitionPlan } from "../src/bus/plan-status.js";
import { parseResultPayload } from "../src/bus/results.js";
import { AgentBus, type Caller } from "../src/bus/service.js";
import { loadConfig } from "../src/config.js";
import { applyMigrations } from "../src/db/migrate.js";
import { MemoryStore } from "../src/db/memory-store.js";
import { PgStore } from "../src/db/pg-store.js";
import type { Agent, SqlClient } from "../src/db/types.js";
import { createApp } from "../src/http/app.js";
import { signSession } from "../src/http/session.js";
import { callTool } from "../src/mcp/tools.js";
import { planDeliveries } from "../src/wake/plan.js";

const PASSWORD = "owner-password-value";

function ownerPost(cookie: string, body = "{}"): RequestInit {
  return { method: "POST", headers: { cookie, "content-type": "application/json" }, body };
}

describe("plan state machine", () => {
  it("walks pending to approved, rejected, executing, paused, and done", () => {
    expect(transitionPlan("pending", "approve")).toBe("approved");
    expect(transitionPlan("pending", "reject")).toBe("rejected");
    expect(transitionPlan("approved", "start")).toBe("executing");
    expect(transitionPlan("executing", "pause")).toBe("paused");
    expect(transitionPlan("paused", "resume")).toBe("executing");
    expect(transitionPlan("executing", "complete")).toBe("done");
    expect(transitionPlan("paused", "complete")).toBe("done");
    expect(() => transitionPlan("rejected", "approve")).toThrow(/Cannot approve a plan that is rejected/);
    expect(() => transitionPlan("pending", "start")).toThrow(/Cannot start/);
    expect(transitionPlan("done", "reopen")).toBe("executing");
    expect(() => transitionPlan("done", "complete")).toThrow(/Cannot complete/);
    expect(() => transitionPlan("approved", "reject")).toThrow(/Cannot reject/);
  });
});

async function fixture() {
  const store = new MemoryStore();
  const config = loadConfig({
    OWNER_NAME: "owner",
    RATE_LIMIT_MAX: "100",
    ROOM_AGENT_CAP: "20",
    WAIT_MAX_SECONDS: "1",
  });
  const bus = new AgentBus(store, config, async (message, tasks) => {
    const rows = await planDeliveries({ store, message, tasks, ownerName: config.ownerName });
    if (rows.length > 0) await store.enqueueDeliveries(rows);
  });
  const owner = await store.insertAgent({
    name: "owner",
    description: "",
    tokenHash: hashToken(mintToken()),
    isHuman: true,
  });
  const codex = await store.insertAgent({ name: "codex", description: "", tokenHash: hashToken(mintToken()) });
  const claude = await store.insertAgent({ name: "claude", description: "", tokenHash: hashToken(mintToken()) });
  const grok = await store.insertAgent({ name: "grok", description: "", tokenHash: hashToken(mintToken()) });
  const caller = (agent: Agent): Caller => ({ id: agent.id, name: agent.name, isHuman: agent.isHuman });
  await callTool(bus, caller(owner), "create_room", { name: "build" }, config);
  for (const agent of [codex, claude, grok]) {
    await callTool(bus, caller(owner), "add_member", { room: "build", agent: agent.name }, config);
    await store.setWebhook(agent.id, `https://example.com/hooks/${agent.name}`, "webhook-secret-value");
  }
  const app = createApp({
    store,
    config,
    env: { OWNER_PASSWORD: PASSWORD, OWNER_NAME: "owner", CHAT_SSE_MS: "250", CHAT_SSE_POLL_MS: "40" },
  });
  const cookie = `ab_session=${signSession("owner", PASSWORD)}`;
  return { store, config, bus, app, cookie, owner, codex, claude, grok, caller };
}

const rollout = {
  room: "build",
  title: "Presence v2 rollout",
  summary: "Presence reflects real work. No polling from the browser.",
  tasks: [
    { title: "SSE heartbeat endpoint", assignee: "codex", estimate: "1h" },
    { title: "Sidebar presence states", assignee: "claude", estimate: "35m", depends_on: "AB-101" },
    { title: "Cost model", assignee: "codex", estimate: "20m" },
  ],
};

describe("plans, results, and owner routes", () => {
  let previousFetch: typeof fetch;
  beforeEach(() => {
    previousFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("ok", { status: 200 });
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  it("proposes a plan, lets the owner edit and approve, and wakes the assignees", async () => {
    const { store, config, bus, app, cookie, owner, codex, claude, caller } = await fixture();
    const proposed = await callTool(bus, caller(claude), "propose_plan", rollout, config);
    expect(proposed.isError).toBeUndefined();
    expect(proposed.content[0]?.text).toContain("is pending");
    expect(proposed.content[0]?.text).toContain("BEGIN UNTRUSTED PLAN");
    expect(await store.listTasks({})).toHaveLength(0);

    const planId = proposed.content[0]?.text.match(/Plan ([0-9a-f-]{36})/)?.[1] ?? "";
    const edited = await app.request(`/chat/api/plans/${planId}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        tasks: [
          { title: "SSE heartbeat endpoint + client reconnect", assignee: "codex", estimate: "1h 10m" },
          { title: "Sidebar presence states", assignee: "claude", estimate: "35m" },
        ],
      }),
    });
    expect(edited.status).toBe(200);

    const approved = await app.request(`/chat/api/plans/${planId}/approve`, ownerPost(cookie));
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as {
      plan: { status: string; items: Array<{ code: string; taskId: string | null; title: string }> };
      tasks: Array<{ id: string; code: string; assigneeName: string; slot: string; creatorName: string }>;
    };
    expect(body.plan.status).toBe("executing");
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks.map((task) => task.assigneeName).sort()).toEqual(["claude", "codex"]);
    expect(body.tasks.every((task) => task.creatorName === "owner")).toBe(true);
    expect(new Set(body.tasks.map((task) => task.code)).size).toBe(2);
    expect(body.plan.items.every((item) => item.taskId)).toBe(true);

    const again = await app.request(`/chat/api/plans/${planId}/approve`, ownerPost(cookie));
    expect(again.status).toBe(409);

    const read = await callTool(bus, caller(codex), "get_plan", { id: planId }, config);
    expect(read.content[0]?.text).toContain("is executing");
    expect(read.content[0]?.text).toContain("SSE heartbeat endpoint + client reconnect");
    expect(read.content[0]?.text).not.toContain("Cost model");

    const latest = await callTool(bus, caller(codex), "get_plan", { room: "build" }, config);
    expect(latest.content[0]?.text).toContain(planId);

    const codexHooks = await store.listDeliveries(codex.id);
    const claudeHooks = await store.listDeliveries(claude.id);
    expect(codexHooks.some((row) => row.event === "mention")).toBe(true);
    expect(claudeHooks.some((row) => row.event === "mention")).toBe(true);

    const waiting = await callTool(bus, caller(codex), "wait_for_messages", {}, config);
    expect(waiting.content[0]?.text).toContain("task");
    const codexTask = body.tasks.find((task) => task.assigneeName === "codex");
    if (!codexTask) throw new Error("codex task missing");
    const claudeTask = body.tasks.find((task) => task.assigneeName === "claude");
    if (!claudeTask) throw new Error("claude task missing");

    const working = await callTool(
      bus,
      caller(codex),
      "update_task",
      { id: codexTask.id, status: "working", result: "running tests — 72%" },
      config,
    );
    expect(working.isError).toBeUndefined();
    expect((await store.getPlan(planId))?.status).toBe("executing");

    await callTool(bus, caller(codex), "update_task", { id: codexTask.id, status: "done" }, config);
    expect((await store.getPlan(planId))?.status).toBe("executing");
    await callTool(bus, caller(owner), "update_task", { id: claudeTask.id, status: "done" }, config);
    expect((await store.getPlan(planId))?.status).toBe("done");
    await expect(bus.decidePlan(caller(codex), planId, "pause")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a pending plan and refuses a later approval", async () => {
    const { store, config, bus, app, cookie, claude, caller } = await fixture();
    const proposed = await callTool(bus, caller(claude), "propose_plan", rollout, config);
    const planId = proposed.content[0]?.text.match(/Plan ([0-9a-f-]{36})/)?.[1] ?? "";
    const rejected = await app.request(`/chat/api/plans/${planId}/reject`, ownerPost(cookie));
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as { plan: { status: string } }).plan.status).toBe("rejected");
    expect(await store.listTasks({})).toHaveLength(0);
    const later = await app.request(`/chat/api/plans/${planId}/approve`, ownerPost(cookie));
    expect(later.status).toBe(409);
    const inbox = await callTool(bus, caller(claude), "read_inbox", {}, config);
    expect(inbox.content[0]?.text).toContain("rejected the plan");
    const paused = await app.request(`/chat/api/plans/${planId}/pause`, ownerPost(cookie));
    expect(paused.status).toBe(409);
  });

  it("requires the owner cookie and publishes plan and result events", async () => {
    const { app, cookie, config, bus, claude, caller } = await fixture();
    for (const path of [
      "/chat/api/home",
      "/chat/api/plans/00000000-0000-4000-8000-000000000001",
      "/chat/api/plans/00000000-0000-4000-8000-000000000001/approve",
      "/chat/api/results/00000000-0000-4000-8000-000000000002/approve",
    ]) {
      const post = path.endsWith("approve");
      const denied = await app.request(
        path,
        post
          ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
          : { method: "GET" },
      );
      expect(denied.status).toBe(401);
    }

    await callTool(bus, caller(claude), "propose_plan", rollout, config);
    const home = await app.request("/chat/api/home", { headers: { cookie } });
    expect(home.status).toBe(200);
    const feed = (await home.json()) as { needsYou: Array<{ title: string; kind: string }> };
    expect(feed.needsYou.some((item) => item.kind === "approval" && item.title.includes("Presence v2 rollout"))).toBe(
      true,
    );

    const posted = await callTool(
      bus,
      caller(claude),
      "post_result",
      {
        room: "build",
        kind: "text",
        payload: { title: "note", body: "ready for a look" },
      },
      config,
    );
    expect(posted.isError).toBeUndefined();
    const live = await app.request("/chat/api/events?since=%7C%7C%7C%7C", { headers: { cookie } });
    const stream = await live.text();
    expect(stream).toContain("event: update");
    expect(stream).not.toContain("ready for a look");
  });

  it("validates result payloads and notifies the author on review", async () => {
    const { store, config, bus, app, cookie, claude, caller } = await fixture();
    const script = await callTool(
      bus,
      caller(claude),
      "post_result",
      {
        room: "build",
        kind: "pr",
        payload: { url: "javascript:alert(1)", title: "<script>alert(1)</script>" },
      },
      config,
    );
    expect(script.isError).toBe(true);
    expect(script.content[0]?.text).toMatch(/http\(s\) URL/);

    const creds = await callTool(
      bus,
      caller(claude),
      "post_result",
      { room: "build", kind: "screenshot", payload: { url: "https://user:pass@example.com/shot.png" } },
      config,
    );
    expect(creds.isError).toBe(true);
    expect(creds.content[0]?.text).toMatch(/credentials/);

    const missing = await callTool(
      bus,
      caller(claude),
      "post_result",
      { room: "build", kind: "tests", payload: { failed: 2 } },
      config,
    );
    expect(missing.isError).toBe(true);

    const extra = parseResultPayload("text", { body: "plain <b>text</b>" });
    expect(extra.body).toBe("plain <b>text</b>");
    expect(() => parseResultPayload("file", { name: "notes.md", url: "file:///etc/passwd" })).toThrow(/http\(s\) URL/);
    expect(() => parseResultPayload("pr", { url: "data:text/html,hi", title: "x" })).toThrow(/http\(s\) URL/);

    const posted = await callTool(
      bus,
      caller(claude),
      "post_result",
      {
        room: "build",
        kind: "pr",
        payload: {
          url: "https://example.com/agent-bus/pull/58",
          title: "presence: SSE heartbeat",
          additions: 312,
          deletions: 48,
          checksPassed: 4,
          checksTotal: 4,
          html: "<img src=x onerror=alert(1)>",
        },
      },
      config,
    );
    expect(posted.isError).toBe(true);

    const clean = await callTool(
      bus,
      caller(claude),
      "post_result",
      {
        room: "build",
        kind: "tests",
        note: "AB-142 is ready for review. Two timer tests are flaky.",
        payload: {
          runner: "vitest",
          passed: 147,
          failed: 2,
          skipped: 2,
          duration: "8.4s",
          note: "<script>alert(1)</script>",
          failures: [{ name: "marks stale after 45s", location: "store.test.ts:88" }],
        },
      },
      config,
    );
    expect(clean.isError).toBeUndefined();
    expect(clean.content[0]?.text).toContain("BEGIN UNTRUSTED RESULT");
    const room = await store.getRoomByName("build");
    const log = await store.listRoomMessages({ roomId: room?.id ?? "", since: null, limit: 20 });
    expect(log.some((message) => message.body.includes("Two timer tests are flaky"))).toBe(true);
    const resultId = clean.content[0]?.text.match(/Result ([0-9a-f-]{36})/)?.[1] ?? "";
    const stored = await store.getResult(resultId);
    expect(stored?.payload.note).toBe("<script>alert(1)</script>");
    expect(stored?.payload).not.toHaveProperty("html");

    const changes = await app.request(`/chat/api/results/${resultId}/changes`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ note: "rerun the flaky clock" }),
    });
    expect(changes.status).toBe(200);
    expect(((await changes.json()) as { result: { status: string } }).result.status).toBe("changes_requested");
    const mail = await callTool(bus, caller(claude), "read_inbox", {}, config);
    expect(mail.content[0]?.text).toContain("requested changes");
    expect(mail.content[0]?.text).toContain("rerun the flaky clock");
    expect((await store.listDeliveries(claude.id)).some((row) => row.event === "dm")).toBe(true);

    const twice = await app.request(`/chat/api/results/${resultId}/approve`, ownerPost(cookie));
    expect(twice.status).toBe(409);
    const undone = await app.request(`/chat/api/results/${resultId}/undo`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as { result: { status: string } }).result.status).toBe("pending");
    const approved = await app.request(`/chat/api/results/${resultId}/approve`, ownerPost(cookie));
    expect(approved.status).toBe(200);
  });

  it("keeps Thai text for mentions, plans, and results", async () => {
    const { store, config, bus, codex, claude, caller } = await fixture();
    const thai = "ก".repeat(70);
    await callTool(
      bus,
      caller(claude),
      "send_room_message",
      { room: "build", body: `@codex ${thai}` },
      config,
    );
    const tasks = await store.listTasks({ assigneeId: codex.id });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe(thai);

    const title = "ข".repeat(80);
    const proposed = await callTool(
      bus,
      caller(claude),
      "propose_plan",
      {
        room: "build",
        title,
        summary: "ค".repeat(40),
        tasks: [{ title: "ง".repeat(40), assignee: "codex", estimate: "10m" }],
      },
      config,
    );
    expect(proposed.isError).toBeUndefined();
    expect(proposed.content[0]?.text).toContain(title);

    const posted = await callTool(
      bus,
      caller(codex),
      "post_result",
      { room: "build", kind: "text", payload: { title: "จ".repeat(20), body: "ฉ".repeat(80) } },
      config,
    );
    expect(posted.isError).toBeUndefined();
  });

  it("approves once, loses an approve-versus-reject race, and recovers a stranded approval", async () => {
    const { store, config, bus, owner, claude, caller } = await fixture();
    const proposed = await callTool(bus, caller(claude), "propose_plan", rollout, config);
    const planId = proposed.content[0]?.text.match(/Plan ([0-9a-f-]{36})/)?.[1] ?? "";
    const [approved, rejected] = await Promise.allSettled([
      bus.decidePlan(caller(owner), planId, "approve"),
      bus.decidePlan(caller(owner), planId, "reject"),
    ]);
    const outcomes = [approved, rejected];
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    const failed = outcomes.find((item) => item.status === "rejected");
    const status = (await store.getPlan(planId))?.status;
    if (failed?.status === "rejected") {
      expect(failed.reason).toMatchObject({ code: "conflict" });
      expect(String((failed.reason as Error).message)).toContain(status);
    }
    const room = await store.getRoomByName("build");
    const decisions = (
      await store.listRoomMessages({ roomId: room?.id ?? "", since: null, limit: 20 })
    ).filter((message) => message.metadata.kind === "plan_decision");
    expect(decisions).toHaveLength(1);
    expect(status === "executing" || status === "rejected").toBe(true);

    const second = await callTool(
      bus,
      caller(claude),
      "propose_plan",
      {
        room: "build",
        title: "Recover me",
        summary: "Stranded after the first status write.",
        tasks: [{ title: "Finish the write", assignee: "codex", estimate: "5m" }],
      },
      config,
    );
    const recoverId = second.content[0]?.text.match(/Plan ([0-9a-f-]{36})/)?.[1] ?? "";
    const stranded = await store.updatePlan(recoverId, { status: "approved", decidedAt: new Date().toISOString() }, [
      "pending",
    ]);
    expect(stranded?.status).toBe("approved");
    const recovered = await bus.decidePlan(caller(owner), recoverId, "approve");
    expect(recovered.plan.status).toBe("executing");
    expect(recovered.tasks).toHaveLength(1);
    await expect(bus.decidePlan(caller(owner), recoverId, "approve")).rejects.toThrow(
      /Cannot approve a plan that is executing/,
    );
    const recoverNotes = (
      await store.listRoomMessages({ roomId: room?.id ?? "", since: null, limit: 20 })
    ).filter((message) => message.metadata.planId === recoverId && message.metadata.kind === "plan_decision");
    expect(recoverNotes).toHaveLength(1);
  });

  it("resumes an executing plan that is missing tasks and posts approval once", async () => {
    const { store, config, bus, owner, codex, claude, caller } = await fixture();
    const proposed = await callTool(
      bus,
      caller(claude),
      "propose_plan",
      {
        room: "build",
        title: "Partial dispatch",
        summary: "The second task insert fails.",
        tasks: [
          { title: "First slice", assignee: "codex", estimate: "10m" },
          { title: "Second slice", assignee: "claude", estimate: "10m" },
        ],
      },
      config,
    );
    const planId = proposed.content[0]?.text.match(/Plan ([0-9a-f-]{36})/)?.[1] ?? "";
    const original = store.insertTasks.bind(store);
    let attempts = 0;
    store.insertTasks = async (inputs) => {
      attempts += 1;
      if (attempts === 2) {
        throw new Error("duplicate key value violates unique constraint tasks_source_assignee_unique");
      }
      return original(inputs);
    };
    await expect(bus.decidePlan(caller(owner), planId, "approve")).rejects.toThrow(/tasks_source_assignee_unique/);
    store.insertTasks = original;
    const stuck = await store.getPlan(planId);
    expect(stuck?.status).toBe("executing");
    const missing = stuck?.items.find((item) => !item.taskId);
    expect(stuck?.items.filter((item) => item.taskId)).toHaveLength(1);
    if (!stuck || !missing) throw new Error("stuck plan missing");
    await original([
      {
        assigneeId: missing.assigneeId,
        creatorId: owner.id,
        sourceMessageId: stuck.messageId,
        roomId: stuck.roomId,
        threadId: stuck.roomId,
        title: missing.title,
        code: missing.code,
        slot: missing.id,
      },
    ]);
    const room = await store.getRoomByName("build");
    const approvedBefore = (
      await store.listRoomMessages({ roomId: room?.id ?? "", since: null, limit: 30 })
    ).filter((message) => message.body.startsWith("Approved the plan"));
    expect(approvedBefore).toHaveLength(0);
    expect((await store.listDeliveries(codex.id)).some((row) => row.event === "mention")).toBe(false);
    const retried = await bus.decidePlan(caller(owner), planId, "approve");
    expect(retried.plan.status).toBe("executing");
    expect(retried.plan.items.every((item) => item.taskId)).toBe(true);
    const linked = await store.listTasks({ messageIds: [stuck.messageId] });
    expect(linked.filter((task) => task.slot === missing.id)).toHaveLength(1);
    const approvedAfter = (
      await store.listRoomMessages({ roomId: room?.id ?? "", since: null, limit: 30 })
    ).filter((message) => message.body.startsWith("Approved the plan"));
    expect(approvedAfter).toHaveLength(1);
    expect((await store.listDeliveries(codex.id)).some((row) => row.event === "mention")).toBe(true);
    expect((await store.listDeliveries(claude.id)).some((row) => row.event === "mention")).toBe(true);
    await expect(bus.decidePlan(caller(owner), planId, "approve")).rejects.toThrow(
      /Cannot approve a plan that is executing/,
    );
    const approvedFinal = (
      await store.listRoomMessages({ roomId: room?.id ?? "", since: null, limit: 30 })
    ).filter((message) => message.body.startsWith("Approved the plan"));
    expect(approvedFinal).toHaveLength(1);
  });

  it("wakes every open assignee on retry and posts Approved only when it is missing", async () => {
    const { store, config, bus, owner, codex, claude, grok, caller } = await fixture();
    const proposed = await callTool(
      bus,
      caller(claude),
      "propose_plan",
      {
        room: "build",
        title: "Retry the wake",
        summary: "The first assignee was never woken.",
        tasks: [
          { title: "First slice", assignee: "codex", estimate: "10m" },
          { title: "Second slice", assignee: "claude", estimate: "10m" },
          { title: "Third slice", assignee: "grok", estimate: "10m" },
        ],
      },
      config,
    );
    const planId = proposed.content[0]?.text.match(/Plan ([0-9a-f-]{36})/)?.[1] ?? "";
    const original = store.insertTasks.bind(store);
    let attempts = 0;
    store.insertTasks = async (inputs) => {
      attempts += 1;
      if (attempts === 3) throw new Error("insert failed after the first task");
      return original(inputs);
    };
    await expect(bus.decidePlan(caller(owner), planId, "approve")).rejects.toThrow(/insert failed/);
    store.insertTasks = original;
    const stuck = await store.getPlan(planId);
    const created = stuck?.items.filter((item) => item.taskId) ?? [];
    const missing = stuck?.items.find((item) => !item.taskId);
    const doneId = created.find((item) => item.assigneeName === "codex")?.taskId;
    if (!stuck || created.length !== 2 || !doneId || !missing) throw new Error("stuck plan missing");
    await store.updateTask(doneId, { status: "done", resultNote: "", resultLink: null });
    const room = await store.getRoomByName("build");
    const posted = await store.insertMessage({
      threadId: stuck.roomId,
      fromAgent: owner.id,
      toAgent: null,
      roomId: stuck.roomId,
      body: `Approved the plan "${stuck.title}". Dispatched 1 task(s) to codex.`,
      metadata: { kind: "plan_decision", planId: stuck.id },
      hopCount: 0,
      replyTo: null,
    });
    const retried = await bus.decidePlan(caller(owner), planId, "approve");
    expect(retried.plan.items.every((item) => item.taskId)).toBe(true);
    const notes = (
      await store.listRoomMessages({ roomId: room?.id ?? "", since: null, limit: 30 })
    ).filter((message) => message.metadata.kind === "plan_decision" && message.metadata.planId === planId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.id).toBe(posted.id);
    expect((await store.listDeliveries(codex.id)).some((row) => row.event === "mention")).toBe(false);
    for (const agent of [claude, grok]) {
      const wakes = (await store.listDeliveries(agent.id)).filter((row) => row.event === "mention");
      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.targetId).toBe(posted.id);
    }
    await expect(bus.decidePlan(caller(owner), planId, "approve")).rejects.toThrow(
      /Cannot approve a plan that is executing/,
    );
    expect(
      (await store.listRoomMessages({ roomId: room?.id ?? "", since: null, limit: 30 })).filter(
        (message) => message.body.startsWith("Approved the plan"),
      ),
    ).toHaveLength(1);
  });

  it("pauses with a room message, requires members, and posts results only for the assignee", async () => {
    const { store, config, bus, app, cookie, owner, claude, codex, grok, caller } = await fixture();
    await store.insertAgent({ name: "mira", description: "", tokenHash: hashToken(mintToken()) });
    const outsider = await callTool(
      bus,
      caller(claude),
      "propose_plan",
      {
        room: "build",
        title: "Needs a member",
        summary: "Mira is not in the room.",
        tasks: [{ title: "Join first", assignee: "mira", estimate: "5m" }],
      },
      config,
    );
    expect(outsider.isError).toBe(true);
    expect(outsider.content[0]?.text).toMatch(/not a member/);

    const proposed = await callTool(bus, caller(claude), "propose_plan", rollout, config);
    const planId = proposed.content[0]?.text.match(/Plan ([0-9a-f-]{36})/)?.[1] ?? "";
    const approved = await bus.decidePlan(caller(owner), planId, "approve");
    const paused = await app.request(`/chat/api/plans/${planId}/pause`, ownerPost(cookie));
    expect(paused.status).toBe(200);
    const room = await store.getRoomByName("build");
    const log = await store.listRoomMessages({ roomId: room?.id ?? "", since: null, limit: 30 });
    expect(log.some((message) => message.body.includes("should stop"))).toBe(true);
    expect((await store.listDeliveries(codex.id)).some((row) => row.event === "mention")).toBe(true);
    const resumed = await bus.decidePlan(caller(owner), planId, "resume");
    expect(resumed.plan.status).toBe("executing");
    const read = await callTool(bus, caller(codex), "get_plan", { id: planId }, config);
    await bus.decidePlan(caller(owner), planId, "pause");
    const pausedRead = await callTool(bus, caller(codex), "get_plan", { id: planId }, config);
    expect(pausedRead.content[0]?.text).toContain("paused");
    expect(pausedRead.content[0]?.text).toMatch(/Stop work/);
    expect(read.content[0]?.text).toContain("executing");

    const taskId = approved.tasks[0]?.id ?? "";
    const denied = await callTool(
      bus,
      caller(grok),
      "post_result",
      { room: "build", task_id: taskId, kind: "text", payload: { body: "not my task" } },
      config,
    );
    expect(denied.isError).toBe(true);
    const allowed = await callTool(
      bus,
      caller(approved.tasks[0]?.assigneeName === "codex" ? codex : claude),
      "post_result",
      { room: "build", task_id: taskId, kind: "text", payload: { body: "my task" } },
      config,
    );
    expect(allowed.isError).toBeUndefined();

    const other = await store.insertAgent({ name: "ada", description: "", tokenHash: hashToken(mintToken()) });
    await store.markHuman("ada");
    await callTool(bus, caller(owner), "add_member", { room: "build", agent: "ada" }, config);
    await expect(bus.decidePlan({ id: other.id, name: other.name, isHuman: true }, planId, "resume")).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("rolls back an orphan plan message and ignores quick-answer mentions", async () => {
    const { store, config, bus, claude, codex, caller } = await fixture();
    const original = store.insertPlan.bind(store);
    store.insertPlan = async () => {
      throw new Error("plan insert failed");
    };
    await expect(bus.proposePlan(caller(claude), rollout)).rejects.toThrow(/plan insert failed/);
    store.insertPlan = original;
    const room = await store.getRoomByName("build");
    const log = await store.listRoomMessages({ roomId: room?.id ?? "", since: null, limit: 20 });
    expect(log.some((message) => message.metadata.kind === "plan")).toBe(false);

    const answered = await bus.sendRoom(caller(claude), {
      room: "build",
      body: "@codex please start",
      metadata: { kind: "quick_answer" },
    });
    expect(answered.body).not.toContain("@");
    expect(await store.listTasks({ assigneeId: codex.id })).toHaveLength(0);

    const older = await callTool(
      bus,
      caller(claude),
      "propose_plan",
      { room: "build", title: "Older plan", summary: "First.", tasks: [{ title: "One", assignee: "codex" }] },
      config,
    );
    const newer = await callTool(
      bus,
      caller(claude),
      "propose_plan",
      { room: "build", title: "Newer plan", summary: "Second.", tasks: [{ title: "Two", assignee: "codex" }] },
      config,
    );
    const olderId = older.content[0]?.text.match(/Plan ([0-9a-f-]{36})/)?.[1] ?? "";
    await store.updatePlan(olderId, { status: "rejected", decidedAt: new Date().toISOString() }, ["pending"]);
    const latest = await callTool(bus, caller(codex), "get_plan", { room: "build" }, config);
    const newerId = newer.content[0]?.text.match(/Plan ([0-9a-f-]{36})/)?.[1] ?? "";
    expect(latest.content[0]?.text).toContain(newerId);
    expect(latest.content[0]?.text).toContain("Newer plan");
  });

  it("notifies the owner for plans and results when the URL is set", async () => {
    const store = new MemoryStore();
    const config = loadConfig({ OWNER_NAME: "owner", RATE_LIMIT_MAX: "100", ROOM_AGENT_CAP: "20" });
    const bus = new AgentBus(store, config, async (message, tasks) => {
      const rows = await planDeliveries({
        store,
        message,
        tasks,
        ownerName: config.ownerName,
        ownerNotifyUrl: "https://example.com/notify",
      });
      if (rows.length > 0) await store.enqueueDeliveries(rows);
    });
    const owner = await store.insertAgent({
      name: "owner",
      description: "",
      tokenHash: hashToken(mintToken()),
      isHuman: true,
    });
    const claude = await store.insertAgent({ name: "claude", description: "", tokenHash: hashToken(mintToken()) });
    const caller = (agent: Agent): Caller => ({ id: agent.id, name: agent.name, isHuman: agent.isHuman });
    await callTool(bus, caller(owner), "create_room", { name: "build" }, config);
    await callTool(bus, caller(owner), "add_member", { room: "build", agent: "claude" }, config);
    await callTool(bus, caller(claude), "propose_plan", {
      room: "build",
      title: "Notify",
      summary: "Ping the owner.",
      tasks: [{ title: "Write it", assignee: "claude" }],
    }, config);
    await callTool(
      bus,
      caller(claude),
      "post_result",
      { room: "build", kind: "text", payload: { body: "done enough" } },
      config,
    );
    const notes = await store.listDeliveries(owner.id);
    expect(notes.filter((row) => row.event === "owner_notify")).toHaveLength(2);
  });

  it("reopens a finished plan when a task is reopened and survives a sync error", async () => {
    const { store, config, bus, owner, claude, codex, caller } = await fixture();
    const proposed = await callTool(
      bus,
      caller(claude),
      "propose_plan",
      {
        room: "build",
        title: "One line",
        summary: "Finish then reopen.",
        tasks: [{ title: "Ship it", assignee: "codex" }],
      },
      config,
    );
    const planId = proposed.content[0]?.text.match(/Plan ([0-9a-f-]{36})/)?.[1] ?? "";
    const approved = await bus.decidePlan(caller(owner), planId, "approve");
    const taskId = approved.tasks[0]?.id ?? "";
    await callTool(bus, caller(codex), "update_task", { id: taskId, status: "done" }, config);
    expect((await store.getPlan(planId))?.status).toBe("done");
    await callTool(bus, caller(codex), "update_task", { id: taskId, status: "working", result: "reopened" }, config);
    expect((await store.getPlan(planId))?.status).toBe("executing");

    const original = store.findPlanByTask.bind(store);
    store.findPlanByTask = async () => {
      throw new Error("sync down");
    };
    const updated = await callTool(bus, caller(codex), "update_task", { id: taskId, status: "blocked" }, config);
    expect(updated.isError).toBeUndefined();
    store.findPlanByTask = original;
  });

  it("blocks cross-site owner posts and rejects a plan id that is not a uuid", async () => {
    const { app, cookie } = await fixture();
    const missingType = await app.request("/chat/api/plans/00000000-0000-4000-8000-000000000001/approve", {
      method: "POST",
      headers: { cookie },
    });
    expect(missingType.status).toBe(415);
    const foreign = await app.request("/chat/api/home", {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(foreign.status).toBe(403);
    const fetched = await app.request("/chat/api/plans/not-a-uuid", { headers: { cookie } });
    expect(fetched.status).toBe(400);
  });
});

describe("postgres plans and results", () => {
  it("assigns display codes, allows two tasks for one agent, and locks the new tables", async () => {
    const db = new PGlite();
    const sql: SqlClient = {
      async query<T extends Record<string, unknown>>(text: string, params: unknown[] = []) {
        const result = await db.query<T>(text, params);
        return { rows: result.rows };
      },
      async exec(text) {
        await db.exec(text);
      },
    };
    await applyMigrations(sql, join(process.cwd(), "supabase/migrations"));
    const store = new PgStore(sql);
    const config = loadConfig({ RATE_LIMIT_MAX: "100", ROOM_AGENT_CAP: "20" });
    const bus = new AgentBus(store, config);
    const owner = await store.insertAgent({
      name: "owner",
      description: "",
      tokenHash: hashToken(mintToken()),
      isHuman: true,
    });
    const codex = await store.insertAgent({ name: "codex", description: "", tokenHash: hashToken(mintToken()) });
    const caller = (agent: Agent): Caller => ({ id: agent.id, name: agent.name, isHuman: agent.isHuman });
    await callTool(bus, caller(owner), "create_room", { name: "build" }, config);
    await callTool(bus, caller(owner), "add_member", { room: "build", agent: "codex" }, config);
    const proposed = await callTool(
      bus,
      caller(codex),
      "propose_plan",
      {
        room: "build",
        title: "Two slices",
        summary: "Same assignee, two tasks.",
        tasks: [
          { title: "First", assignee: "codex", estimate: "10m" },
          { title: "Second", assignee: "codex", estimate: "10m" },
        ],
      },
      config,
    );
    expect(proposed.isError).toBeUndefined();
    const planId = proposed.content[0]?.text.match(/Plan ([0-9a-f-]{36})/)?.[1] ?? "";
    const approved = await bus.decidePlan(caller(owner), planId, "approve");
    expect(approved.plan.status).toBe("executing");
    expect(approved.tasks).toHaveLength(2);
    expect(approved.tasks.map((task) => task.code).sort()).toEqual(["AB-101", "AB-102"]);
    expect(approved.tasks[0]?.code).not.toBe(approved.tasks[1]?.code);
    expect(approved.tasks.every((task) => task.assigneeId === codex.id)).toBe(true);

    const posted = await callTool(
      bus,
      caller(codex),
      "post_result",
      { room: "build", kind: "file", payload: { name: "rfc.md", url: "https://example.com/rfc.md", preview: "# hi" } },
      config,
    );
    expect(posted.isError).toBeUndefined();

    const security = await sql.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relname in ('plans', 'plan_items', 'results') order by relname`,
    );
    expect(security.rows.every((row) => row.relrowsecurity === true || String(row.relrowsecurity) === "t")).toBe(true);
    const definers = await sql.query<{ prosecdef: boolean }>(
      `select prosecdef from pg_proc where proname = 'assign_display_code'`,
    );
    expect(definers.rows[0]?.prosecdef === false || String(definers.rows[0]?.prosecdef) === "f").toBe(true);
    const indexes = await sql.query<{ indexname: string }>(
      `select indexname from pg_indexes
       where indexname in (
         'plans_message_idx', 'plans_author_idx', 'plans_updated_idx',
         'plan_items_assignee_idx', 'results_task_idx', 'results_plan_idx', 'results_updated_idx'
       )`,
    );
    expect(indexes.rows).toHaveLength(7);
    const first = readFileSync(join(process.cwd(), "supabase/migrations/20261018120000_plans_results.sql"), "utf8");
    const second = readFileSync(
      join(process.cwd(), "supabase/migrations/20261018140100_drop_tasks_source_assignee_unique.sql"),
      "utf8",
    );
    expect(first).not.toContain("drop constraint tasks_source_assignee_unique");
    expect(first).toContain("start with 101");
    expect(first).toContain("char_length(title)");
    expect(second).toContain("drop constraint tasks_source_assignee_unique");
    const thai = await callTool(
      bus,
      caller(codex),
      "send_room_message",
      { room: "build", body: `@owner ${"ก".repeat(70)}` },
      config,
    );
    expect(thai.isError).toBeUndefined();
    const mentioned = await store.listTasks({ assigneeId: owner.id });
    expect(mentioned.some((task) => task.title === "ก".repeat(70))).toBe(true);
    await db.close();
  });
});
