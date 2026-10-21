import { describe, expect, it } from "vitest";
import { hashToken, mintToken } from "../src/auth/tokens.js";
import { AgentBus } from "../src/bus/service.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/db/memory-store.js";
import type { Agent, AgentSummary } from "../src/db/types.js";
import { buildHome } from "../src/http/home-feed.js";

function summary(agent: Agent, isHuman = agent.isHuman): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    isHuman,
    createdAt: agent.createdAt,
    revokedAt: agent.revokedAt,
    lastSeenAt: agent.lastSeenAt,
    presence: agent.presence,
    statusText: agent.statusText,
    statusUpdatedAt: agent.statusUpdatedAt,
  };
}

describe("home feed owner", () => {
  it("marks a finished task as human only when the assignee is the configured owner", async () => {
    const store = new MemoryStore();
    const config = loadConfig({ OWNER_NAME: "ada", RATE_LIMIT_MAX: "100" });
    const bus = new AgentBus(store, config);
    const ada = await store.insertAgent({
      name: "ada",
      description: "",
      tokenHash: hashToken(mintToken()),
      isHuman: true,
    });
    const owner = await store.insertAgent({
      name: "owner",
      description: "",
      tokenHash: hashToken(mintToken()),
    });
    const codex = await store.insertAgent({
      name: "codex",
      description: "",
      tokenHash: hashToken(mintToken()),
    });
    const caller = (agent: { id: string; name: string }, isHuman = false) => ({
      id: agent.id,
      name: agent.name,
      isHuman,
    });
    const room = await bus.createRoom(caller(ada, true), { name: "general" });
    await bus.addMember(caller(ada, true), { room: "general", agent: "owner" });
    await bus.addMember(caller(ada, true), { room: "general", agent: "codex" });
    await bus.sendRoom(caller(codex), { room: "general", body: "please @owner and @ada finish the note" });
    const tasks = await store.listTasks({});
    for (const task of tasks) {
      await bus.updateTask(caller(task.assigneeName === "ada" ? ada : owner, task.assigneeName === "ada"), {
        id: task.id,
        status: "done",
      });
    }
    const feed = await buildHome(store, summary(ada), [room.id]);
    const finished = feed.activity.filter((item) => item.text.startsWith("finished"));
    expect(finished.find((item) => item.actor === "owner")?.actorHuman).toBe(false);
    expect(finished.find((item) => item.actor === "ada")?.actorHuman).toBe(true);

    const ownerConfig = loadConfig({ OWNER_NAME: "owner", RATE_LIMIT_MAX: "100" });
    const asOwner = await buildHome(store, summary(owner, true), [room.id]);
    expect(ownerConfig.ownerName).toBe("owner");
    expect(asOwner.activity.find((item) => item.actor === "owner" && item.text.startsWith("finished"))?.actorHuman).toBe(
      true,
    );
  });
});
