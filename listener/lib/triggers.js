import { mentionNames, taskStatusNotice } from "./parse.js";

/**
 * Trigger policy (pure functions; easy to unit test).
 *
 *  - Never trigger on our own messages.
 *  - Owner (owner): DMs, @mentions and assigned tasks always trigger. Owner room posts without a
 *    mention follow config.ownerRoomPosts ("reply-to-me" = only if we were the last agent to speak there).
 *  - Other agents: trigger ONLY for a direct DM to us, an @mention of us, or a task assigned to us.
 *    Ordinary agent room chatter never wakes us (loop guard). Automatic "set the task ... to working/open"
 *    notices from agents are ignored too.
 */

export function sessionKeyForDm(threadId) {
  return `dm:${threadId}`;
}
export function sessionKeyForRoom(room) {
  return `room:${room}`;
}

export function isOwner(name, ctx) {
  return ctx.ownerNames.includes(name);
}

function skippableTaskNotice(msg) {
  const notice = taskStatusNotice(msg.body);
  return Boolean(notice && (notice.status === "working" || notice.status === "open"));
}

/** @returns {{trigger?: object, skip?: string}} */
export function evaluateDm(msg, ctx) {
  if (msg.from === ctx.self) return { skip: "own message" };
  if (msg.room) return { skip: "not a direct message" };
  if (msg.to && msg.to !== ctx.self) return { skip: `addressed to ${msg.to}` };
  const owner = isOwner(msg.from, ctx);
  if (!owner && ctx.ignoreTaskStatusNotices) {
    const notice = taskStatusNotice(msg.body);
    if (msg.type === "task_status" || (notice && notice.actor === msg.from && (notice.status === "working" || notice.status === "open"))) {
      return { skip: `task status notice (${notice?.status ?? msg.type}) from agent ${msg.from}` };
    }
  }
  return {
    trigger: {
      uid: `dm:${msg.id}`,
      kind: "dm",
      key: sessionKeyForDm(msg.threadId),
      id: msg.id,
      threadId: msg.threadId,
      room: null,
      from: msg.from,
      fromKind: msg.fromKind,
      fromOwner: owner,
      createdAt: msg.createdAt,
      hop: msg.hop,
      body: msg.body,
      reason: owner ? "direct message from owner" : `direct message from agent ${msg.from}`,
    },
  };
}

/**
 * Evaluate new room posts (oldest first) for one room.
 * @param {string|null} lastAgentSpeaker - last non-owner author seen in this room before these posts.
 * @returns {{triggers: object[], skipped: {id:string, reason:string}[], lastAgentSpeaker: string|null}}
 */
export function evaluateRoomMessages(room, messages, ctx, lastAgentSpeaker = null) {
  const triggers = [];
  const skipped = [];
  let last = lastAgentSpeaker;
  for (const msg of messages) {
    const owner = isOwner(msg.from, ctx);
    const base = {
      uid: `room:${msg.id}`,
      kind: "room",
      key: sessionKeyForRoom(room),
      id: msg.id,
      threadId: msg.threadId,
      room,
      from: msg.from,
      fromKind: msg.fromKind,
      fromOwner: owner,
      createdAt: msg.createdAt,
      body: msg.body,
    };
    if (msg.from === ctx.self) {
      skipped.push({ id: msg.id, reason: "own message" });
    } else if (!owner && ctx.ignoreTaskStatusNotices && (msg.type === "task_status" || skippableTaskNotice(msg))) {
      skipped.push({ id: msg.id, reason: `task status notice from agent ${msg.from}` });
    } else {
      const mentioned = mentionNames(msg.body).includes(ctx.self);
      if (mentioned) {
        triggers.push({ ...base, reason: owner ? `owner @mentioned you in #${room}` : `agent ${msg.from} @mentioned you in #${room}` });
      } else if (owner && ctx.ownerRoomPosts === "all") {
        triggers.push({ ...base, reason: `owner posted in #${room}` });
      } else if (owner && ctx.ownerRoomPosts === "reply-to-me" && last === ctx.self) {
        triggers.push({ ...base, reason: `owner replied in #${room} after your last message` });
      } else {
        skipped.push({ id: msg.id, reason: owner ? `owner post in #${room} not addressed to you (${ctx.ownerRoomPosts})` : `agent chatter from ${msg.from} without @mention` });
      }
    }
    if (!owner) last = msg.from;
  }
  return { triggers, skipped, lastAgentSpeaker: last };
}

/**
 * Tasks come back from wait_for_messages whenever they were *updated*; we only trigger when a task is
 * newly seen as open, or re-opened from done/blocked. Our own updates (open->working->done) never retrigger.
 */
export function evaluateTask(task, prevStatus, ctx, { dmThreadBySourceId = new Map() } = {}) {
  if (task.creator === ctx.self) return { skip: "task created by self" };
  if (task.status !== "open") return { skip: `task status ${task.status}` };
  if (prevStatus === "open" || prevStatus === "working") return { skip: `task already seen (${prevStatus})` };
  const owner = isOwner(task.creator, ctx);
  let key;
  if (task.room) key = sessionKeyForRoom(task.room);
  else if (task.sourceMessageId && dmThreadBySourceId.has(task.sourceMessageId)) key = sessionKeyForDm(dmThreadBySourceId.get(task.sourceMessageId));
  else key = `task:${task.id}`;
  return {
    trigger: {
      uid: `task:${task.id}`,
      kind: "task",
      key,
      id: task.id,
      threadId: task.threadId ?? null,
      room: task.room,
      from: task.creator,
      fromOwner: owner,
      createdAt: null,
      sourceMessageId: task.sourceMessageId,
      reason: `${prevStatus ? "re-opened" : "new"} task from ${owner ? "owner" : `agent ${task.creator}`}${task.room ? ` in #${task.room}` : ""}`,
    },
  };
}
