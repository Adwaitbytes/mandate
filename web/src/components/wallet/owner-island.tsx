"use client";

import { useEffect, useState } from "react";
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  isAddressEqual,
  UserRejectedRequestError,
} from "viem";
import { baseSepolia, unichainSepolia } from "viem/chains";
import {
  createConfig,
  http,
  injected,
  useConnect,
  useConnection,
  useConnectors,
  useSwitchChain,
  useWriteContract,
  WagmiProvider,
} from "wagmi";
import { docketAbi, mandateReactiveAbi } from "@/generated/abi";
import { type ChainId, chains, lasna, txUrl } from "@/lib/chains";
import { publicClient } from "@/lib/clients";
import { deployments } from "@/lib/config";
import { shortHash } from "@/lib/format";
import { classifyReactiveTx, SMART_TX_ADVICE, smartTransactionError } from "@/lib/reactive-tx";
import { supportLabel } from "@/lib/tally";

export type Intent =
  | { type: "veto"; caseId: bigint }
  | { type: "override"; caseId: bigint; support: 0 | 1 | 2 }
  | { type: "set-mandate"; hash: Hex; uri: string; nextVersion: number }
  | { type: "expire"; caseId: bigint };

const config = createConfig({
  chains: [baseSepolia, unichainSepolia, lasna],
  connectors: [injected()],
  transports: {
    [baseSepolia.id]: http(chains[84532].rpc),
    [unichainSepolia.id]: http(chains[1301].rpc),
    [lasna.id]: http(chains[5318007].rpc),
  },
  ssr: false,
});

function targetChain(intent: Intent): ChainId {
  return intent.type === "expire" ? 5318007 : 84532;
}

function verb(intent: Intent): { button: string; done: string } {
  switch (intent.type) {
    case "veto":
      return { button: `Veto case ${intent.caseId}`, done: `Vetoed case ${intent.caseId}` };
    case "override":
      return {
        button: `Vote ${supportLabel[intent.support]} on case ${intent.caseId}`,
        done: `Overrode case ${intent.caseId} with ${supportLabel[intent.support]}`,
      };
    case "set-mandate":
      return {
        button: `Set mandate version ${intent.nextVersion}`,
        done: `Set mandate version ${intent.nextVersion}`,
      };
    case "expire":
      return { button: `Expire case ${intent.caseId}`, done: `Expired case ${intent.caseId}` };
  }
}

type Phase =
  | { phase: "idle" }
  | { phase: "signing" }
  | { phase: "pending"; hash: Hex; sentAt: number }
  | { phase: "confirmed"; hash: Hex }
  | { phase: "failed"; message: string; hash?: Hex; smartTx?: boolean };

function explain(err: unknown): { message: string; smartTx: boolean } {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) {
      return { message: "You cancelled the transaction in your wallet", smartTx: false };
    }
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) {
      const names: Record<string, string> = {
        OwnerAlreadyActed:
          "You have already vetoed or overridden this case; the Docket allows one owner action per case",
        UnknownCase: "The Docket has no such case",
        OwnableUnauthorizedAccount: "Only the mandate owner can do this",
      };
      return {
        message: names[revert.data.errorName] ?? `The contract refused: ${revert.data.errorName}`,
        smartTx: false,
      };
    }
    return { message: err.shortMessage, smartTx: smartTransactionError(err.message) };
  }
  const message = err instanceof Error ? err.message : "The wallet returned an error";
  return { message, smartTx: smartTransactionError(message) };
}

interface IslandProps {
  intent: Intent;
  owner: Address | null;
  onConfirmed?: () => void;
  /** Told whether the connected wallet is the owner, so the page can grey out actions it cannot take. */
  onRole?: (notOwner: boolean) => void;
}

