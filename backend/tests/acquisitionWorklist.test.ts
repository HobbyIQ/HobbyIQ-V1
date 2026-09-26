/**
 * acquisitionWorklist.test.ts — pure-function coverage for
 * scripts/acquisition-worklist.cjs. No Cosmos, no network: every Cosmos-
 * shaped input (`io.pointReadById`, `io.getCellIndex`) is a plain in-memory
 * fake built from fixture rows, matching how gap2024-classify.cjs's own
 * classifyOne was exercised in prior-art runs.
 *
 * Covers: classification of each bucket (STALE / STALE-NO-ROW /
 * BACKED-DERIVED-ONLY / RUNG-MISSING / CARD-MISSING / NO-NUMBER),
 * aggregation keys, ranking/cumulative math, case-insensitive cardNumber
 * match (+ a mutation check proving that guard is load-bearing), namesAgree
 * gating, and URL-guess formatting.
 */
import { describe, it, expect } from "vitest";
import path from "path";

const mod = require(path.join(__dirname, "..", "scripts", "acquisition-worklist.cjs"));
const {
  extractInsertPrefix,
  indexCatalogCell,
  isBacked,
  rungLookup,
  classifyOne,
  aggregationKey,
  foldIntoAggregate,
  rankAggregate,
  guessSourceUrls,
  summarizeCell,
} = mod;

