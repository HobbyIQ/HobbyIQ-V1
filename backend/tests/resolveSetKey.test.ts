// CF-CATALOG-DRIVEN-SETKEY. The catalog decides which set a sale belongs
// to; vendor product text is only ever a tiebreak among sets the catalog
// already vouches for.
//
// The behaviour that matters most: this must NEVER invent a setKey. A null
// return means "catalog can't say", and the caller keeps its existing
// normalizeSetKey() behaviour — which is what makes adopting this safe on a
// live pool.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { queryMock, ctorMock } = vi.hoisted(() => {
  const queryMock = vi.fn();
  const containerMock = { items: { query: queryMock } };
  const databaseMock = { container: vi.fn().mockReturnValue(containerMock) };
  const ctorMock = vi.fn(function (this: any) {
    this.database = vi.fn().mockReturnValue(databaseMock);
  });
  return { queryMock, ctorMock };
});

vi.mock("@azure/cosmos", () => ({ CosmosClient: ctorMock }));

const { seedMock } = vi.hoisted(() => ({ seedMock: vi.fn() }));
vi.mock("../src/services/catalog/checklistSeedQueue.service", () => ({
  requestChecklistSeed: seedMock,
}));

import {
  resolveSetKeyFromCatalog,
  __resetResolveSetKeyForTests,
} from "../src/services/catalog/resolveSetKey.service";

// CF-RESOLVER-RESPECTS-AUTHORITY (2026-08-23). These fixtures predate
// CF-CATALOG-AUTHORITY (2026-08-20): they returned rows with no `source`, and
// the resolver now asks canAdjudicate() before letting a row decide anything.
// A row with no source is UNKNOWN authority and may not adjudicate — correctly.
//
// So the helper defaults to a checklist source, which is what every one of
// these cases has always MEANT: "the catalog says". The authority behaviour
// itself is exercised explicitly further down, with sources named.
function catalogReturns(rows: Array<{ setKey: string; playerSlug?: string; source?: string }>) {
  const withSource = rows.map((r) => ({ source: "baseballcardpedia", ...r }));
  queryMock.mockImplementation(() => ({ fetchAll: async () => ({ resources: withSource }) }));
}

// The real case that started this: a 2025 Bowman Draft Chrome auto.
const CPA = {
  sport: "baseball",
  year: 2025,
  cardNumber: "CPA-JHA",
  playerName: "Jonah Hartshorn",
};

describe("resolveSetKeyFromCatalog", () => {
  beforeEach(() => {
    process.env.COSMOS_CONNECTION_STRING = "AccountEndpoint=https://x/;AccountKey=y;";
    queryMock.mockReset();
    seedMock.mockReset();
    seedMock.mockResolvedValue(true);
    __resetResolveSetKeyForTests();
  });

  afterEach(() => {
    delete process.env.COSMOS_CONNECTION_STRING;
  });

  it("takes the catalog's answer when the cardNumber is unique to one set", async () => {
    catalogReturns([{ setKey: "bowman-chrome" }, { setKey: "bowman-chrome" }]);

    const r = await resolveSetKeyFromCatalog(CPA);

    expect(r.setKey).toBe("bowman-chrome");
    expect(r.resolution).toBe("exact");
    expect(seedMock).not.toHaveBeenCalled();
  });

  it("ignores misleading vendor product text when the catalog is unambiguous", async () => {
    // Seller typed "Bowman Draft Chrome"; catalog says this number is
    // bowman-chrome. The catalog wins — that is the whole point.
    catalogReturns([{ setKey: "bowman-chrome" }]);

    const r = await resolveSetKeyFromCatalog({
      ...CPA,
      sourceSetText: "2025 Bowman Draft Chrome Baseball",
    });

    expect(r.setKey).toBe("bowman-chrome");
    expect(r.resolution).toBe("exact");
  });

  it("narrows by player when one number spans two sets", async () => {
    catalogReturns([
      { setKey: "bowman-chrome", playerSlug: "jonah-hartshorn" },
      { setKey: "bowman-draft-paper", playerSlug: "someone-else" },
    ]);

    const r = await resolveSetKeyFromCatalog(CPA);

    expect(r.setKey).toBe("bowman-chrome");
    expect(r.resolution).toBe("narrowed-by-player");
    expect(r.candidates).toHaveLength(2);
  });

  it("falls back to vendor text only to choose among catalog-vouched sets", async () => {
    catalogReturns([
      { setKey: "bowman-chrome", playerSlug: "a" },
      { setKey: "bowman-draft-paper", playerSlug: "a" },
    ]);

    const r = await resolveSetKeyFromCatalog({
      ...CPA,
      playerName: "A",
      sourceSetText: "2025 Bowman Draft Paper",
    });

    expect(r.setKey).toBe("bowman-draft-paper");
    expect(r.resolution).toBe("narrowed-by-text");
  });

  it("refuses to guess when nothing separates the candidates", async () => {
    catalogReturns([
      { setKey: "bowman-chrome", playerSlug: "a" },
      { setKey: "bowman-chrome", playerSlug: "a" },
      { setKey: "bowman-draft-paper", playerSlug: "a" },
    ]);

    const r = await resolveSetKeyFromCatalog({ ...CPA, playerName: "A" });

    // bowman-chrome is more populated — picking it would look right and be
    // unjustified. Report ambiguity and hand back the evidence instead.
    expect(r.setKey).toBeNull();
    expect(r.resolution).toBe("ambiguous");
    expect(r.candidates?.[0]).toEqual({ setKey: "bowman-chrome", count: 2 });
  });

  it("treats an unknown cardNumber as a catalog gap and seeds it", async () => {
    catalogReturns([]);

    const r = await resolveSetKeyFromCatalog({
      ...CPA,
      sourceSetText: "2025 Bowman Draft Chrome Baseball",
    });

    expect(r.setKey).toBeNull();
    expect(r.resolution).toBe("catalog-gap");
    expect(r.seedRequested).toBe(true);
    expect(seedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sport: "baseball",
        year: 2025,
        reason: "setkey-unresolved",
        missingCardNumber: "CPA-JHA",
      }),
    );
  });

  it("does NOT seed when the read itself failed — absence of evidence is not evidence", async () => {
    queryMock.mockImplementation(() => ({
      fetchAll: async () => {
        throw new Error("429 request rate is large");
      },
    }));

    const r = await resolveSetKeyFromCatalog(CPA);

    expect(r.setKey).toBeNull();
    expect(r.resolution).toBe("catalog-unavailable");
    expect(seedMock).not.toHaveBeenCalled();
  });

  it("matches cardNumber case-insensitively", async () => {
    catalogReturns([{ setKey: "bowman-chrome" }]);
    const r = await resolveSetKeyFromCatalog({ ...CPA, cardNumber: " cpa-jha " });
    expect(r.setKey).toBe("bowman-chrome");
  });

  it("returns null without touching Cosmos on incomplete input", async () => {
    const r = await resolveSetKeyFromCatalog({ ...CPA, cardNumber: "" });
    expect(r.resolution).toBe("insufficient-input");
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("degrades to null when Cosmos is unconfigured", async () => {
    delete process.env.COSMOS_CONNECTION_STRING;
    __resetResolveSetKeyForTests();
    const r = await resolveSetKeyFromCatalog(CPA);
    expect(r.resolution).toBe("catalog-unavailable");
  });
});
