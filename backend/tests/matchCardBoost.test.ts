// CF-CH-MATCH-CARD-BOOST (2026-06-28) — pins the AI-match boost behavior
// in the freetext dispatcher.
//
// PRIOR-CF GAP: even with CF-CH-RERANK-BY-INTENT, candidates outside the
// search window (rank > FREETEXT_TAKE_DEFAULT) can't be re-ranked because
// they aren't in the result set at all. Observable on Kurtz CPA-NK Green
// Lava — sometimes inside the first 100 hits, sometimes outside depending
// on whether other parallels (Pink, Atomic, Speckle, etc.) dilute the
// ranking. CardHedge's AI matcher (/v1/cards/card-match) understands
// semantic intent regardless of where the card sits in token-search
// ordering, so we use it as a complementary boost signal.
//
// THIS FILE PINS:
//   1. When identifyCard returns null/low confidence → no boost, search
//      results pass through unchanged.
//   2. When identifyCard's matched card_id IS in the search hits →
//      that card is promoted to position 0 with attribution "ai-matched"
//      and confidence 1.0.
//   3. When identifyCard's matched card_id is NOT in the search hits →
//      getCardDetailsById fetches the missing card and it's prepended
//      to the candidate list at position 0 with the same attribution.
//   4. getCardDetailsById network failures degrade silently — search-only
//      results still surface.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardhedge.client.js")>();
  return {
    ...actual,
    identifyCard: vi.fn(),
    getCardDetailsById: vi.fn(),
  };
});

vi.mock("../src/services/compiq/cardsight.router.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/compiq/cardsight.router.js")>();
  return {
    ...actual,
    searchCardsRouted: vi.fn(),
  };
});

import {
  identifyCard,
  getCardDetailsById,
} from "../src/services/compiq/cardhedge.client.js";
import { searchCardsRouted } from "../src/services/compiq/cardsight.router.js";
import { dispatchSearch } from "../src/services/unifiedSearch/dispatcher.js";

const mockedIdentify = identifyCard as unknown as ReturnType<typeof vi.fn>;
const mockedGetDetails = getCardDetailsById as unknown as ReturnType<typeof vi.fn>;
const mockedSearch = searchCardsRouted as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockedIdentify.mockReset();
  mockedGetDetails.mockReset();
  mockedSearch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. NO-OP — identifyCard returned null
// ─────────────────────────────────────────────────────────────────────────────

