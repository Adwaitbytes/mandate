"use client";

import dynamic from "next/dynamic";
import type { Address } from "viem";
import { shortHash } from "@/lib/format";
import type { Intent } from "./owner-island";

// wagmi loads only when someone starts an owner action, so read-only visitors never download it.
const OwnerIsland = dynamic(() => import("./owner-island"), {
  ssr: false,
  loading: () => (
    <p className="status" role="status">
      Loading the wallet connection
    </p>
  ),
});

export function OwnerOnlyNote({ owner, what }: { owner: Address | null; what: string }) {
  return (
    <p className="status">
      Only the mandate owner
      {owner ? (
        <>
          , <span className="hash">{shortHash(owner)}</span>,
        </>
      ) : null}{" "}
      can {what}. Everyone else sees this read-only.
    </p>
  );
}

export function OwnerAction({
  intent,
  owner,
  onConfirmed,
  onRole,
}: {
  intent: Intent | null;
  owner: Address | null;
  onConfirmed?: () => void;
  onRole?: (notOwner: boolean) => void;
}) {
  if (intent === null) return null;
  return (
    <div className="owner-panel">
      <OwnerIsland
        intent={intent}
        owner={owner}
        {...(onConfirmed ? { onConfirmed } : {})}
        {...(onRole ? { onRole } : {})}
      />
    </div>
  );
}
