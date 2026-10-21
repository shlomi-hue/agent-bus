import { canonicalTimestamp } from "./time.js";

export function toIso(value: Date | string): string {
  return canonicalTimestamp(value);
}

export function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

export function asMetadata(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function one<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Expected a row for ${label}`);
  return row;
}
