// CF-CATALOG-PRODUCT-FAMILY-FALLBACK (Drew, 2026-07-14): pins the
// product-family ladder walk in referenceCatalogLookup. Real-world data
// nests "Bowman Chrome" under `product: "Bowman"` (2026-07-14 probe on
// Drew's 36 holdings: 0/34 chrome-family holdings verified against the
// catalog before this fix because slug("Bowman Chrome") = "bowman-chrome"
// which has no rows for 2026). Ladder walk recovers those matches.

import { describe, it, expect, vi, beforeEach } from "vitest";

const listParallelsByProductYearMock = vi.fn();
vi.mock("../src/repositories/referenceCatalog.repository.js", () => ({
  listParallelsByProductYear: (...args: unknown[]) =>
    listParallelsByProductYearMock(...args),
}));

async function load() {
  const mod = await import("../src/services/compiq/referenceCatalogLookup");
  mod._resetReferenceCatalogCacheForTest();
  return mod;
}

const doc = (o: Partial<Record<string, unknown>> = {}) => ({
  id: "id", docType: "parallel" as const,
  productKey: "bowman", product: "Bowman", year: 2026,
  cardSetKey: "chrome-prospect-autographs", cardSet: "Chrome Prospect Autographs",
  parallelKey: "green-refractor", parallel: "Green Refractor",
  printRun: 99, numbered: true, runVaries: false, perCardRun: false,
  auto: true, licensed: true, confidence: "Verified" as const,
  notes: "", sourceUrl: null, schemaVersion: 1 as const,
  updatedAt: "2026-07-14T00:00:00.000Z",
  ...o,
});

beforeEach(() => {
  listParallelsByProductYearMock.mockReset();
  process.env.COMPIQ_REFERENCE_CATALOG_ENABLED = "true";
});

