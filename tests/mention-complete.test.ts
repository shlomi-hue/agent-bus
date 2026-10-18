import { describe, expect, it } from "vitest";
import { mentionNames } from "../src/bus/mentions.js";
import { applyMention, hintLabel, mentionHints, mentionQuery, suggestMentions } from "../src/chat/mention-complete.js";

describe("composer mention autocomplete", () => {
  it("finds the @token at the caret", () => {
    expect(mentionQuery("hi @co", 6)).toEqual({ start: 3, query: "co" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("(@cl", 4)).toEqual({ start: 1, query: "cl" });
    expect(mentionQuery("mail me@codex", 13)).toBeNull();
    expect(mentionQuery("hi @co there", 12)).toBeNull();
    expect(mentionQuery("@1x", 3)).toBeNull();
  });

  it("ranks prefix matches before substring matches", () => {
    expect(suggestMentions("c", ["grok", "codex", "claude", "codex"])).toEqual(["claude", "codex"]);
    expect(suggestMentions("o", ["grok", "codex", "claude"])).toEqual(["codex", "grok"]);
    expect(suggestMentions("", ["b", "a"], 1)).toEqual(["a"]);
    expect(suggestMentions("CO", ["codex", "claude"])).toEqual(["codex"]);
  });

  it("replaces the partial token and adds one space", () => {
    expect(applyMention("hi @co", 3, 6, "codex")).toEqual({ text: "hi @codex ", caret: 10 });
    expect(applyMention("hi @cox please", 3, 5, "codex")).toEqual({ text: "hi @codex please", caret: 9 });
  });

  it("classifies mentions the way the server will treat them", () => {
    const hints = mentionHints("@codex and @Claude and @nobody and @grok `@skip`", ["codex", "claude", "grok"], ["codex", "claude"]);
    expect(hints.map((hint) => [hint.name, hint.status])).toEqual([
      ["codex", "ok"],
      ["claude", "ok"],
      ["nobody", "unknown"],
      ["grok", "not-member"],
    ]);
    expect(hintLabel(hints[0]!)).toBe("@codex gets a task");
    expect(hintLabel(hints[2]!)).toBe("@nobody: unknown agent");
    expect(hintLabel(hints[3]!)).toBe("@grok is not in this room");
    expect(mentionHints("@grok", ["grok"], null)[0]?.status).toBe("ok");
    expect(hints.some((hint) => hintLabel(hint).includes("lowercase"))).toBe(false);
  });

  it("agrees with the server parser on which mentions count", () => {
    const text = "@codex, ping (@Claude). `@grok` @CODEX x@y";
    const ok = mentionHints(text, ["codex", "claude", "grok"], null)
      .filter((hint) => hint.status === "ok")
      .map((hint) => hint.name);
    expect(ok).toEqual(mentionNames(text));
    expect(ok).toEqual(["codex", "claude"]);
  });
});
