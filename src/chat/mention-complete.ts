// Pure helpers for composer @-autocomplete and live mention hints.
// Which tokens count is decided by mentionNames so the chips match the server.

import { mentionNames } from "../bus/mentions.js";

export type MentionQuery = { start: number; query: string };
export type MentionStatus = "ok" | "not-member" | "unknown";
export type MentionHint = { raw: string; name: string; status: MentionStatus };

/** The @token being typed at the caret, if any. start is the index of "@". */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_-]{0,64})$/.exec(before);
  if (!match) return null;
  const query = match[1] ?? "";
  if (query !== "" && !/^[A-Za-z]/.test(query)) return null;
  return { start: caret - query.length - 1, query };
}

/** Prefix matches first, then substring matches, case-insensitive. */
export function suggestMentions(query: string, candidates: string[], limit = 6): string[] {
  const q = query.toLowerCase();
  const unique = [...new Set(candidates)].sort((a, b) => a.localeCompare(b));
  const prefix = unique.filter((name) => name.toLowerCase().startsWith(q));
  const inner = unique.filter((name) => !name.toLowerCase().startsWith(q) && name.toLowerCase().includes(q));
  return [...prefix, ...inner].slice(0, limit);
}

/** Replace the @token that starts at `start` and ends at the caret with "@name ". */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const tail = text.slice(caret).replace(/^[A-Za-z0-9_-]*/, "");
  const insert = `@${name}${/^\s/.test(tail) ? "" : " "}`;
  const next = text.slice(0, start) + insert + tail;
  return { text: next, caret: start + insert.length };
}

/**
 * Classify every @mention in a draft the way the server will treat it.
 * ok: creates a task for a member. not-member: creates a task, but the agent is not in this room.
 * unknown: no such agent, nothing happens. Matching is case-insensitive.
 */
export function mentionHints(text: string, known: string[], members: string[] | null): MentionHint[] {
  const knownSet = new Set(known.map((name) => name.toLowerCase()));
  const memberSet = members ? new Set(members.map((name) => name.toLowerCase())) : null;
  return mentionNames(text).map((name) => {
    let status: MentionStatus;
    if (!knownSet.has(name)) status = "unknown";
    else if (memberSet && !memberSet.has(name)) status = "not-member";
    else status = "ok";
    return { raw: name, name, status };
  });
}

export function hintLabel(hint: MentionHint): string {
  switch (hint.status) {
    case "ok":
      return `@${hint.name} gets a task`;
    case "not-member":
      return `@${hint.name} is not in this room`;
    default:
      return `@${hint.name}: unknown agent`;
  }
}