// A deps object with just enough real-shaped behavior to drive
// deriveIdentity/storedIdentity deterministically without loading dist/.
function makeDeps(overrides: Record<string, any> = {}) {
  return {
    parseListingIdentity: (title: string) => {
      const numMatch = title.match(/#([A-Za-z0-9-]+)/);
      const isAuto = /auto/i.test(title);
      const parallelMatch = title.match(/\b(Gold|Silver|Refractor|Base)\b/i);
      return {
        cardNumber: numMatch ? numMatch[1] : null,
        isAuto,
        parallel: parallelMatch ? parallelMatch[1] : null,
        parallelIsUnconfirmed: false,
        printRun: null,
      };
    },
    isCardNumberAutoSubset: () => false,
    scopedMarketLanguageAlias: () => null,
    inferSetKeyFromTitle: (_title: string, _num: string) => null,
    titleStatesSoccerCompetition: () => false,
    inferSportFromTitle: () => "baseball",
    ingestGradeFromTitle: () => ({ gradeCompany: null, gradeValue: null }),
    isMultiCardLot: () => false,
    normalizeSetKey: (s: string) => String(s || "").toLowerCase().replace(/\s+/g, "-"),
    computeHobbyIqCardId: (input: any) =>
      `hiq:${input.sport}:${input.year}:${String(input.setKey).toLowerCase()}:${input.cardNumber}:${input.parallel}:${input.isAuto ? "auto" : "raw"}`,
    applySiblingChecklistOverride: (setKey: string) => setKey,
    spellForEra: (setKey: string) => setKey,
    guardSlugInputs: (input: any) => ({ ok: true, sport: input.sport, reasons: [] }),
    normalizeSportStrict: (s: string) => s || "baseball",
    extractYearFromTitle: () => null,
    ...overrides,
  };
}

function makeIo(cellsByKey: Record<string, any[]>) {
  const byIdCache: Record<string, Map<string, any>> = {};
  const byNumberCache: Record<string, Map<string, any[]>> = {};
  for (const [key, rows] of Object.entries(cellsByKey)) {
    const byId = new Map();
    for (const r of rows) byId.set(r.id, r);
    byIdCache[key] = byId;
    byNumberCache[key] = indexCatalogCell(rows);
  }
  return {
    pointReadById(id: string | null) {
      if (!id) return null;
      const parts = String(id).split(":");
      const key = `${parts[2]}|${parts[3]}`;
      const byId = byIdCache[key];
      return byId ? byId.get(id) || null : null;
    },
    getCellIndex(year: number, setKey: string) {
      const key = `${year}|${setKey}`;
      return { rows: cellsByKey[key] || [], byNumber: byNumberCache[key] || new Map() };
    },
  };
}

describe("extractInsertPrefix", () => {
  it("extracts a leading letters-and-dash prefix", () => {
    expect(extractInsertPrefix("BP-12")).toBe("BP");
    expect(extractInsertPrefix("T90R-3")).toBe("T90R");
  });
  it("returns null for a bare numeric cardNumber (base, no insert prefix)", () => {
    expect(extractInsertPrefix("42")).toBeNull();
    expect(extractInsertPrefix("")).toBeNull();
  });
});

describe("isBacked", () => {
  it("is false for a null row", () => {
    expect(isBacked(null)).toBe(false);
  });
  it("is true when source is a known strict checklist source", () => {
    expect(isBacked({ source: "checklistinsider" })).toBe(true);
  });
  it("is false when source is a vendor-only source", () => {
    expect(isBacked({ source: "cardhedge", sourceSystem: "cardhedge" })).toBe(false);
  });
});

describe("case-insensitive cardNumber matching (rungLookup / indexCatalogCell)", () => {
  const catalogRows = [
    { id: "c1", cardNumber: "1A", isAuto: false, printRun: null, playerName: "Bobby Witt Jr.", source: "checklistinsider" },
  ];
  const index = indexCatalogCell(catalogRows);

  it("matches a lowercase sale cardNumber against an uppercase catalog cardNumber", () => {
    const hits = rungLookup(index, "1a", false, null, "Bobby Witt");
    expect(hits.length).toBe(1);
    expect(hits[0].row.id).toBe("c1");
  });

  it("matches regardless of catalog-side case too", () => {
    const hits = rungLookup(index, "1A", false, null, "Bobby Witt Jr.");
    expect(hits.length).toBe(1);
  });

  it("MUTATION CHECK: a case-SENSITIVE index must fail to find the same pair", () => {
    // Rebuild the index without normalizing case, simulating the mutation of
    // dropping norm() from indexCatalogCell -- proves the guard is load-
    // bearing, not incidental.
    const caseSensitiveByNumber = new Map<string, any[]>();
    for (const r of catalogRows) {
      const num = String(r.cardNumber || ""); // no .toLowerCase()
      if (!caseSensitiveByNumber.has(num)) caseSensitiveByNumber.set(num, []);
      caseSensitiveByNumber.get(num)!.push(r);
    }
    const hits = rungLookup(caseSensitiveByNumber, "1a", false, null, "Bobby Witt");
    expect(hits.length).toBe(0); // "1a" !== "1A" without normalization
  });
});

describe("namesAgree gating inside rungLookup", () => {
  const catalogRows = [
    { id: "c1", cardNumber: "5", isAuto: false, printRun: null, playerName: "Vladimir Guerrero Jr.", source: "checklistinsider" },
    { id: "c2", cardNumber: "5", isAuto: false, printRun: null, playerName: "Vladimir Guerrero Sr.", source: "checklistinsider" },
  ];
  const index = indexCatalogCell(catalogRows);

  it("agrees on Jr./Sr. presence-vs-absence but not Jr. vs Sr. disagreement", () => {
    const hits = rungLookup(index, "5", false, null, "Vladimir Guerrero");
    const c1 = hits.find((h) => h.row.id === "c1")!;
    const c2 = hits.find((h) => h.row.id === "c2")!;
    // "Vladimir Guerrero" (no suffix) agrees with EITHER a Jr. or Sr. row in
    // isolation (presence-vs-absence), per name-agreement.cjs rule (c).
    expect(c1.agree).toBe(true);
    expect(c2.agree).toBe(true);
  });

  it("refuses Jr. vs Sr. as a real disagreement", () => {
    const hits = rungLookup(index, "5", false, null, "Vladimir Guerrero Jr.");
    const c2 = hits.find((h) => h.row.id === "c2")!;
    expect(c2.agree).toBe(false); // Jr. (sale) vs Sr. (catalog) — different people
  });
});

describe("classifyOne buckets", () => {
  it("classifies STALE when the current derivation lands on a DIFFERENT id that IS backed", () => {
    const deps = makeDeps({
      inferSetKeyFromTitle: () => "topps-chrome",
    });
    const row = {
      id: "s1",
      title: "2024 Topps Chrome Baseball #5 Gold",
      hobbyiqCardId: "hiq:baseball:2024:topps:5:base:raw", // stored under a stale key
      cardYear: 2024,
      cardNumber: "5",
      playerName: "Julio Rodriguez",
    };
    const derivedId = "hiq:baseball:2024:topps-chrome:5:Gold:raw";
    const io = makeIo({
      "2024|topps-chrome": [{ id: derivedId, cardNumber: "5", isAuto: false, printRun: null, playerName: "Julio Rodriguez", source: "checklistinsider" }],
    });
    // Patch pointReadById to answer for the derived id shape exactly.
    const patchedIo = {
      ...io,
      pointReadById(id: string | null) {
        if (id === derivedId) return { id: derivedId, source: "checklistinsider", playerName: "Julio Rodriguez" };
        return null;
      },
    };
    const result = classifyOne(row, { sport: "baseball", year: 2024, setKey: "topps" }, deps, patchedIo);
    expect(result.name).toBe("STALE");
  });

  it("classifies STALE-NO-ROW when the derived id differs and has no row at all", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "topps-chrome" });
    const row = {
      id: "s2",
      title: "2024 Topps Chrome Baseball #7 Gold",
      hobbyiqCardId: "hiq:baseball:2024:topps:7:base:raw",
      cardYear: 2024,
      cardNumber: "7",
      playerName: "Elly De La Cruz",
    };
    const io = makeIo({ "2024|topps-chrome": [] });
    const result = classifyOne(row, { sport: "baseball", year: 2024, setKey: "topps" }, deps, io);
    expect(result.name).toBe("STALE-NO-ROW");
  });

  it("classifies BACKED-DERIVED-ONLY when the exact rung exists but wasn't point-read", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "topps" });
    const row = {
      id: "s3",
      title: "2024 Topps Baseball #10 Base",
      hobbyiqCardId: "hiq:baseball:2024:topps:10:Base:raw",
      cardYear: 2024,
      cardNumber: "10",
      playerName: "Corbin Carroll",
    };
    const io = makeIo({
      "2024|topps": [{ id: "cat10", cardNumber: "10", isAuto: false, printRun: null, playerName: "Corbin Carroll", source: "checklistinsider" }],
    });
    const result = classifyOne(row, { sport: "baseball", year: 2024, setKey: "topps" }, deps, io);
    expect(result.name).toBe("BACKED-DERIVED-ONLY");
  });

  it("classifies RUNG-MISSING when the number exists but not at this auto/printRun rung", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "topps" });
    const row = {
      id: "s4",
      title: "2024 Topps Baseball #11 auto",
      hobbyiqCardId: "hiq:baseball:2024:topps:11:Base:auto",
      cardYear: 2024,
      cardNumber: "11",
      playerName: "Jackson Holliday",
    };
    const io = makeIo({
      // catalog has #11 but only as a non-auto base card
      "2024|topps": [{ id: "cat11", cardNumber: "11", isAuto: false, printRun: null, playerName: "Jackson Holliday", source: "checklistinsider" }],
    });
    const result = classifyOne(row, { sport: "baseball", year: 2024, setKey: "topps" }, deps, io);
    expect(result.name).toBe("RUNG-MISSING");
  });

  it("classifies CARD-MISSING when no catalog row exists for that cardNumber at all", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "topps" });
    const row = {
      id: "s5",
      title: "2024 Topps Baseball #BP-3 Best of Topps",
      hobbyiqCardId: "hiq:baseball:2024:topps:BP-3:Base:raw",
      cardYear: 2024,
      cardNumber: "BP-3",
      playerName: "Gunnar Henderson",
    };
    const io = makeIo({ "2024|topps": [] });
    const result = classifyOne(row, { sport: "baseball", year: 2024, setKey: "topps" }, deps, io);
    expect(result.name).toBe("CARD-MISSING");
    expect(result.detail!.prefix).toBe("BP");
  });

  it("classifies NO-NUMBER when the title is blank (deriveIdentity refuses)", () => {
    const deps = makeDeps();
    const row = { id: "s6", title: "", hobbyiqCardId: null, cardYear: 2024, cardNumber: null, playerName: null };
    const io = makeIo({});
    const result = classifyOne(row, { sport: "baseball", year: 2024, setKey: "topps" }, deps, io);
    expect(result.name).toBe("NO-NUMBER");
  });
});

