import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { loadConfig } from "../src/config.js";
import { readInboxSchema, sendMessageSchema } from "../src/bus/schemas.js";

const config = loadConfig({});

describe("validation", () => {
  it("uses the documented defaults", () => {
    expect(config.maxHops).toBe(10);
    expect(config.maxBodyBytes).toBe(16_384);
    expect(config.rateLimitMax).toBe(30);
    expect(loadConfig({ MAX_HOPS: "4" }).maxHops).toBe(4);
    expect(() => loadConfig({ MAX_HOPS: "0" })).toThrow(/MAX_HOPS/);
    expect(() => loadConfig({ MAX_BODY_BYTES: "999999" })).toThrow(/MAX_BODY_BYTES/);
  });

  it("rejects an empty or oversized body and a bad agent name", () => {
    const schema = sendMessageSchema(config);
    expect(() => schema.parse({ to: "codex", body: "   " })).toThrow(ZodError);
    expect(() => schema.parse({ to: "Codex", body: "hello" })).toThrow(ZodError);
    expect(() => schema.parse({ to: "codex", body: "x".repeat(16_385) })).toThrow(/16384/);
    expect(schema.parse({ to: "codex", body: "hello" }).metadata).toBeUndefined();
  });

  it("caps metadata and inbox limits", () => {
    const schema = sendMessageSchema(config);
    expect(() =>
      schema.parse({
        to: "codex",
        body: "hello",
        metadata: { blob: "y".repeat(9_000) },
      }),
    ).toThrow(/metadata/);

    const inbox = readInboxSchema(config);
    expect(inbox.parse({}).unread_only).toBe(true);
    expect(inbox.parse({}).limit).toBe(20);
    expect(() => inbox.parse({ limit: 500 })).toThrow(ZodError);
    expect(() => inbox.parse({ since: "yesterday" })).toThrow(/ISO-8601/);
    expect(inbox.parse({ unread_only: false, limit: 5, since: "2026-10-15T00:00:00.000Z" }).limit).toBe(
      5,
    );
  });
});
