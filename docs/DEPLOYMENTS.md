# Deployments

Testnet only, deployed 19 Nov 2026 between 11:50 and 12:12 UTC from a clean worktree pinned to commit `b8d283b` (the EIP-170 fix, docs/DECISIONS.md). Every contract is owned by the deployer `0x4d96Ec766088D952D62255227902eeEe1C58276c` (Foundry keystore `omni-deployer`), which is both the operator on Lasna and the mandate owner on the Docket. Addresses are also in `contracts/deployments/<chainId>.env` (last line per key wins) and the broadcasts in `contracts/broadcast/DeployMandate.s.sol/`.

Explorers: Lasna `https://lasna.reactscan.net`, Base Sepolia `https://sepolia.basescan.org`, Unichain Sepolia `https://unichain-sepolia.blockscout.com`. Source: Sourcify, `https://repo.sourcify.dev/<chainId>/<address>`. Every contract below returned status `match` (full bytecode match; `bytecode_hash = "none"` means there is no metadata hash to make it an `exact_match`). Log: `evidence/live/sourcify.log`.

## Reactive Lasna (5318007)

| Contract | Address | Deploy tx | Gas |
|---|---|---|---|
| MandateLogic (linked library) | `0x6fd18Ff568825BCC34095cCB195fcdD1ecC75dF2` | `0x4ac6f055d0aacaef9cb2f37f9d8cc7a0a2f7dac50e914c7870c864f192dbeb5d` | 1,286,494 |
| MandateReactive | `0xd5897E56762eB47ac309610CDe8cbf03b5996560` | `0x095cc3741d59fdbf40716151bda283946f5771429f6d8879c0d89ea88efdc55b` | 5,240,036 |

Constructor: operator `0x4d96…276c`, cron topic Cron100 `0xb49937fb…3c70`, `MIN_VETO_WINDOW` 300 s, funded 2.0 lREACT; topped up 1.0 lREACT with `depositTo` at 12:23 UTC (`0x1dde9818…bd9714`).

Wiring (`WireReactive`, then `cast send`):

| Call | Tx |
|---|---|
| `setDocket(84532, Docket)` | `0x56d34f486e715a4f4a1a3bd3860732d777e9217b629626e6dac4769a4875d86d` |
| `watchGovernor(84532, base governor, Timestamp, 0)` | `0x05a2d36bdb039fb6dc78682c06433c2a92a15e63ed336386408811b1d02c117b` |
| `setDelegate(84532, base Delegate)` | `0x63f790124d6c7c34772eb9f48a11b83733089f3dbedbba8391e3edc23d2c2a32` |
| `watchGovernor(1301, unichain governor, BlockNumber, 1000 ms)` | `0xf3683ffd66ae014f55801d2b7a154144999a406981fe79ba35e3094870e75526` |
| `setDelegate(1301, unichain Delegate)` | `0x5006ff6d7cdf56e3d1e10e0053c073ee6be875d75639a559614046f5f5b2e7a7` |
| `watchGovernor(84532, slow governor, Timestamp, 0)` | `0xfab2ad1276203c4673c2a4c90b6c634db374f8d8a9b1a67a0a78d2c52fffa25f` |
| `watchGovernor(84532, brief governor, Timestamp, 0)` | `0x5299554b0b58612a54f903a0166bfe5455fc52346d63fd3a2718db5c53fb02ab` |
| `setConfig` (below) | sent twice; the first send was dropped by a shell quoting mistake, the second applied (read back with `config()`) |
| `setGovernorLimits(…, maxActive 32, maxPerHour 30)` x4 | `0x3a1c15de…de6d4`, `0x36d71bf2…f724`, `0xdbb620f3…f3e4`, `0xef23e98f…76da` |

`setDelegate` for the second and third Base governors returned early (same Delegate), as designed.

