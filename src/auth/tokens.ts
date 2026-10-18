import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "ab_";

/**
 * Agent tokens are 256 bits of randomness. A SHA-256 lookup hash is enough:
 * the secret is not a human password, and the server has to find the agent
 * by an indexed digest. The raw token is shown once and never stored.
 */
export function mintToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

export function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  const presented = parseBearer(header);
  if (!presented || !secret) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(secret);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
