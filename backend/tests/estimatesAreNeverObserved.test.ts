/**
 * Drew, 2026-08-30, holding 7a90172d (Theo Gillen 2024 Bowman Draft CPA-TG Blue
 * Refractor /150, PSA 9): a sibling-parallel $3.26 persisted as "observed", and
 * the exact-pool gate never saw the numbered twin's 5 sales because the holding
 * carried no printRun field.
 */
import { describe, expect, it } from "vitest";
import { estimatesAreNeverObserved } from "../src/services/portfolioiq/portfolioStore.service.js";
import { exactIdentityCandidates, exactSalesCountQuery, unifiedIdentityAttempts } from "../src/services/portfolioiq/exactPoolSupremacy.js";
import { poolReadIdsFor } from "../src/services/catalog/catalogIdentityResolver.js";

describe("CF-AN-ESTIMATE-IS-NEVER-OBSERVED -- the write-time firewall", () => {
  it("relabels a sibling-parallel rung persisted as observed", () => {
    const doc = { id: "u", userId: "u", holdings: { a: { fmvRung: "sibling-parallel", fairMarketValue: 3.26, isEstimate: false, valuationStatus: "observed" } } } as never;
    const out = estimatesAreNeverObserved(doc) as { holdings: Record<string, { isEstimate?: boolean; valuationStatus?: string }> };
    expect(out.holdings.a.isEstimate).toBe(true);
    expect(out.holdings.a.valuationStatus).toBe("estimated");
  });
  it("leaves an exact-pool rung observed, and an unpriced holding with no rung alone", () => {
    const doc = { id: "u", userId: "u", holdings: { a: { fmvRung: "exact-pool-weighted-median", isEstimate: false, valuationStatus: "observed" }, b: { valuationStatus: "pending" } } } as never;
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

// CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30, holding deced7d3 -- Max Williams
// CPA-MWI). Once the resolver has normalized a holding's cardId / hobbyiqCardId to
// the catalog's numbered row, the exact-pool attempts form from that id directly --
// no printRun field needed. The gate's STARTSWITH stays as the fail-safe (it counts
// BOTH twins on an ambiguous id, by design); the readers union exactly the id and
// the ONE twin the resolver names (the pool is keyed both ways until D29 re-keys
// it), never every twin.
describe("CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW -- a normalized holding needs no printRun", () => {
  const MWI = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
  const MWI_499 = `${MWI}:num-499`;
  const TWIN = { requested: MWI, id: MWI_499, kind: "numbered-twin" as const, twins: [MWI_499] };
  it("cardId/hobbyiqCardId …:num-499 with no printRun: the numbered identity first, its un-numbered twin second", () => {
    const h = { hobbyiqCardId: MWI_499, cardId: MWI_499 };
    expect(exactIdentityCandidates(h)).toEqual([MWI_499, MWI]);
    expect(unifiedIdentityAttempts(h).map((a) => [a.cardId, a.label])).toEqual([
      [MWI_499, "hobbyiqCardId"],
      [MWI, "hobbyiqCardId-twin"],
    ]);
  });
  it("with the resolver's numbered-twin answer, the FIRST attempt reads both keys in one query and neither half is re-tried alone", () => {
    // The holding still carries the un-numbered id (the common state)...
    const viaHolding = unifiedIdentityAttempts({ hobbyiqCardId: MWI }, TWIN);
    expect(viaHolding[0]).toEqual({ cardId: MWI_499, hobbyiqCardId: MWI_499, hobbyiqCardIds: [MWI_499, MWI], label: "hobbyiqCardId+numbered-twin" });
    expect(viaHolding.map((a) => a.cardId)).toEqual([MWI_499]);
    // ...and the valuation entry hands the catalog row: the same union.
    const viaEntry = unifiedIdentityAttempts({ hobbyiqCardId: MWI_499, printRun: 499 }, TWIN);
    expect(viaEntry).toEqual(viaHolding);
    // A second identity (cardId) still follows, as before.
    const withCardId = unifiedIdentityAttempts({ hobbyiqCardId: MWI, cardId: "vendor-1" }, TWIN);
    expect(withCardId.map((a) => a.label)).toEqual(["hobbyiqCardId+numbered-twin", "cardId+hobbyiqCardId"]);
    // A resolution for a DIFFERENT slug, or a refusal, changes nothing.
    expect(unifiedIdentityAttempts({ hobbyiqCardId: MWI }, { ...TWIN, requested: "hiq:other", id: "hiq:other:num-5" }).map((a) => a.label)).toEqual(["hobbyiqCardId"]);
    expect(unifiedIdentityAttempts({ hobbyiqCardId: MWI }, { requested: MWI, id: null, kind: "ambiguous", twins: [] }).map((a) => a.label)).toEqual(["hobbyiqCardId"]);
    expect(unifiedIdentityAttempts({ hobbyiqCardId: MWI }, null)).toEqual(unifiedIdentityAttempts({ hobbyiqCardId: MWI }));
  });
  it("the gate counts both twins on an un-numbered id (fail-safe); the read unions the id with its ONE twin, never more", () => {
    expect(exactSalesCountQuery(MWI, "x").query).toMatch(/STARTSWITH\(c\.hobbyiqCardId, @idNum\)/);
    expect(poolReadIdsFor(MWI, { requested: MWI, id: null, kind: "ambiguous", twins: [`${MWI}:num-250`, MWI_499] })).toEqual([MWI]);
    expect(poolReadIdsFor(MWI, TWIN)).toEqual([MWI, MWI_499]);
  });
});
