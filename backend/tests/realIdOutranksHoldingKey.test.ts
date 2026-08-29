import { describe, it, expect } from "vitest";
import { scoreForCanonical } from "../src/services/portfolioiq/soldCompsStore.service.js";

// CF-A-REAL-ID-OUTRANKS-A-SYNTHETIC-ONE (2026-08-29, checklist D7b). On a
// content-hash collision pickCanonical keeps the higher score and DELETES the
// other. The row keyed by the eBay item/order id is the transaction; the
// holding:: key is our stand-in. The stand-in must never win.
describe("scoreForCanonical: a real id outranks a holding:: key", () => {
  it("verified real-id row beats verified holding:: row", () => {
    const real = scoreForCanonical({ verifiedByUser: true, sourceExternalId: "v1|123456789012", parallel: "Refractor" });
    const standIn = scoreForCanonical({ verifiedByUser: true, sourceExternalId: "holding::abc", parallel: "Refractor" });
    expect(real).toBeGreaterThan(standIn);
  });
  it("unverified real-id row beats unverified holding:: row", () => {
    expect(scoreForCanonical({ sourceExternalId: "123456789012" })).toBeGreaterThan(scoreForCanonical({ sourceExternalId: "holding::abc" }));
  });
  it("verification still dominates keying", () => {
    expect(scoreForCanonical({ verifiedByUser: true, sourceExternalId: "holding::abc" })).toBeGreaterThan(scoreForCanonical({ verifiedByUser: false, sourceExternalId: "123456789012" }));
  });
});
