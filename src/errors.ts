export type BusErrorCode =
  | "unauthorized"
  | "not_found"
  | "forbidden"
  | "conflict"
  | "validation"
  | "rate_limited"
  | "hop_limit";

export class BusError extends Error {
  readonly code: BusErrorCode;

  constructor(code: BusErrorCode, message: string) {
    super(message);
    this.name = "BusError";
    this.code = code;
  }
}

export function dbErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

export function rethrowConstraint(error: unknown): never {
  const code = dbErrorCode(error);
  if (code === "23505") {
    throw new BusError(
      "conflict",
      "That name or token is already registered. Revoke the agent before minting a new token.",
    );
  }
  if (code === "23503") {
    throw new BusError("not_found", "The sender or recipient does not exist.");
  }
  if (code === "23514") {
    throw new BusError("validation", "The database rejected the row.");
  }
  throw error;
}
