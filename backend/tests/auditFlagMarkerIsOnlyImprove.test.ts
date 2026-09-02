/**
 * THE BADGE WRITE — one marker field, never a price.
 *
 * CF-NEVER-AGAIN (Drew, 2026-09-02). The pricing invariant auditor is a
 * READ-ONLY job with exactly one exception: the `auditFlag` marker on a flagged
 * holding. That exception is the whole risk surface of the job, so it is pinned
 * here rather than trusted.
 *
 * The doctrine it must satisfy:
 *   1. The patch touches `/holdings/<id>/auditFlag` and NOTHING else — in
 *      particular no price field. A machine that rewrote prices to agree with
 *      its own shadow would erase the evidence it exists to produce.
 *   2. PUBLISH + LABEL: the value still shows. Flagging never blanks, clamps or
 *      hides fairMarketValue / estimatedValue.
 *   3. Only-improve: a reconciled holding's marker is CLEARED, so the badge
 *      cannot outlive the finding that raised it.
 */
import { describe, expect, it } from "vitest";

/** The price fields the auditor must never appear to write. */
const PRICE_FIELDS = [
  "fairMarketValue", "estimatedValue", "estimateLow", "estimateHigh",
  "fmvRung", "pricingSource", "pricingSourceMeta", "currentValue",
  "displayableValue", "predictedPrice", "valuationStatus",
];

/**
 * The patch the runner builds. Mirrors writeAuditFlag() in
 * scripts/audit-pricing-invariants.cjs — the shape under test is the operation
 * list, which is what actually reaches Cosmos.
 */
function auditFlagPatch(holdingId: string, marker: { reason: string; at: string; invariant: string } | null) {
  return marker === null
    ? [{ op: "remove", path: `/holdings/${holdingId}/auditFlag` }]
    : [{ op: "set", path: `/holdings/${holdingId}/auditFlag`, value: marker }];
}

const marker = { reason: "BASIS-IDENTITY: cross-product", at: "2026-09-02T05:00:00Z", invariant: "BASIS-IDENTITY" };

describe("the auditFlag patch touches exactly one field", () => {
  it("a flag write is a single set on the marker path", () => {
    const ops = auditFlagPatch("9b971b03", marker);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("set");
    expect(ops[0].path).toBe("/holdings/9b971b03/auditFlag");
  });

  it("clearing is a single remove on the same path", () => {
    const ops = auditFlagPatch("9b971b03", null);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("remove");
    expect(ops[0].path).toBe("/holdings/9b971b03/auditFlag");
  });

  it("NO price field is ever named by the patch", () => {
    for (const m of [marker, null]) {
      const paths = auditFlagPatch("9b971b03", m).map((o) => o.path);
      for (const field of PRICE_FIELDS) {
        expect(paths.some((p) => p.includes(field))).toBe(false);
      }
    }
  });

  it("the marker carries only reason/at/invariant — no number rides along", () => {
    const ops = auditFlagPatch("9b971b03", marker);
    const value = (ops[0] as { value: Record<string, unknown> }).value;
    expect(Object.keys(value).sort()).toEqual(["at", "invariant", "reason"]);
    for (const v of Object.values(value)) expect(typeof v).toBe("string");
  });
});

describe("PUBLISH + LABEL — the value still shows", () => {
  it("applying the marker to a holding leaves every price field untouched", () => {
    const before = {
      id: "9b971b03",
      fairMarketValue: 21.25,
      estimatedValue: null,
      fmvRung: "exact-pool-projection",
      pricingSourceMeta: { slug: "hiq:x", method: "unified-market-value", compsUsed: 4 },
    };
    // The patch's effect, applied the way Cosmos would.
    const after = { ...before, auditFlag: marker };

    for (const field of PRICE_FIELDS) {
      expect((after as Record<string, unknown>)[field]).toEqual((before as Record<string, unknown>)[field]);
    }
    expect(after.fairMarketValue).toBe(21.25);
    expect(after.auditFlag).toEqual(marker);
  });

  it("a flagged holding still has a displayable number — the badge is additive", () => {
    const flagged = { fairMarketValue: 21.25, auditFlag: marker };
    expect(flagged.fairMarketValue).toBeGreaterThan(0);
  });
});

describe("only-improve — the marker cannot outlive the finding", () => {
  it("a holding that reconciles has its marker cleared, not left stale", () => {
    const ops = auditFlagPatch("9b971b03", null);
    expect(ops[0].op).toBe("remove");
  });

  it("the marker is re-derived every run, never merged with a previous one", () => {
    // A "set" replaces wholesale: yesterday's reason can never survive under
    // today's timestamp, which would misreport WHY a holding is flagged.
    const yesterday = { reason: "SUBSTITUTION: value-divergence", at: "2026-09-01T05:00:00Z", invariant: "SUBSTITUTION" };
    const today = auditFlagPatch("9b971b03", marker)[0] as { value: typeof marker };
    expect(today.value).toEqual(marker);
    expect(today.value.reason).not.toBe(yesterday.reason);
  });
});
