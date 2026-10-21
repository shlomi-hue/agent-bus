import { describe, expect, it } from "vitest";
import { canonicalTimestamp, compareInstants, isAfter } from "../src/db/time.js";
import pg from "pg";
import "../src/db/pg-store.js";

describe("timestamp precision", () => {
  it("keeps microseconds from Postgres text and pads older ISO forms", () => {
    expect(canonicalTimestamp("2026-10-18T09:00:01.123456Z")).toBe("2026-10-18T09:00:01.123456Z");
    expect(canonicalTimestamp("2026-10-18T09:00:01.123Z")).toBe("2026-10-18T09:00:01.123000Z");
    expect(canonicalTimestamp("2026-10-18T09:00:01Z")).toBe("2026-10-18T09:00:01.000000Z");
    expect(canonicalTimestamp("2026-10-18T09:00:01.123456+00:00")).toBe("2026-10-18T09:00:01.123456Z");
    expect(canonicalTimestamp("2026-10-18 09:00:01.123456+00")).toBe("2026-10-18T09:00:01.123456Z");
    expect(canonicalTimestamp("2026-10-18T11:00:01.123456+02:00")).toBe("2026-10-18T09:00:01.123456Z");
    expect(canonicalTimestamp(new Date("2026-10-18T09:00:01.123Z"))).toBe("2026-10-18T09:00:01.123000Z");
  });

  it("orders a truncated millisecond cursor before the real microsecond instant", () => {
    const stored = "2026-10-18T09:00:01.123456Z";
    const truncated = "2026-10-18T09:00:01.123Z";
    expect(isAfter(stored, canonicalTimestamp(truncated))).toBe(true);
    expect(compareInstants(stored, canonicalTimestamp(stored))).toBe(0);
    expect(isAfter(truncated, canonicalTimestamp(truncated))).toBe(false);
  });

  it("leaves node-pg timestamptz values as text", () => {
    const raw = "2026-10-18 09:00:01.123456+00";
    expect(pg.types.getTypeParser(1184)(raw)).toBe(raw);
    expect(canonicalTimestamp(String(pg.types.getTypeParser(1184)(raw)))).toBe(
      "2026-10-18T09:00:01.123456Z",
    );
  });
});
