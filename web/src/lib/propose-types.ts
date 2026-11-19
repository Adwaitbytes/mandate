import type { Hex } from "viem";

/** Responses of POST /api/propose. */
export type ProposeError =
  | { code: "invalid"; field: "chain" | "sample" | "title" | "body" | "request"; error: string }
  | { code: "not-deployed"; error: string }
  | { code: "relayer-unset"; error: string }
  | { code: "relayer-empty"; error: string }
  | { code: "rate-limited"; error: string; retryAfterSeconds: number; scope: "visitor" | "site" }
  | { code: "chain"; error: string };

export interface ProposeOk {
  chainId: number;
  governor: Hex;
  txHash: Hex;
  proposalId: string;
}
