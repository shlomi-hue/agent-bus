import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "ab_session";
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const PLACEHOLDER_PASSWORDS = new Set([
  "replace-with-the-owner-password",
  "replace-with-a-long-random-string",
  "password",
  "changeme",
]);

export function passwordConfigured(password: string | undefined): password is string {
  if (!password) return false;
  const value = password.trim();
  if (value.length < 8) return false;
  if (PLACEHOLDER_PASSWORDS.has(value)) return false;
  return true;
}

export function passwordsMatch(provided: string, expected: string): boolean {
  const left = createHash("sha256").update(provided).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

type Payload = { sub: string; exp: number };

export function signSession(subject: string, password: string, now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: subject, exp: now + MAX_AGE_SECONDS * 1000 } satisfies Payload),
  ).toString("base64url");
  const signature = createHmac("sha256", password).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function readSession(token: string | undefined, password: string, now = Date.now()): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = createHmac("sha256", password).update(payload).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Payload;
    if (typeof parsed.sub !== "string" || typeof parsed.exp !== "number") return null;
    if (parsed.exp <= now) return null;
    return parsed.sub;
  } catch {
    return null;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function cookieIsSecure(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || Boolean(env.VERCEL);
}
