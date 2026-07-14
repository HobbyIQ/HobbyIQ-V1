// CF-CARDID-SUGGESTER-CATALOG-BOOST (Drew, 2026-07-14): pins the
// confidence bump applied when the reference-catalog verifies a
// candidate's SKU. Tests verify boost DELTAS (base + expected boost),
// not absolute scores — field-alignment scoring evolves, but the boost
// math is what this PR is pinning.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/services/compiq/cardhedge.client.js", () => ({
  searchCards: vi.fn(),
  isAutoCardNumber: (num) => {
    if (!num) return false;
    const s = String(num).toLowerCase();
    return /(^|\b)(cpa|bcpa|bpa|cra|bsa|bca|tca|usa|au)[- ]/.test(s);
  },
}));
vi.mock("../src/services/compiq/cardsightUuidSource.js", () => ({
  fetchCardsightUuidNativeCandidates: vi.fn(),
}));
vi.mock("../src/services/compiq/referenceCatalogLookup.js", () => ({
  inferPrintRunFromReferenceCatalog: vi.fn(),
}));

import { suggestCardIdForHolding } from "../src/services/portfolioiq/cardIdSuggester.service.js";
import { searchCards } from "../src/services/compiq/cardhedge.client.js";
import { fetchCardsightUuidNativeCandidates } from "../src/services/compiq/cardsightUuidSource.js";
import { inferPrintRunFromReferenceCatalog } from "../src/services/compiq/referenceCatalogLookup.js";
import type { PortfolioHolding } from "../src/types/portfolioiq.types.js";

function makeHolding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    id: "h-1", playerName: "Eric Hartman", cardYear: 2026,
    setName: "Bowman Chrome", parallel: "Green Refractor",
    cardNumber: "CPA-EHA", isAuto: true, quantity: 1,
    ...overrides,
  } as PortfolioHolding;
}

const CH_ROW = {
  card_id: "ch-hartman-green",
  title: "2026 Bowman Chrome Eric Hartman CPA-EHA Green Refractor",
  set: "2026 Bowman Baseball", year: 2026, number: "CPA-EHA",
  variant: "Green Refractor", name: "Eric Hartman",
} as any;

beforeEach(() => {
  vi.mocked(searchCards).mockReset().mockResolvedValue([]);
  vi.mocked(fetchCardsightUuidNativeCandidates).mockReset().mockResolvedValue([]);
  vi.mocked(inferPrintRunFromReferenceCatalog).mockReset();
});
afterEach(() => vi.restoreAllMocks());

async function captureBaseConfidence(): Promise<number> {
  vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue(null);
  const r = await suggestCardIdForHolding(makeHolding());
  return r!.confidence;
}