Config in force for every case of the live run (`config()` on Lasna): quorum **3**, minAgreeing 2, injectionFlagsToHold 1, minConfidence 6000 bps, majority 5000 bps, split policy **Hold**, maxAttempts 3, veto window **300 s**, resendAfter 180 s, retryAfter 60 s, caseTtl 14 days, openCase gas 500,000, cast gas 600,000. Quorum 3 rather than the default 2 so every case is tallied on all three verdicts and a split is a real three-way disagreement (DECISIONS.md).

`list_subscriptions` (Reactive MCP) after wiring: 14 active filters, all proven: four Docket events, `ProposalCreated` on four governors, and `Cast` / `NotActive` / `Cancelled` on both Delegates. Cron subscribes and unsubscribes itself.

## Base Sepolia (84532): hearing chain and timestamp-clock demo DAO

| Contract | Address | Deploy tx |
|---|---|---|
| Docket | `0xE48a9dFdDBb8dD3bDE49a06d1113DaB58599F40c` | `0x8ec13ec21aa884563c54047d94229b0bf461632e3184417f5e491072bf98c01a` (block 60,839,337, funded 0.0003 ETH) |
| `addJurors` (3) | | `0xf540fce9a3a34a7d34b7195a168fbef4003945e5960439260f7875992168dd15` |
| `setMandate` v1 | | `0xa8730280a89c3841de94e3becdb1e54b4980e7506197e2c171b3632838dfbbfa` |
| DemoVotesToken MDV (timestamp clock) | `0x025E568DFc21874f2D690dA57E78fb43def2cC55` | `0xdb90447c2ba85192a6a93e609c39857886618eba3302e996c641ef712783b1ef` |
| DemoGovernor "Mandate Demo DAO" (delay 60 s, period 1,800 s, quorum 1 %) | `0xD38490BCd74bAEBe081550C48E5cF5d90557266B` | `0xfaabe3ab86f5c16ef0a4c462b8d433f57cf40333c22e72a30f9f638acc3636c6` |
| DemoGovernor "slow start" (delay 720 s, period 1,800 s), same token | `0x19E22b78ed01E5B7Bc6530fD3F86687d127bAd06` | `0x0c06391b01ebc24af8d99785184aef2f0a5d817c4331f3528ab5572502856d3e` |
| DemoGovernor "brief vote" (delay 30 s, period 150 s), same token | `0x2EB54888fA245F59970C90b3feea89c387c5906f` | `0xfc692a7f8c48bc71a43e67f668e6dafd1631b3303f6112c39096c903432164a5` |
| DelegateFactory | `0x0fAE8143f7D9C2cF18Ae68BEA374c2EF94F5E11d` | `0xa1e4b9b22cbd982531d9087f080c1d0ab3e239ab158504e94a10f4398371c16b` |
| Delegate (owner = deployer, funded 0.0002 ETH) | `0xDA5347702da783EDa85A1627896d944Ed8F2052C` | `0xb539b9f4c3784216182315a3ded65fbc3233dd94193d53b3eaf1e02484c79545` (`factory.create`) |
| faucet 1,000 MDV, delegated to the Delegate | | `0x7f62f2bfd60070b324c69eb31361e0adddc54299d5d652818f82d3107ead7c31` |

Mandate v1: `mandates/conservative-treasury.v1.md`, keccak256 `0x2508149f762e4a366382fe84d115f3e2684f6e1d53bc1deb7ee5d32c2bf7753e`, URI `https://raw.githubusercontent.com/Adwaitbytes/mandate/master/mandates/conservative-treasury.v1.md` (the served bytes hash to the on-chain value). Chosen over `growth.v1.md` because it is the mandate the site shows and the anvil run used, and its numbered rules give the jurors something concrete to disagree about.

Jurors (registered, each funded 0.0003 ETH for `postVerdict` gas):

