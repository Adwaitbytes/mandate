#!/usr/bin/env python3
"""Files the live evidence run's proposals on the demo governors and appends one JSON line per filing to
evidence/proposals.jsonl (label, governor, tx, block, chain stamp, proposal id). Signs with `cast` and the
omni-deployer keystore; this script never sees a key.

  python3 tools/live/propose.py C01 C02 ...      # file these labels (each at most once; refuses a repeat)
"""
import json, os, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from cases import CASES, DEAD, GOVERNORS, INJECTION_2  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
RPC = {84532: "https://sepolia.base.org", 1301: "https://sepolia.unichain.org"}
TOPIC = "0x7d84a6263ae0d98d3329bd7b46bb4e8d6f98cd35a7adb45c274c8b7fd5ebd5e0"
OUT = REPO / "evidence" / "proposals.jsonl"
SIGNER = ["--account", "omni-deployer", "--password-file", os.path.expanduser("~/.claude/secrets/omni-deployer.pass")]


def deployment(chain: int, key: str) -> str:
    lines = (REPO / "contracts" / "deployments" / f"{chain}.env").read_text().splitlines()
    vals = [l.split("=", 1)[1] for l in lines if l.startswith(key + "=")]
    if not vals:
        raise SystemExit(f"{key} missing in deployments/{chain}.env")
    return vals[-1]


def cast(*args: str) -> str:
    return subprocess.run(["cast", *args], check=True, capture_output=True, text=True).stdout.strip()


def samples() -> dict:
    tsx = REPO / "workers" / "node_modules" / ".bin" / "tsx"
    src = REPO / "web" / "src" / "lib" / "samples.ts"
    out = subprocess.run([str(tsx), "-e", f"import {{samples}} from '{src}'; console.log(JSON.stringify(samples))"],
                         check=True, capture_output=True, text=True).stdout
    return {s["id"]: s for s in json.loads(out)}


def eval_proposal(dao: str, key: str) -> dict:
    data = json.loads((REPO / "analysis" / "eval" / "data" / "proposals.json").read_text())["proposals"]
    hits = [p for p in data if p["dao"] == dao and str(p["proposalId"]) == key]
    hits = hits or [p for p in data if p["dao"] == dao and key in p["description"][:200]]
    if len(hits) != 1:
        raise SystemExit(f"eval:{dao}:{key} matched {len(hits)} proposals")
    return hits[0]


def demo_action(token: str, s: dict) -> tuple[list, list, list]:
    to = s["recipient"] or deployment(84532, "DOCKET") and "0x4d96Ec766088D952D62255227902eeEe1C58276c"
    amount = int(s["transferTokens"]) * 10**18
    data = cast("calldata", "transfer(address,uint256)", to, str(amount))
    return [token], ["0"], [data]


def build(source: str, chain: int, iso: str) -> tuple[list, list, list, str, dict]:
    kind, _, rest = source.partition(":")
    token = deployment(chain, "VOTES_TOKEN")
    if kind in ("sample", "custom"):
        s = samples()[rest] if kind == "sample" else INJECTION_2
        t, v, c = demo_action(token, s)
        footer = (f"---\nFiled on the Mandate demo governor by the live evidence run at {iso}. Its one on-chain action "
                  "is the token transfer described above, on the demo token.")
        return t, v, c, f"# {s['title']}\n\n{s['body']}\n\n{footer}", {"source": source}
    dao, _, key = rest.partition(":")
    p = eval_proposal(dao, key)
    calldatas = []
    for sig, data in zip(p["signatures"], p["calldatas"]):
        if sig:
            sel = cast("sig", sig)
            data = sel + data[2:]
        calldatas.append(data)
    footer = (f"\n\n---\nReplayed verbatim on the Mandate demo governor for the live evidence run at {iso}, from "
              f"{dao} mainnet proposal {p['proposalId']}. The actions are the original mainnet actions and are never "
              "executed here.")
    return p["targets"], [str(x) for x in p["values"]], calldatas, p["description"] + footer, {
        "source": source, "mainnetProposalId": str(p["proposalId"]), "mainnetTx": p["txHash"]}


def file(label: str) -> dict:
    case = next((c for c in CASES if c[0] == label), None)
    if case is None:
        raise SystemExit(f"unknown label {label}")
    done = [json.loads(l)["label"] for l in OUT.read_text().splitlines()] if OUT.exists() else []
    if label in done:
        raise SystemExit(f"{label} already filed")
    _, gov_key, source, intent = case
    chain, key = GOVERNORS[gov_key]
    governor = deployment(chain, key)
    iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    targets, values, calldatas, desc, meta = build(source, chain, iso)
    arr = lambda xs: "[" + ",".join(xs) + "]"
    sent_ms = int(time.time() * 1000)
    rcpt = json.loads(cast("send", governor, "propose(address[],uint256[],bytes[],string)", arr(targets), arr(values),
                           arr(calldatas), desc, "--rpc-url", RPC[chain], *SIGNER, "--json"))
    if rcpt["status"] != "0x1":
        raise SystemExit(f"{label}: propose reverted {rcpt['transactionHash']}")
    log = next(l for l in rcpt["logs"] if l["topics"][0] == TOPIC and l["address"].lower() == governor.lower())
    data = log["data"][2:]
    word = lambda i: int(data[64 * i:64 * (i + 1)], 16)
    block = None
    for _ in range(20):  # public RPCs can lag the receipt by a few seconds
        block = json.loads(cast("rpc", "eth_getBlockByNumber", rcpt["blockNumber"], "false", "--rpc-url", RPC[chain]))
        if block:
            break
        time.sleep(2)
    row = {
        "label": label, "intent": intent, "governorKey": gov_key, "chainId": chain, "governor": governor,
        "proposalId": str(word(0)), "voteStart": str(word(6)), "voteEnd": str(word(7)),
        "tx": rcpt["transactionHash"], "block": int(rcpt["blockNumber"], 16),
        "blockTimestamp": int(block["timestamp"], 16),
        "blockTimestampMs": int(log["blockTimestampMs"], 16) if log.get("blockTimestampMs") else None,
        "gasUsed": int(rcpt["gasUsed"], 16), "descriptionChars": len(desc), "sentAtLocalMs": sent_ms,
        "filedAt": iso, **meta,
    }
    with OUT.open("a") as f:
        f.write(json.dumps(row) + "\n")
    return row


if __name__ == "__main__":
    for label in sys.argv[1:]:
        r = file(label)
        print(f"{r['label']} {r['governorKey']} proposal {r['proposalId'][:12]}... tx {r['tx']} block {r['block']}")
