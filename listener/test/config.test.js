import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  freshConfig,
  reconfigurePreservingCodex,
  enableClaudeAgent,
  disableClaudeAgent,
  claudeMcpTemplate,
  DEFAULT_CLAUDE_ALLOWED_TOOLS,
} from "../lib/config.js";
import { tmpdir } from "./helpers.js";

const example = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config.example.json"), "utf8"));

test("defaults: claude is dontAsk with an allowlist, bypass off", () => {
  const dir = tmpdir();
  const cfg = loadConfig({ file: null, overrides: { stateFile: path.join(dir, "s"), workspace: dir } });
  assert.equal(cfg.agents.claude.permissionMode, "dontAsk");
  assert.equal(cfg.agents.claude.dangerouslySkipPermissions, false);
  assert.equal(cfg.agents.claude.allowBash, false);
  assert.deepEqual(cfg.agents.claude.allowedTools, [...DEFAULT_CLAUDE_ALLOWED_TOOLS]);
  assert.ok(!cfg.agents.claude.allowedTools.includes("Bash"));
  assert.equal(cfg.agents.claude.maxTurns, null);
});

test("bypassPermissions without the explicit flag is rejected", () => {
  assert.throws(
    () => loadConfig({ file: null, overrides: { agents: { claude: { permissionMode: "bypassPermissions" } } } }),
    /dangerouslySkipPermissions/,
  );
  const cfg = loadConfig({ file: null, overrides: { agents: { claude: { dangerouslySkipPermissions: true, permissionMode: "bypassPermissions" } } } });
  assert.equal(cfg.agents.claude.dangerouslySkipPermissions, true);
});

test("enable and disable claude leave the codex object untouched", () => {
  const prev = structuredClone(example);
  prev.agents.codex.model = "keep-me";
  prev.agents.codex.extraArgs = ["-c", "x=1"];
  prev.agents.codex.bin = "/opt/codex";
  prev.agents.claude.enabled = false;
  prev.workspace = "/work";
  prev.childPath = "/opt/codex:/usr/bin";
  const codexBefore = JSON.stringify(prev.agents.codex);
  const enabled = enableClaudeAgent(prev, example, { CLAUDE_FOUND: "1", CLAUDE_BIN: "/opt/homebrew/bin/claude" });
  assert.equal(JSON.stringify(prev.agents.codex), codexBefore);
  assert.equal(prev.agents.claude.enabled, false);
  assert.deepEqual(enabled.agents.codex, prev.agents.codex);
  assert.equal(enabled.agents.claude.enabled, true);
  assert.equal(enabled.agents.claude.bin, "/opt/homebrew/bin/claude");
  assert.equal(enabled.agents.claude.dangerouslySkipPermissions, false);
  assert.equal(enabled.agents.claude.allowBash, false);
  assert.match(enabled.childPath, /^\/opt\/homebrew\/bin:/);
  const disabled = disableClaudeAgent(enabled, example);
  assert.deepEqual(disabled.agents.codex, prev.agents.codex);
  assert.equal(disabled.agents.claude.enabled, false);
  assert.equal(disabled.agents.claude.bin, "/opt/homebrew/bin/claude");
});

test("reconfigure keeps codex settings and claude permission choices", () => {
  const prev = structuredClone(example);
  prev.agents.codex.model = "keep-me";
  prev.agents.codex.bin = "/old/codex";
  prev.agents.claude.dangerouslySkipPermissions = true;
  prev.agents.claude.allowedTools = ["Read"];
  prev.agents.claude.allowBash = true;
  prev.agents.claude.model = "opus";
  const cfg = reconfigurePreservingCodex(prev, example, {
    WORKSPACE: "/new-work",
    CHILD_PATH: "/bin",
    CODEX_BIN: "/new/codex",
    CODEX_EXPLICIT: "0",
    CLAUDE_FOUND: "1",
    CLAUDE_BIN: "/new/claude",
    CLAUDE_EXPLICIT: "1",
  });
  assert.equal(cfg.agents.codex.model, "keep-me");
  assert.equal(cfg.agents.codex.bin, "/old/codex");
  assert.equal(cfg.workspace, "/new-work");
  assert.equal(cfg.agents.claude.dangerouslySkipPermissions, true);
  assert.deepEqual(cfg.agents.claude.allowedTools, ["Read"]);
  assert.equal(cfg.agents.claude.allowBash, true);
  assert.equal(cfg.agents.claude.model, "opus");
  assert.equal(cfg.agents.claude.bin, "/new/claude");
});

test("fresh config and mcp template never embed a token value", () => {
  const cfg = freshConfig(example, { WORKSPACE: "/w", CHILD_PATH: "/bin", CODEX_BIN: "/codex", CLAUDE_FOUND: "0" });
  assert.equal(cfg.agents.claude.bin, "claude");
  assert.equal(cfg.agents.claude.dangerouslySkipPermissions, false);
  const doc = claudeMcpTemplate({ url: "https://example.test/mcp", serverName: "agent_bus" });
  const text = JSON.stringify(doc);
  assert.match(text, /Bearer \$\{CLAUDE_TOKEN\}/);
  assert.equal(doc.mcpServers.agent_bus.type, "http");
  assert.equal(doc.mcpServers.agent_bus.url, "https://example.test/mcp");
  assert.ok(!text.includes("ab_"));
});
