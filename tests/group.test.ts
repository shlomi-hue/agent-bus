import { describe, expect, it } from "vitest";
import {
  agentBadge,
  agentRunPaused,
  avatarColor,
  groupMessages,
  initials,
  relativeTime,
  type ChatMessage,
} from "../src/chat/group.js";

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "createdAt" | "fromName">): ChatMessage {
  return {
    fromIsHuman: false,
    body: partial.id,
    ...partial,
  };
}

describe("message grouping", () => {
  const now = new Date("2026-10-16T15:00:00.000Z");

  it("groups the same sender within a few minutes and splits the rest", () => {
    const blocks = groupMessages(
      [
        message({ id: "a", fromName: "codex", createdAt: "2026-10-16T14:00:00.000Z", body: "one" }),
        message({ id: "b", fromName: "codex", createdAt: "2026-10-16T14:03:00.000Z", body: "two" }),
        message({ id: "c", fromName: "codex", createdAt: "2026-10-16T14:12:00.000Z", body: "later" }),
        message({ id: "d", fromName: "claude", createdAt: "2026-10-16T14:12:30.000Z", body: "other" }),
      ],
      now,
    );
    const groups = blocks.filter((block) => block.kind === "group");
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ fromName: "codex" });
    expect(groups[0]?.kind === "group" ? groups[0].messages.map((item) => item.id) : []).toEqual(["a", "b"]);
    expect(groups[1]?.kind === "group" ? groups[1].messages.map((item) => item.id) : []).toEqual(["c"]);
    expect(groups[2]).toMatchObject({ fromName: "claude" });
    expect(blocks[0]).toMatchObject({ kind: "day", label: "Today" });
  });

  it("starts a new day even when the gap is short", () => {
    const blocks = groupMessages(
      [
        message({ id: "late", fromName: "codex", createdAt: "2026-10-15T23:59:30.000Z" }),
        message({ id: "early", fromName: "codex", createdAt: "2026-10-16T00:01:00.000Z" }),
      ],
      now,
    );
    expect(blocks.map((block) => block.kind)).toEqual(["day", "group", "day", "group"]);
    expect(blocks.filter((block) => block.kind === "day").map((block) => block.label)).toEqual([
      "Yesterday",
      "Today",
    ]);
  });

  it("describes relative time, initials, and a paused agent run", () => {
    expect(relativeTime("2026-10-16T14:59:20.000Z", now)).toBe("just now");
    expect(relativeTime("2026-10-16T14:50:00.000Z", now)).toBe("10m");
    expect(relativeTime("2026-10-16T12:00:00.000Z", now)).toBe("3h");
    expect(initials("codex")).toBe("CO");
    expect(agentBadge("claude-dev")).toBe("Claude");
    expect(agentBadge("owner")).toBeNull();
    expect(avatarColor("owner", true)).toBe("#0f6e56");
    expect(avatarColor("codex", false)).not.toBe(avatarColor("owner", true));
    const agents = [{ fromIsHuman: false }, { fromIsHuman: false }];
    expect(agentRunPaused(agents, 2)).toBe(true);
    expect(agentRunPaused([...agents, { fromIsHuman: true }, { fromIsHuman: false }], 2)).toBe(false);
    expect(agentRunPaused(agents, 3)).toBe(false);
  });
});
