#!/usr/bin/env bash
# Appends one funds snapshot (spendable = balance + reserves - debt at the system contract / callback proxy) for the
# reactive contract, the Docket and both Delegates to evidence/live/funds.jsonl.  tools/live/funds.sh <note>
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
last() { grep "^$1=" "$REPO/contracts/deployments/$2.env" | tail -1 | cut -d= -f2; }
snap() { # rpc payer service
  local b r d n
  n=$(cast block-number --rpc-url "$1")
  b=$(cast balance "$2" --rpc-url "$1" --block "$n")
  r=$(cast call "$3" "reserves(address)(uint256)" "$2" --rpc-url "$1" --block "$n" | cut -d' ' -f1)
  d=$(cast call "$3" "debt(address)(uint256)" "$2" --rpc-url "$1" --block "$n" | cut -d' ' -f1)
  printf '{"block":%s,"balance":"%s","reserves":"%s","debt":"%s","spendable":"%s"}' "$n" "$b" "$r" "$d" "$(python3 -c "print($b+$r-$d)")"
}
L=https://lasna-rpc.rnk.dev/; B=https://sepolia.base.org; U=https://sepolia.unichain.org
printf '{"at":"%s","note":"%s","reactive":%s,"docket":%s,"delegateBase":%s,"delegateUnichain":%s}\n' \
  "$(date -u +%FT%TZ)" "${1:-}" \
  "$(snap $L "$(last MANDATE_REACTIVE 5318007)" 0x8888888888888888888888888888888888888888)" \
  "$(snap $B "$(last DOCKET 84532)" 0x476F44b11F5C942c58f4c8E3d0300E5710743585)" \
  "$(snap $B "$(last DELEGATE 84532)" 0x476F44b11F5C942c58f4c8E3d0300E5710743585)" \
  "$(snap $U "$(last DELEGATE 1301)" 0x775c9B990ADe401060B78D0e98684eEf8d2466C1)" | tee -a "$REPO/evidence/live/funds.jsonl"
