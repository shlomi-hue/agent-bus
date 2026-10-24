import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FIXTURES, tmpdir } from "./helpers.js";

const INSTALL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "install.sh");
const SECRET = "super-secret-do-not-copy";

function runInstall(home, args) {
  return spawnSync("bash", [INSTALL, "--node", process.execPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, AGENT_BUS_LISTENER_TEST: "1" },
  });
}

function readConfig(home) {
  return JSON.parse(fs.readFileSync(path.join(home, ".agent-bus", "listener", "config.json"), "utf8"));
}

test("install enable preserves codex, writes a token-less MCP file, and rollback restores it", () => {
  const home = tmpdir("abl-install-");
  fs.mkdirSync(path.join(home, ".agent-bus"), { recursive: true });
  fs.writeFileSync(path.join(home, ".agent-bus", "tokens.env"), `CLAUDE_TOKEN=${SECRET}\nCODEX_TOKEN=codex-secret\n`, { mode: 0o600 });
  const codex = path.join(FIXTURES, "fake-codex.sh");
  const claude = path.join(FIXTURES, "fake-claude.sh");
  const workspace = path.join(home, "agent-workspace");

  const first = runInstall(home, ["--codex", codex, "--workspace", workspace]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /backup:/);
  assert.ok(!first.stdout.includes(SECRET));
  assert.ok(!first.stderr.includes(SECRET));

  const cfgPath = path.join(home, ".agent-bus", "listener", "config.json");
  const cfg = readConfig(home);
  cfg.agents.codex.model = "keep-me";
  cfg.agents.codex.extraArgs = ["-c", "x=1"];
  fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);

  const enabled = runInstall(home, ["--enable-claude", "--claude", claude, "--codex", codex, "--workspace", workspace]);
  assert.equal(enabled.status, 0, enabled.stdout + enabled.stderr);
  const after = readConfig(home);
  assert.equal(after.agents.codex.model, "keep-me");
  assert.deepEqual(after.agents.codex.extraArgs, ["-c", "x=1"]);
  assert.equal(after.agents.codex.bin, codex);
  assert.equal(after.agents.claude.enabled, true);
  assert.equal(after.agents.claude.bin, claude);
  assert.equal(after.agents.claude.dangerouslySkipPermissions, false);
  assert.equal(after.agents.claude.permissionMode, "dontAsk");
  assert.equal(after.agents.claude.allowBash, false);
  assert.ok(!after.agents.claude.allowedTools.includes("Bash"));

  const mcpPath = path.join(home, ".agent-bus", "listener", "claude.mcp.json");
  const mcpText = fs.readFileSync(mcpPath, "utf8");
  assert.equal(fs.statSync(mcpPath).mode & 0o777, 0o600);
  assert.match(mcpText, /Bearer \$\{CLAUDE_TOKEN\}/);
  assert.equal(JSON.parse(mcpText).mcpServers.agent_bus.type, "http");
  assert.ok(!mcpText.includes(SECRET), "mcp template must not contain the token");
  assert.ok(!fs.readFileSync(cfgPath, "utf8").includes(SECRET));

  const rolled = runInstall(home, ["--rollback"]);
  assert.equal(rolled.status, 0, rolled.stdout + rolled.stderr);
  assert.match(rolled.stdout, /rolling back/);
  const restored = readConfig(home);
  assert.equal(restored.agents.codex.model, "keep-me");
  assert.deepEqual(restored.agents.codex.extraArgs, ["-c", "x=1"]);
  assert.equal(restored.agents.claude.bin, "claude");
  assert.notEqual(restored.agents.claude.bin, claude);

  const again = runInstall(home, ["--enable-claude", "--claude", claude]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  const off = runInstall(home, ["--disable-claude"]);
  assert.equal(off.status, 0, off.stdout + off.stderr);
  const disabled = readConfig(home);
  assert.equal(disabled.agents.codex.model, "keep-me");
  assert.equal(disabled.agents.codex.bin, codex);
  assert.equal(disabled.agents.claude.enabled, false);
  assert.equal(disabled.agents.claude.bin, claude);
});
