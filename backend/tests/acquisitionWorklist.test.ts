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
  resolveDefectOrAcquire,
  classifyOne,
  ACQUIRE_CLASSIFICATION,
  aggregationKey,
  foldIntoAggregate,
  rankAggregate,
  rankWithinClassification,
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

// `siblingTables` lets a test declare which sibling-key helpers "find"
// something -- omitting a table means that helper returns nothing, exactly
// like a real deploy where the vocabulary hasn't been taught a sibling yet
// (the shape the mutation test below exploits: DELETE the tables and a
// KEY-DEFECT fixture must flip to ACQUIRE).
function makeIo(
  cellsByKey: Record<string, any[]>,
  siblingTables: {
    resolveSetKeyForSlug?: (sport: string, setName: string, year: number) => string | null;
    productAncestry?: (setKey: string) => string[];
    productRefinementsOf?: (setKey: string) => string[];
    siblingSetKeysToAlsoCheck?: (setKey: string, year: number) => string[];
    crossSetKeyProbe?: () => any[];
  } = {},
) {
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
    isBacked,
    resolveSetKeyForSlug: siblingTables.resolveSetKeyForSlug,
    productAncestry: siblingTables.productAncestry,
    productRefinementsOf: siblingTables.productRefinementsOf,
    siblingSetKeysToAlsoCheck: siblingTables.siblingSetKeysToAlsoCheck,
    crossSetKeyProbe: siblingTables.crossSetKeyProbe,
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

describe("classifyOne takes the destination from der.slug, not identity.setKey (coordinator follow-up, 2026-09-26)", () => {
  // Reproduces the coordinator's exact root-cause report: deriveIdentity's
  // returned `identity.setKey` is built from spellForEra+
  // applySiblingChecklistOverride ONLY, while `der.slug` is built by
  // computeHobbyIqCardId, which ALSO runs resolveSetKeyForSlug -- the one
  // seam where an R75-shaped redirect (2026+, bare "Bowman Mega Box" ->
  // the DISTINCT `bowman-mega` product) actually fires. So for this one
  // title, identity.setKey stays "bowman-chrome-mega-box" while der.slug's
  // OWN setKey segment reads "bowman-mega" -- the two disagree by
  // construction, exactly reproducing the live defect. The real slug format
  // (7-9 parts, "auto"/"no-auto" literal, `parseHobbyIqCardId`'s own
  // contract) is used here so this test exercises the ACTUAL parser
  // contract, not a shorthand.
  function makeSlugAwareDeps(overrides: Record<string, any> = {}) {
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
      inferSetKeyFromTitle: () => "bowman-chrome-mega-box",
      titleStatesSoccerCompetition: () => false,
      inferSportFromTitle: () => "baseball",
      ingestGradeFromTitle: () => ({ gradeCompany: null, gradeValue: null }),
      isMultiCardLot: () => false,
      normalizeSetKey: (s: string) => String(s || "").toLowerCase().replace(/\s+/g, "-"),
      // identity.setKey's own path: NEVER redirected to bowman-mega -- the
      // exact defect shape (spellForEra/applySiblingChecklistOverride never
      // see the raw setName text or apply R75).
      applySiblingChecklistOverride: (setKey: string) => setKey,
      spellForEra: (setKey: string) => setKey,
      // der.slug's own path: computeHobbyIqCardId DOES apply the R75
      // redirect (mirroring resolveSetKeyForSlug being called from inside
      // it in production), producing the REAL 7-part slug shape
      // parseHobbyIqCardId expects: hiq:sport:year:setKey:cardNumber:
      // parallelSlug:auto|no-auto[:num-N].
      computeHobbyIqCardId: (input: any) => {
        // Mirrors production's resolveSetKeyForSlug redirect: bare Mega Box,
        // 2026+, no "chrome" in setKey -> the distinct `bowman-mega` product.
        const isBareMegaBoxFrom2026 = input.setKey === "bowman-chrome-mega-box" && Number(input.year) >= 2026;
        const redirectedSetKey = isBareMegaBoxFrom2026 ? "bowman-mega" : String(input.setKey).toLowerCase();
        const parallelSlug = String(input.parallel || "Base").toLowerCase().replace(/\s+/g, "-");
        return `hiq:${input.sport}:${input.year}:${redirectedSetKey}:${String(input.cardNumber).toLowerCase()}:${parallelSlug}:${input.isAuto ? "auto" : "no-auto"}`;
      },
      guardSlugInputs: (input: any) => ({ ok: true, sport: input.sport, reasons: [] }),
      normalizeSportStrict: (s: string) => s || "baseball",
      extractYearFromTitle: () => null,
      // The real grade/subset-aware parser's contract, reimplemented exactly
      // (not a naive split) so this test exercises the same shape
      // classifyOne's own production deps.parseHobbyIqCardId does.
      parseHobbyIqCardId: (hiqId: string) => {
        if (typeof hiqId !== "string" || !hiqId.startsWith("hiq:")) return null;
        const parts = hiqId.split(":");
        if (parts.length < 7 || parts.length > 9) return null;
        const [, sport, yearStr, setKey] = parts;
        let rest = parts.slice(4);
        let subsetSlug: string | null = null;
        if (rest.length && rest[0].startsWith("sub-")) {
          subsetSlug = rest[0].slice("sub-".length);
          rest = rest.slice(1);
        }
        if (rest.length !== 3 && rest.length !== 4) return null;
        const [cardNumber, parallelSlug, autoFlag, printRunPart] = rest;
        if (autoFlag !== "auto" && autoFlag !== "no-auto") return null;
        let printRun: number | null = null;
        if (printRunPart) {
          if (!printRunPart.startsWith("num-")) return null;
          printRun = Number(printRunPart.slice(4));
        }
        return {
          sport, year: Number(yearStr), setKey, cardNumber, parallel: parallelSlug,
          isAuto: autoFlag === "auto", printRun,
          ...(subsetSlug ? { subsetName: subsetSlug, subsetInId: true } : {}),
        };
      },
      ...overrides,
    };
  }

  it("uses der.slug's setKey (bowman-mega), NOT identity.setKey (bowman-chrome-mega-box), as the destination", () => {
    const deps = makeSlugAwareDeps();
    const row = {
      id: "s-slug-wins",
      title: "2026 Bowman Mega Box Baseball #52 Base",
      hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-mega-box:52:base:no-auto", // stored under the OLD/wrong key
      cardYear: 2026,
      cardNumber: "52",
      playerName: "Shohei Ohtani",
    };
    const io = {
      pointReadById(id: string | null) {
        // Row exists, backed, at the SLUG's destination (bowman-mega) --
        // never at identity.setKey's (bowman-chrome-mega-box).
        if (id === "hiq:baseball:2026:bowman-mega:52:base:no-auto") {
          return { id, source: "checklistinsider", playerName: "Shohei Ohtani" };
        }
        return null;
      },
      getCellIndex() { return { rows: [], byNumber: new Map() }; },
      isBacked,
    };
    const result = classifyOne(row, { sport: "baseball", year: 2026, setKey: "bowman-chrome-mega-box" }, deps, io);
    // The stored slug (bowman-chrome-mega-box) differs from der.slug
    // (bowman-mega, because computeHobbyIqCardId applied the redirect) --
    // and der.slug IS backed, so this must resolve STALE (rematch's job:
    // repoint this stored row to the slug's own destination), never a
    // fresh CARD-MISSING/ACQUIRE against the wrong (identity.setKey) product.
    expect(result.name).toBe("STALE");
    expect(result.detail!.to).toBe("hiq:baseball:2026:bowman-mega:52:base:no-auto");
  });

  it("when the slug's destination has NO row either, STALE-NO-ROW's own identity carries setKey from the SLUG (bowman-mega), not identity.setKey", () => {
    const deps = makeSlugAwareDeps();
    const row = {
      id: "s-slug-wins-2",
      title: "2026 Bowman Mega Box Baseball #53 Base",
      hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-mega-box:53:base:no-auto",
      cardYear: 2026,
      cardNumber: "53",
      playerName: "Someone Rookie",
    };
    const io = {
      pointReadById() { return null; }, // nothing backed anywhere
      getCellIndex(year: number, setKey: string) {
        if (setKey === "bowman-mega") {
          // The card genuinely IS absent even at the correct destination --
          // this is a real ACQUIRE, but critically the destination reported
          // must be bowman-mega, never bowman-chrome-mega-box.
          return { rows: [], byNumber: new Map() };
        }
        return { rows: [], byNumber: new Map() };
      },
      isBacked,
    };
    const result = classifyOne(row, { sport: "baseball", year: 2026, setKey: "bowman-chrome-mega-box" }, deps, io);
    expect(result.name).toBe("STALE-NO-ROW");
    expect(result.detail!.identity.setKey).toBe("bowman-mega");
    expect(result.detail!.identity.setKey).not.toBe("bowman-chrome-mega-box");
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

  it("classifies RUNG-MISSING/ISAUTO-DEFECT when the number exists at the OTHER isAuto value (PR #2439 review, step c)", () => {
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
      // catalog has #11 but only as a non-auto base card, same player.
      "2024|topps": [{ id: "cat11", cardNumber: "11", isAuto: false, printRun: null, playerName: "Jackson Holliday", source: "checklistinsider" }],
    });
    const result = classifyOne(row, { sport: "baseball", year: 2024, setKey: "topps" }, deps, io);
    // Bucket name is still RUNG-MISSING (the raw shape); classification is
    // the review's new axis and must say ISAUTO-DEFECT, not ACQUIRE — the
    // card already exists, just at the other auto flag.
    expect(result.name).toBe("RUNG-MISSING");
    expect(result.classification).toBe("ISAUTO-DEFECT");
  });

  it("classifies RUNG-MISSING as ACQUIRE when the other-isAuto candidate is a DIFFERENT player (namesAgree refuses)", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "topps" });
    const row = {
      id: "s4b",
      title: "2024 Topps Baseball #11 auto",
      hobbyiqCardId: "hiq:baseball:2024:topps:11:Base:auto",
      cardYear: 2024,
      cardNumber: "11",
      playerName: "Jackson Holliday",
    };
    const io = makeIo({
      // #11 non-auto exists, but for a DIFFERENT player -- must not count.
      "2024|topps": [{ id: "cat11", cardNumber: "11", isAuto: false, printRun: null, playerName: "Someone Else", source: "checklistinsider" }],
    });
    const result = classifyOne(row, { sport: "baseball", year: 2024, setKey: "topps" }, deps, io);
    expect(result.classification).toBe(ACQUIRE_CLASSIFICATION);
  });

  it("classifies CARD-MISSING as ACQUIRE when no catalog row exists for that cardNumber anywhere", () => {
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
    expect(result.classification).toBe(ACQUIRE_CLASSIFICATION);
  });

  it("classifies CARD-MISSING as KEY-DEFECT when the card is backed under a SIBLING setKey (2026 Bowman Mega Box shape, PR #2439 review)", () => {
    // Mirrors the reviewer's own finding: card_catalog carries the 2026 bare
    // "Bowman Mega Box" checklist under setKey FIELD `bowman-mega`, a
    // DISTINCT product from `bowman-chrome-mega-box` from 2026 (R75). A sale
    // whose derived identity lands on `bowman-chrome-mega-box` (because
    // deriveIdentity's own identity.setKey never runs resolveSetKeyForSlug)
    // must be caught by the sibling-key search, not filed as a genuine gap.
    const deps = makeDeps({ inferSetKeyFromTitle: () => "bowman-chrome-mega-box" });
    const row = {
      id: "s-mega",
      title: "2026 Bowman Mega Box Baseball #ES-18 Base",
      hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-mega-box:ES-18:Base:raw",
      cardYear: 2026,
      cardNumber: "ES-18",
      playerName: "Shohei Ohtani",
      setName: "2026 Bowman Mega Box Baseball", // raw setName text resolveSetKeyForSlug needs
    };
    const io = makeIo(
      {
        "2026|bowman-chrome-mega-box": [], // nothing under the (wrong) derived key
        "2026|bowman-mega": [
          { id: "hiq:baseball:2026:bowman-mega:es-18:base:no-auto", cardNumber: "ES-18", isAuto: false, printRun: null, playerName: "Shohei Ohtani", source: "checklistinsider" },
        ],
      },
      {
        // The real resolveSetKeyForSlug would read the raw setName + year and
        // apply R75; the fake asserts the SAME shape without needing dist/.
        resolveSetKeyForSlug: (_sport: string, setName: string, year: number) => {
          if (year >= 2026 && /bowman/i.test(setName) && /mega/i.test(setName) && !/chrome/i.test(setName)) return "bowman-mega";
          return null;
        },
      },
    );
    const result = classifyOne(row, { sport: "baseball", year: 2026, setKey: "bowman-chrome-mega-box" }, deps, io);
    expect(result.classification).toBe("KEY-DEFECT");
    expect(result.detail!.foundUnderSetKey).toBe("bowman-mega");
  });

  it("classifies as KEY-DEFECT via productAncestry/productRefinementsOf/siblingSetKeysToAlsoCheck when resolveSetKeyForSlug is absent", () => {
    // 2025 "Bowman's Best" shape from the review (rank 3/5): a sale
    // pool-derived under `bowman` instead of the sibling `bowmans-best`.
    const deps = makeDeps({ inferSetKeyFromTitle: () => "bowman" });
    const row = {
      id: "s-bb",
      title: "2025 Bowman's Best Baseball #B25-1 Base",
      hobbyiqCardId: "hiq:baseball:2025:bowman:B25-1:Base:raw",
      cardYear: 2025,
      cardNumber: "B25-1",
      playerName: "Paul Skenes",
      setName: "2025 Bowman's Best Baseball",
    };
    const io = makeIo(
      {
        "2025|bowman": [],
        "2025|bowmans-best": [
          { id: "cat-bb-1", cardNumber: "B25-1", isAuto: false, printRun: null, playerName: "Paul Skenes", source: "checklistinsider" },
        ],
      },
      {
        productRefinementsOf: (setKey: string) => (setKey === "bowman" ? ["bowmans-best"] : []),
      },
    );
    const result = classifyOne(row, { sport: "baseball", year: 2025, setKey: "bowman" }, deps, io);
    expect(result.classification).toBe("KEY-DEFECT");
    expect(result.detail!.foundUnderSetKey).toBe("bowmans-best");
  });

  it("classifies as KEY-DEFECT via the bounded cross-setKey probe when no vocabulary table names the sibling", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "topps" });
    const row = {
      id: "s-cross",
      title: "2025 Topps Holiday Baseball #HE-1 Base",
      hobbyiqCardId: "hiq:baseball:2025:topps:HE-1:Base:raw",
      cardYear: 2025,
      cardNumber: "HE-1",
      playerName: "Ronald Acuna Jr.",
      setName: "2025 Topps Holiday Baseball",
    };
    const io = makeIo(
      { "2025|topps": [] },
      {
        // No table names topps-holiday as a sibling of topps -- only the
        // WIDEST net (the cross-setKey probe) finds it.
        crossSetKeyProbe: () => [
          { id: "cat-he-1", setKey: "topps-holiday", cardNumber: "HE-1", isAuto: false, printRun: null, playerName: "Ronald Acuna Jr.", source: "checklistinsider" },
        ],
      },
    );
    const result = classifyOne(row, { sport: "baseball", year: 2025, setKey: "topps" }, deps, io);
    expect(result.classification).toBe("KEY-DEFECT");
    expect(result.detail!.foundUnderSetKey).toBe("topps-holiday");
  });

  it("classifies as SPELLING when the same setKey/cardNumber/isAuto/printRun is backed under a DIFFERENT parallel spelling", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "panini-prizm" });
    const row = {
      id: "s-spell",
      title: "2025 Panini Prizm Baseball #302 Silver",
      hobbyiqCardId: "hiq:baseball:2025:panini-prizm:302:Silver:raw",
      cardYear: 2025,
      cardNumber: "302",
      playerName: "Shedeur Sanders",
    };
    const io = makeIo({
      "2025|panini-prizm": [
        { id: "cat-302", cardNumber: "302", isAuto: false, printRun: null, playerName: "Shedeur Sanders", parallel: "Silver Prizm", source: "checklistinsider" },
      ],
    });
    const result = classifyOne(row, { sport: "baseball", year: 2025, setKey: "panini-prizm" }, deps, io);
    expect(result.classification).toBe("SPELLING");
    expect(result.detail!.foundSpelling).toBe("Silver Prizm");
  });

  describe("MUTATION CHECK: removing the sibling-key lookup must turn a KEY-DEFECT into ACQUIRE", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "bowman-chrome-mega-box" });
    const row = {
      id: "s-mega-mut",
      title: "2026 Bowman Mega Box Baseball #ES-18 Base",
      hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-mega-box:ES-18:Base:raw",
      cardYear: 2026,
      cardNumber: "ES-18",
      playerName: "Shohei Ohtani",
      setName: "2026 Bowman Mega Box Baseball",
    };
    const cellsByKey = {
      "2026|bowman-chrome-mega-box": [],
      "2026|bowman-mega": [
        { id: "hiq:baseball:2026:bowman-mega:es-18:base:no-auto", cardNumber: "ES-18", isAuto: false, printRun: null, playerName: "Shohei Ohtani", source: "checklistinsider" },
      ],
    };
    const siblingTables = {
      resolveSetKeyForSlug: (_sport: string, setName: string, year: number) =>
        year >= 2026 && /bowman/i.test(setName) && /mega/i.test(setName) && !/chrome/i.test(setName) ? "bowman-mega" : null,
    };

    it("baseline: WITH the sibling-key lookup wired, this is KEY-DEFECT", () => {
      const io = makeIo(cellsByKey, siblingTables);
      const result = classifyOne(row, { sport: "baseball", year: 2026, setKey: "bowman-chrome-mega-box" }, deps, io);
      expect(result.classification).toBe("KEY-DEFECT");
    });

    it("MUTATION: WITHOUT any sibling-key lookup (resolveSetKeyForSlug/productAncestry/productRefinementsOf/siblingSetKeysToAlsoCheck/crossSetKeyProbe all absent), the SAME fixture must become ACQUIRE -- proving the guard is load-bearing", () => {
      const io = makeIo(cellsByKey, {}); // no sibling tables wired at all
      const result = classifyOne(row, { sport: "baseball", year: 2026, setKey: "bowman-chrome-mega-box" }, deps, io);
      expect(result.classification).toBe(ACQUIRE_CLASSIFICATION);
      // This assertion is the point of the mutation check: if someone
      // deletes the sibling-key search from resolveDefectOrAcquire, THIS
      // fixture (which the baseline test above proves is a real
      // KEY-DEFECT) silently starts reading as ACQUIRE again -- exactly the
      // PR #2439 review defect. A future accidental removal of the search
      // would make this test read ACQUIRE for a card that demonstrably
      // exists under a sibling key, which is the wrong outcome, so this
      // test would need to be updated to `.toBe("KEY-DEFECT")` to pass --
      // and that update is the signal the removal broke the guard.
    });
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
    const k1 = aggregationKey("Baseball", 2024, "Topps", "bp", "Gold", true, "99", "ACQUIRE");
    const k2 = aggregationKey("baseball", 2024, "topps", "BP", "Gold", true, "99", "ACQUIRE");
    expect(k1).toBe(k2);
  });
  it("differs when any axis differs (isAuto)", () => {
    const k1 = aggregationKey("baseball", 2024, "topps", "bp", "Gold", true, null, "ACQUIRE");
    const k2 = aggregationKey("baseball", 2024, "topps", "bp", "Gold", false, null, "ACQUIRE");
    expect(k1).not.toBe(k2);
  });
  it("differs by classification alone, same destination identity otherwise (PR #2439 review)", () => {
    const k1 = aggregationKey("baseball", 2026, "bowman-chrome-mega-box", "base", "Base", false, null, "ACQUIRE");
    const k2 = aggregationKey("baseball", 2026, "bowman-chrome-mega-box", "base", "Base", false, null, "KEY-DEFECT");
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
    foldIntoAggregate(agg, "baseball", 2024, { title: "sale one" }, { name: "CARD-MISSING", detail: detail1, classification: ACQUIRE_CLASSIFICATION });
    foldIntoAggregate(agg, "baseball", 2024, { title: "sale two" }, { name: "CARD-MISSING", detail: detail2, classification: ACQUIRE_CLASSIFICATION });
    expect(agg.size).toBe(1);
    const entry = [...agg.values()][0];
    expect(entry.salesCount).toBe(2);
    expect(entry.cardNumbers.size).toBe(2);
    expect(entry.exampleTitles).toEqual(["sale one", "sale two"]);
    expect(entry.classification).toBe(ACQUIRE_CLASSIFICATION);
  });

  it("keeps an ACQUIRE sale and a KEY-DEFECT sale at the SAME destination identity as TWO separate entries", () => {
    const agg = new Map();
    const identity = { setKey: "bowman-chrome-mega-box", parallel: "Base", isAuto: false, printRun: null };
    foldIntoAggregate(agg, "baseball", 2026, { title: "genuinely missing" }, {
      name: "CARD-MISSING",
      detail: { identity, cardNumber: "1" },
      classification: "ACQUIRE",
    });
    foldIntoAggregate(agg, "baseball", 2026, { title: "actually a sibling-key defect" }, {
      name: "CARD-MISSING",
      detail: { identity, cardNumber: "2", foundUnderSetKey: "bowman-mega" },
      classification: "KEY-DEFECT",
    });
    expect(agg.size).toBe(2);
    const entries = [...agg.values()];
    const acquireEntry = entries.find((e) => e.classification === "ACQUIRE")!;
    const defectEntry = entries.find((e) => e.classification === "KEY-DEFECT")!;
    expect(acquireEntry.salesCount).toBe(1);
    expect(defectEntry.salesCount).toBe(1);
    expect(defectEntry.classificationDetail).toBe("bowman-mega");
  });

  it("carries the found spelling into classificationDetail for a SPELLING entry", () => {
    const agg = new Map();
    foldIntoAggregate(agg, "baseball", 2025, { title: "silver spelling" }, {
      name: "RUNG-MISSING",
      detail: { identity: { setKey: "panini-prizm", parallel: "Silver", isAuto: false, printRun: null }, cardNumber: "302", foundSpelling: "Silver Prizm" },
      classification: "SPELLING",
    });
    const entry = [...agg.values()][0];
    expect(entry.classificationDetail).toBe("Silver Prizm");
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

describe("rankWithinClassification", () => {
  it("ranks and shares SEPARATELY within ACQUIRE vs KEY-DEFECT, never blending the two", () => {
    const ranked = [
      { sport: "baseball", year: 2026, setKey: "a", prefix: "base", parallel: "Base", isAuto: false, printRun: null, salesCount: 100, distinctCardNumbers: 1, exampleTitles: [], classification: "ACQUIRE" },
      { sport: "baseball", year: 2026, setKey: "b", prefix: "base", parallel: "Base", isAuto: false, printRun: null, salesCount: 900, distinctCardNumbers: 1, exampleTitles: [], classification: "KEY-DEFECT" },
      { sport: "baseball", year: 2026, setKey: "c", prefix: "base", parallel: "Base", isAuto: false, printRun: null, salesCount: 50, distinctCardNumbers: 1, exampleTitles: [], classification: "ACQUIRE" },
    ];
    const out = rankWithinClassification(ranked);
    const acquireRows = out.filter((r: any) => r.classification === "ACQUIRE");
    const defectRows = out.filter((r: any) => r.classification === "KEY-DEFECT");
    // ACQUIRE's own cumulative share reaches 100% over ACQUIRE rows ALONE
    // (100 + 50 = 150), utterly unaffected by KEY-DEFECT's 900.
    expect(acquireRows[0].setKey).toBe("a");
    expect(acquireRows[0].shareOfClassification).toBeCloseTo(100 / 150, 5);
    expect(acquireRows[1].cumulativeShareOfClassification).toBeCloseTo(1.0, 5);
    // KEY-DEFECT is its own group, sharing to 100% over itself.
    expect(defectRows[0].shareOfClassification).toBeCloseTo(1.0, 5);
  });

  it("orders ACQUIRE before all defect classifications regardless of salesCount", () => {
    const ranked = [
      { sport: "baseball", year: 2026, setKey: "big-defect", prefix: "base", parallel: "Base", isAuto: false, printRun: null, salesCount: 9999, distinctCardNumbers: 1, exampleTitles: [], classification: "KEY-DEFECT" },
      { sport: "baseball", year: 2026, setKey: "small-acquire", prefix: "base", parallel: "Base", isAuto: false, printRun: null, salesCount: 1, distinctCardNumbers: 1, exampleTitles: [], classification: "ACQUIRE" },
    ];
    const out = rankWithinClassification(ranked);
    expect(out[0].classification).toBe("ACQUIRE");
    expect(out[1].classification).toBe("KEY-DEFECT");
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
