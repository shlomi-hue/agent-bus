/**
 * Parsers for agent-bus tool text output (src/bus/format.ts in agent-bus).
 * Bodies are fenced by BEGIN/END markers; the server escapes those markers inside bodies,
 * so anything between them is treated purely as data and never parsed for structure.
 */

export const BEGIN = "--- BEGIN UNTRUSTED BODY ---";
export const END = "--- END UNTRUSTED BODY ---";

const UUID = "[0-9a-fA-F-]{36}";
const SLUG = "[a-z][a-z0-9_-]{0,63}";
const RE_ID = new RegExp(`^id: (${UUID})$`);
const RE_THREAD = new RegExp(`^thread: (${UUID})$`);
const RE_FROM_ROOM = new RegExp(`^from: "(${SLUG})" in room "(${SLUG})"$`);
const RE_FROM_DM = new RegExp(`^from: "(${SLUG})" -> to: "([^"]*)"$`);
const RE_HOP = /^hop: (\d+)$/;
const RE_ACKED = /^acked: (no|yes(?: \((\S+)\))?)$/;
const RE_REPLY_TO = new RegExp(`^reply_to: (none|${UUID})$`);
const RE_UNTRUSTED = new RegExp(`^UNTRUSTED MESSAGE from (human|agent) "(${SLUG})" \\(id (${UUID}), sent (\\S+)\\)\\.$`);
const RE_TASK = new RegExp(
  `^- (open|working|done|blocked) from (${SLUG}) (?:in #(${SLUG})|in a direct message) task (${UUID}) source (\\S+?)(?: updated (\\S+) thread (${UUID}))?\\.(?: Note: .*)?$`,
);

/**
 * Split tool text into message blocks plus the "outside" lines (never inside a body).
 * @returns {{messages: object[], outside: string[]}}
 */
export function parseMessages(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const messages = [];
  const outside = [];
  let cur = null;
  let inBody = false;
  let body = [];
  for (const line of lines) {
    if (inBody) {
      if (line === END) {
        inBody = false;
        if (cur) cur.body = body.join("\n");
        body = [];
      } else {
        body.push(line);
      }
      continue;
    }
    let m;
    if ((m = RE_ID.exec(line))) {
      cur = { id: m[1].toLowerCase(), threadId: null, from: null, to: null, room: null, hop: 0, acked: false, ackedAt: null, replyTo: null, fromKind: null, createdAt: null, body: "", type: null };
      messages.push(cur);
      continue;
    }
    if (cur && line === BEGIN) {
      inBody = true;
      body = [];
      continue;
    }
    if (cur && (m = RE_THREAD.exec(line))) {
      cur.threadId = m[1].toLowerCase();
      continue;
    }
    if (cur && (m = RE_FROM_ROOM.exec(line))) {
      cur.from = m[1];
      cur.room = m[2];
      continue;
    }
    if (cur && (m = RE_FROM_DM.exec(line))) {
      cur.from = m[1];
      cur.to = m[2];
      continue;
    }
    if (cur && (m = RE_HOP.exec(line))) {
      cur.hop = Number(m[1]);
      continue;
    }
    if (cur && (m = RE_ACKED.exec(line))) {
      cur.acked = m[1] !== "no";
      cur.ackedAt = m[2] ?? null;
      continue;
    }
    if (cur && (m = RE_REPLY_TO.exec(line))) {
      cur.replyTo = m[1] === "none" ? null : m[1].toLowerCase();
      continue;
    }
    if (cur && (m = RE_UNTRUSTED.exec(line))) {
      cur.fromKind = m[1];
      if (!cur.from) cur.from = m[2];
      if (!cur.createdAt) cur.createdAt = m[4];
      continue;
    }
    if (cur && (m = /^type: ([a-z][a-z0-9_]{0,40})$/.exec(line))) {
      cur.type = m[1];
      continue;
    }
    if (cur && (m = /^sender_kind: (human|agent)$/.exec(line))) {
      cur.fromKind = m[1];
      continue;
    }
    if (cur && (m = /^created_at: (\S+)$/.exec(line))) {
      cur.createdAt = m[1];
      continue;
    }
    outside.push(line);
  }
  // A block without its END marker is incomplete: drop it rather than trust partial data.
  if (inBody && cur) messages.pop();
  return { messages: messages.filter((x) => x.threadId && x.from && x.createdAt), outside };
}

