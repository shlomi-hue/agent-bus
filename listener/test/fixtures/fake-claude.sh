#!/bin/bash
# Fake `claude` for tests. Records argv, the --mcp-config file mode/content check, emits a JSON result.
set -u
log="${FAKE_LOG:-/dev/null}"
{
  echo "ARGV"
  printf '%s\n' "$@"
  echo "END"
} >>"$log"
cat >/dev/null
if [ "${1:-}" = "--version" ]; then echo "0.0.0 (Claude Code fake)"; exit 0; fi
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
echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"done\",\"session_id\":\"$sid\"}"
exit "${FAKE_EXIT:-0}"
