// CF-CH-RERANK-YEAR-FROM-SET (2026-07-02) — pin the year-fallback rerank
// contract via a small integration slice against the dispatcher.
//
// PRIOR-CF GAP: CardHedge's card-search response often carries `year: null`
// even when the year is clearly present in the `set` string ("2024 Bowman
// Chrome Baseball Paul Skenes 31 Base"). scoreCandidateForIntent's
// year-delta branch guards with `Number.isFinite(candY)`; a null candidate
// year becomes NaN and the whole year-delta scoring silently no-ops.
//
// Observable pre-CF (fresh live probe against prod post-#242):
//   query="2023 Bowman Chrome Paul Skenes Base"
//   position 1 was "2025 Topps Chrome Platinum" (should have received
//   -2 delta-2 penalty but didn't; year field was null)
//   position 2 was "2024 Bowman Chrome" (should have won with 0-penalty
//   delta-1 score)
//
// Fix: when `card.year` is null, fall back to extractYearFromSetText(card.set).
// The rerank's year branch then fires with a real year and the closest-year
// candidate correctly bubbles up.
//
// THIS FILE PINS the observable outcome — a synthetic 3-hit CardHedge
// response with mixed year fields (some null, some set-only) reranks
// correctly against a user's intent year via the dispatcher.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  identifyCard: vi.fn(),
  getCardDetailsById: vi.fn(),
  searchCards: vi.fn(),
}));

vi.mock("../src/services/compiq/cardsight.router.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardsight.router.js")>(
    "../src/services/compiq/cardsight.router.js",
  );
  return {
    ...actual,
    searchCardsRouted: vi.fn(),
  };
});

import { dispatchSearch } from "../src/services/unifiedSearch/dispatcher.js";
import {
  identifyCard as identifyCardMock,
  getCardDetailsById as getCardDetailsByIdMock,
} from "../src/services/compiq/cardhedge.client.js";
import { searchCardsRouted as searchCardsRoutedMock } from "../src/services/compiq/cardsight.router.js";

beforeEach(() => {
  vi.mocked(identifyCardMock).mockResolvedValue(null);
  vi.mocked(getCardDetailsByIdMock).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("dispatcher rerank — year-fallback from setName", () => {
  it("candidate.year=null → extracts year from setName so delta-2 penalty fires", async () => {
    // Mimic prod: CH returns cards with year field null; setName carries the year.
    vi.mocked(searchCardsRoutedMock).mockResolvedValue([
      {
        card_id: "topps-platinum-2025",
        player: "Paul Skenes",
        set: "2025 Topps Chrome Platinum Baseball",
        year: null as unknown as number, // ← real CH behavior
        number: "197",
        variant: "Base",
        title: "2025 Topps Chrome Platinum Baseball Paul Skenes 197 Base",
      },
      {
        card_id: "bowman-chrome-2024",
        player: "Paul Skenes",
        set: "2024 Bowman Chrome Baseball",
        year: null as unknown as number,
        number: "31",
        variant: "Base",
        title: "2024 Bowman Chrome Baseball Paul Skenes 31 Base",
      },
    ]);

    // User's intent year is 2023 (wrong — Skenes's real rookie is 2024).
    // Expected rerank:
    //   2025 Topps Platinum: year delta 2 → -2 penalty
    //   2024 Bowman Chrome:  year delta 1 → 0 penalty
    // 2024 should win.
    const res = await dispatchSearch("2023 Bowman Chrome Paul Skenes Base");
    expect(res.candidates.length).toBe(2);
    expect(res.candidates[0].candidateId).toBe("cardsight:bowman-chrome-2024");
    expect(res.candidates[1].candidateId).toBe("cardsight:topps-platinum-2025");
  });

  it("candidate.year set numerically → still used (no regression)", async () => {
    vi.mocked(searchCardsRoutedMock).mockResolvedValue([
      {
        card_id: "wrong-year-explicit",
        player: "Paul Skenes",
        set: "2025 Topps Chrome Platinum Baseball",
        year: 2025, // explicit numeric year — should still work
        number: "197",
        variant: "Base",
      },
      {
        card_id: "right-year-explicit",
        player: "Paul Skenes",
        set: "2024 Bowman Chrome Baseball",
        year: 2024,
        number: "31",
        variant: "Base",
      },
    ]);
    const res = await dispatchSearch("2023 Bowman Chrome Paul Skenes Base");
    expect(res.candidates[0].candidateId).toBe("cardsight:right-year-explicit");
  });

  it("candidate.year=null AND setName has no year → no year scoring, CH order preserved", async () => {
    vi.mocked(searchCardsRoutedMock).mockResolvedValue([
      {
        card_id: "first",
        player: "Paul Skenes",
        set: "Some Product Baseball",
        year: null as unknown as number,
        number: "1",
        variant: "Base",
      },
      {
        card_id: "second",
        player: "Paul Skenes",
        set: "Another Set Baseball",
        year: null as unknown as number,
        number: "2",
        variant: "Base",
      },
    ]);
    const res = await dispatchSearch("2023 Bowman Chrome Paul Skenes Base");
    // With no year to score, both cards tie on score; stable sort keeps CH order.
    expect(res.candidates[0].candidateId).toBe("cardsight:first");
    expect(res.candidates[1].candidateId).toBe("cardsight:second");
  });

  it("intentYear=null (no year in user query) → year branch skips, CH order preserved", async () => {
    vi.mocked(searchCardsRoutedMock).mockResolvedValue([
      {
        card_id: "candA",
        player: "Paul Skenes",
        set: "2024 Bowman Chrome Baseball",
        year: null as unknown as number,
        number: "31",
        variant: "Base",
      },
      {
        card_id: "candB",
        player: "Paul Skenes",
        set: "2025 Topps Chrome Platinum Baseball",
        year: null as unknown as number,
        number: "197",
        variant: "Base",
      },
    ]);
    // Query has no year — intentYear will parse to null; year scoring should skip.
    const res = await dispatchSearch("Paul Skenes Base");
    expect(res.candidates[0].candidateId).toBe("cardsight:candA");
    expect(res.candidates[1].candidateId).toBe("cardsight:candB");
  });
});
