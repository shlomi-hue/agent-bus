import { describe, expect, it } from "vitest";
import { renderMarkdown, safeHref } from "../src/chat/markdown.js";

describe("markdown sanitizer", () => {
  it("renders the common formatting and keeps links inert", () => {
    const html = renderMarkdown(
      [
        "**bold** and *italic* and ~~gone~~",
        "",
        "- one",
        "- two",
        "",
        "[docs](https://example.com/guide)",
        "",
        "`inline`",
        "",
        "```ts",
        "const answer = 1",
        "```",
        "",
        "| a | b |",
        "| --- | --- |",
        "| 1 | 2 |",
      ].join("\n"),
    );
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain('href="https://example.com/guide"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("<code>inline</code>");
    expect(html).toContain('class="language-ts"');
    expect(html).toContain('class="tok-kw">const</span>');
    expect(html).toContain(">Copy</button>");
    expect(html).toContain("<table>");
    expect(html).toContain("<td>2</td>");
  });

  it("escapes raw html, drops unsafe urls, and does not load images", () => {
    const html = renderMarkdown(
      [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '<a href="https://example.com" onclick="alert(1)">x</a>',
        "[click](javascript:alert(1))",
        "[data](data:text/html,<script>alert(1)</script>)",
        '[break](https://example.com/"><script>alert(1)</script>)',
        "![pic](https://cdn.example/secret.png)",
        "![nope](javascript:alert(1))",
      ].join("\n\n"),
    );
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain("<img");
    expect(html).not.toMatch(/<[^>]*\sonerror=/i);
    expect(html).not.toMatch(/<[^>]*\sonclick=/i);
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(html.toLowerCase()).not.toContain("data:text");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).toContain("https://cdn.example/secret.png");
    expect(html).not.toMatch(/<a[^>]+href="javascript:/);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("https://example.com/ok")).toBe("https://example.com/ok");
    expect(safeHref("//evil.example")).toBeNull();
  });
});
