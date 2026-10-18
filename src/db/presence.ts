export const PRESENCE_STATUSES = ["available", "busy", "away"] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

export function asPresence(value: unknown): PresenceStatus {
  if (value === "busy" || value === "away" || value === "available") return value;
  return "available";
}
