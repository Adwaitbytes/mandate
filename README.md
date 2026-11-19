# Mandate

Write down how you want your governance votes cast. When a watched governor emits `ProposalCreated`, a reactive contract on the Reactive Network opens a case, three independent model jurors post verdicts on chain, the reactive contract tallies them by weight, waits out your veto window, and casts the vote through your Delegate on the governor's chain. Vetoes and overrides move weight toward the jurors who read you right.

Work in progress. See `docs/ARCHITECTURE.md` for the loop, `docs/JUROR_INTERFACE.md` for the juror contract, `docs/DECISIONS.md` for choices made, and `STATUS.md` for what exists.

```
make test        # Foundry tests, local Omni harness, no network
make workers-check   # juror workers: typecheck, Biome, Vitest
make e2e-anvil       # local anvil: real Docket, three jurors, real models
```

Jurors: `docs/JURORS.md`. Evaluation on real proposals: `analysis/eval/MODEL_CARD.md`.

Dependencies: Foundry 1.8.4, Solidity 0.8.30, reactive-lib-omni v0.1.0, OpenZeppelin Contracts v5.7.0, forge-std v1.17.0. MIT licensed.
