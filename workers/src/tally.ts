import type { Support } from "./schema.ts";

export interface Ballot {
  support: Support;
  confidenceBps: number;
  injectionFlag: boolean;
  weight: number;
}

export type Decision = Support | "held-injection" | "held-split" | "waiting";

export interface TallyConfig {
  quorum: number;
  minConfidenceBps: number;
  majorityBps: number;
  splitPolicy: "hold" | "abstain";
}

/** MandateReactive defaults (docs/ARCHITECTURE.md). */
export const DEFAULT_TALLY: TallyConfig = {
  quorum: 2,
  minConfidenceBps: 6000,
  majorityBps: 5000,
  splitPolicy: "hold",
};

/**
 * Off-chain mirror of the reactive contract's tally, used by the evaluation: any injection flag holds the case;
 * below quorum it waits; low-confidence ballots count in the denominator but toward no side; a side wins with
 * strictly more than majorityBps of all posted weight; otherwise the split policy applies.
 */
export function tally(ballots: readonly Ballot[], config: TallyConfig = DEFAULT_TALLY): Decision {
  if (ballots.some((b) => b.injectionFlag)) return "held-injection";
  if (ballots.length < config.quorum) return "waiting";
  const total = ballots.reduce((sum, b) => sum + b.weight, 0);
  const sides: Record<Support, number> = { for: 0, against: 0, abstain: 0 };
  for (const b of ballots) if (b.confidenceBps >= config.minConfidenceBps) sides[b.support] += b.weight;
  for (const side of ["for", "against", "abstain"] as const) {
    if (sides[side] * 10_000 > total * config.majorityBps) return side;
  }
  return config.splitPolicy === "abstain" ? "abstain" : "held-split";
}
