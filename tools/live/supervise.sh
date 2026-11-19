#!/usr/bin/env bash
# Keeps one juror running: restarts tools/live/juror.sh whenever it exits (the worker exits on an unhandled RPC
# error such as a public-RPC timeout on eth_blockNumber). Re-scans are safe: the worker skips posted verdicts.
#   tools/live/supervise.sh <1|2|3> [workers dir]
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
while true; do
  "$DIR/juror.sh" "$@"
  echo "--- juror $1 exited with $? at $(date -u +%FT%TZ); restarting in 5 s"
  sleep 5
done
