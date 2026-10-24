#!/bin/bash
# Install agent-bus-listener into ~/.agent-bus/listener and write the LaunchAgent plist.
# Default: install only (does NOT start). Pass --start to load it with launchctl.
#
#   ./install.sh [--start] [--node PATH] [--codex PATH] [--claude PATH] [--workspace DIR]
#                [--reconfigure] [--enable-claude] [--disable-claude] [--rollback]
#
# Idempotent: re-running upgrades the code and keeps config.json unless --reconfigure,
# --enable-claude, or --disable-claude is set. Each run stores a backup first.
# --rollback restores the newest backup (code, config, plist) and does not start anything.
set -euo pipefail

LABEL="com.agent-bus.listener"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START=0
RECONFIGURE=0
ENABLE_CLAUDE=0
DISABLE_CLAUDE=0
ROLLBACK=0
CODEX_EXPLICIT=0
CLAUDE_EXPLICIT=0
NODE_BIN="${AGENT_BUS_LISTENER_NODE:-}"
CODEX_BIN=""
CLAUDE_BIN=""
WORKSPACE="$HOME/agent-workspace"
TEST_MODE="${AGENT_BUS_LISTENER_TEST:-0}" # 1 = allow non-macOS and skip launchctl (used for testing)

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --start) START=1 ;;
    --reconfigure) RECONFIGURE=1 ;;
    --enable-claude) ENABLE_CLAUDE=1 ;;
    --disable-claude) DISABLE_CLAUDE=1 ;;
    --rollback) ROLLBACK=1 ;;
    --node) NODE_BIN="$2"; shift ;;
    --codex) CODEX_BIN="$2"; CODEX_EXPLICIT=1; shift ;;
    --claude) CLAUDE_BIN="$2"; CLAUDE_EXPLICIT=1; shift ;;
    --workspace) WORKSPACE="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

if [ "$ENABLE_CLAUDE" = "1" ] && [ "$DISABLE_CLAUDE" = "1" ]; then
  die "pass only one of --enable-claude and --disable-claude"
fi

if [ "$(uname -s)" != "Darwin" ] && [ "$TEST_MODE" != "1" ]; then
  die "this installer is for macOS (set AGENT_BUS_LISTENER_TEST=1 to dry-install elsewhere)"
fi

LISTENER_DIR="$HOME/.agent-bus/listener"
LOG_DIR="$HOME/.agent-bus/logs"
TOKENS="$HOME/.agent-bus/tokens.env"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
CODEX_APP_BIN="/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
BACKUP_ITEMS=(lib bin templates test package.json README.md config.example.json install.sh uninstall.sh config.json claude.mcp.json)

backup_state() {
  local dest stamp item
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="$LISTENER_DIR/backups/${stamp}-$$"
  mkdir -p "$dest"
  for item in "${BACKUP_ITEMS[@]}"; do
    if [ -e "$LISTENER_DIR/$item" ]; then
      cp -a "$LISTENER_DIR/$item" "$dest/$item"
    fi
  done
  if [ -f "$PLIST" ]; then
    cp -a "$PLIST" "$dest/plist"
  fi
  printf '%s\n' "$dest" >"$LISTENER_DIR/backups/latest"
  say "backup: $dest"
}

prune_backups() {
  local dirs=() d count keep drop i
  for d in "$LISTENER_DIR"/backups/20*; do
    [ -d "$d" ] || continue
    dirs+=("$d")
  done
  count="${#dirs[@]}"
  keep=15
  if [ "$count" -le "$keep" ]; then return 0; fi
  drop=$((count - keep))
  for ((i = 0; i < drop; i++)); do
    rm -rf "${dirs[$i]}"
  done
}

latest_backup() {
  local p
  if [ -f "$LISTENER_DIR/backups/latest" ]; then
    p="$(head -n 1 "$LISTENER_DIR/backups/latest")"
    if [ -n "$p" ] && [ -d "$p" ]; then
      printf '%s\n' "$p"
      return 0
    fi
  fi
  return 1
}

