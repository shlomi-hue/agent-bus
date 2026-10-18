import { describe, expect, it } from "vitest";
import { bearerMatches, hashToken, mintToken, parseBearer } from "../src/auth/tokens.js";
import { MemoryStore } from "../src/db/memory-store.js";
import { serviceRoleFetch } from "../src/db/supabase-store.js";

describe("tokens", () => {
  it("mints a high-entropy token and stores only its hash", () => {
    const token = mintToken();
    const hash = hashToken(token);
    expect(token.startsWith("ab_")).toBe(true);
    expect(token.length).toBeGreaterThan(40);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
    expect(hashToken(mintToken())).not.toBe(hash);
  });

  it("parses a bearer header and ignores anything else", () => {
    expect(parseBearer("Bearer ab_token")).toBe("ab_token");
    expect(parseBearer("bearer ab_token")).toBe("ab_token");
    expect(parseBearer("Basic ab_token")).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("Bearer ")).toBeNull();
  });

  it("compares cron secrets without accepting a different length", () => {
    expect(bearerMatches("Bearer super-secret-value", "super-secret-value")).toBe(true);
    expect(bearerMatches("Bearer super-secret-value", "super-secret-other")).toBe(false);
    expect(bearerMatches("Bearer short", "super-secret-value")).toBe(false);
    expect(bearerMatches(undefined, "super-secret-value")).toBe(false);
  });
});

describe("supabase service key", () => {
  it("sends a new secret key only as apikey and keeps a legacy JWT bearer", async () => {
    const seen: Array<{ authorization: string | null; apikey: string | null }> = [];
    const capture: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ authorization: headers.get("authorization"), apikey: headers.get("apikey") });
      return new Response("ok");
    };

    await serviceRoleFetch(
      "sb_secret_test",
      capture,
    )("https://example.test", {
      headers: { authorization: "Bearer sb_secret_test", apikey: "sb_secret_test" },
    });
    await serviceRoleFetch(
      "eyJlegacy",
      capture,
    )("https://example.test", {
      headers: { authorization: "Bearer eyJlegacy", apikey: "eyJlegacy" },
    });

    expect(seen[0]).toEqual({ authorization: null, apikey: "sb_secret_test" });
    expect(seen[1]).toEqual({ authorization: "Bearer eyJlegacy", apikey: "eyJlegacy" });
  });
});

describe("agent resolution", () => {
  it("resolves an active agent and rejects missing, wrong, and revoked tokens", async () => {
    const store = new MemoryStore();
    const token = mintToken();
    const agent = await store.insertAgent({
      name: "codex",
      description: "laptop",
      tokenHash: hashToken(token),
    });

    expect((await store.findAgentByTokenHash(hashToken(token)))?.id).toBe(agent.id);
    expect(await store.findAgentByTokenHash(hashToken("ab_nope"))).toBeNull();
    expect(await store.findAgentByTokenHash(hashToken(parseBearer(undefined) ?? ""))).toBeNull();

    await store.revokeAgentByName("codex");
    expect(await store.findAgentByTokenHash(hashToken(token))).toBeNull();
    const listed = await store.listAgents(false);
    expect(listed.find((item) => item.name === "codex")).toBeUndefined();
  });
});
