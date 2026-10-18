#!/bin/bash
# Fake `codex` for tests. Records argv + stdin, emits codex-style JSONL.
# Env: FAKE_LOG (argv log), FAKE_SLEEP (seconds), FAKE_EXIT (code), FAKE_BAD_SESSIONS (space separated ids
# that fail to resume), FAKE_CHILD_PIDFILE (spawn a grandchild `sleep` and write its pid here).
set -u
log="${FAKE_LOG:-/dev/null}"
{
  echo "ARGV"
  printf '%s\n' "$@"
  echo "END"
} >>"$log"
stdin_data="$(cat)"
printf '%s' "$stdin_data" >"${log}.stdin.$$"

if [ "${1:-}" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi

resume_id=""
outfile=""
prev=""
is_resume=0
for a in "$@"; do
  if [ "$prev" = "-o" ]; then outfile="$a"; fi
  if [ "$a" = "resume" ]; then is_resume=1; fi
  prev="$a"
done
if [ "$is_resume" = "1" ]; then
  # session id is the argument right before the final "-"
  n=$#
  resume_id="${!n}"
  if [ "$resume_id" = "-" ]; then m=$((n - 1)); resume_id="${!m}"; fi
  for bad in ${FAKE_BAD_SESSIONS:-}; do
    if [ "$bad" = "$resume_id" ]; then
      echo "Error: thread/resume: thread/resume failed: no rollout found for thread id $resume_id (code -32600)" >&2
      exit 1
    fi
  done
fi
if [ -n "$resume_id" ]; then tid="$resume_id"; else tid="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr '[:upper:]' '[:lower:]')"; fi
echo "{\"type\":\"thread.started\",\"thread_id\":\"$tid\"}"
echo '{"type":"turn.started"}'
if [ -n "${FAKE_CHILD_PIDFILE:-}" ]; then
  sleep 300 &
  echo $! >"$FAKE_CHILD_PIDFILE"
fi
if [ -n "${FAKE_SLEEP:-}" ]; then sleep "$FAKE_SLEEP"; fi
if [ -n "$outfile" ]; then echo "fake final answer" >"$outfile"; fi
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
exit "${FAKE_EXIT:-0}"
