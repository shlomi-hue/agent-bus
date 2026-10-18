import { describe, expect, it } from "vitest";
import { hashToken, mintToken } from "../src/auth/tokens.js";
import { AgentBus, nextHop } from "../src/bus/service.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/db/memory-store.js";
import { BusError } from "../src/errors.js";

describe("hop limit", () => {
  it("increments on reply and refuses the hop past the maximum", () => {
    expect(nextHop(0, 10)).toBe(1);
    expect(() => nextHop(10, 10)).toThrow(BusError);
    expect(() => nextHop(10, 10)).toThrow(/maximum is 10/);
    expect(nextHop(9, 10)).toBe(10);
  });

  it("keeps the thread, swaps the recipient, and stops the chain", async () => {
    const store = new MemoryStore();
    const config = loadConfig({ MAX_HOPS: "2" });
    const bus = new AgentBus(store, config);
    const codex = await store.insertAgent({
      name: "codex",
      description: "",
      tokenHash: hashToken(mintToken()),
    });
    const claude = await store.insertAgent({
      name: "claude",
      description: "",
      tokenHash: hashToken(mintToken()),
    });

    const first = await bus.send({ id: codex.id, name: "codex" }, { to: "claude", body: "ping" });
    expect(first.hopCount).toBe(0);
    expect(first.toName).toBe("claude");

    const second = await bus.reply({ id: claude.id, name: "claude" }, { message_id: first.id, body: "pong" });
    expect(second.threadId).toBe(first.threadId);
    expect(second.toAgent).toBe(codex.id);
    expect(second.hopCount).toBe(1);
    expect(second.replyTo).toBe(first.id);

    const third = await bus.reply({ id: codex.id, name: "codex" }, { message_id: second.id, body: "again" });
    expect(third.hopCount).toBe(2);

    await expect(
      bus.reply({ id: claude.id, name: "claude" }, { message_id: third.id, body: "too far" }),
    ).rejects.toMatchObject({ code: "hop_limit" });

    await expect(
      bus.reply({ id: codex.id, name: "codex" }, { message_id: first.id, body: "not mine" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
