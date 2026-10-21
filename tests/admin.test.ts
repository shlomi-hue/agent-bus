import { describe, expect, it } from "vitest";
import { hashToken } from "../src/auth/tokens.js";
import { runAdmin } from "../src/admin/cli.js";
import { MemoryStore } from "../src/db/memory-store.js";

function io(secret = "local-admin-secret-value", ownerName?: string) {
  const store = new MemoryStore();
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    store,
    stdout,
    stderr,
    admin: {
      store,
      adminSecret: secret,
      ownerName,
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    },
  };
}

describe("admin CLI", () => {
  it("refuses to mint a token without a real admin secret", async () => {
    const harness = io("short");
    expect(await runAdmin(["register", "--name", "codex"], harness.admin)).toBe(1);
    expect(harness.stderr.join("\n")).toMatch(/ADMIN_SECRET/);
    const placeholder = io("replace-with-a-long-random-string");
    expect(await runAdmin(["list"], placeholder.admin)).toBe(1);
  });

  it("registers, lists, revokes, and rotates a revoked name", async () => {
    const harness = io();
    expect(
      await runAdmin(
        ["register", "--name", "codex", "--description", "laptop codex"],
        harness.admin,
      ),
    ).toBe(0);
    const tokenLine = harness.stdout.find((line) => line.startsWith("token: "));
    expect(tokenLine).toBeTruthy();
    const token = tokenLine?.slice("token: ".length) ?? "";
    expect(harness.stderr.join("\n")).toMatch(/will not be shown again/);
    const agent = await harness.store.findAgentByTokenHash(hashToken(token));
    expect(agent?.name).toBe("codex");
    expect(agent?.tokenHash).not.toBe(token);

    harness.stdout.length = 0;
    expect(await runAdmin(["register", "--name", "codex"], harness.admin)).toBe(1);
    expect(harness.stderr.join("\n")).toMatch(/already registered/);

    expect(await runAdmin(["revoke", "--name", "codex"], harness.admin)).toBe(0);
    expect(await harness.store.findAgentByTokenHash(hashToken(token))).toBeNull();

    harness.stdout.length = 0;
    expect(await runAdmin(["register", "--name", "codex"], harness.admin)).toBe(0);
    const rotated = harness.stdout.find((line) => line.startsWith("token: "))?.slice("token: ".length);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(token);
    expect((await harness.store.findAgentByTokenHash(hashToken(rotated ?? "")))?.name).toBe("codex");

    harness.stdout.length = 0;
    expect(await runAdmin(["list"], harness.admin)).toBe(0);
    expect(harness.stdout.join("\n")).toContain("codex");
    expect(harness.stdout.join("\n")).not.toContain(rotated);
  });

  it("creates the human owner and seeds a room without printing a token", async () => {
    const harness = io();
    expect(await runAdmin(["ensure-owner"], harness.admin)).toBe(0);
    expect(harness.stdout.join("\n")).toContain("human: owner");
    expect(harness.stdout.join("\n")).not.toContain("token:");
    expect(harness.stderr.join("\n")).toMatch(/No token was printed/);
    const owner = await harness.store.getAgentByName("owner");
    expect(owner?.isHuman).toBe(true);

    await harness.store.insertAgent({
      name: "codex",
      description: "",
      tokenHash: hashToken("a".repeat(32)),
    });
    harness.stdout.length = 0;
    expect(
      await runAdmin(["seed-room", "--name", "general", "--members", "owner,codex,missing"], harness.admin),
    ).toBe(1);
    expect(harness.stdout.join("\n")).toContain("room: general");
    expect(harness.stderr.join("\n")).toContain("missing");
    const room = await harness.store.getRoomByName("general");
    expect(room).toBeTruthy();
    expect(await harness.store.isRoomMember(room?.id ?? "", owner?.id ?? "")).toBe(true);

    harness.stderr.length = 0;
    expect(await runAdmin(["seed-room", "--members", "owner,codex"], harness.admin)).toBe(0);
  });

  it("uses OWNER_NAME when the owner slug is set explicitly", async () => {
    const harness = io("local-admin-secret-value", "owner");
    expect(await runAdmin(["ensure-owner"], harness.admin)).toBe(0);
    expect(harness.stdout.join("\n")).toContain("human: owner");
    expect((await harness.store.getAgentByName("owner"))?.isHuman).toBe(true);
  });

  it("stores a webhook secret without printing it", async () => {
    const harness = io();
    await harness.store.insertAgent({
      name: "codex",
      description: "",
      tokenHash: hashToken("b".repeat(32)),
    });
    const secret = "webhook-secret-value";
    expect(
      await runAdmin(
        ["set-webhook", "--name", "codex", "--url", "https://example.com/hook", "--secret", secret],
        harness.admin,
      ),
    ).toBe(0);
    expect(harness.stdout.join("\n")).toContain("https://example.com/hook");
    expect(harness.stdout.join("\n")).not.toContain(secret);
    expect(harness.stderr.join("\n")).toMatch(/will not be shown/);
    const agent = await harness.store.getAgentByName("codex");
    expect((await harness.store.getWebhook(agent?.id ?? ""))?.secret).toBe(secret);
    expect(await runAdmin(["clear-webhook", "--name", "codex"], harness.admin)).toBe(0);
    expect(await harness.store.getWebhook(agent?.id ?? "")).toBeNull();
  });
});