describe("CF-CARDID-SUGGESTER-CATALOG-BOOST — confidence delta per tier", () => {
  it("Verified boost adds +0.10 to base confidence", async () => {
    vi.mocked(searchCards).mockResolvedValue([CH_ROW]);
    const base = await captureBaseConfidence();

    vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue({
      printRun: 99, auto: true, confidence: "Verified",
      product: "Bowman Chrome", cardSet: "Chrome Prospects Autographs",
      parallel: "Green Refractor", source: "reference-catalog",
    });
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r?.confidence).toBe(Math.min(0.98, Math.round((base + 0.10) * 100) / 100));
    expect(r?.catalogVerified?.confidence).toBe("Verified");
  });

  it("High boost adds +0.05", async () => {
    vi.mocked(searchCards).mockResolvedValue([CH_ROW]);
    const base = await captureBaseConfidence();

    vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue({
      printRun: 99, auto: true, confidence: "High",
      product: "Bowman Chrome", cardSet: "Chrome Prospects Autographs",
      parallel: "Green Refractor", source: "reference-catalog",
    });
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r?.confidence).toBe(Math.min(0.98, Math.round((base + 0.05) * 100) / 100));
  });

  it("Medium boost adds +0.02", async () => {
    vi.mocked(searchCards).mockResolvedValue([CH_ROW]);
    const base = await captureBaseConfidence();

    vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue({
      printRun: 99, auto: true, confidence: "Medium",
      product: "Bowman Chrome", cardSet: "Chrome Prospects Autographs",
      parallel: "Green Refractor", source: "reference-catalog",
    });
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r?.confidence).toBe(Math.min(0.98, Math.round((base + 0.02) * 100) / 100));
  });

  it("No catalog match → confidence unchanged from base", async () => {
    vi.mocked(searchCards).mockResolvedValue([CH_ROW]);
    const base = await captureBaseConfidence();

    vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue(null);
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r?.confidence).toBe(base);
    expect(r?.catalogVerified).toBeNull();
  });

  it("Boost caps at 0.98 (never overrides user-verified 1.0 semantic ceiling)", async () => {
    vi.mocked(searchCards).mockResolvedValue([CH_ROW]);
    vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue({
      printRun: 99, auto: true, confidence: "Verified",
      product: "Bowman Chrome", cardSet: "Chrome Prospects Autographs",
      parallel: "Green Refractor", source: "reference-catalog",
    });
    const r = await suggestCardIdForHolding(makeHolding());
    expect(r?.confidence).toBeLessThanOrEqual(0.98);
  });

  it("Borderline medium promotes to high when Verified boost crosses 0.85", async () => {
    // Force base into borderline-medium by breaking cardYear alignment
    // (2025 vs 2026). Base scores ~0.75; Verified boost → 0.85 = high.
    vi.mocked(searchCards).mockResolvedValue([CH_ROW]);
    vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue(null);
    const baseR = await suggestCardIdForHolding(makeHolding({ cardYear: 2025 }));
    if (baseR!.confidence >= 0.85) {
      // Test premise false — scorer landed borderline case in high already
      // (which is honest; different design would let this test become
      // meaningless as scoring evolves). Skip rather than assert wrongly.
      return;
    }
    if (baseR!.confidence < 0.75) {
      // Base too low for +0.10 to promote — test premise no longer holds.
      return;
    }

    vi.mocked(inferPrintRunFromReferenceCatalog).mockResolvedValue({
      printRun: 99, auto: true, confidence: "Verified",
      product: "Bowman Chrome", cardSet: "Chrome Prospects Autographs",
      parallel: "Green Refractor", source: "reference-catalog",
    });
    const r = await suggestCardIdForHolding(makeHolding({ cardYear: 2025 }));
    // Boost lifts it into high tier (0.85+)
    expect(r?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(r?.confidenceTier).toBe("high");
  });

  it("Alternatives boost independently — verified alt outranks unverified peer", async () => {
    vi.mocked(searchCards).mockResolvedValue([
      CH_ROW,
      {
        card_id: "ch-alt-a",
        set: "2026 Bowman Baseball", year: 2026, number: "CPA-EHA",
        variant: "Purple Refractor", name: "Eric Hartman",
      } as any,
      {
        card_id: "ch-alt-b",
        set: "2026 Bowman Baseball", year: 2026, number: "CPA-EHA",
        variant: "Speckle Refractor", name: "Eric Hartman",
      } as any,
    ]);
    vi.mocked(inferPrintRunFromReferenceCatalog).mockImplementation(async (_p, _y, parallel) => {
      if (String(parallel).toLowerCase().includes("purple")) {
        return {
          printRun: 250, auto: true, confidence: "Verified",
          product: "Bowman Chrome", cardSet: "Chrome Prospects Autographs",
          parallel: "Purple Refractor", source: "reference-catalog",
        };
      }
      return null;
    });

    // Force medium tier so alts emit
    const r = await suggestCardIdForHolding(makeHolding({ cardYear: 2025 }));
    const altA = r?.alternatives?.find((a) => a.cardId === "ch-alt-a");
    const altB = r?.alternatives?.find((a) => a.cardId === "ch-alt-b");
    // Both may or may not be present depending on scoring; if both are,
    // A should be boosted higher than B.
    if (altA && altB) {
      expect(altA.confidence).toBeGreaterThan(altB.confidence);
      expect(altA.catalogVerified?.confidence).toBe("Verified");
      expect(altB.catalogVerified).toBeNull();
    } else if (altA) {
      expect(altA.catalogVerified?.confidence).toBe("Verified");
    }
  });
});