| Juror | Address | Model that answered in the live run |
|---|---|---|
| 1 | `0x1e1005C3Ac959A66e8cE5423382fC7a28a24839F` | `anthropic/claude-haiku-5-5` |
| 2 | `0xEa5C14faC05Aa8a4C9a3A4184aE6E17E65402f54` | `groq/openai/gpt-oss-120b`, then `pollinations/openai-fast` after Groq's daily token cap |
| 3 | `0x1e0702541FC8cd645Bf955fA5c26e4DfC0eF9fc7` | `groq/qwen/qwen3.8-27b` (Gemini's free quota was spent for the day; fallback) |

The model of every verdict is in its rationale document and in the `verdict_models` column of `evidence/cases.csv`.

## Unichain Sepolia (1301): block-clock demo DAO

| Contract | Address | Deploy tx |
|---|---|---|
| DemoVotesToken MDV (block clock) | `0xaBc9ECc0052C4fB0928dB1D1c2CDd397E1C840d1` | `0x8f1c70b9892ec456fc8dd3fce62fcd3a83d4c4d10df88c11f8cd40dbf4a630f5` |
| DemoGovernor "Mandate Demo DAO" (delay 60 blocks, period 1,800 blocks) | `0xFEacE2CD295E4Dea9839552ef1612bAF7f53cEB3` | `0x1b680ffde94176cd14cb1b417d7118d88131460316e2957213ee6425b1047eb0` |
| DelegateFactory | `0x05064168796f3499cdec99bC518BB5c7aB543fB8` | `0xc0151d0455fc0cf762d00f2eeaf68a9441aaa9f775cd35d9b8e626c415044974` |
| Delegate (owner = deployer, funded 0.0001 ETH) | `0x05694A503eF614dfF2AfDa85485a76d97F949d1d` | `0x015a31af6564c968a795a1bad09e1f65e0f6f4d48b62c5f3202204a43dac1b71` |
| faucet 1,000 MDV, delegated to the Delegate | | `0x68c6e5dea8a79c1029b56f3717d2749d8736150ed61fd9284863e9c2ebf097bd` |

## Cost of deploying

| Item | Amount |
|---|---|
| Lasna: library + reactive contract deploy (6.53M gas at 100 gwei) | 0.653 lREACT |
| Lasna: wiring and config transactions | about 0.07 lREACT |
| Lasna: reactive contract funding (spent by the cases, remainder withdrawable above the 0.5 floor) | 2.0 + 1.0 lREACT |
| Base Sepolia: all deploys and setup | under 0.00003 ETH, plus 0.0003 Docket, 0.0002 Delegate, 3 x 0.0003 jurors funding |
| Unichain Sepolia: all deploys | under 0.00002 ETH, plus 0.0001 Delegate funding |

## Reproducing

```
git worktree add --detach ../mandate-deploy b8d283b          # deploy from a pinned tree, never a working copy
cd ../mandate-deploy/contracts && cp .env.example .env        # fill in; see each script's Env line
set -a && source .env && set +a
forge script script/DeployMandate.s.sol:DeployReactive --rpc-url $REACTIVE_RPC --account omni-deployer --broadcast --with-gas-price 100gwei --slow
forge script script/DeployMandate.s.sol:DeployHearing  --rpc-url $HEARING_RPC  --account omni-deployer --broadcast --slow
forge script script/DeployMandate.s.sol:DeployGovernorChain --rpc-url $GOVERNOR_RPC --account omni-deployer --broadcast --slow   # once per chain
forge script script/DeployMandate.s.sol:DeployDemoGovernor  --rpc-url $GOVERNOR_RPC --account omni-deployer --broadcast --slow   # optional extra governors
forge script script/DeployMandate.s.sol:WireReactive  --rpc-url $REACTIVE_RPC --account omni-deployer --broadcast --with-gas-price 100gwei --slow
```

Lasna rejects any transaction whose fee cap exceeds 1 ether, and forge's default (twice the base fee times a 6M+ gas limit) does, so every Lasna call takes `--with-gas-price 100gwei` (`--gas-price` for `cast send`). The `make deploy-*` targets do not pass it yet.
