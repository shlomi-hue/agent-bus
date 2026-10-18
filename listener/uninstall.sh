#!/bin/bash
# Uninstall agent-bus-listener.
#   ./uninstall.sh            stop + remove the LaunchAgent; asks before deleting ~/.agent-bus/listener
#   ./uninstall.sh --purge    also delete ~/.agent-bus/listener (code, config, state) and the listener's logs
#   ./uninstall.sh --keep     never delete ~/.agent-bus/listener (no prompt)
# Never touches ~/.agent-bus/tokens.env, ~/.codex, ~/.claude, or the workspace folder.
set -euo pipefail

LABEL="com.agent-bus.listener"
LISTENER_DIR="$HOME/.agent-bus/listener"
LOG_DIR="$HOME/.agent-bus/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEST_MODE="${AGENT_BUS_LISTENER_TEST:-0}"
MODE="ask"
for arg in "$@"; do
  case "$arg" in
    --purge) MODE="purge" ;;
    --keep) MODE="keep" ;;
    -h|--help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
TARGET="gui/$(id -u)/$LABEL"

if [ "$TEST_MODE" = "1" ]; then
  echo "[test mode] launchctl bootout $TARGET"
elif launchctl print "$TARGET" >/dev/null 2>&1; then
  say "stopping $TARGET"
  launchctl bootout "$TARGET" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
else
  say "service not loaded"
fi

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  say "removed $PLIST"
fi

if [ "$MODE" = "ask" ]; then
  if [ -t 0 ]; then
    printf 'Delete %s (code, config.json, state.json with session ids)? [y/N] ' "$LISTENER_DIR"
    read -r answer || answer=""
    case "$answer" in y|Y|yes|YES) MODE="purge" ;; *) MODE="keep" ;; esac
  else
    MODE="keep"
  fi
fi

if [ "$MODE" = "purge" ]; then
  # Safety: only ever delete the exact listener directory and the listener's own log files.
  case "$LISTENER_DIR" in
    "$HOME/.agent-bus/listener") rm -rf "$LISTENER_DIR" ;;
    *) echo "refusing to delete unexpected path $LISTENER_DIR" >&2; exit 1 ;;
  esac
  rm -f "$LOG_DIR"/listener.log "$LOG_DIR"/listener.log.* "$LOG_DIR"/launchd.out.log "$LOG_DIR"/launchd.err.log
  rm -rf "$LOG_DIR/runs"
  rmdir "$LOG_DIR" 2>/dev/null || true
  say "removed $LISTENER_DIR and listener logs"
else
  say "kept $LISTENER_DIR (run with --purge to delete it)"
fi
say "untouched: ~/.agent-bus/tokens.env, ~/.codex, ~/.claude, and your workspace folder"
