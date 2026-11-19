/** MandateReactive.Status, in declaration order. */
export const STATUS = {
  None: 0,
  Opening: 1,
  Open: 2,
  Held: 3,
  Window: 4,
  Waiting: 5,
  Casting: 6,
  Cast: 7,
  Vetoed: 8,
  Expired: 9,
  Failed: 10,
} as const;
export type StatusCode = (typeof STATUS)[keyof typeof STATUS];

/** MandateReactive.HoldReason. */
export const HOLD = { None: 0, Injection: 1, Split: 2 } as const;

/** Docket.OwnerAction. */
export const OWNER_ACTION = { None: 0, Veto: 1, Override: 2 } as const;

/** IDelegate.Refusal. */
export const REFUSAL: Record<number, string> = {
  0: "none",
  1: "voting not open yet",
  2: "voting has ended",
  3: "the Delegate is paused",
  4: "the governor rejected the vote",
  5: "the governor state could not be read",
  6: "invalid support",
  7: "an older request was superseded",
};

export type CaseCondition =
  | "unknown"
  | "opening"
  | "hearing"
  | "held-injection"
  | "held-split"
  | "window"
  | "waiting"
  | "casting"
  | "cast"
  | "vetoed"
  | "expired"
  | "failed";

export function conditionOf(status: number, hold: number): CaseCondition {
  switch (status) {
    case STATUS.Opening:
      return "opening";
    case STATUS.Open:
      return "hearing";
    case STATUS.Held:
      return hold === HOLD.Injection ? "held-injection" : "held-split";
    case STATUS.Window:
      return "window";
    case STATUS.Waiting:
      return "waiting";
    case STATUS.Casting:
      return "casting";
    case STATUS.Cast:
      return "cast";
    case STATUS.Vetoed:
      return "vetoed";
    case STATUS.Expired:
      return "expired";
    case STATUS.Failed:
      return "failed";
    default:
      return "unknown";
  }
}

/** Court-list wording for each condition. */
export const conditionLabel: Record<CaseCondition, string> = {
  unknown: "Not yet seen on Lasna",
  opening: "Being opened",
  hearing: "Awaiting verdicts",
  "held-injection": "Held, injection flagged",
  "held-split": "Held, split verdict",
  window: "Veto window",
  waiting: "Voting not open yet",
  casting: "Vote on its way",
  cast: "Cast",
  vetoed: "Vetoed",
  expired: "Expired",
  failed: "Failed",
};

export function isTerminal(condition: CaseCondition): boolean {
  return condition === "cast" || condition === "vetoed" || condition === "expired" || condition === "failed";
}
