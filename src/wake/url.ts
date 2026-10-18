import { BusError } from "../errors.js";

const BLOCKED_HOSTS = new Set(["169.254.169.254", "metadata.google.internal"]);

export function assertWebhookUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BusError("validation", "Webhook URL must be absolute.");
  }
  if (url.username || url.password) {
    throw new BusError("validation", "Webhook URL must not include credentials.");
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) {
    throw new BusError("validation", "Webhook URL host is not allowed.");
  }
  const local = host === "localhost" || host === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.toString();
  throw new BusError("validation", "Webhook URL must be https, or http on localhost.");
}

export function assertWebhookSecret(value: string): string {
  const secret = value.trim();
  if (secret.length < 16 || secret.length > 200) {
    throw new BusError("validation", "Webhook secret must be 16 to 200 characters.");
  }
  if (secret === "replace-with-a-long-random-string" || secret === "password" || secret === "changeme") {
    throw new BusError("validation", "Choose a real webhook secret.");
  }
  return secret;
}
