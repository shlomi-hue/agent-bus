export const GROUP_GAP_MS = 5 * 60 * 1000;

export type ChatMessage = {
  id: string;
  fromName: string;
  fromIsHuman: boolean;
  body: string;
  createdAt: string;
};

export type DayBlock = {
  kind: "day";
  key: string;
  label: string;
};

export type MessageGroup = {
  kind: "group";
  fromName: string;
  fromIsHuman: boolean;
  messages: ChatMessage[];
};

export type RenderBlock = DayBlock | MessageGroup;

export function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function previousDay(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function dayLabel(date: Date, now: Date, timeZone: string): string {
  const key = dayKey(date, timeZone);
  const today = dayKey(now, timeZone);
  if (key === today) return "Today";
  if (key === previousDay(today)) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function relativeTime(iso: string, now: Date): string {
  const delta = Math.max(0, now.getTime() - new Date(iso).getTime());
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
}

export function fullTimestamp(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

export function agentRunPaused(messages: Array<{ fromIsHuman: boolean }>, cap: number): boolean {
  if (cap < 1 || messages.length < cap) return false;
  return messages.slice(messages.length - cap).every((message) => !message.fromIsHuman);
}

export function groupMessages(
  messages: ChatMessage[],
  now = new Date(),
  gapMs = GROUP_GAP_MS,
  timeZone = "UTC",
): RenderBlock[] {
  const ordered = [...messages].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  const blocks: RenderBlock[] = [];
  let currentDay = "";
  let group: MessageGroup | null = null;

  for (const message of ordered) {
    const when = new Date(message.createdAt);
    const key = dayKey(when, timeZone);
    if (key !== currentDay) {
      currentDay = key;
      group = null;
      blocks.push({ kind: "day", key, label: dayLabel(when, now, timeZone) });
    }
    const previous = group?.messages.at(-1);
    const closeEnough =
      previous !== undefined && when.getTime() - new Date(previous.createdAt).getTime() <= gapMs;
    if (group && group.fromName === message.fromName && closeEnough) {
      group.messages.push(message);
      continue;
    }
    group = {
      kind: "group",
      fromName: message.fromName,
      fromIsHuman: message.fromIsHuman,
      messages: [message],
    };
    blocks.push(group);
  }
  return blocks;
}

const AVATAR_COLORS = ["#3d6b58", "#3d5a80", "#8a5a44", "#6b4c7a", "#3f6f8a", "#8a6a3d", "#5c6b3d", "#7a4e5c"];

export function avatarColor(name: string, isHuman: boolean): string {
  if (isHuman) return "#0f6e56";
  let hash = 0;
  for (const character of name) hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

export function initials(name: string): string {
  const parts = name.split(/[^a-z0-9]+/i).filter((part) => part.length > 0);
  if (parts.length >= 2) return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function agentBadge(name: string): string | null {
  const value = name.toLowerCase();
  if (value.includes("codex")) return "Codex";
  if (value.includes("claude")) return "Claude";
  if (value.includes("grok")) return "Grok";
  return null;
}
