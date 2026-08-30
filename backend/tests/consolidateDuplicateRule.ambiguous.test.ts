/**
 * The ambiguous reasons are DISJOINT and the not-a-duplicate kinds are never
 * folded. 69,378 groups reach Drew, so the counters he reads have to add up:
 * every group lands in exactly one reason, and no reason is a euphemism for a
 * guess.
 */
import { describe, expect, it } from "vitest";
import {
  decideDuplicateGroup,
  nearMissPrintRuns,
  type DupRow,
  type AmbiguousReason,
} from "../src/services/catalog/duplicateWinnerRule.js";

const base = (over: Partial<DupRow> = {}): DupRow => ({
  id: "hiq:baseball:2024:bowman-chrome:1:gold:no-auto",
  source: "checklistcenter",
  sport: "baseball",
  year: 2024,
  setKey: "bowman-chrome",
  cardNumber: "1",
  parallelSlug: "gold",
  isAuto: false,
  playerName: "A Player",
  ...over,
});

describe("two checklist rows of one product at different print runs", () => {
  it("is AMBIGUOUS and never folded", () => {
    const d = decideDuplicateGroup({
      rows: [
        base({ id: "a", printRun: 55 }),
        base({ id: "b", source: "beckett", printRun: 75 }),
      ],
    });
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") {
      expect(d.why).toBe("two-checklist-print-runs-one-product");
      expect(d.nearMiss).toBe(false);
      expect(d.detail).toMatch(/distinct rungs/);
    }
  });

  it("flags the /149-vs-/150 NEAR MISS so Drew rules per product, not per card", () => {
    const d = decideDuplicateGroup({
      rows: [
        base({ id: "a", source: "checklistcenter-2026-08-29", printRun: 149 }),
        base({ id: "b", source: "checklistinsider-2026-08-27", printRun: 150 }),
      ],
    });
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") {
      expect(d.why).toBe("two-checklist-print-runs-one-product");
      expect(d.nearMiss).toBe(true);
      expect(d.detail).toMatch(/NEAR MISS/);
    }
  });

  it("nearMissPrintRuns: <=10% apart is a near miss, further apart is two rungs", () => {
    expect(nearMissPrintRuns([149, 150])).toBe(true);
    expect(nearMissPrintRuns([99, 100])).toBe(true);
    expect(nearMissPrintRuns([55, 75])).toBe(false);
    expect(nearMissPrintRuns([1, 500])).toBe(false);
    expect(nearMissPrintRuns([150])).toBe(false);
    expect(nearMissPrintRuns([])).toBe(false);
  });
});

describe("no checklist row", () => {
  it("is AMBIGUOUS when nothing resolves it", () => {
    const d = decideDuplicateGroup({
      rows: [
        base({ id: "a", source: "ingest-auto-seed", parallelSlug: "refractor" }),
        base({ id: "b", source: "catalog-explode-actuals", parallelSlug: "refractor", printRun: 10 }),
      ],
    });
    expect(d.kind).toBe("ambiguous");
    if (d.kind === "ambiguous") expect(d.why).toBe("no-checklist-row");
  });

  it("is NOT ambiguous when the printRun FIELD matches the other row's :num- suffix", () => {
    // The refinement the measurement found: `...:gold-wave-refractor:no-auto`
    // carrying printRun=50 beside `...:num-50` is the same /50 written twice.
    const d = decideDuplicateGroup({
      rows: [
        base({ id: "hiq:x:446:gold-wave-refractor:no-auto", source: "ingest-auto-seed", printRun: 50 }),
        base({ id: "hiq:x:446:gold-wave-refractor:no-auto:num-50", source: "ingest-auto-seed", printRun: null }),
      ],
    });
    expect(d.kind).toBe("consolidate");
    if (d.kind === "consolidate") expect(d.winnerBy).toBe("numbered");
  });
});

describe("not a duplicate at all", () => {
  it("rows naming different players are NOT a group (the CPA initials collision)", () => {
    const d = decideDuplicateGroup({
      rows: [
        base({ id: "a", cardNumber: "cpa-an", playerName: "Angel Nunez" }),
        base({ id: "b", cardNumber: "cpa-an", playerName: "Alejandro Nunez" }),
      ],
    });
    expect(d.kind).toBe("not-a-group");
    if (d.kind === "not-a-group") expect(d.why).toBe("player-differs");
  });

  it("the player gate fires BEFORE any merge gate", () => {
    // Two players AND a spelling difference: the player gate must win, or the
    // fleet merges two players' pools on a spelling technicality.
    const d = decideDuplicateGroup({
      rows: [
        base({ id: "a", parallelSlug: "gold", playerName: "Angel Nunez" }),
        base({ id: "b", parallelSlug: "base-gold", playerName: "Alejandro Nunez" }),
      ],
    });
    expect(d.kind).toBe("not-a-group");
  });

  it("a single row is not a group", () => {
    const d = decideDuplicateGroup({ rows: [base()] });
    expect(d.kind).toBe("not-a-group");
    if (d.kind === "not-a-group") expect(d.why).toBe("single-row");
  });
});

describe("the reasons are disjoint and every group lands in exactly one", () => {
  it("classifies a mixed corpus with no group counted twice", () => {
    const groups: DupRow[][] = [
      [base({ id: "p1", printRun: 55 }), base({ id: "p2", source: "beckett", printRun: 75 })],
      [base({ id: "n1", source: "ingest-auto-seed" }), base({ id: "n2", source: "sold-comps-stub", printRun: 3 })],
      [base({ id: "c1", parallelSlug: "uncommon" }), base({ id: "c2", parallelSlug: "uncommon-refractor" })],
      [base({ id: "x1", playerName: "One Guy" }), base({ id: "x2", playerName: "Other Guy" })],
      [base({ id: "g1", printRun: 50 }), base({ id: "g2", source: "ingest-auto-seed" })],
    ];

    const tally: Record<string, number> = {};
    for (const rows of groups) {
      const d = decideDuplicateGroup({ rows });
      const label = d.kind === "ambiguous" ? `ambiguous:${d.why}` : d.kind === "not-a-group" ? `not-a-group:${d.why}` : "consolidate";
      tally[label] = (tally[label] ?? 0) + 1;
    }

    expect(Object.values(tally).reduce((a, b) => a + b, 0)).toBe(groups.length);
    expect(tally["ambiguous:two-checklist-print-runs-one-product"]).toBe(1);
    expect(tally["ambiguous:no-checklist-row"]).toBe(1);
    expect(tally["ambiguous:d31-one-source-names-both-colour-forms"]).toBe(1);
    expect(tally["not-a-group:player-differs"]).toBe(1);
    expect(tally["consolidate"]).toBe(1);
  });

  it("every ambiguous reason is one of the declared four (plus the rulings guard)", () => {
    const declared: AmbiguousReason[] = [
      "no-checklist-row",
      "two-checklist-print-runs-one-product",
      "d31-one-source-names-both-colour-forms",
      "two-dedicated-cpa-products",
      "contradicts-holding-ruling",
    ];
    const d = decideDuplicateGroup({ rows: [base({ id: "a", printRun: 55 }), base({ id: "b", source: "beckett", printRun: 75 })] });
    if (d.kind === "ambiguous") expect(declared).toContain(d.why);
  });
});
