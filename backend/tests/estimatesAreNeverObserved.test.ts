/**
 * Drew, 2026-08-30, holding 7a90172d (Theo Gillen 2024 Bowman Draft CPA-TG Blue
 * Refractor /150, PSA 9): a sibling-parallel $3.26 persisted as "observed", and
 * the exact-pool gate never saw the numbered twin's 5 sales because the holding
 * carried no printRun field.
 */
import { describe, expect, it } from "vitest";
import { estimatesAreNeverObserved } from "../src/services/portfolioiq/portfolioStore.service.js";
import { exactSalesCountQuery } from "../src/services/portfolioiq/exactPoolSupremacy.js";

describe("CF-AN-ESTIMATE-IS-NEVER-OBSERVED -- the write-time firewall", () => {
  it("relabels a sibling-parallel rung persisted as observed", () => {
    const doc = { id: "u", userId: "u", holdings: { a: { fmvRung: "sibling-parallel", fairMarketValue: 3.26, isEstimate: false, valuationStatus: "observed" } } } as never;
    const out = estimatesAreNeverObserved(doc) as { holdings: Record<string, { isEstimate?: boolean; valuationStatus?: string }> };
    expect(out.holdings.a.isEstimate).toBe(true);
    expect(out.holdings.a.valuationStatus).toBe("estimated");
  });
  it("leaves an exact-pool rung observed, and a holding with no rung alone", () => {
    const doc = { id: "u", userId: "u", holdings: { a: { fmvRung: "exact-pool-weighted-median", isEstimate: false, valuationStatus: "observed" }, b: { fairMarketValue: 10 } } } as never;
    const out = estimatesAreNeverObserved(doc) as { holdings: Record<string, { isEstimate?: boolean; valuationStatus?: string }> };
    expect(out.holdings.a.valuationStatus).toBe("observed");
    expect(out.holdings.b.isEstimate).toBeUndefined();
    expect(out).toBe(doc); // nothing to relabel -> same object
  });
});

describe("CF-A-TWIN-WITHOUT-A-PRINT-RUN -- the gate counts a base id's numbered twins", () => {
  it("an un-numbered hiq id counts sales under any :num-N twin", () => {
    const q = exactSalesCountQuery("hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto", "2026-03-01T00:00:00.000Z");
    expect(q.query).toMatch(/STARTSWITH\(c\.hobbyiqCardId, @idNum\)/);
    expect(q.parameters.find((p) => p.name === "@idNum")?.value).toBe("hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-");
  });
  it("a numbered id and a vendor id count only themselves", () => {
    expect(exactSalesCountQuery("hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150", "x").query).not.toMatch(/STARTSWITH/);
    const v = exactSalesCountQuery("1778814561816x835862652021336800", "x");
    expect(v.query).toMatch(/c\.cardId = @id/);
    expect(v.query).not.toMatch(/STARTSWITH/);
  });
});
