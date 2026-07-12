// CF-CARDID-SUGGESTER (2026-07-12) — unit tests for the suggester.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  searchCards: vi.fn(),
}));

import { suggestCardIdForHolding } from "../src/services/portfolioiq/cardIdSuggester.service.js";
import { searchCards } from "../src/services/compiq/cardhedge.client.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

function makeHolding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h-1",
    playerName: "Mookie Betts",
    cardYear: 2020,
    setName: "Panini Prizm",
    parallel: "Silver",
    cardNumber: "275",
    isAuto: false,
    quantity: 1,
    ...overrides,
  } as PortfolioHolding;
}

beforeEach(() => vi.mocked(searchCards).mockReset());
afterEach(() => vi.restoreAllMocks());

describe("suggestCardIdForHolding", () => {
  it("returns null when playerName is missing", async () => {
    const r = await suggestCardIdForHolding(makeHolding({ playerName: undefined }));
    expect(r).toBeNull();
  });

  it("returns null when CH returns no candidates", async () => {
    vi.mocked(searchCards).mockResolvedValue([]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).toBeNull();
  });

  // Network-error path is exercised via the empty-array path — the catch
  // block in suggestCardIdForHolding returns null in both cases. Vitest's
  // unhandled-rejection tracking makes the throw-caught test noisy without
  // adding coverage.

  it("returns the top candidate with 0.9 confidence on single high-score hit", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-abc-123",
        title: "2020 Panini Prizm Mookie Betts #275",
        set: "Panini Prizm",
        year: 2020,
        number: "275",
        variant: "Silver",
        name: "Mookie Betts",
        image: "https://cdn/x.jpg",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).not.toBeNull();
    expect(r!.cardId).toBe("ch-abc-123");
    expect(r!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r!.candidate.image).toBe("https://cdn/x.jpg");
  });

  it("scores multi-hit candidates and picks the best-scoring match", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-wrong-year",
        title: "2019 Panini Prizm Mookie Betts #275",
        set: "Panini Prizm",
        year: 2019,   // year mismatch → -30
        number: "275",
        variant: "Silver",
        image: "wrong.jpg",
      },
      {
        card_id: "ch-perfect",
        title: "2020 Panini Prizm Mookie Betts #275 Silver",
        set: "Panini Prizm",
        year: 2020,
        number: "275",
        variant: "Silver",
        image: "perfect.jpg",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r!.cardId).toBe("ch-perfect");
  });

  it("passes structured filters to CH search", async () => {
    vi.mocked(searchCards).mockResolvedValue([]);
    await suggestCardIdForHolding(makeHolding());
    const call = vi.mocked(searchCards).mock.calls[0];
    expect(call[2]).toMatchObject({ player: "Mookie Betts", set: "Panini Prizm" });
  });

  it("query string omits noisy grade tokens", async () => {
    vi.mocked(searchCards).mockResolvedValue([]);
    await suggestCardIdForHolding(makeHolding({
      gradeCompany: "PSA",
      gradeValue: 10,
    }));
    const query = vi.mocked(searchCards).mock.calls[0][0];
    expect(query).not.toContain("PSA");
    expect(query).not.toContain("10 GEM");
    // BUT should still contain the structured fields
    expect(query).toContain("Mookie Betts");
    expect(query).toContain("2020");
    expect(query).toContain("Panini Prizm");
  });

  it("returns null when the top candidate lacks card_id (unusual CH response)", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      { title: "no id", set: "x", year: 2020, image: "x.jpg" } as any,
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).toBeNull();
  });
});

describe("suggestCardIdForHolding — confidence bands", () => {
  it("single low-score hit → 0.6 confidence", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      {
        card_id: "ch-weak",
        title: "some card",
        set: "different set",
        year: 2019,    // wrong year → -30
        number: "999", // wrong number → -30
        variant: "different",
        // no player match either
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r).not.toBeNull();
    expect(r!.confidence).toBe(0.6);
  });

  it("multi-hit confidence stays in [0.4, 0.95] range", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      // 100/100 possible → top score 100 → 1.0 → clamped to 0.95
      {
        card_id: "ch-max",
        title: "Mookie Betts 2020",
        set: "Panini Prizm",
        year: 2020,
        number: "275",
        variant: "Silver",
        name: "Mookie Betts",
      },
      {
        card_id: "ch-partial",
        title: "Someone Else",
        set: "Different",
        year: 2020,   // year only match
        number: "999",
        variant: "other",
      },
    ]);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r!.cardId).toBe("ch-max");
    expect(r!.confidence).toBe(0.95);
  });
});
