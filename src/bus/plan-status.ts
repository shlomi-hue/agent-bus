import { BusError } from "../errors.js";
import type { PlanStatus } from "../db/types.js";

export type PlanEvent = "approve" | "reject" | "start" | "complete" | "pause" | "resume" | "reopen";

const TRANSITIONS: Record<PlanStatus, Partial<Record<PlanEvent, PlanStatus>>> = {
  pending: { approve: "approved", reject: "rejected" },
  approved: { start: "executing" },
  rejected: {},
  executing: { complete: "done", pause: "paused" },
  paused: { resume: "executing", complete: "done" },
  done: { reopen: "executing" },
};

export function transitionPlan(status: PlanStatus, event: PlanEvent): PlanStatus {
  const next = TRANSITIONS[status][event];
  if (!next) {
    throw new BusError("conflict", `Cannot ${event} a plan that is ${status}.`);
  }
  return next;
}