describe("aggregationKey", () => {
  it("is stable and case-normalized for sport/setKey, upper-cased prefix", () => {
    const k1 = aggregationKey("Baseball", 2024, "Topps", "bp", "Gold", true, "99");
    const k2 = aggregationKey("baseball", 2024, "topps", "BP", "Gold", true, "99");
    expect(k1).toBe(k2);
  });
  it("differs when any axis differs (isAuto)", () => {
    const k1 = aggregationKey("baseball", 2024, "topps", "bp", "Gold", true, null);
    const k2 = aggregationKey("baseball", 2024, "topps", "bp", "Gold", false, null);
    expect(k1).not.toBe(k2);
  });
});

describe("foldIntoAggregate", () => {
  it("only folds worklist-bound buckets, excludes STALE/NO-NUMBER/BACKED-DERIVED-ONLY", () => {
    const agg = new Map();
    foldIntoAggregate(agg, "baseball", 2024, { title: "t1" }, { name: "STALE", detail: {} });
    foldIntoAggregate(agg, "baseball", 2024, { title: "t2" }, { name: "NO-NUMBER", detail: {} });
    foldIntoAggregate(agg, "baseball", 2024, { title: "t3" }, { name: "BACKED-DERIVED-ONLY", detail: {} });
    expect(agg.size).toBe(0);
  });

  it("aggregates CARD-MISSING sales sharing a destination identity into one entry", () => {
    const agg = new Map();
    const detail1 = { identity: { setKey: "topps", parallel: "Base", isAuto: false, printRun: null }, cardNumber: "BP-1", prefix: "BP" };
    const detail2 = { identity: { setKey: "topps", parallel: "Base", isAuto: false, printRun: null }, cardNumber: "BP-2", prefix: "BP" };
    foldIntoAggregate(agg, "baseball", 2024, { title: "sale one" }, { name: "CARD-MISSING", detail: detail1 });
    foldIntoAggregate(agg, "baseball", 2024, { title: "sale two" }, { name: "CARD-MISSING", detail: detail2 });
    expect(agg.size).toBe(1);
    const entry = [...agg.values()][0];
    expect(entry.salesCount).toBe(2);
    expect(entry.cardNumbers.size).toBe(2);
    expect(entry.exampleTitles).toEqual(["sale one", "sale two"]);
  });
});

