import { existsSync, readFileSync } from "node:fs";

/** Load a local .env without overriding variables that are already set. */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-long-random-string",
  "replace-with-another-long-random-string",
]);

export function assertAdminSecret(secret: string | undefined): string {
  if (!secret || secret.trim().length < 16 || PLACEHOLDER_SECRETS.has(secret.trim())) {
    throw new Error(
      "Set ADMIN_SECRET to a random string of at least 16 characters before using the admin CLI.",
    );
  }
  return secret.trim();
}
