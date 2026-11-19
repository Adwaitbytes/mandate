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

export interface RulingHeading {
  /** The word in bold: Cast, Decided, Vetoed, Held, Overridden, Expired, Failed, Pending */
  word: string;
  text: string;
}

const SIDE: Record<number, string> = { 0: "Against", 1: "For", 2: "Abstain" };

/**
 * The tally's heading, from the case's status on Lasna and the decision the contract recorded, never from a
 * recount: the site recounts with today's weights, which can differ from the ones the contract used.
 */
export function rulingHeading(input: {
  condition: CaseCondition;
  /** The contract's decided support (getCase.support when hasDecision), or null. */
  decided: number | null;
  overridden: boolean;
  verdictsNeeded: number;
}): RulingHeading {
  const { condition, decided, overridden } = input;
  const side = decided !== null ? (SIDE[decided] ?? `support ${decided}`) : null;
  if (overridden && condition !== "vetoed") {
    const done = condition === "cast" ? "cast" : "on its way";
    return {
      word: "Overridden",
      text: side ? `the owner chose ${side}, ${done}` : "the owner voted by hand",
    };
  }
  switch (condition) {
    case "cast":
      return { word: "Cast", text: side ?? "the Delegate voted" };
    case "casting":
      return { word: "Decided", text: side ? `${side}, the vote is on its way` : "the vote is on its way" };
    case "window":
      return { word: "Decided", text: side ? `${side}, in the veto window` : "in the veto window" };
    case "waiting":
      return {
        word: "Decided",
        text: side ? `${side}, waiting for voting to open` : "waiting for voting to open",
      };
    case "vetoed":
      return {
        word: "Vetoed",
        text: side ? `the jurors decided ${side} and the owner stopped it` : "no vote",
      };
    case "held-injection":
      return { word: "Held", text: "an injection flag stops every automated vote" };
    case "held-split":
      return { word: "Held", text: "the jurors split, so the case waits for the owner" };
    case "expired":
      return {
        word: "Expired",
        text: side
          ? `decided ${side}, but voting closed before it could be cast`
          : "no side was decided before the case closed",
      };
    case "failed":
      return {
        word: "Failed",
        text: side ? `decided ${side}, but the vote request failed after every retry` : "no vote",
      };
    case "hearing":
    case "opening":
      return {
        word: "Pending",
        text:
          input.verdictsNeeded > 0
            ? `${input.verdictsNeeded} more ${input.verdictsNeeded === 1 ? "verdict" : "verdicts"} needed for quorum`
            : "waiting for the tally on Lasna",
      };
    case "unknown":
      return { word: "Pending", text: "Lasna has not reported this case yet" };
  }
}