rollback() {
  local src item
  src="$(latest_backup)" || die "no backup to roll back (looked in $LISTENER_DIR/backups)"
  say "rolling back from $src (does not start the listener)"
  for item in "${BACKUP_ITEMS[@]}"; do
    if [ -e "$src/$item" ]; then
      rm -rf "${LISTENER_DIR:?}/$item"
      cp -a "$src/$item" "$LISTENER_DIR/$item"
    fi
  done
  if [ -f "$src/plist" ]; then
    mkdir -p "$PLIST_DIR"
    cp -a "$src/plist" "$PLIST"
    say "restored $PLIST"
  fi
  say "restored code and config from $src"
  say "Codex settings in that backup are back. Restart only if you want the restored code loaded:"
  echo "    launchctl kickstart -k gui/$(id -u)/$LABEL"
  exit 0
}

if [ "$ROLLBACK" = "1" ]; then
  mkdir -p "$LISTENER_DIR"
  rollback
fi

# ---------------------------------------------------------------- detect node (>= 20)
node_ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0])>=20?0:1)' 2>/dev/null; }
if ! node_ok "$NODE_BIN"; then
  NODE_BIN=""
  # newest usable nvm node (glob order is lexical; keep the last one that works)
  for cand in "$HOME"/.nvm/versions/node/v*/bin/node; do
    if node_ok "$cand"; then NODE_BIN="$cand"; fi
  done
  if [ -z "$NODE_BIN" ]; then
    for cand in /opt/homebrew/bin/node /usr/local/bin/node "$(command -v node 2>/dev/null || true)"; do
      if node_ok "$cand"; then NODE_BIN="$cand"; break; fi
    done
  fi
fi
[ -n "$NODE_BIN" ] || die "no Node >= 20 found; pass --node /absolute/path/to/node"
say "node: $NODE_BIN ($("$NODE_BIN" --version))"

# ---------------------------------------------------------------- detect codex / claude
if [ -z "$CODEX_BIN" ]; then
  if [ -x "$CODEX_APP_BIN" ]; then CODEX_BIN="$CODEX_APP_BIN"; else CODEX_BIN="$(command -v codex 2>/dev/null || true)"; fi
fi
if [ -n "$CODEX_BIN" ] && [ -x "$CODEX_BIN" ]; then
  say "codex: $CODEX_BIN"
else
  warn "codex CLI not found (expected $CODEX_APP_BIN); codex will be skipped until it exists"
  CODEX_BIN="${CODEX_BIN:-$CODEX_APP_BIN}"
fi

CLAUDE_FOUND=0
if [ "$CLAUDE_EXPLICIT" = "1" ]; then
  if [ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ]; then
    CLAUDE_FOUND=1
  else
    warn "claude path not executable: ${CLAUDE_BIN:-<empty>}"
  fi
else
  for cand in "$(command -v claude 2>/dev/null || true)" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then CLAUDE_BIN="$cand"; CLAUDE_FOUND=1; break; fi
  done
fi
if [ "$CLAUDE_FOUND" = "1" ]; then
  say "claude: $CLAUDE_BIN"
else
  say "claude: Claude Code CLI not installed; the listener will skip claude until you install it and pass --enable-claude"
  CLAUDE_BIN="${CLAUDE_BIN:-claude}"
fi

NODE_DIR="$(dirname "$NODE_BIN")"
CODEX_DIR="$(dirname "$CODEX_BIN")"
CHILD_PATH="$CODEX_DIR:$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
if [ "$CLAUDE_FOUND" = "1" ]; then
  CLAUDE_DIR="$(dirname "$CLAUDE_BIN")"
  case ":$CHILD_PATH:" in
    *":$CLAUDE_DIR:"*) ;;
    *) CHILD_PATH="$CLAUDE_DIR:$CHILD_PATH" ;;
  esac
fi

