import type { DaoSpec } from "./types.ts";

/**
 * Mainnet governors used by the evaluation. Fetched over a keyless public RPC: ProposalCreated logs
 * for the text, state() for the outcome, and VoteCast logs for the tally and the named delegate's vote.
 * Governor addresses were checked on chain: Uniswap's is Timelock(0x1a9C...35BC).admin().
 */
export const DAOS: DaoSpec[] = [
  { key: "uniswap", name: "Uniswap", governor: "0x408ED6354d4973f66138C91495F2f2FCbd8724C3", kind: "bravo" },
  {
    key: "compound",
    name: "Compound",
    governor: "0xc0Da02939E1441F497fd74F78cE7Decb17B66529",
    kind: "bravo",
  },
  { key: "ens", name: "ENS", governor: "0x323A76393544d5ecca80cd6ef2A560C6a395b7E3", kind: "oz" },
];
