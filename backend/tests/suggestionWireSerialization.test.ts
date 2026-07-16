// CF-CARDID-SUGGESTER-WIRE-SERIALIZATION (Drew, 2026-07-14): pins the
// serialization of the two suggestion fields PR #438 added:
//   - suggestionCandidateSource
//   - suggestionAlternatives
//
// Root cause of Drew's 2026-07-14 "review queue but no suggestion to
// pick from" report: these fields were stored on the holding in Cosmos
// but responseAssembly.ts wasn't serializing them onto the wire, so
// iOS decoded a holding with missing fields and rendered the "no
// suggestion" empty state for 14 pending-review rows.

import { describe, expect, it } from "vitest";
import { composeHoldingWireShape } from "../src/services/portfolioiq/responseAssembly.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

function makeHoldingWithSuggestion(fields: Record<string, unknown> = {}): PortfolioHolding {
  return {
    id: "h1",
    playerName: "Eric Hartman",
    cardYear: 2026,
    product: "Bowman Chrome",
    cardTitle: "2026 Bowman Eric Hartman CPA-EHA",
    quantity: 1,
    purchasePrice: 100,
    totalCostBasis: 100,
    cardStatus: "pending-review",
    suggestedCardId: "1778542173652x303328120692600800",
    suggestionConfidence: 0.76,
    suggestionConfidenceTier: "medium",
    suggestionCandidateSource: "cardhedge",
    suggestionCandidate: {
      title: "2026 Bowman Chrome Eric Hartman CPA-EHA Green Refractor",
      set: "2026 Bowman Baseball",
      year: 2026,
      number: "CPA-EHA",
      variant: "Green Refractor",
    },
    suggestionAlternatives: [
      {
        cardId: "alt-1",
        confidence: 0.60,
        confidenceTier: "medium",
        candidateSource: "cardhedge",
        candidate: { variant: "Purple Refractor", number: "CPA-EHA", set: "2026 Bowman Baseball" },
      },
      {
        cardId: "alt-2",
        confidence: 0.60,
        confidenceTier: "medium",
        candidateSource: "cardsight-uuid",
        candidate: { variant: "Speckle Refractor", number: "CPA-EHA", set: "Chrome Prospects Autographs" },
      },
    ],
    ...fields,
  } as any;
}

describe("CF-CARDID-SUGGESTER-WIRE-SERIALIZATION", () => {
  it("serializes suggestionCandidateSource onto the wire", () => {
    const wire = composeHoldingWireShape(makeHoldingWithSuggestion());
    expect((wire as any).suggestionCandidateSource).toBe("cardhedge");
  });

  it("serializes suggestionAlternatives onto the wire (array preserved)", () => {
    const wire = composeHoldingWireShape(makeHoldingWithSuggestion());
    const alts = (wire as any).suggestionAlternatives;
    expect(Array.isArray(alts)).toBe(true);
    expect(alts).toHaveLength(2);
    expect(alts[0].cardId).toBe("alt-1");
    expect(alts[0].candidateSource).toBe("cardhedge");
    expect(alts[1].candidateSource).toBe("cardsight-uuid");
  });

  it("high-tier holdings serialize null/undefined alternatives cleanly (no throw)", () => {
    const wire = composeHoldingWireShape(makeHoldingWithSuggestion({
      suggestionConfidenceTier: "high",
      suggestionAlternatives: undefined,
    }));
    expect((wire as any).suggestionCandidateSource).toBe("cardhedge");
    // Alternatives absent OR undefined — either is acceptable, but
    // must not crash serialization.
    const alts = (wire as any).suggestionAlternatives;
    expect(alts === undefined || alts === null).toBe(true);
  });

  it("legacy holdings without any suggestion serialize without missing-key errors", () => {
    const legacy = {
      id: "legacy",
      playerName: "Mike Trout",
      cardYear: 2011,
      product: "Topps Update",
      cardTitle: "2011 Topps Update US175",
      quantity: 1,
      purchasePrice: 50,
      totalCostBasis: 50,
    } as PortfolioHolding;
    const wire = composeHoldingWireShape(legacy);
    // Both new fields present as undefined — iOS decoder tolerates.
    expect((wire as any).suggestionCandidateSource).toBeUndefined();
    expect((wire as any).suggestionAlternatives).toBeUndefined();
  });
});
