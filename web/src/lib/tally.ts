/**
 * Display mirror of MandateReactive's tally (`_onVerdict`, `_evaluate`, `_tally`, `_injectionHeld`).
 * The contract is the authority; the site uses this to explain the numbers it reads. Tests replay the vectors in
 * contracts/test/unit/Tally.t.sol.
 */

export const SUPPORT = { AGAINST: 0, FOR: 1, ABSTAIN: 2 } as const;
export type Support = (typeof SUPPORT)[keyof typeof SUPPORT];

export function isSupport(value: number): value is Support {
  return value === 0 || value === 1 || value === 2;
}

export const supportLabel: Record<Support, string> = { 0: "Against", 1: "For", 2: "Abstain" };

export interface TallyConfig {
  quorum: number;
  minAgreeing: number;
  injectionFlagsToHold: number;
  minConfidenceBps: number;
  majorityBps: number;
  splitPolicy: "abstain" | "hold";
}

/** Constructor defaults (docs/ARCHITECTURE.md). Live cases use their own `caseConfig` snapshot instead. */
export const DEFAULT_CONFIG: TallyConfig = {
  quorum: 2,
  minAgreeing: 2,
  injectionFlagsToHold: 1,
  minConfidenceBps: 6000,
  majorityBps: 5000,
  splitPolicy: "hold",
};

export interface BallotInput {
  support: number;
  confidenceBps: number;
  injection: boolean;
  /** `weightOf(juror)` at the time of the tally. */
  weight: number;
}

export type TallyOutcome =
  | { kind: "held-injection"; flags: number }
  | { kind: "waiting"; verdictsNeeded: number }
  | { kind: "decided"; support: Support }
  | { kind: "split"; policy: "abstain" | "hold" };

export interface TallyResult {
  weights: { against: number; for: number; abstain: number; low: number; total: number };
  confident: { against: number; for: number; abstain: number };
  ballots: number;
  injectionFlags: number;
  outcome: TallyOutcome;
  /** The support the contract would cast: the winner, or abstain under the Abstain split policy. */
  decidedSupport: Support | null;
}

const BPS = 10_000;
const ORDER: readonly Support[] = [SUPPORT.AGAINST, SUPPORT.FOR, SUPPORT.ABSTAIN];
const KEY = { 0: "against", 1: "for", 2: "abstain" } as const;

export function tally(
  ballots: readonly BallotInput[],
  config: TallyConfig,
  options: { overridden?: boolean } = {},
): TallyResult {
  const weights = { against: 0, for: 0, abstain: 0, low: 0, total: 0 };
  const confident = { against: 0, for: 0, abstain: 0 };
  let injectionFlags = 0;
  for (const ballot of ballots) {
    if (!isSupport(ballot.support) || ballot.confidenceBps < 0 || ballot.confidenceBps > BPS) {
      // _onVerdict returns early on these, so they never reach the tally; showing them would misstate it.
      throw new RangeError(`Ballot outside the contract's range: ${JSON.stringify(ballot)}`);
    }
    if (ballot.injection) injectionFlags++;
    weights.total += ballot.weight;
    if (ballot.confidenceBps >= config.minConfidenceBps) {
      weights[KEY[ballot.support]] += ballot.weight;
      confident[KEY[ballot.support]]++;
    } else {
      weights.low += ballot.weight;
    }
  }

  const base = { weights, confident, ballots: ballots.length, injectionFlags };
  const held = !options.overridden && injectionFlags !== 0 && injectionFlags >= config.injectionFlagsToHold;
  if (held)
    return { ...base, outcome: { kind: "held-injection", flags: injectionFlags }, decidedSupport: null };
  if (ballots.length < config.quorum) {
    return {
      ...base,
      outcome: { kind: "waiting", verdictsNeeded: config.quorum - ballots.length },
      decidedSupport: null,
    };
  }
  for (const side of ORDER) {
    const key = KEY[side];
    if (confident[key] >= config.minAgreeing && weights[key] * BPS > weights.total * config.majorityBps) {
      return { ...base, outcome: { kind: "decided", support: side }, decidedSupport: side };
    }
  }
  return {
    ...base,
    outcome: { kind: "split", policy: config.splitPolicy },
    decidedSupport: config.splitPolicy === "abstain" ? SUPPORT.ABSTAIN : null,
  };
}

/** Percentage of the posted weight, one decimal, for display. */
export function share(part: number, total: number): string {
  if (total === 0) return "0%";
  const value = Math.round((part / total) * 1000) / 10;
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

export function percentFromBps(bps: number): string {
  const value = bps / 100;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}
