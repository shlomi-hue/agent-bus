import { describe, expect, it } from "vitest";
import { hashToken, mintToken } from "../src/auth/tokens.js";
import { mentionNames } from "../src/bus/mentions.js";
import { AgentBus, type Caller } from "../src/bus/service.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/db/memory-store.js";
import type { Agent } from "../src/db/types.js";
import { callTool } from "../src/mcp/tools.js";

async function fixture(cap = "2") {
  const store = new MemoryStore();
  const config = loadConfig({ ROOM_AGENT_CAP: cap, MAX_HOPS: "1", RATE_LIMIT_MAX: "100" });
  const bus = new AgentBus(store, config);
  const codex = await store.insertAgent({ name: "codex", description: "", tokenHash: hashToken(mintToken()) });
  const claude = await store.insertAgent({ name: "claude", description: "", tokenHash: hashToken(mintToken()) });
  const owner = await store.insertAgent({
    name: "owner",
    description: "",
    tokenHash: hashToken(mintToken()),
    isHuman: true,
  });
  const caller = (agent: Agent): Caller => ({ id: agent.id, name: agent.name, isHuman: agent.isHuman });
  await callTool(bus, caller(owner), "create_room", { name: "general" }, config);
  await callTool(bus, caller(owner), "add_member", { room: "general", agent: "codex" }, config);
  await callTool(bus, caller(owner), "add_member", { room: "general", agent: "claude" }, config);
  return { store, config, bus, codex, claude, owner, caller };
}

describe("mentions", () => {
  it("reads @names and skips fenced code", () => {
    expect(mentionNames("hey @codex and @claude")).toEqual(["codex", "claude"]);
    expect(mentionNames("email me at user@domain.test")).toEqual([]);
    expect(mentionNames("```\n@codex\n``` and `@claude` plus @grok")).toEqual(["grok"]);
  });
});

describe("tasks", () => {
  it("creates one task per mentioned agent and surfaces it in the inbox", async () => {
    const { store, config, bus, codex, claude, owner, caller } = await fixture();
    const sent = await callTool(
      bus,
      caller(owner),
      "send_room_message",
      { room: "general", body: "please @codex look, and @codex again, not @nobody, not @owner" },
      config,
    );
    expect(sent.isError).toBeUndefined();
    const tasks = await store.listTasks({ assigneeId: codex.id });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.creatorName).toBe("owner");
    expect(tasks[0]?.status).toBe("open");
    expect(await store.listTasks({ assigneeId: claude.id })).toHaveLength(0);

    const inbox = await callTool(bus, caller(codex), "read_inbox", {}, config);
    expect(inbox.content[0]?.text).toContain("Tasks for you");
    expect(inbox.content[0]?.text).toContain(tasks[0]?.id);

    const listed = await callTool(bus, caller(codex), "list_my_tasks", {}, config);
    expect(listed.content[0]?.text).toContain("1 task(s)");
  });

  it("posts a status note, and skips that note when the room is paused", async () => {
    const { store, config, bus, codex, claude, owner, caller } = await fixture("1");
    await callTool(bus, caller(owner), "send_room_message", { room: "general", body: "@codex ship it" }, config);
    await callTool(bus, caller(codex), "send_room_message", { room: "general", body: "on it" }, config);
    const task = (await store.listTasks({ assigneeId: codex.id }))[0];
    if (!task) throw new Error("task missing");
    const before = (await store.listRoomMessages({ roomId: task.roomId ?? "", since: null, limit: 20 })).length;

    const updated = await callTool(
      bus,
      caller(codex),
      "update_task",
      { id: task.id, status: "working", result: "reading the diff" },
      config,
    );
    expect(updated.isError).toBeUndefined();
    expect(updated.content[0]?.text).toContain("not posted");
    const afterPause = await store.listRoomMessages({ roomId: task.roomId ?? "", since: null, limit: 20 });
    expect(afterPause).toHaveLength(before);
    expect((await store.getTask(task.id))?.status).toBe("working");

    const human = await callTool(
      bus,
      caller(owner),
      "update_task",
      { id: task.id, status: "done", link: "https://example.com/pr/1" },
      config,
    );
    expect(human.isError).toBeUndefined();
    expect(human.content[0]?.text).toContain("status note was posted");
    const log = await store.listRoomMessages({ roomId: task.roomId ?? "", since: null, limit: 20 });
    expect(log.at(-1)?.body).toContain("set the task for codex to done");
    expect(log.at(-1)?.body).not.toContain("@");
    expect(log.at(-1)?.metadata.kind).toBe("task_status");
    expect(await store.listTasks({})).toHaveLength(1);

    const stranger = await callTool(
      bus,
      caller(claude),
      "update_task",
      { id: task.id, status: "blocked" },
      config,
    );
    expect(stranger.isError).toBe(true);
    expect(stranger.content[0]?.text).toContain("assignee");
  });

  it("does not let a mention chain skip the room cap", async () => {
    const { store, config, bus, codex, claude, owner, caller } = await fixture("2");
    await callTool(bus, caller(owner), "send_room_message", { room: "general", body: "start" }, config);
    await callTool(bus, caller(codex), "send_room_message", { room: "general", body: "@claude your turn" }, config);
    await callTool(bus, caller(claude), "send_room_message", { room: "general", body: "looking" }, config);
    const blocked = await callTool(
      bus,
      caller(codex),
      "send_room_message",
      { room: "general", body: "@claude again" },
      config,
    );
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]?.text).toContain("paused");
    const room = await store.getRoomByName("general");
    const messages = await store.listRoomMessages({ roomId: room?.id ?? "", since: null, limit: 20 });
    expect(messages).toHaveLength(3);
    expect(await store.listTasks({ assigneeId: claude.id })).toHaveLength(1);
    expect(await store.listTasks({ assigneeId: codex.id })).toHaveLength(0);
  });

  it("assigns a direct-message mention without raising the hop by itself", async () => {
    const { store, config, bus, codex, owner, caller } = await fixture();
    const sent = await callTool(
      bus,
      caller(owner),
      "send_message",
      { to: "codex", body: "@codex can you check this?" },
      config,
    );
    expect(sent.isError).toBeUndefined();
    const tasks = await store.listTasks({ assigneeId: codex.id });
    expect(tasks).toHaveLength(1);
    const thread = await store.listThread(tasks[0]?.threadId ?? "");
    expect(thread).toHaveLength(1);
    expect(thread[0]?.hopCount).toBe(0);
  });
});
