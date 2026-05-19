/**
 * Unit tests for cardsight.mapper.ts
 *
 * cardsight.client.ts is fully mocked via vi.mock so no HTTP calls are made.
 * Each test case exercises the mapping logic: release dictionary lookup,
 * set name disambiguation, parallel resolution, confidence levels.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { resolveCardId } from "../src/services/compiq/cardsight.mapper.js";

// ─── Mock cardsight.client ────────────────────────────────────────────────────

vi.mock("../src/services/compiq/cardsight.client.js", () => ({
  searchCatalog: vi.fn(),
  getCardDetail: vi.fn(),
}));

import { searchCatalog, getCardDetail } from "../src/services/compiq/cardsight.client.js";

const mockSearchCatalog = vi.mocked(searchCatalog);
const mockGetCardDetail = vi.mocked(getCardDetail);

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OHTANI_CHROME = {
  id: "cs-ohtani-chrome-2018",
  name: "Shohei Ohtani",
  number: "700",
  releaseName: "Topps Chrome",
  setName: "Base Set",
  year: 2018,
};

const OHTANI_CHROME_UPDATE = {
  id: "cs-ohtani-update-2018",
  name: "Shohei Ohtani",
  number: "US1",
  releaseName: "Topps Chrome Update",
  setName: "Base Set",
  year: 2018,
};

const BOWMAN_PROSPECT_AUTO = {
  id: "cs-bowman-cpa-rodriguez",
  name: "Julio Rodriguez",
  number: "CPA-JR",
  releaseName: "Bowman Draft Chrome",
  setName: "Chrome Prospect Autograph",
  year: 2020,
};

const OHTANI_DETAIL_WITH_PARALLELS = {
  id: "cs-ohtani-chrome-2018",
  name: "Shohei Ohtani",
  number: "700",
  releaseName: "Topps Chrome",
  setName: "Base Set",
  year: 2018,
  parallels: [
    { id: "par-refractor", name: "Refractor" },
    { id: "par-blue-raywave", name: "Blue RayWave Refractor", numberedTo: 150 },
    { id: "par-gold", name: "Gold Refractor", numberedTo: 50 },
  ],
  notFound: false,
};

// ─── Test Setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Release Dictionary Mapping ───────────────────────────────────────────────

describe("resolveCardId — release dictionary mapping", () => {
  it("maps 'Topps Chrome' correctly and searches with Cardsight name", async () => {
    mockSearchCatalog.mockResolvedValue([OHTANI_CHROME]);
    await resolveCardId({ playerName: "Shohei Ohtani", cardYear: 2018, product: "Topps Chrome" });
    expect(mockSearchCatalog).toHaveBeenCalledWith(
      "Shohei Ohtani Topps Chrome",
      expect.objectContaining({ year: 2018 }),
    );
  });

  it("maps 'Bowman Chrome' to 'Bowman Draft Chrome' in the search query", async () => {
    mockSearchCatalog.mockResolvedValue([BOWMAN_PROSPECT_AUTO]);
    await resolveCardId({ playerName: "Julio Rodriguez", cardYear: 2020, product: "Bowman Chrome" });
    expect(mockSearchCatalog).toHaveBeenCalledWith(
      "Julio Rodriguez Bowman Draft Chrome",
      expect.anything(),
    );
  });

  it("maps 'Bowman Draft' correctly", async () => {
    mockSearchCatalog.mockResolvedValue([BOWMAN_PROSPECT_AUTO]);
    await resolveCardId({ playerName: "Julio Rodriguez", cardYear: 2020, product: "Bowman Draft" });
    expect(mockSearchCatalog).toHaveBeenCalledWith(
      "Julio Rodriguez Bowman Draft",
      expect.anything(),
    );
  });

  it("maps 'Panini Prizm' correctly", async () => {
    mockSearchCatalog.mockResolvedValue([]);
    await resolveCardId({ playerName: "Ronald Acuna", cardYear: 2019, product: "Panini Prizm" });
    expect(mockSearchCatalog).toHaveBeenCalledWith(
      "Ronald Acuna Panini Prizm",
      expect.anything(),
    );
  });

  it("searches by player name only when product is unknown, warns about missing dictionary entry", async () => {
    mockSearchCatalog.mockResolvedValue([OHTANI_CHROME]);
    const result = await resolveCardId({ playerName: "Shohei Ohtani", product: "Unknown Set XYZ" });
    expect(mockSearchCatalog).toHaveBeenCalledWith("Shohei Ohtani", expect.anything());
    expect(result.warnings.some((w) => w.includes("not in Cardsight release dictionary"))).toBe(true);
  });
});

// ─── Confidence Levels ────────────────────────────────────────────────────────

describe("resolveCardId — matchConfidence", () => {
  it('returns "exact" confidence for a single unambiguous match', async () => {
    mockSearchCatalog.mockResolvedValue([OHTANI_CHROME]);
    const result = await resolveCardId({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome",
    });
    expect(result.cardId).toBe("cs-ohtani-chrome-2018");
    expect(result.matchConfidence).toBe("exact");
    expect(result.warnings).toHaveLength(0);
  });

  it('returns "likely" confidence when multiple candidates returned', async () => {
    mockSearchCatalog.mockResolvedValue([OHTANI_CHROME, OHTANI_CHROME_UPDATE]);
    const result = await resolveCardId({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
    });
    expect(result.matchConfidence).toBe("likely");
    expect(result.cardId).toBe("cs-ohtani-chrome-2018"); // top-ranked
    expect(result.warnings.some((w) => w.includes("candidates"))).toBe(true);
  });

  it('returns "none" confidence and cardId=null when no results', async () => {
    mockSearchCatalog.mockResolvedValue([]);
    const result = await resolveCardId({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome",
    });
    expect(result.matchConfidence).toBe("none");
    expect(result.cardId).toBeNull();
    expect(result.parallelId).toBeNull();
    expect(result.warnings.some((w) => w.includes("No Cardsight catalog results"))).toBe(true);
  });
});

// ─── Disambiguation (Chrome vs Chrome Update) ─────────────────────────────────

describe("resolveCardId — release name disambiguation", () => {
  it("filters to Topps Chrome Update when releaseName matches exactly", async () => {
    mockSearchCatalog.mockResolvedValue([OHTANI_CHROME, OHTANI_CHROME_UPDATE]);
    const result = await resolveCardId({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome Update",
    });
    // After release name filter, only Update card remains → single exact match
    expect(result.cardId).toBe("cs-ohtani-update-2018");
  });
});

// ─── Parallel Resolution ──────────────────────────────────────────────────────

describe("resolveCardId — parallel resolution", () => {
  it("resolves parallelId when parallel name matches exactly (case-insensitive)", async () => {
    mockSearchCatalog.mockResolvedValue([OHTANI_CHROME]);
    mockGetCardDetail.mockResolvedValue(OHTANI_DETAIL_WITH_PARALLELS);
    const result = await resolveCardId({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome",
      parallel: "Refractor",
    });
    expect(result.cardId).toBe("cs-ohtani-chrome-2018");
    expect(result.parallelId).toBe("par-refractor");
    expect(result.matchConfidence).toBe("exact");
  });

  it("resolves 'Blue Raywave' (input) against 'Blue RayWave Refractor' (Cardsight) via suffix tolerance", async () => {
    mockSearchCatalog.mockResolvedValue([OHTANI_CHROME]);
    mockGetCardDetail.mockResolvedValue(OHTANI_DETAIL_WITH_PARALLELS);
    const result = await resolveCardId({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome",
      parallel: "Blue Raywave",
    });
    expect(result.parallelId).toBe("par-blue-raywave");
    expect(result.warnings).toHaveLength(0);
  });

  it("returns cardId only with a warning when parallel is not found", async () => {
    mockSearchCatalog.mockResolvedValue([OHTANI_CHROME]);
    mockGetCardDetail.mockResolvedValue(OHTANI_DETAIL_WITH_PARALLELS);
    const result = await resolveCardId({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome",
      parallel: "Purple Prizm",
    });
    expect(result.cardId).toBe("cs-ohtani-chrome-2018");
    expect(result.parallelId).toBeNull();
    expect(result.warnings.some((w) => w.includes("not found among"))).toBe(true);
  });

  it("does not call getCardDetail when no parallel is requested", async () => {
    mockSearchCatalog.mockResolvedValue([OHTANI_CHROME]);
    await resolveCardId({ playerName: "Shohei Ohtani", cardYear: 2018, product: "Topps Chrome" });
    expect(mockGetCardDetail).not.toHaveBeenCalled();
  });

  it("returns cardId=null when detail returns notFound sentinel during parallel resolution", async () => {
    mockSearchCatalog.mockResolvedValue([OHTANI_CHROME]);
    mockGetCardDetail.mockResolvedValue({
      id: "cs-ohtani-chrome-2018",
      name: "",
      number: "",
      releaseName: "",
      setName: "",
      year: 0,
      parallels: [],
      notFound: true,
    });
    const result = await resolveCardId({
      playerName: "Shohei Ohtani",
      cardYear: 2018,
      product: "Topps Chrome",
      parallel: "Refractor",
    });
    expect(result.cardId).toBe("cs-ohtani-chrome-2018");
    expect(result.parallelId).toBeNull();
    expect(result.warnings.some((w) => w.includes("Could not load card detail"))).toBe(true);
  });
});

// ─── Bowman Chrome Prospect Auto ──────────────────────────────────────────────

describe("resolveCardId — Bowman Chrome Prospect Auto", () => {
  it("resolves a Bowman Chrome Prospect Autograph card and returns correct cardId", async () => {
    mockSearchCatalog.mockResolvedValue([BOWMAN_PROSPECT_AUTO]);
    const result = await resolveCardId({
      playerName: "Julio Rodriguez",
      cardYear: 2020,
      product: "Bowman Draft Chrome",
    });
    expect(result.cardId).toBe("cs-bowman-cpa-rodriguez");
    expect(result.matchConfidence).toBe("exact");
  });
});