export function parseTaskLines(lines) {
  const tasks = [];
  const seen = new Set();
  for (const line of lines) {
    const m = RE_TASK.exec(line);
    if (!m) continue;
    const id = m[4].toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    tasks.push({
      status: m[1],
      creator: m[2],
      room: m[3] ?? null,
      id,
      sourceMessageId: m[5] === "null" ? null : m[5].toLowerCase(),
      updatedAt: m[6] ?? null,
      threadId: m[7] ? m[7].toLowerCase() : null,
    });
  }
  return tasks;
}

/** Parse wait_for_messages output. */
export function parseWait(text) {
  const { messages: all, outside } = parseMessages(text);
  const messages = all.filter((message) => !message.room);
  const roomMessages = all.filter((message) => message.room);
  let timedOut = false;
  let cursor = null;
  let rooms = [];
  let truncatedRooms = [];
  let roomMessagesInline = false;
  let markedRead = null;
  let recognized = false;
  for (const line of outside) {
    let m;
    if ((m = /^No new messages for "[^"]*" before the wait ended\. Call wait_for_messages again with since (\S+)\.$/.exec(line))) {
      timedOut = true;
      cursor = m[1];
      recognized = true;
    } else if ((m = /^Wake for "[^"]*"\. Pass since (\S+) on the next wait_for_messages call\.$/.exec(line))) {
      cursor = m[1];
      recognized = true;
    } else if ((m = new RegExp(`^New room messages in: (${SLUG}(?:, ${SLUG})*)\\. Call read_room for each\\.`).exec(line))) {
      rooms = m[1].split(", ");
    } else if ((m = /^mark_read: (true|false)$/.exec(line))) {
      markedRead = m[1] === "true";
    } else if (line === "room_messages: inline") {
      roomMessagesInline = true;
    } else if ((m = new RegExp(`^room_truncated: (${SLUG}(?:, ?${SLUG})*)$`).exec(line))) {
      truncatedRooms = m[1].split(",").map((name) => name.trim());
    }
  }
  if (!recognized) throw new Error("unrecognized wait_for_messages output");
  if (markedRead === null) markedRead = !outside.some((line) => line.includes("were not marked read"));
  // Task lines only appear after the "Tasks:" header.
  const idx = outside.indexOf("Tasks:");
  const tasks = idx >= 0 ? parseTaskLines(outside.slice(idx + 1)) : [];
  return { timedOut, cursor, rooms, messages, tasks, roomMessages, roomMessagesInline, truncatedRooms, markedRead };
}

export function parseRoomLog(text) {
  return parseMessages(text).messages;
}

export function parseInbox(text) {
  return parseMessages(text).messages;
}

export function parseTaskList(text) {
  return parseTaskLines(parseMessages(text).outside);
}

export function parseRoomList(text) {
  const rooms = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = new RegExp(`^(${SLUG}) \\((${UUID})\\)$`).exec(line);
    if (m) rooms.push({ name: m[1], id: m[2].toLowerCase() });
  }
  return rooms;
}

const FENCE = /```[\s\S]*?```/g;
const CODE = /`[^`\n]*`/g;
const MENTION = /(?:^|[^A-Za-z0-9_])@([a-z][a-z0-9_-]{0,63})/g;

/** Same rule as agent-bus src/bus/mentions.ts. */
export function mentionNames(body) {
  const stripped = String(body ?? "").replace(FENCE, " ").replace(CODE, " ");
  const names = new Set();
  for (const match of stripped.matchAll(MENTION)) names.add(match[1]);
  return [...names];
}

const TASK_NOTICE = new RegExp(`^(${SLUG}) set the task for (${SLUG}) to (open|working|done|blocked)\\.`);
/** Detect the automatic task status line that update_task posts. */
export function taskStatusNotice(body) {
  const m = TASK_NOTICE.exec(String(body ?? ""));
  return m ? { actor: m[1], assignee: m[2], status: m[3] } : null;
}
