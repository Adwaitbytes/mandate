"use client";

import { Seal } from "@/components/seal";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section className="empty" aria-labelledby="err-title">
      <Seal unset />
      <h1 id="err-title">This page stopped while rendering</h1>
      <p>
        {error.message || "An unexpected error"}. Nothing was sent anywhere. Reading the chain again usually
        clears it.
      </p>
      <div className="actions">
        <button type="button" className="btn" onClick={reset}>
          Try again
        </button>
      </div>
    </section>
  );
}
