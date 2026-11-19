import { describe, expect, it } from "vitest";
import { classifyReactiveTx, DROP_AFTER_MS, smartTransactionError } from "@/lib/reactive-tx";

describe("MetaMask Smart Transactions detection on Reactive", () => {
  it("is pending until Lasna sees the hash or the drop timeout passes", () => {
    expect(classifyReactiveTx("0xabc", 0, 1000, false).state).toBe("pending");
    expect(classifyReactiveTx("0xabc", 0, DROP_AFTER_MS - 1, false).state).toBe("pending");
    expect(classifyReactiveTx("0xabc", 0, DROP_AFTER_MS, false).state).toBe("dropped");
    expect(classifyReactiveTx("0xabc", 0, DROP_AFTER_MS * 10, true).state).toBe("seen");
  });

  it("recognises wallet errors that name Smart Transactions", () => {
    expect(smartTransactionError("Smart Transaction failed: cancelled")).toBe(true);
    expect(smartTransactionError("smartTransaction status: failed")).toBe(true);
    expect(smartTransactionError("User rejected the request")).toBe(false);
  });
});
