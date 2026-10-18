import { z } from "zod";
import { BusError } from "../errors.js";
import type { ResultKind } from "../db/types.js";

const MAX_PAYLOAD_BYTES = 12_000;

export function safeHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BusError("validation", "url must be an http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BusError("validation", "url must be an http(s) URL");
  }
  if (url.username || url.password) {
    throw new BusError("validation", "url must not include credentials");
  }
  if (!url.hostname) {
    throw new BusError("validation", "url must be an http(s) URL");
  }
  return url.toString();
}

const httpUrl = z.string().max(2000).superRefine((value, ctx) => {
  try {
    safeHttpUrl(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof BusError ? error.message : "url must be an http(s) URL",
    });
  }
});

const httpsUrl = z.string().max(2000).superRefine((value, ctx) => {
  try {
    const normalized = safeHttpUrl(value);
    if (new URL(normalized).protocol !== "https:") {
      throw new BusError("validation", "screenshot url must be https");
    }
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof BusError ? error.message : "screenshot url must be https",
    });
  }
});

const fileChange = z.object({
  path: z.string().min(1).max(400),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});

export const prPayloadSchema = z
  .object({
    url: httpUrl,
    title: z.string().min(1).max(300),
    repo: z.string().max(200).optional(),
    number: z.number().int().positive().optional(),
    state: z.enum(["open", "merged", "closed", "draft"]).optional(),
    branch: z.string().max(200).optional(),
    base: z.string().max(200).optional(),
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
    files: z.array(fileChange).max(20).optional(),
    checksPassed: z.number().int().nonnegative().optional(),
    checksTotal: z.number().int().nonnegative().optional(),
  })
  .strict();

export const testsPayloadSchema = z
  .object({
    runner: z.string().max(80).optional(),
    duration: z.string().max(40).optional(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative().optional(),
    failures: z
      .array(
        z.object({
          name: z.string().min(1).max(300),
          location: z.string().max(200).optional(),
        }),
      )
      .max(20)
      .optional(),
    note: z.string().max(1000).optional(),
  })
  .strict();

export const filePayloadSchema = z
  .object({
    name: z.string().min(1).max(200),
    url: httpUrl.optional(),
    size: z.string().max(40).optional(),
    type: z.string().max(80).optional(),
    preview: z.string().max(4000).optional(),
  })
  .strict();

export const screenshotPayloadSchema = z
  .object({
    name: z.string().max(200).optional(),
    url: httpsUrl,
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    caption: z.string().max(500).optional(),
  })
  .strict();

export const textPayloadSchema = z
  .object({
    title: z.string().max(200).optional(),
    body: z.string().min(1).max(8000),
  })
  .strict();

const payloadByKind = {
  pr: prPayloadSchema,
  tests: testsPayloadSchema,
  file: filePayloadSchema,
  screenshot: screenshotPayloadSchema,
  text: textPayloadSchema,
} as const;

export function parseResultPayload(kind: ResultKind, payload: unknown): Record<string, unknown> {
  const parsed = payloadByKind[kind].parse(payload) as Record<string, unknown>;
  const encoded = JSON.stringify(parsed);
  if (Buffer.byteLength(encoded, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new BusError("validation", `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  return parsed;
}

export function isResultKind(value: string): value is ResultKind {
  return value === "pr" || value === "tests" || value === "file" || value === "screenshot" || value === "text";
}
