import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDm, evaluateRoomMessages, evaluateTask } from "../lib/triggers.js";

const ctx = { self: "codex", ownerNames: ["owner"], ownerRoomPosts: "reply-to-me", ignoreTaskStatusNotices: true };
let n = 0;
const msg = (from, extra = {}) => ({ id: `m${++n}`, threadId: "t1", from, to: "codex", room: null, body: "hi", createdAt: "2026-10-18T00:00:00.000Z", fromKind: from === "owner" ? "human" : "agent", ...extra });
const post = (from, body) => ({ ...msg(from), to: null, room: "general", threadId: "room-general", body });

test("owner DM triggers, keyed by thread", () => {
  const r = evaluateDm(msg("owner"), ctx);
  assert.equal(r.trigger.kind, "dm");
  assert.equal(r.trigger.key, "dm:t1");
  assert.equal(r.trigger.fromOwner, true);
});

test("own messages never trigger", () => {
  assert.ok(evaluateDm(msg("codex"), ctx).skip);
  const r = evaluateRoomMessages("general", [post("codex", "@codex note to self")], ctx);
  assert.equal(r.triggers.length, 0);
});

test("direct DM from another agent triggers (hop limit bounds it)", () => {
  const r = evaluateDm(msg("claude"), ctx);
  assert.equal(r.trigger.fromOwner, false);
});

test("agent task-status notices for working/open are ignored, done triggers", () => {
  assert.ok(evaluateDm(msg("claude", { body: "claude set the task for claude to working." }), ctx).skip);
  assert.ok(evaluateDm(msg("claude", { body: "claude set the task for claude to done. Note: merged" }), ctx).trigger);
});

test("agent room chatter without @mention never triggers (loop guard)", () => {
  const r = evaluateRoomMessages("general", [post("claude", "I think we should refactor"), post("grok", "agreed")], ctx);
  assert.equal(r.triggers.length, 0);
  assert.equal(r.skipped.length, 2);
});

test("@mention by another agent or the owner triggers", () => {
  const r = evaluateRoomMessages("general", [post("claude", "@codex can you review?"), post("owner", "@codex go")], ctx);
  assert.equal(r.triggers.length, 2);
  assert.equal(r.triggers[0].fromOwner, false);
  assert.equal(r.triggers[1].fromOwner, true);
  assert.equal(r.triggers[0].key, "room:general");
});

test("mention inside code does not count", () => {
  assert.equal(evaluateRoomMessages("general", [post("claude", "run `@codex` literally")], ctx).triggers.length, 0);
});

test("owner room post: reply-to-me only when we spoke last", () => {
  let r = evaluateRoomMessages("general", [post("codex", "done"), post("owner", "thanks, now do X")], ctx);
  assert.equal(r.triggers.length, 1);
  r = evaluateRoomMessages("general", [post("claude", "done"), post("owner", "thanks")], ctx);
  assert.equal(r.triggers.length, 0);
  r = evaluateRoomMessages("general", [post("owner", "and Y")], ctx, "codex");
  assert.equal(r.triggers.length, 1, "uses lastAgentSpeaker from earlier polls");
  assert.equal(r.lastAgentSpeaker, "codex");
});

test("owner room post modes", () => {
  const p = [post("owner", "anyone?")];
  assert.equal(evaluateRoomMessages("general", p, { ...ctx, ownerRoomPosts: "mention-only" }, "codex").triggers.length, 0);
  assert.equal(evaluateRoomMessages("general", p, { ...ctx, ownerRoomPosts: "all" }, "claude").triggers.length, 1);
});

test("tasks: new open triggers; own updates do not retrigger; reopen does", () => {
  const t = { id: "k1", status: "open", creator: "owner", room: "general", sourceMessageId: "m0" };
  const r = evaluateTask(t, undefined, ctx);
  assert.equal(r.trigger.key, "room:general");
  assert.equal(r.trigger.fromOwner, true);
  assert.ok(evaluateTask({ ...t, status: "working" }, "open", ctx).skip);
  assert.ok(evaluateTask(t, "open", ctx).skip);
  assert.ok(evaluateTask(t, "working", ctx).skip);
  assert.ok(evaluateTask(t, "done", ctx).trigger, "re-opened task triggers");
  assert.ok(evaluateTask({ ...t, creator: "claude" }, undefined, ctx).trigger, "task from another agent triggers");
});

test("DM task keyed to the DM thread when its source DM is in the same batch", () => {
  const t = { id: "k2", status: "open", creator: "claude", room: null, sourceMessageId: "m77" };
  assert.equal(evaluateTask(t, undefined, ctx, { dmThreadBySourceId: new Map([["m77", "t9"]]) }).trigger.key, "dm:t9");
  assert.equal(evaluateTask(t, undefined, ctx).trigger.key, "task:k2");
});
