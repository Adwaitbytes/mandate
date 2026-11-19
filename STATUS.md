# Status

Updated 2026-11-19.

| Area | State |
|---|---|
| Contracts (`MandateReactive`, `Docket`, `Delegate`, `DelegateFactory`, demo DAO) | Built, zero compiler warnings, `forge fmt` clean |
| Local Omni harness and tests | 145 passing (`make test`) |
| `check_rc_source` | Clean on MandateReactive, Delegate, DelegateFactory; two accepted findings on Docket (docs/DECISIONS.md) |
| Deploy scripts | Written and tested in-process; nothing deployed (no testnet funds yet) |
| Jurors (workers/) | Runtime, three providers with fallbacks, injection pre-filter and Prompt Guard, replay, CI workflow; 130 Vitest tests; anvil end-to-end passes with six verdicts on chain (docs/JURORS.md) |
| Evaluation (analysis/eval/) | 72 real Uniswap, Compound and ENS proposals plus 16 injection samples; model card in analysis/eval/MODEL_CARD.md |
| Web | Not started |