# ---------------------------------------------------------------- copy code
say "installing into $LISTENER_DIR"
mkdir -p "$LISTENER_DIR" "$LOG_DIR" "$PLIST_DIR" "$LISTENER_DIR/backups" "$HOME/.agent-bus"
chmod 700 "$HOME/.agent-bus" "$LISTENER_DIR" 2>/dev/null || true
backup_state
prune_backups
if [ "$SRC" != "$LISTENER_DIR" ]; then
  for item in lib bin templates test package.json README.md config.example.json install.sh uninstall.sh; do
    if [ -e "$SRC/$item" ]; then
      rm -rf "${LISTENER_DIR:?}/$item"
      cp -a "$SRC/$item" "$LISTENER_DIR/$item"
    fi
  done
else
  say "running from the install dir; code left as is"
fi
chmod +x "$LISTENER_DIR/bin/agent-bus-listener" "$LISTENER_DIR/install.sh" "$LISTENER_DIR/uninstall.sh"
printf '%s\n' "$NODE_BIN" >"$LISTENER_DIR/node-path"

# ---------------------------------------------------------------- config.json
CONFIG_MODE=""
if [ ! -f "$LISTENER_DIR/config.json" ]; then
  CONFIG_MODE="fresh"
elif [ "$RECONFIGURE" = "1" ]; then
  CONFIG_MODE="reconfigure"
fi