describe("CF-CH-MATCH-CARD-BOOST — no boost when AI matcher returns null", () => {
  it("passes search results through unchanged when identifyCard → null", async () => {
    mockedIdentify.mockResolvedValue(null);
    mockedSearch.mockResolvedValue([
      { card_id: "card-A", player: "Mike Trout", variant: "Refractor" },
      { card_id: "card-B", player: "Mike Trout", variant: "Base" },
    ]);

    const result = await dispatchSearch("mike trout refractor");

    expect(mockedIdentify).toHaveBeenCalledWith("mike trout refractor");
    expect(mockedGetDetails).not.toHaveBeenCalled();
    expect(result.candidates).toHaveLength(2);
    // No candidate should be attributed ai-matched.
    expect(result.candidates.every((c) => c.attribution !== "ai-matched")).toBe(true);
  });

  it("ignores AI matcher errors gracefully (no boost, search still works)", async () => {
    mockedIdentify.mockRejectedValue(new Error("CH unavailable"));
    mockedSearch.mockResolvedValue([
      { card_id: "card-A", player: "Mike Trout", variant: "Refractor" },
    ]);

    const result = await dispatchSearch("mike trout refractor");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].attribution).not.toBe("ai-matched");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. BOOST IN PLACE — matched card_id IS in the search hits
// ─────────────────────────────────────────────────────────────────────────────

describe("CF-CH-MATCH-CARD-BOOST — promotion of an existing hit", () => {
  it("moves the AI-matched card_id to position 0 even if buried", async () => {
    // The "right" card sits at position 2 in the search hits — the AI
    // matcher correctly identifies it and we boost it to the front.
    mockedIdentify.mockResolvedValue({
      card_id: "card-target",
      confidence: 0.95,
      number: "CPA-NK",  // CF-AI-MATCH-INTENT-VALIDATION: detected as auto
    });
    mockedSearch.mockResolvedValue([
      { card_id: "card-decoy-1", player: "Nick Kurtz", variant: "Base" },
      { card_id: "card-decoy-2", player: "Nick Kurtz", variant: "Refractor" },
      { card_id: "card-target", player: "Nick Kurtz", variant: "Green Lava" },
    ]);

    const result = await dispatchSearch("nick kurtz green lava auto");

    expect(result.candidates).toHaveLength(3);
    expect(result.candidates[0].candidateId).toBe("cardsight:card-target");
    expect(result.candidates[0].attribution).toBe("ai-matched");
    expect(result.candidates[0].confidence).toBe(1.0);
    expect(mockedGetDetails).not.toHaveBeenCalled();
  });

  it("does not call getCardDetailsById when the match is already in hits", async () => {
    mockedIdentify.mockResolvedValue({ card_id: "card-A", confidence: 0.92 });
    mockedSearch.mockResolvedValue([
      { card_id: "card-A", player: "Player A", variant: "Base" },
    ]);

    await dispatchSearch("player a base");

    expect(mockedGetDetails).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PREPEND — matched card_id NOT in the search hits (the load-bearing case)
// ─────────────────────────────────────────────────────────────────────────────

describe("CF-CH-MATCH-CARD-BOOST — prepend a card outside the search window", () => {
  it("fetches details for unknown card_id and prepends to the candidate list", async () => {
    mockedIdentify.mockResolvedValue({
      card_id: "card-buried",
      confidence: 0.88,
      number: "CPA-NK",  // CF-AI-MATCH-INTENT-VALIDATION: detected as auto
    });
    mockedSearch.mockResolvedValue([
      { card_id: "card-decoy-1", player: "Nick Kurtz", variant: "Base" },
      { card_id: "card-decoy-2", player: "Nick Kurtz", variant: "Refractor" },
    ]);
    mockedGetDetails.mockResolvedValue({
      card_id: "card-buried",
      player: "Nick Kurtz",
      set: "2025 Bowman Chrome Prospects Baseball",
      year: 2025,
      number: "CPA-NK",
      variant: "Green Lava",
      title: "Nick Kurtz 2025 Bowman Chrome Prospects Green Lava Auto",
      image: "https://cdn.example.com/x.jpg",
    });

    const result = await dispatchSearch("nick kurtz green lava auto");

    expect(mockedGetDetails).toHaveBeenCalledWith("card-buried");
    expect(result.candidates).toHaveLength(3); // 2 search + 1 prepended
    expect(result.candidates[0].candidateId).toBe("cardsight:card-buried");
    expect(result.candidates[0].attribution).toBe("ai-matched");
    expect(result.candidates[0].confidence).toBe(1.0);
    expect(result.candidates[0].parallel).toBe("Green Lava");
    expect(result.candidates[0].imageUrl).toBe("https://cdn.example.com/x.jpg");
  });

  it("degrades to search-only when getCardDetailsById returns null", async () => {
    mockedIdentify.mockResolvedValue({
      card_id: "card-missing",
      confidence: 0.92,
    });
    mockedSearch.mockResolvedValue([
      { card_id: "card-A", player: "Player A", variant: "Base" },
    ]);
    mockedGetDetails.mockResolvedValue(null);

    const result = await dispatchSearch("query");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].candidateId).toBe("cardsight:card-A");
    expect(result.candidates[0].attribution).not.toBe("ai-matched");
  });

  it("degrades to search-only when getCardDetailsById throws", async () => {
    mockedIdentify.mockResolvedValue({
      card_id: "card-flake",
      confidence: 0.92,
    });
    mockedSearch.mockResolvedValue([
      { card_id: "card-A", player: "Player A", variant: "Base" },
    ]);
    mockedGetDetails.mockRejectedValue(new Error("HTTP 500"));

    const result = await dispatchSearch("query");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].attribution).not.toBe("ai-matched");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. EDGE — empty search results + AI match still produces a candidate
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CF-AI-MATCH-INTENT-VALIDATION (2026-06-29) — auto-intent rejection
// ─────────────────────────────────────────────────────────────────────────────

describe("CF-AI-MATCH-INTENT-VALIDATION — reject match_card when isAuto disagrees with intent", () => {
  it("user typed 'auto' AND match returned non-auto card → boost SKIPPED, rerank takes over", async () => {
    // Reproduces the 2011 Harper Bowman Chrome Prospect Auto case:
    // CH's matcher resolved to BCP111 (base insert, isAuto=false) but
    // user clearly wanted the autograph. The boost must NOT prepend the
    // non-auto card; the dispatcher's rerank ranks scored hits instead.
    mockedIdentify.mockResolvedValue({
      card_id: "wrong-base-insert",
      confidence: 0.92,
      number: "BCP111",  // base prospect insert prefix → not auto
    });
    mockedSearch.mockResolvedValue([
      { card_id: "actual-cpa-auto", player: "Bryce Harper", number: "CPA-BH", variant: "Base" },
      { card_id: "decoy", player: "Bryce Harper", number: "BCP111", variant: "Base" },
    ]);

    const result = await dispatchSearch("bryce harper 2011 bowman chrome prospect auto");

    // The CPA-BH (auto, scored higher by rerank) wins position 0,
    // NOT the BCP111 the AI matcher picked.
    expect(result.candidates).toHaveLength(2);
    // No candidate should be tagged ai-matched (boost was skipped).
    expect(result.candidates.every((c) => c.attribution !== "ai-matched")).toBe(true);
  });

  it("user typed 'auto' AND match returned auto card → boost still fires normally", async () => {
    // Control: when the matcher IS aligned with intent, the boost works.
    mockedIdentify.mockResolvedValue({
      card_id: "correct-auto",
      confidence: 0.92,
      number: "CPA-NK",  // chrome prospect auto prefix → IS auto
    });
    mockedSearch.mockResolvedValue([
      { card_id: "correct-auto", player: "Nick Kurtz", number: "CPA-NK", variant: "Green Lava" },
    ]);

    const result = await dispatchSearch("nick kurtz green lava auto");

    expect(result.candidates[0].attribution).toBe("ai-matched");
  });

  it("user did NOT type 'auto' → intent gate not engaged, normal boost", async () => {
    // Control: when user query has no auto intent, the gate doesn't fire
    // — the boost is the natural CF-CH-MATCH-CARD-BOOST behavior.
    mockedIdentify.mockResolvedValue({
      card_id: "any-card",
      confidence: 0.9,
      number: "BCP111",  // would have triggered gate IF auto were in query
    });
    mockedSearch.mockResolvedValue([
      { card_id: "any-card", player: "Bryce Harper", number: "BCP111", variant: "Base" },
    ]);

    const result = await dispatchSearch("bryce harper 2011 bowman chrome prospect");  // no "auto"

    expect(result.candidates[0].attribution).toBe("ai-matched");
  });
});

describe("CF-CH-MATCH-CARD-BOOST — surfaces a candidate even when search returns zero", () => {
  it("AI match alone yields a single-candidate response when search is empty", async () => {
    mockedIdentify.mockResolvedValue({
      card_id: "card-only",
      confidence: 0.91,
    });
    mockedSearch.mockResolvedValue([]);
    mockedGetDetails.mockResolvedValue({
      card_id: "card-only",
      player: "Eric Hartman",
      variant: "Speckle Refractor",
      title: "Hartman Speckle Refractor",
    });

    const result = await dispatchSearch("eric hartman speckle refractor");

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].candidateId).toBe("cardsight:card-only");
    expect(result.candidates[0].attribution).toBe("ai-matched");
    expect(result.warnings).not.toContain("no_freetext_matches");
  });

  it("returns no_freetext_matches when both search AND AI match are empty", async () => {
    mockedIdentify.mockResolvedValue(null);
    mockedSearch.mockResolvedValue([]);

    const result = await dispatchSearch("nonexistent card");

    expect(result.candidates).toHaveLength(0);
    expect(result.warnings).toContain("no_freetext_matches");
  });
});
