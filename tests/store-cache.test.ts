import { describe, expect, it } from "vitest";
import { createStoreFromEnv } from "../src/db/create-store.js";

describe("createStoreFromEnv", () => {
  it("creates one Supabase client per url and key for the life of the process", () => {
    const env = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_example_key",
    };
    const first = createStoreFromEnv(env);
    const second = createStoreFromEnv({ ...env });
    expect(second).toBe(first);

    const otherKey = createStoreFromEnv({
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: "sb_secret_other_key",
    });
    expect(otherKey).not.toBe(first);
  });
});
