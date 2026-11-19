/**
 * The Reactive docs warn that MetaMask Smart Transactions can drop transactions sent to the Reactive Network
 * (spec 7.19). The wallet returns a hash, but the transaction never reaches Lasna. A hash that Lasna has not seen
 * after DROP_AFTER_MS is treated as dropped, and so is any wallet error that names Smart Transactions.
 */
export const DROP_AFTER_MS = 45_000;

export const SMART_TX_ADVICE =
  "MetaMask Smart Transactions can drop transactions sent to Reactive Lasna. In MetaMask open Settings, then Advanced, turn off Smart Transactions, and send again.";

export type ReactiveTxState =
  | { state: "pending"; hash: string }
  | { state: "seen"; hash: string }
  | { state: "dropped"; hash: string | null; reason: string };

/** Classifies a wallet error raised while sending to Lasna. Returns null for errors with other causes. */
export function smartTransactionError(message: string): boolean {
  return /smart\s*transaction|\bstx\b/i.test(message);
}

/** After the wallet returned `hash` at `sentAt`, decide from whether Lasna knows the transaction yet. */
export function classifyReactiveTx(
  hash: string,
  sentAt: number,
  now: number,
  seenOnLasna: boolean,
): ReactiveTxState {
  if (seenOnLasna) return { state: "seen", hash };
  if (now - sentAt >= DROP_AFTER_MS) {
    return { state: "dropped", hash, reason: "Lasna has no record of this transaction" };
  }
  return { state: "pending", hash };
}