apply_config() {
  LISTENER_DIR="$LISTENER_DIR" CONFIG_MODE="$1" \
    CODEX_BIN="$CODEX_BIN" CLAUDE_BIN="$CLAUDE_BIN" CLAUDE_FOUND="$CLAUDE_FOUND" \
    WORKSPACE="$WORKSPACE" CHILD_PATH="$CHILD_PATH" \
    CODEX_EXPLICIT="$CODEX_EXPLICIT" CLAUDE_EXPLICIT="$CLAUDE_EXPLICIT" \
    "$NODE_BIN" --input-type=module <<'JS'
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const root = process.env.LISTENER_DIR;
const mod = await import(pathToFileURL(`${root}/lib/config.js`).href);
const example = JSON.parse(fs.readFileSync(`${root}/config.example.json`, "utf8"));
const outPath = `${root}/config.json`;
const prev = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : null;
let cfg;
switch (process.env.CONFIG_MODE) {
  case "fresh":
    cfg = mod.freshConfig(example, process.env);
    break;
  case "reconfigure":
    cfg = mod.reconfigurePreservingCodex(prev, example, process.env);
    break;
  case "enable-claude":
    cfg = mod.enableClaudeAgent(prev ?? example, example, process.env);
    break;
  case "disable-claude":
    cfg = mod.disableClaudeAgent(prev ?? example, example);
    break;
  default:
    throw new Error(`unknown config mode ${process.env.CONFIG_MODE}`);
}
fs.writeFileSync(outPath, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
if (process.env.CONFIG_MODE !== "disable-claude") {
  const name = cfg.agents?.claude?.mcpServerName || "agent_bus";
  const doc = mod.claudeMcpTemplate({ url: cfg.mcpUrl, serverName: name });
  fs.writeFileSync(`${root}/claude.mcp.json`, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
}
JS
}

if [ -n "$CONFIG_MODE" ]; then
  apply_config "$CONFIG_MODE"
  say "wrote $LISTENER_DIR/config.json ($CONFIG_MODE)"
else
  say "keeping existing config.json (Codex settings included). Use --reconfigure, --enable-claude, or --disable-claude to change it."
fi
if [ "$ENABLE_CLAUDE" = "1" ]; then
  apply_config "enable-claude"
  say "claude enabled in config.json (Codex settings were not changed)"
  if [ "$CLAUDE_FOUND" != "1" ]; then
    warn "Claude Code is still not installed. Install it yourself, then re-run install.sh --enable-claude"
  fi
fi
if [ "$DISABLE_CLAUDE" = "1" ]; then
  apply_config "disable-claude"
  say "claude disabled in config.json (Codex settings were not changed)"
fi

mkdir -p "$WORKSPACE"
say "workspace: $WORKSPACE"
if [ -f "$TOKENS" ]; then
  say "tokens: $TOKENS present ($(grep -oE '^(export )?[A-Z_]+_TOKEN=' "$TOKENS" | sed -E 's/^export //; s/=$//' | tr '\n' ' '))"
else
  warn "$TOKENS not found; the listener needs CODEX_TOKEN (and CLAUDE_TOKEN for claude). Values are never written into config."
fi
if [ -f "$LISTENER_DIR/claude.mcp.json" ]; then
  say "claude MCP template: $LISTENER_DIR/claude.mcp.json (Authorization is \${CLAUDE_TOKEN}, not a token value)"
fi

# ---------------------------------------------------------------- plist
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
sed_escape() { printf '%s' "$1" | sed -e 's/[\/&|]/\\&/g'; }
sub() { sed_escape "$(xml_escape "$1")"; }
TMP_PLIST="$(mktemp "${TMPDIR:-/tmp}/agent-bus-listener-plist.XXXXXX")"
sed -e "s|__LABEL__|$(sub "$LABEL")|g" \
    -e "s|__NODE__|$(sub "$NODE_BIN")|g" \
    -e "s|__LISTENER_DIR__|$(sub "$LISTENER_DIR")|g" \
    -e "s|__LOGDIR__|$(sub "$LOG_DIR")|g" \
    -e "s|__PATH__|$(sub "$CHILD_PATH")|g" \
    -e "s|__HOME__|$(sub "$HOME")|g" \
    "$LISTENER_DIR/templates/$LABEL.plist.template" >"$TMP_PLIST"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$TMP_PLIST" >/dev/null || { rm -f "$TMP_PLIST"; die "generated plist failed plutil -lint"; }
elif command -v xmllint >/dev/null 2>&1; then
  xmllint --noout "$TMP_PLIST" || { rm -f "$TMP_PLIST"; die "generated plist is not well-formed XML"; }
fi
mv "$TMP_PLIST" "$PLIST"
chmod 644 "$PLIST"
say "wrote $PLIST"

# ---------------------------------------------------------------- launchctl
DOMAIN="gui/$(id -u)"
TARGET="$DOMAIN/$LABEL"
run_launchctl() {
  if [ "$TEST_MODE" = "1" ]; then echo "[test mode] launchctl $*"; return 0; fi
  launchctl "$@"
}
is_loaded() { [ "$TEST_MODE" != "1" ] && launchctl print "$TARGET" >/dev/null 2>&1; }

if [ "$START" = "1" ]; then
  if is_loaded; then
    say "service already loaded; reloading"
    run_launchctl bootout "$TARGET" 2>/dev/null || true
    sleep 2
  fi
  run_launchctl enable "$TARGET" 2>/dev/null || true
  if ! run_launchctl bootstrap "$DOMAIN" "$PLIST"; then
    warn "launchctl bootstrap failed; trying legacy 'launchctl load -w' (seen on some macOS 26.x hosts)"
    run_launchctl load -w "$PLIST" || die "could not load $PLIST"
  fi
  say "started. Check: $LISTENER_DIR/bin/agent-bus-listener status"
else
  if is_loaded; then
    say "service is currently loaded and still runs the previous code; restart it with:"
    echo "    launchctl kickstart -k $TARGET"
  else
    say "installed but NOT started. Start with:"
    echo "    launchctl bootstrap gui/\$(id -u) ~/Library/LaunchAgents/$LABEL.plist"
  fi
fi
cat <<MSG

Next steps:
  $LISTENER_DIR/bin/agent-bus-listener doctor
  $LISTENER_DIR/bin/agent-bus-listener health
  $LISTENER_DIR/bin/agent-bus-listener test
  (optional) alias agent-bus-listener=$LISTENER_DIR/bin/agent-bus-listener

Claude Code is not installed by this script. When you install it yourself:
  install.sh --enable-claude
Undo that with install.sh --disable-claude. Undo the last install with install.sh --rollback.

Codex still runs with --dangerously-bypass-approvals-and-sandbox.
Claude runs in --permission-mode dontAsk with the allowlist in config.json unless
agents.claude.dangerouslySkipPermissions is true. Read README.md.
MSG