describe("productFamilyLadder walk — bowman-chrome → bowman fallback", () => {
  it("misses bowman-chrome, hits bowman flagship on ladder walk", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "bowman-chrome") return [];      // empty bucket
      if (pk === "bowman") return [doc()];         // real data here
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Bowman Chrome", 2026, "Green Refractor", { isAuto: true },
    );
    expect(r).not.toBeNull();
    expect(r?.printRun).toBe(99);
    expect(r?.product).toBe("Bowman");   // canonical form from fallback bucket
  });

  it("exact match takes precedence when bowman-chrome bucket has data", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "bowman-chrome") return [doc({
        productKey: "bowman-chrome", product: "Bowman Chrome", printRun: 150,
      })];
      if (pk === "bowman") return [doc({ printRun: 999 })];   // shouldn't reach here
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Bowman Chrome", 2026, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(150);
    expect(r?.product).toBe("Bowman Chrome");
    // bowman flagship never queried
    const calls = listParallelsByProductYearMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("bowman-chrome");
    expect(calls).not.toContain("bowman");
  });

  it("bowman-draft-chrome walks: bowman-draft-chrome → bowman-draft → bowman", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "bowman-draft") return [doc({
        productKey: "bowman-draft", product: "Bowman Draft", printRun: 250,
      })];
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Bowman Draft Chrome", 2026, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(250);
    expect(r?.product).toBe("Bowman Draft");
    // ladder should be [bowman-draft-chrome, bowman-draft, bowman]
    const calls = listParallelsByProductYearMock.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe("bowman-draft-chrome");
    expect(calls).toContain("bowman-draft");
  });

  it("bowman-sterling walks straight to bowman when sterling has no data", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "bowman") return [doc({ printRun: 199 })];
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Bowman Sterling", 2026, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(199);
  });

  it("topps-chrome-update walks: → topps-chrome → topps", async () => {
    // Only topps-chrome (parent) has data
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "topps-chrome") return [doc({
        productKey: "topps-chrome", product: "Topps Chrome", printRun: 99,
      })];
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Topps Chrome Update", 2026, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(99);
    expect(r?.product).toBe("Topps Chrome");
  });

  // CF-FAMILY-LADDER-BRAND-ROOT (Drew, 2026-07-29). Previously the
  // ladder only walked bowman-* and topps-* families. Extended so
  // every brand's subsets nest under the company parent (Panini Prizm
  // Football → Panini Prizm → Panini; Fleer Stickers → Fleer). This
  // test used to pin the old restrictive behavior; flipped to pin the
  // new expected walk.
  it("panini-prizm-football walks: → panini-prizm → panini (all brands walk)", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "panini") return [doc({
        productKey: "panini", product: "Panini", printRun: 199,
      })];
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Panini Prizm Football", 2024, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(199);
    const calls = listParallelsByProductYearMock.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBe("panini-prizm-football");
    expect(calls).toContain("panini-prizm");
    expect(calls).toContain("panini");
  });

  // CF-FAMILY-LADDER-BRAND-ROOT — expanded coverage
  it("fleer-stickers walks to fleer (Fleer is its own company parent)", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "fleer") return [doc({
        productKey: "fleer", product: "Fleer", printRun: 100,
      })];
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Fleer Stickers", 1986, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(100);
    const calls = listParallelsByProductYearMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("fleer-stickers");
    expect(calls).toContain("fleer");
  });

  it("topps-heritage walks to topps (heritage is a Topps subset)", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "topps") return [doc({ product: "Topps", printRun: 50 })];
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Topps Heritage", 2026, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(50);
    const calls = listParallelsByProductYearMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("topps-heritage");
    expect(calls).toContain("topps");
  });

  it("bowman-chrome-draft walks: → bowman-chrome → bowman (previously missed the -chrome intermediate)", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "bowman-chrome") return [doc({
        productKey: "bowman-chrome", product: "Bowman Chrome", printRun: 150,
      })];
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Bowman Chrome Draft", 2026, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(150);
    expect(r?.product).toBe("Bowman Chrome");
    const calls = listParallelsByProductYearMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("bowman-chrome-draft");
    expect(calls).toContain("bowman-chrome");
  });

  it("bowman-chrome-sapphire walks: → bowman-chrome → bowman", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "bowman-chrome") return [doc({ product: "Bowman Chrome", printRun: 199 })];
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Bowman Chrome Sapphire", 2026, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(199);
    const calls = listParallelsByProductYearMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("bowman-chrome-sapphire");
    expect(calls).toContain("bowman-chrome");
  });

  it("bowman-draft-paper walks: → bowman-draft → bowman", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "bowman-draft") return [doc({ product: "Bowman Draft", printRun: 75 })];
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Bowman Draft Paper", 2026, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(75);
    const calls = listParallelsByProductYearMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("bowman-draft-paper");
    expect(calls).toContain("bowman-draft");
  });

  it("bowman-paper walks straight to bowman", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "bowman") return [doc({ product: "Bowman", printRun: 499 })];
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Bowman Paper", 2026, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(499);
  });

  it("bare 'prizm' setKey (orphan, no brand prefix) walks to panini via subset-to-brand fallback", async () => {
    listParallelsByProductYearMock.mockImplementation(async (pk: string) => {
      if (pk === "panini") return [doc({ product: "Panini", printRun: 25 })];
      return [];
    });
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Prizm", 2024, "Green Refractor", { isAuto: true },
    );
    expect(r?.printRun).toBe(25);
    const calls = listParallelsByProductYearMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("prizm");
    expect(calls).toContain("panini");
  });

  it("upper-deck (multi-segment brand) does NOT get split into upper→deck", async () => {
    // Regression guard: upper-deck is one company. The peel loop would
    // normally walk upper-deck → upper, but KNOWN_BRAND_ROOTS contains
    // "upper-deck" so we terminate there.
    listParallelsByProductYearMock.mockResolvedValue([]);
    const { inferPrintRunFromReferenceCatalog } = await load();
    await inferPrintRunFromReferenceCatalog(
      "Upper Deck", 2000, "Base", { isAuto: false },
    );
    const calls = listParallelsByProductYearMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("upper-deck");
    expect(calls).not.toContain("upper");
  });

  it("miss on the whole ladder returns null cleanly", async () => {
    listParallelsByProductYearMock.mockResolvedValue([]);
    const { inferPrintRunFromReferenceCatalog } = await load();
    const r = await inferPrintRunFromReferenceCatalog(
      "Bowman Chrome", 2026, "Nonexistent Parallel", { isAuto: true },
    );
    expect(r).toBeNull();
  });
});
