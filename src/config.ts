export type AppConfig = {
  maxHops: number;
  maxBodyBytes: number;
  maxMetadataBytes: number;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  inboxDefaultLimit: number;
  inboxMaxLimit: number;
  maxDescriptionLength: number;
  roomAgentCap: number;
  ownerName: string;
  waitMaxSeconds: number;
};

export const DEFAULTS = {
  maxHops: 10,
  maxBodyBytes: 16_384,
  maxMetadataBytes: 8_192,
  rateLimitMax: 30,
  rateLimitWindowSeconds: 60,
  inboxDefaultLimit: 20,
  inboxMaxLimit: 100,
  maxDescriptionLength: 500,
  roomAgentCap: 10,
  ownerName: "owner",
  waitMaxSeconds: 8,
} as const;

function integer(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return {
    maxHops: integer("MAX_HOPS", env.MAX_HOPS, DEFAULTS.maxHops, 1, 100),
    maxBodyBytes: integer(
      "MAX_BODY_BYTES",
      env.MAX_BODY_BYTES,
      DEFAULTS.maxBodyBytes,
      1,
      DEFAULTS.maxBodyBytes,
    ),
    maxMetadataBytes: DEFAULTS.maxMetadataBytes,
    rateLimitMax: integer("RATE_LIMIT_MAX", env.RATE_LIMIT_MAX, DEFAULTS.rateLimitMax, 1, 10_000),
    rateLimitWindowSeconds: integer(
      "RATE_LIMIT_WINDOW_SECONDS",
      env.RATE_LIMIT_WINDOW_SECONDS,
      DEFAULTS.rateLimitWindowSeconds,
      1,
      86_400,
    ),
    inboxDefaultLimit: DEFAULTS.inboxDefaultLimit,
    inboxMaxLimit: DEFAULTS.inboxMaxLimit,
    maxDescriptionLength: DEFAULTS.maxDescriptionLength,
    roomAgentCap: integer("ROOM_AGENT_CAP", env.ROOM_AGENT_CAP, DEFAULTS.roomAgentCap, 1, 100),
    ownerName: ownerName(env.OWNER_NAME),
    waitMaxSeconds: integer("WAIT_MAX_SECONDS", env.WAIT_MAX_SECONDS, DEFAULTS.waitMaxSeconds, 1, 20),
  };
}

function ownerName(value: string | undefined): string {
  const name = value?.trim() || DEFAULTS.ownerName;
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) {
    throw new Error("OWNER_NAME must be a lowercase agent slug");
  }
  return name;
}
