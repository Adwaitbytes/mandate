#!/usr/bin/env bash
# Keeps one juror running: restarts tools/live/juror.sh whenever it exits, with exponential backoff (5 s doubling
# to 5 min, back to 5 s after a run that lasted 10 min), and appends its output to evidence/live/juror-<n>.log,
# rotated at JUROR_LOG_MAX_BYTES (default 5 MB, JUROR_LOG_KEEP=5 old files). API-key-shaped strings are masked,
# $HOME is written as ~ and a pinned worktree's directory as <pinned worktree> before anything reaches the log.
# The worker itself never prints a key; the mask is a second line of defence. Re-scans after a restart are safe:
# the worker skips verdicts already posted.
#   tools/live/supervise.sh <1|2|3> [workers dir]
# SIGTERM or SIGINT stops it: the juror gets SIGTERM, finishes its pass (at most JUROR_STOP_GRACE_S, default 45 s,
# then SIGKILL) and the supervisor exits. Exit code 78 from the juror is a configuration error: no restart.
# `make jurors-up` / `make jurors-down` start and stop all three.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
JUROR="${1:?usage: supervise.sh <1|2|3> [workers dir]}"
case "$JUROR" in 1 | 2 | 3) ;; *) echo "juror must be 1, 2 or 3" >&2 && exit 2 ;; esac

LOG_DIR="${JUROR_LOG_DIR:-$REPO/evidence/live}"
LOG="$LOG_DIR/juror-$JUROR.log"
MAX_BYTES="${JUROR_LOG_MAX_BYTES:-5242880}"
KEEP="${JUROR_LOG_KEEP:-5}"
GRACE="${JUROR_STOP_GRACE_S:-45}"
STATE_DIR="$REPO/workers/.state"
PIDFILE="$STATE_DIR/supervise-juror-$JUROR.pid"
mkdir -p "$LOG_DIR" "$STATE_DIR"

# A pinned worktree usually lives in a scratch directory whose path names the machine's user; log it as a label.
WORKERS_ARG="${2:-$REPO/workers}"
PIN="$(cd "$(dirname "$WORKERS_ARG")" 2>/dev/null && pwd || true)"
[ "$PIN" = "$REPO" ] && PIN=""

if sed --version >/dev/null 2>&1; then UNBUFFERED=-u; else UNBUFFERED=-l; fi
redact() {
  sed "$UNBUFFERED" -E \
    -e "${PIN:+s#${PIN}#<pinned worktree>#g}" \
    -e 's/sk-ant-[A-Za-z0-9_-]{8,}/sk-ant-[redacted]/g' \
    -e 's/gsk_[A-Za-z0-9]{8,}/gsk_[redacted]/g' \
    -e 's/AIza[0-9A-Za-z_-]{20,}/AIza[redacted]/g' \
    -e 's/(Bearer|x-api-key|X-goog-api-key)([" :=]+)[A-Za-z0-9._-]{8,}/\1\2[redacted]/g' \
    -e 's/([?&](key|apikey|api_key|token)=)[^&[:space:]"]+/\1[redacted]/g' \
    -e "s#${HOME}#~#g"
}

rotate() {
  [ -f "$LOG" ] || return 0
  local size
  size=$(wc -c <"$LOG")
  [ "$size" -lt "$MAX_BYTES" ] && return 0
  local i
  for ((i = KEEP - 1; i >= 1; i--)); do
    [ -f "$LOG.$i" ] && mv -f "$LOG.$i" "$LOG.$((i + 1))"
  done
  mv -f "$LOG" "$LOG.1"
}

write_log() {
  local n=0 line
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line" >>"$LOG"
    n=$((n + 1))
    if [ $((n % 50)) -eq 0 ]; then rotate; fi
  done
}

say() { printf -- '--- %s supervisor juror %s: %s\n' "$(date -u +%FT%TZ)" "$JUROR" "$*" | redact | write_log; }

child=""
killer=""
stopping=0
on_stop() {
  stopping=1
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    kill -TERM "$child" 2>/dev/null
    (sleep "$GRACE" && kill -KILL "$child" 2>/dev/null) &
    killer=$!
  fi
}
trap on_stop TERM INT
trap 'rm -f "$PIDFILE"' EXIT
echo $$ >"$PIDFILE"

rotate
delay=5
say "started (pid $$, workers $WORKERS_ARG)"
while [ "$stopping" -eq 0 ]; do
  started=$(date +%s)
  "$DIR/juror.sh" "$@" > >(redact | write_log) 2>&1 &
  child=$!
  status=0
  wait "$child" || status=$?
  # A trapped signal interrupts `wait`; wait again for the juror to finish its pass and report its real status.
  while kill -0 "$child" 2>/dev/null; do
    status=0
    wait "$child" || status=$?
  done
  child=""
  [ -n "$killer" ] && kill "$killer" 2>/dev/null
  ran=$(($(date +%s) - started))
  if [ "$stopping" -ne 0 ]; then
    say "stopped (juror exited with $status after ${ran} s)"
    break
  fi
  if [ "$status" -eq 78 ]; then
    say "juror exited with 78 (configuration error) after ${ran} s; not restarting"
    exit 78
  fi
  [ "$ran" -ge 600 ] && delay=5
  say "juror exited with $status after ${ran} s; restarting in ${delay} s"
  sleep "$delay" &
  wait $! 2>/dev/null
  delay=$((delay * 2))
  [ "$delay" -gt 300 ] && delay=300
done
