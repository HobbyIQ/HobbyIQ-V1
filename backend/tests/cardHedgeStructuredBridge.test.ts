// CF-CH-STRUCTURED-BRIDGE (Drew, 2026-07-15) — pins the structured
// CH bridge that uses /v1/cards/card-search + local cardNumber filter
// to bypass the AI matcher when we have exact identity fields.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CardHedgeCard } from "../src/services/compiq/cardhedge.client.js";

vi.mock("../src/services/compiq/cardhedge.client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/compiq/cardhedge.client.js")>(
    "../src/services/compiq/cardhedge.client.js",
  );
  return {
    ...actual,
    searchCards: vi.fn(),
  };
});

import { searchCards } from "../src/services/compiq/cardhedge.client.js";
import { structuredCardHedgeBridge } from "../src/services/compiq/cardHedgeStructuredBridge.js";

const mockedSearch = vi.mocked(searchCards);

const ORIGINAL_FLAG = process.env.CH_STRUCTURED_BRIDGE_ENABLED;

function chCard(overrides: Partial<CardHedgeCard> = {}): CardHedgeCard {
  return {
    card_id: "ch-default",
    player: "Eric Hartman",
    year: 2026,
    number: "CPA-EHA",
    variant: "Blue Refractor",
    set: "Bowman Chrome",
    title: "Eric Hartman 2026 Bowman Chrome Blue Refractor",
    ...overrides,
  } as CardHedgeCard;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CH_STRUCTURED_BRIDGE_ENABLED = "true";
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.CH_STRUCTURED_BRIDGE_ENABLED;
  else process.env.CH_STRUCTURED_BRIDGE_ENABLED = ORIGINAL_FLAG;
});

describe("structuredCardHedgeBridge — env gate", () => {
  it("returns null when env flag is unset (default off)", async () => {
    delete process.env.CH_STRUCTURED_BRIDGE_ENABLED;
    const r = await structuredCardHedgeBridge({
      playerName: "Eric Hartman", number: "CPA-EHA", cardYear: 2026,
    });
    expect(r).toBeNull();
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it("returns null when env flag is not exactly 'true'", async () => {
    process.env.CH_STRUCTURED_BRIDGE_ENABLED = "1";
    const r = await structuredCardHedgeBridge({
      playerName: "Eric Hartman", number: "CPA-EHA",
    });
    expect(r).toBeNull();
  });
});

describe("structuredCardHedgeBridge — precondition guards", () => {
  it("returns null with no playerName (need player for filter)", async () => {
    const r = await structuredCardHedgeBridge({ playerName: "", number: "CPA-EHA" });
    expect(r).toBeNull();
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it("returns null with playerName too short (< 2 chars)", async () => {
    const r = await structuredCardHedgeBridge({ playerName: "A", number: "CPA-EHA" });
    expect(r).toBeNull();
  });

  it("returns null without cardNumber (nothing to disambiguate)", async () => {
    const r = await structuredCardHedgeBridge({ playerName: "Eric Hartman" });
    expect(r).toBeNull();
    expect(mockedSearch).not.toHaveBeenCalled();
  });
});

describe("structuredCardHedgeBridge — happy path", () => {
  it("returns cardId + 0.85 confidence for exact number match", async () => {
    mockedSearch.mockResolvedValue([
      chCard({ card_id: "ch-hartman-blue-ref", number: "CPA-EHA", year: 2026 }),
    ]);
    const r = await structuredCardHedgeBridge({
      playerName: "Eric Hartman", number: "CPA-EHA", cardYear: 2026,
    });
    expect(r).not.toBeNull();
    expect(r!.chCardId).toBe("ch-hartman-blue-ref");
    expect(r!.confidence).toBe(0.85);
    // Verifies we passed player as both search text AND filter
    expect(mockedSearch).toHaveBeenCalledWith("Eric Hartman", 30, { player: "Eric Hartman" }, 1);
  });

  it("case-insensitive cardNumber match (CPA-eha == CPA-EHA)", async () => {
    mockedSearch.mockResolvedValue([chCard({ number: "cpa-eha" })]);
    const r = await structuredCardHedgeBridge({
      playerName: "Eric Hartman", number: "CPA-EHA",
    });
    expect(r).not.toBeNull();
  });

  it("returns null when no candidate has matching cardNumber", async () => {
    mockedSearch.mockResolvedValue([
      chCard({ number: "BCP-999" }),
      chCard({ number: "SC-42" }),
    ]);
    const r = await structuredCardHedgeBridge({
      playerName: "Eric Hartman", number: "CPA-EHA",
    });
    expect(r).toBeNull();
  });

  it("narrows by year when multiple number matches", async () => {
    mockedSearch.mockResolvedValue([
      chCard({ card_id: "ch-2025", number: "CPA-EHA", year: 2025 }),
      chCard({ card_id: "ch-2026", number: "CPA-EHA", year: 2026 }),
    ]);
    const r = await structuredCardHedgeBridge({
      playerName: "Eric Hartman", number: "CPA-EHA", cardYear: 2026,
    });
    expect(r!.chCardId).toBe("ch-2026");
  });

  it("keeps number-only pool when year narrows to zero (soft constraint)", async () => {
    mockedSearch.mockResolvedValue([
      chCard({ card_id: "ch-2024", number: "CPA-EHA", year: 2024 }),
      chCard({ card_id: "ch-2025", number: "CPA-EHA", year: 2025 }),
    ]);
    const r = await structuredCardHedgeBridge({
      playerName: "Eric Hartman", number: "CPA-EHA", cardYear: 2026,  // no 2026 match
    });
    // Falls back to the number-only pool — picks first
    expect(r!.chCardId).toBe("ch-2024");
  });

  it("prefers candidate whose variant contains identity.parallel", async () => {
    mockedSearch.mockResolvedValue([
      chCard({ card_id: "ch-blue-xfractor", number: "CPA-EHA", variant: "Blue X-Fractor" }),
      chCard({ card_id: "ch-blue-refractor", number: "CPA-EHA", variant: "Blue Refractor" }),
      chCard({ card_id: "ch-refractor", number: "CPA-EHA", variant: "Refractor" }),
    ]);
    const r = await structuredCardHedgeBridge({
      playerName: "Eric Hartman", number: "CPA-EHA", parallel: "Blue Refractor",
    });
    expect(r!.chCardId).toBe("ch-blue-refractor");
  });
});

describe("structuredCardHedgeBridge — error resilience", () => {
  it("returns null when searchCards throws", async () => {
    mockedSearch.mockRejectedValue(new Error("network"));
    const r = await structuredCardHedgeBridge({
      playerName: "Eric Hartman", number: "CPA-EHA",
    });
    expect(r).toBeNull();
  });

  it("returns null on empty search result", async () => {
    mockedSearch.mockResolvedValue([]);
    const r = await structuredCardHedgeBridge({
      playerName: "Eric Hartman", number: "CPA-EHA",
    });
    expect(r).toBeNull();
  });
});