function Island({ intent, owner, onConfirmed, onRole }: IslandProps) {
  const connection = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const switchChain = useSwitchChain();
  const write = useWriteContract();
  const [phase, setPhase] = useState<Phase>({ phase: "idle" });
  const [hasProvider, setHasProvider] = useState<boolean | null>(null);
  const chainId = targetChain(intent);
  const chainName = chains[chainId].name;

  useEffect(() => {
    setHasProvider(typeof window !== "undefined" && "ethereum" in window);
  }, []);

  // Follow the transaction until it is included; on Lasna, also catch a Smart Transactions drop.
  useEffect(() => {
    if (phase.phase !== "pending") return;
    let cancelled = false;
    const client = publicClient(chainId);
    const run = async () => {
      if (chainId === 5318007) {
        for (;;) {
          if (cancelled) return;
          const seen = await client.getTransaction({ hash: phase.hash }).then(
            () => true,
            () => false,
          );
          const verdict = classifyReactiveTx(phase.hash, phase.sentAt, Date.now(), seen);
          if (verdict.state === "seen") break;
          if (verdict.state === "dropped") {
            setPhase({ phase: "failed", hash: phase.hash, message: verdict.reason, smartTx: true });
            return;
          }
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      try {
        const receipt = await client.waitForTransactionReceipt({ hash: phase.hash, timeout: 180_000 });
        if (cancelled) return;
        if (receipt.status === "success") {
          setPhase({ phase: "confirmed", hash: phase.hash });
          onConfirmed?.();
        } else {
          setPhase({
            phase: "failed",
            hash: phase.hash,
            message: `${chainName} included the transaction but it reverted`,
          });
        }
      } catch (err) {
        if (!cancelled) setPhase({ phase: "failed", hash: phase.hash, ...explain(err) });
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [phase, chainId, chainName, onConfirmed]);

  const account = connection.address;
  const notOwner = !!(account && owner && !isAddressEqual(account, owner));
  useEffect(() => onRole?.(notOwner), [notOwner, onRole]);
  if (hasProvider === false) {
    return (
      <p className="status" role="status">
        No browser wallet found. Owner actions need one, such as MetaMask or Rabby. Everything else on this
        page is read from chain and works without a wallet.
      </p>
    );
  }
  if (!account) {
    const connector = connectors[0];
    return (
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={!connector || connect.isPending}
          onClick={() => connector && connect.mutate({ connector })}
        >
          {connect.isPending ? "Waiting for the wallet" : "Connect wallet"}
        </button>
        {connect.error ? (
          <span className="status" role="alert">
            {explain(connect.error).message}
          </span>
        ) : null}
      </div>
    );
  }
  if (owner && !isAddressEqual(account, owner)) {
    return (
      <p className="status" role="status">
        This wallet, <span className="hash">{shortHash(account)}</span>, is not the mandate owner,{" "}
        <span className="hash">{shortHash(owner)}</span>. Only the owner can veto, override or change the
        mandate, so this page stays read-only for you.
      </p>
    );
  }
  if (connection.chainId !== chainId) {
    const current = connection.chainId
      ? (chains[connection.chainId as ChainId]?.name ?? `chain ${connection.chainId}`)
      : "another network";
    return (
      <div className="actions">
        <span className="status" role="status">
          Your wallet is on {current}. This action is sent on {chainName}.
        </span>
        <button
          type="button"
          className="btn"
          disabled={switchChain.isPending}
          onClick={() => switchChain.mutate({ chainId })}
        >
          {switchChain.isPending ? "Waiting for the wallet" : `Switch to ${chainName}`}
        </button>
      </div>
    );
  }

  const send = async () => {
    setPhase({ phase: "signing" });
    try {
      let hash: Hex;
      const docket = deployments.docket.address;
      const reactive = deployments.reactive.address;
      if (intent.type === "expire") {
        if (!reactive) throw new Error("MandateReactive is not deployed");
        hash = await write.mutateAsync({
          address: reactive,
          abi: mandateReactiveAbi,
          functionName: "expireStale",
          args: [[intent.caseId]],
          chainId: 5318007,
        });
      } else {
        if (!docket) throw new Error("The Docket is not deployed");
        hash =
          intent.type === "veto"
            ? await write.mutateAsync({
                address: docket,
                abi: docketAbi,
                functionName: "veto",
                args: [intent.caseId],
                chainId: 84532,
              })
            : intent.type === "override"
              ? await write.mutateAsync({
                  address: docket,
                  abi: docketAbi,
                  functionName: "overrideVote",
                  args: [intent.caseId, intent.support],
                  chainId: 84532,
                })
              : await write.mutateAsync({
                  address: docket,
                  abi: docketAbi,
                  functionName: "setMandate",
                  args: [intent.hash, intent.uri],
                  chainId: 84532,
                });
      }
      setPhase({ phase: "pending", hash, sentAt: Date.now() });
    } catch (err) {
      setPhase({ phase: "failed", ...explain(err) });
    }
  };

  const { button, done } = verb(intent);
  const link = (hash: Hex) => {
    const url = txUrl(chainId, hash);
    return url ? (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {shortHash(hash, 10, 6)} on {chainName}
      </a>
    ) : (
      <span className="hash">{hash}</span>
    );
  };

  return (
    <div>
      <div className="actions">
        <button
          type="button"
          className={intent.type === "veto" ? "btn seal" : "btn"}
          disabled={phase.phase === "signing" || phase.phase === "pending" || phase.phase === "confirmed"}
          onClick={send}
        >
          {phase.phase === "signing" ? "Confirm in your wallet" : button}
        </button>
      </div>
      <p className="status" role="status" aria-live="polite">
        {phase.phase === "pending" ? (
          <>
            Sent. Waiting for {chainName} to include {link(phase.hash)}
          </>
        ) : null}
        {phase.phase === "confirmed" ? (
          <>
            {done}: {link(phase.hash)}.{" "}
            {intent.type === "set-mandate"
              ? "Cases opened from now on are judged against it."
              : "The reactive contract acts when this event reaches Lasna."}
          </>
        ) : null}
        {phase.phase === "failed" ? (
          <span role="alert">
            {phase.message}
            {phase.hash ? <> ({link(phase.hash)})</> : null}. {phase.smartTx ? SMART_TX_ADVICE : null}
          </span>
        ) : null}
      </p>
    </div>
  );
}

export default function OwnerIsland(props: IslandProps) {
  return (
    <WagmiProvider config={config}>
      <Island {...props} />
    </WagmiProvider>
  );
}
