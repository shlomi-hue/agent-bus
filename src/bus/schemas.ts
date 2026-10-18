import { z } from "zod";
import type { AppConfig } from "../config.js";

export const agentNameSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,63}$/,
    "name must be 1-64 characters: start with a letter, then lowercase letters, digits, underscores, or hyphens",
  );

export function bodySchema(maxBodyBytes: number) {
  return z.string().superRefine((value, ctx) => {
    if (value.trim().length === 0) {
      ctx.addIssue({ code: "custom", message: "body is empty" });
    }
    if (Buffer.byteLength(value, "utf8") > maxBodyBytes) {
      ctx.addIssue({ code: "custom", message: `body exceeds ${maxBodyBytes} bytes` });
    }
  });
}

export function metadataSchema(maxMetadataBytes: number) {
  return z
    .record(z.string(), z.json())
    .superRefine((value, ctx) => {
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded, "utf8") > maxMetadataBytes) {
        ctx.addIssue({ code: "custom", message: `metadata exceeds ${maxMetadataBytes} bytes` });
      }
    });
}

const sinceSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: "since must be an ISO-8601 timestamp",
});

export function sendMessageSchema(config: AppConfig) {
  return z.object({
    to: agentNameSchema,
    body: bodySchema(config.maxBodyBytes),
    thread_id: z.uuid().optional(),
    metadata: metadataSchema(config.maxMetadataBytes).optional(),
  });
}

export function readInboxSchema(config: AppConfig) {
  return z.object({
    unread_only: z.boolean().default(true),
    limit: z.number().int().min(1).max(config.inboxMaxLimit).default(config.inboxDefaultLimit),
    since: sinceSchema.optional(),
  });
}

export function ackMessageSchema() {
  return z.object({
    id: z.uuid(),
  });
}

export function replySchema(config: AppConfig) {
  return z.object({
    message_id: z.uuid(),
    body: bodySchema(config.maxBodyBytes),
  });
}

export function getThreadSchema() {
  return z.object({
    thread_id: z.uuid(),
  });
}

export function descriptionSchema(maxLength: number) {
  return z.string().max(maxLength, `description exceeds ${maxLength} characters`);
}

export const roomNameSchema = agentNameSchema;

export function createRoomSchema() {
  return z.object({ name: roomNameSchema });
}

export function joinRoomSchema() {
  return z.object({ room: roomNameSchema });
}

export function addMemberSchema() {
  return z.object({
    room: roomNameSchema,
    agent: agentNameSchema,
  });
}

export function sendRoomMessageSchema(config: AppConfig) {
  return z.object({
    room: roomNameSchema,
    body: bodySchema(config.maxBodyBytes),
    metadata: z.object({ kind: z.literal("quick_answer") }).strict().optional(),
  });
}

export function waitForMessagesSchema(config: AppConfig) {
  return z.object({
    since: sinceSchema.optional(),
    timeout_seconds: z.number().int().min(1).max(config.waitMaxSeconds).optional(),
  });
}

export function listMyTasksSchema() {
  return z.object({
    status: z.enum(["open", "working", "done", "blocked"]).optional(),
  });
}

export function updateTaskSchema() {
  return z.object({
    id: z.uuid(),
    status: z.enum(["open", "working", "done", "blocked"]),
    result: z.string().max(2000).optional(),
    link: z.string().max(500).optional(),
  });
}

export function setStatusSchema() {
  return z.object({
    status: z.enum(["available", "busy", "away"]),
    text: z.string().max(200).optional(),
  });
}

export function readRoomSchema(config: AppConfig) {
  return z.object({
    room: roomNameSchema,
    since: sinceSchema.optional(),
    limit: z.number().int().min(1).max(config.inboxMaxLimit).default(config.inboxDefaultLimit),
  });
}

const planTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  assignee: agentNameSchema,
  estimate: z.string().trim().max(40).optional(),
  depends_on: z.string().trim().max(80).optional(),
});

export function proposePlanSchema() {
  return z.object({
    room: roomNameSchema,
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(4000),
    note: z.string().trim().max(2000).optional(),
    tasks: z.array(planTaskSchema).min(1).max(20),
  });
}

export function getPlanSchema() {
  return z.object({
    id: z.uuid().optional(),
    room: roomNameSchema.optional(),
  });
}

export function editPlanSchema() {
  return z.object({
    tasks: z.array(planTaskSchema).min(1).max(20),
  });
}

export function postResultSchema() {
  return z.object({
    room: roomNameSchema,
    task_id: z.uuid().optional(),
    plan_id: z.uuid().optional(),
    kind: z.enum(["pr", "tests", "file", "screenshot", "text"]),
    payload: z.record(z.string(), z.json()),
    note: z.string().trim().max(2000).optional(),
  });
}
