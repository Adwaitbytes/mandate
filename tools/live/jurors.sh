#!/usr/bin/env bash
# Starts, stops or lists the three supervised live jurors (tools/live/supervise.sh). Used by make jurors-up,
# jurors-down and jurors-status.
#   tools/live/jurors.sh up [workers dir] | down | status
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
STATE="$REPO/workers/.state"
LOGS="${JUROR_LOG_DIR:-$REPO/evidence/live}"

pid_of() {
  local f="$STATE/supervise-juror-$1.pid"
  [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null && cat "$f"
}

case "${1:-}" in
up)
  workers="${2:-$REPO/workers}"
  for n in 1 2 3; do
    if pid=$(pid_of "$n"); then
      echo "juror $n already supervised (pid $pid)"
      continue
    fi
    nohup "$DIR/supervise.sh" "$n" "$workers" >/dev/null 2>&1 &
    echo "juror $n started from $workers, log $LOGS/juror-$n.log"
  done
  ;;
down)
  for n in 1 2 3; do
    if pid=$(pid_of "$n"); then
      kill -TERM "$pid" && echo "juror $n stopping (supervisor $pid)"
    else
      echo "juror $n not running"
    fi
  done
  # The supervisor gives each juror JUROR_STOP_GRACE_S (45 s) to finish its pass before SIGKILL.
  for _ in $(seq 1 60); do
    alive=0
    for n in 1 2 3; do pid_of "$n" >/dev/null && alive=1; done
    [ "$alive" -eq 0 ] && echo "all jurors stopped" && exit 0
    sleep 1
  done
  echo "jurors still stopping after 60 s; see $LOGS/juror-<n>.log" >&2
  exit 1
  ;;
status)
  for n in 1 2 3; do
    if pid=$(pid_of "$n"); then state="up (supervisor $pid)"; else state="down"; fi
    echo "juror $n: $state; last line: $(tail -1 "$LOGS/juror-$n.log" 2>/dev/null | cut -c1-160)"
  done
  ;;
*)
  echo "usage: jurors.sh up [workers dir] | down | status" >&2
  exit 2
  ;;
esac
