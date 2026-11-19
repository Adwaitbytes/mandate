#!/usr/bin/env bash
# Dev server pointed at the local mock chain (tests/e2e/mock-chain.ts) for the screenshot harness.
# The relayer key is anvil's first well-known test key, public and worthless; DATABASE_URL is unset so the
# harness never writes to the shared database.
set -euo pipefail
cd "$(dirname "$0")/.."
MOCK="${MOCK:-http://127.0.0.1:8645}"
export NEXT_PUBLIC_RPC_84532="$MOCK/rpc/84532"
export NEXT_PUBLIC_RPC_1301="$MOCK/rpc/1301"
export NEXT_PUBLIC_RPC_5318007="$MOCK/rpc/5318007"
export NEXT_PUBLIC_RATIONALE_BASE_URL="$MOCK/evidence"
export NEXT_PUBLIC_E2E_DEPLOYMENTS="$(tr -d '\n' < tests/e2e/deployments.json)"
export DEMO_RELAYER_PK="${DEMO_RELAYER_PK-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
export PROPOSE_LIMIT_PER_IP_PER_HOUR="${PROPOSE_LIMIT_PER_IP_PER_HOUR:-100}"
unset DATABASE_URL
exec npx next dev -p "${PORT:-3218}"
