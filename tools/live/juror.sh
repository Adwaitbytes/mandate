#!/usr/bin/env bash
# Runs one live juror worker (polling) against the deployed Docket on Base Sepolia.
#   tools/live/juror.sh <1|2|3> [workers dir]
# The workers dir defaults to this repo's workers/; pass a worktree pinned to a commit to keep the code fixed while
# others edit. Evidence always lands in this repo's evidence/. Keys come from the Foundry keystores, API keys from the
# workspace .env.local (never printed).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
JUROR="${1:?usage: juror.sh <1|2|3> [workers dir]}"
WORKERS="${2:-$REPO/workers}"
last() { grep "^$1=" "$REPO/contracts/deployments/$2.env" | tail -1 | cut -d= -f2; }

export JUROR_ID="$JUROR"
export DOCKET="$(last DOCKET 84532)"
export DOCKET_START_BLOCK="${DOCKET_START_BLOCK:-60839337}"
export HEARING_CHAIN_ID=84532
export RPC_URL_84532="${RPC_URL_84532:-https://sepolia.base.org}"
export RPC_URL_1301="${RPC_URL_1301:-https://sepolia.unichain.org}"
export RATIONALE_BASE_URL="https://raw.githubusercontent.com/Adwaitbytes/mandate/master/evidence"
export RATIONALE_STORE=fs
export EVIDENCE_DIR="$REPO/evidence"
export MANDATE_ENV_FILE="${MANDATE_ENV_FILE:-$(cd "$REPO/.." && pwd)/.env.local}"
# Base Sepolia's public RPC serves at most 200 blocks per eth_getLogs.
export LOG_CHUNK_BLOCKS="${LOG_CHUNK_BLOCKS:-150}"
export CONFIRMATIONS="${CONFIRMATIONS:-2}"
export POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-10000}"

cd "$WORKERS"
echo "juror $JUROR from $(git rev-parse --short HEAD) in $WORKERS, Docket $DOCKET"
exec ./node_modules/.bin/tsx src/cli/juror.ts