describe("rankAggregate / cumulative math", () => {
  it("ranks by salesCount descending and computes correct cumulative share", () => {
    const agg = new Map();
    agg.set("a", { sport: "baseball", year: 2024, setKey: "topps", prefix: "BP", parallel: "Base", isAuto: false, printRun: null, salesCount: 60, cardNumbers: new Set(["1", "2"]), exampleTitles: [], buckets: {} });
    agg.set("b", { sport: "baseball", year: 2024, setKey: "topps", prefix: "HA", parallel: "Base", isAuto: false, printRun: null, salesCount: 40, cardNumbers: new Set(["3"]), exampleTitles: [], buckets: {} });
    const ranked = rankAggregate(agg);
    expect(ranked[0].prefix).toBe("BP");
    expect(ranked[0].share).toBeCloseTo(0.6, 5);
    expect(ranked[0].cumulativeShare).toBeCloseTo(0.6, 5);
    expect(ranked[1].prefix).toBe("HA");
    expect(ranked[1].share).toBeCloseTo(0.4, 5);
    expect(ranked[1].cumulativeShare).toBeCloseTo(1.0, 5);
  });

  it("breaks ties by distinct cardNumber count, then setKey|prefix for determinism", () => {
    const agg = new Map();
    agg.set("a", { sport: "baseball", year: 2024, setKey: "topps", prefix: "ZZ", parallel: "Base", isAuto: false, printRun: null, salesCount: 10, cardNumbers: new Set(["1"]), exampleTitles: [], buckets: {} });
    agg.set("b", { sport: "baseball", year: 2024, setKey: "topps", prefix: "AA", parallel: "Base", isAuto: false, printRun: null, salesCount: 10, cardNumbers: new Set(["1", "2"]), exampleTitles: [], buckets: {} });
    const ranked = rankAggregate(agg);
    expect(ranked[0].prefix).toBe("AA"); // more distinct card numbers wins the tie
  });

  it("handles an empty aggregate without dividing by zero", () => {
    const ranked = rankAggregate(new Map());
    expect(ranked).toEqual([]);
  });
});

describe("guessSourceUrls", () => {
  it("formats checklistinsider, baseballcardpedia, and cardboardconnection URLs for baseball, all marked as guesses", () => {
    const urls = guessSourceUrls("baseball", 2025, "bowman-chrome");
    const byName = Object.fromEntries(urls.map((u: any) => [u.source, u]));
    expect(byName.checklistinsider.url).toBe("https://www.checklistinsider.com/2025-bowman-chrome-baseball-checklist");
    expect(byName.baseballcardpedia.url).toBe("https://www.baseballcardpedia.com/index.php/2025_Bowman_Chrome");
    expect(byName.cardboardconnection.url).toBe("https://www.cardboardconnection.com/2025-bowman-chrome-baseball-cards");
    for (const u of urls) expect(u.guess).toBe(true);
  });

  it("omits baseballcardpedia for a non-baseball sport", () => {
    const urls = guessSourceUrls("football", 2025, "panini-prizm");
    expect(urls.find((u: any) => u.source === "baseballcardpedia")).toBeUndefined();
  });
});

describe("summarizeCell", () => {
  it("separates the rematch lever (STALE-with-row) from the acquisition lever", () => {
    const stats = {
      scanned: 1000,
      sampled: 500,
      unbacked: 500,
      staleWithRowCount: 120,
      buckets: { "STALE-NO-ROW": 200, "CARD-MISSING": 100, "RUNG-MISSING": 80 },
      totalPopulationHint: 5000,
    };
    const summary = summarizeCell(stats);
    expect(summary.sampledFraction).toBeCloseTo(0.1, 5);
    expect(summary.rematchVsAcquisitionSplit.rematch).toBe(120);
    expect(summary.rematchVsAcquisitionSplit.acquisition).toBe(380);
    expect(summary.bucketShares["STALE-NO-ROW"]).toBeCloseTo(200 / 380, 5);
  });
});
