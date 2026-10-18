#!/bin/bash
# Install agent-bus-listener into ~/.agent-bus/listener and write the LaunchAgent plist.
# Default: install only (does NOT start). Pass --start to load it with launchctl.
#
#   ./install.sh [--start] [--node PATH] [--codex PATH] [--claude PATH] [--workspace DIR] [--reconfigure]
#
# Idempotent: re-running upgrades the code, keeps config.json (unless --reconfigure), state, and PAUSE.
set -euo pipefail

LABEL="com.agent-bus.listener"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
START=0
RECONFIGURE=0
NODE_BIN="${AGENT_BUS_LISTENER_NODE:-}"
CODEX_BIN=""
CLAUDE_BIN=""
WORKSPACE="$HOME/agent-workspace"
TEST_MODE="${AGENT_BUS_LISTENER_TEST:-0}" # 1 = allow non-macOS and skip launchctl (used for testing)

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --start) START=1 ;;
    --reconfigure) RECONFIGURE=1 ;;
    --node) NODE_BIN="$2"; shift ;;
    --codex) CODEX_BIN="$2"; shift ;;
    --claude) CLAUDE_BIN="$2"; shift ;;
    --workspace) WORKSPACE="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

if [ "$(uname -s)" != "Darwin" ] && [ "$TEST_MODE" != "1" ]; then
  die "this installer is for macOS (set AGENT_BUS_LISTENER_TEST=1 to dry-install elsewhere)"
fi

LISTENER_DIR="$HOME/.agent-bus/listener"
LOG_DIR="$HOME/.agent-bus/logs"
TOKENS="$HOME/.agent-bus/tokens.env"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
CODEX_APP_BIN="/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"

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
  CODEX_BIN="$CODEX_APP_BIN"
fi
if [ -z "$CLAUDE_BIN" ]; then
  for cand in "$(command -v claude 2>/dev/null || true)" "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then CLAUDE_BIN="$cand"; break; fi
  done
fi
if [ -n "$CLAUDE_BIN" ]; then
  say "claude: $CLAUDE_BIN"
else
  say "claude: Claude Code CLI not installed; the listener will skip claude (see README 'Enabling claude')"
  CLAUDE_BIN="claude"
fi

NODE_DIR="$(dirname "$NODE_BIN")"
CODEX_DIR="$(dirname "$CODEX_BIN")"
CHILD_PATH="$CODEX_DIR:$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# ---------------------------------------------------------------- copy code
say "installing into $LISTENER_DIR"
mkdir -p "$LISTENER_DIR" "$LOG_DIR" "$PLIST_DIR"
chmod 700 "$HOME/.agent-bus" "$LISTENER_DIR" 2>/dev/null || true
if [ "$SRC" != "$LISTENER_DIR" ]; then
  for item in lib bin templates test package.json README.md config.example.json install.sh uninstall.sh; do
    if [ -e "$SRC/$item" ]; then
      rm -rf "${LISTENER_DIR:?}/$item"
      cp -R "$SRC/$item" "$LISTENER_DIR/$item"
    fi
  done
else
  say "running from the install dir; code left as is"
fi
chmod +x "$LISTENER_DIR/bin/agent-bus-listener" "$LISTENER_DIR/install.sh" "$LISTENER_DIR/uninstall.sh"
printf '%s\n' "$NODE_BIN" >"$LISTENER_DIR/node-path"

# ---------------------------------------------------------------- config.json
if [ -f "$LISTENER_DIR/config.json" ] && [ "$RECONFIGURE" != "1" ]; then
  say "keeping existing config.json (use --reconfigure to regenerate from detected paths)"
else
  [ -f "$LISTENER_DIR/config.json" ] && cp "$LISTENER_DIR/config.json" "$LISTENER_DIR/config.json.bak"
  CODEX_BIN="$CODEX_BIN" CLAUDE_BIN="$CLAUDE_BIN" WORKSPACE="$WORKSPACE" CHILD_PATH="$CHILD_PATH" \
    "$NODE_BIN" -e '
      const fs = require("fs");
      const [example, out] = process.argv.slice(1);
      const cfg = JSON.parse(fs.readFileSync(example, "utf8"));
      cfg.workspace = process.env.WORKSPACE;
      cfg.childPath = process.env.CHILD_PATH;
      cfg.agents.codex.bin = process.env.CODEX_BIN;
      cfg.agents.claude.bin = process.env.CLAUDE_BIN;
      fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    ' "$LISTENER_DIR/config.example.json" "$LISTENER_DIR/config.json"
  say "wrote $LISTENER_DIR/config.json"
fi

mkdir -p "$WORKSPACE"
say "workspace: $WORKSPACE"
if [ -f "$TOKENS" ]; then
  say "tokens: $TOKENS present ($(grep -oE '^(export )?[A-Z_]+_TOKEN=' "$TOKENS" | sed -E 's/^export //; s/=$//' | tr '\n' ' '))"
else
  warn "$TOKENS not found; the listener needs CODEX_TOKEN (and CLAUDE_TOKEN for claude)"
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
  $LISTENER_DIR/bin/agent-bus-listener test
  (optional) alias agent-bus-listener=$LISTENER_DIR/bin/agent-bus-listener

WARNING: runs Codex/Claude with ALL approvals and sandboxing disabled in $WORKSPACE. Read README.md.
MSG
