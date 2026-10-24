#!/bin/bash
# Fake `claude` for tests.
# Records argv. `auth status` prints Claude Code's auth JSON and exits 0, or 1 when FAKE_AUTH=missing.
# A normal -p run emits one --output-format json result unless FAKE_STDOUT is set.
# Env: FAKE_LOG, FAKE_SLEEP, FAKE_EXIT, FAKE_BAD_SESSIONS, FAKE_STDOUT, FAKE_AUTH (ok|missing).
set -u
log="${FAKE_LOG:-/dev/null}"
{
  echo "ARGV"
  printf '%s\n' "$@"
  echo "END"
} >>"$log"

if [ "${1:-}" = "--version" ]; then
  echo "0.0.0 (Claude Code fake)"
  exit 0
fi
if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then
  if [ "${FAKE_AUTH:-ok}" = "missing" ]; then
    echo '{"authMethod":"none"}'
    exit 1
  fi
  echo '{"authMethod":"claude.ai"}'
  exit 0
fi

cat >/dev/null
sid=""
resume=""
prev=""
for a in "$@"; do
  case "$prev" in
    --session-id) sid="$a" ;;
    --resume) resume="$a" ;;
    --mcp-config)
      if [ -f "$a" ]; then
        mode="$(stat -c '%a' "$a" 2>/dev/null || stat -f '%Lp' "$a")"
        echo "MCPCONFIG mode=$mode" >>"$log"
        if grep -q '"Authorization":"Bearer ' "$a"; then echo "MCPCONFIG has-auth" >>"$log"; fi
      else
        echo "MCPCONFIG missing" >>"$log"
      fi
      ;;
  esac
  prev="$a"
done
if [ -n "$resume" ]; then
  for bad in ${FAKE_BAD_SESSIONS:-}; do
    if [ "$bad" = "$resume" ]; then echo "No conversation found with session ID: $resume" >&2; exit 1; fi
  done
  sid="$resume"
fi
if [ -n "${FAKE_SLEEP:-}" ]; then sleep "$FAKE_SLEEP"; fi
if [ -n "${FAKE_STDOUT+x}" ] && [ -n "${FAKE_STDOUT}" ]; then
  printf '%s\n' "$FAKE_STDOUT"
else
  echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"done\",\"session_id\":\"$sid\"}"
fi
exit "${FAKE_EXIT:-0}"
