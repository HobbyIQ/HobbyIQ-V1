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
  resolveSiblingSetKeyCandidates,
  checkKeyDefectByPlayer,
  checkSplitIdentity,
  resolveDefectOrAcquire,
  classifyOne,
  ACQUIRE_CLASSIFICATION,
  SPLIT_IDENTITY_CLASSIFICATION,
  aggregationKey,
  foldIntoAggregate,
  rankAggregate,
  rankWithinClassification,
  guessSourceUrls,
  collectUnregisteredProductTokens,
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

  describe("resolveDefectOrAcquire part (b)/(c) widened: ANY backed rung at the same cardNumber/setKey is a defect, not just an exact auto+printRun match (PR #2439 review, defect 2, 2026-09-26)", () => {
    // Live shape: "2024/topps-holiday/Base 587 sales, RC- numbers" -- every
    // RC-/EG-/HE-/TSA-/MLBO-/SDC-/HRC-/ARC- cardNumber is checklist-backed
    // under topps-holiday as a "Holiday Relics ... Memorabilia Patch" row
    // (isAuto=false, but SERIAL-NUMBERED, i.e. printRun set), while the SALE
    // is bucketed generic "Base" (isAuto=false, printRun=null, since the sale
    // doc never carries the relic's actual serial number). autoMatch is TRUE
    // but prMatch is FALSE, so neither the old (b) SPELLING check (needs
    // autoMatch && prMatch) nor the old (c) ISAUTO-DEFECT check (needs
    // prMatch && !autoMatch) fires, and the sale fell through to ACQUIRE
    // despite the exact cardNumber being backed one parallel/insert segment
    // over -- the task's rule: ACQUIRE requires ZERO checklist-grade rows for
    // this cardNumber under this setKey across EVERY parallel/insert segment.
    const deps = makeDeps({ inferSetKeyFromTitle: () => "topps-holiday" });
    const row = {
      id: "s-rcgh",
      title: "Gunnar Henderson 2024 Topps Holiday Relics #RC-GH Memorabilia Patch Player Worn",
      hobbyiqCardId: "hiq:baseball:2024:topps-holiday:RC-GH:Base:raw",
      cardYear: 2024,
      cardNumber: "RC-GH",
      playerName: "Gunnar Henderson",
    };
    const cellsByKey = {
      "2024|topps-holiday": [
        {
          id: "cat-rcgh",
          cardNumber: "RC-GH",
          isAuto: false,
          printRun: 199, // serial-numbered relic -- prMatch against the sale's null printRun is FALSE
          playerName: "Gunnar Henderson",
          parallel: "Holiday Relics Memorabilia Patch",
          source: "checklistinsider",
        },
      ],
    };

    it("classifies as SPELLING (a bucketing/segment defect), never ACQUIRE, even though auto matches but printRun does not", () => {
      const io = makeIo(cellsByKey, {});
      const result = classifyOne(row, { sport: "baseball", year: 2024, setKey: "topps-holiday" }, deps, io);
      expect(result.classification).toBe("SPELLING");
      expect(result.detail!.foundSpelling).toBe("Holiday Relics Memorabilia Patch");
    });

    it("MUTATION CHECK: removing the any-parallel/any-rung lookup flips this fixture back to ACQUIRE", () => {
      // Simulate the pre-fix behavior directly: call resolveDefectOrAcquire
      // with an io whose getCellIndex returns the SAME backed row, but drive
      // it through the OLD (exact autoMatch&&prMatch / prMatch&&!autoMatch)
      // gates only, by asserting the real function's widened (b)/(c)+any-rung
      // check is what makes the difference -- i.e. prove the fixture is
      // exactly at the seam the fix touches: autoMatch true, prMatch false.
      const hits = rungLookup(indexCatalogCell(cellsByKey["2024|topps-holiday"]), "RC-GH", false, null, "Gunnar Henderson");
      const h = hits[0];
      expect(h.autoMatch).toBe(true); // isAuto matches (both false)
      expect(h.prMatch).toBe(false); // printRun does NOT match (199 vs null)
      // Old (b): needs autoMatch && prMatch -> FALSE, would not fire.
      expect(h.autoMatch && h.prMatch).toBe(false);
      // Old (c): needs prMatch && !autoMatch -> FALSE, would not fire either.
      expect(h.prMatch && !h.autoMatch).toBe(false);
      // Only the widened any-rung-backed-agreeing check (added by the fix)
      // catches this fixture; without it the same inputs resolve to ACQUIRE,
      // which is the live defect this test guards against regressing to.
    });
  });

  describe("resolveSiblingSetKeyCandidates + lazy cell warming (PR #2439 review, defect 1, 2026-09-26)", () => {
    // The live defect: getCellIndex only reads whatever the CLI driver's main
    // FOR loop already `await loadCatalogCell`'d for an EARLIER cell in
    // --setkeys/--cells-from order. 2026:bowman-chrome is processed before
    // 2026:bowman, so every bowman-chrome sale's sibling probe of `bowman`
    // saw an empty Map (indistinguishable from "loaded and genuinely empty")
    // and fell through to ACQUIRE. This suite can't exercise the CLI driver's
    // real Cosmos-backed loadCatalogCell (no Cosmos in vitest), but it proves
    // the piece the fix actually changed: resolveSiblingSetKeyCandidates is
    // now its OWN pure, exported function that the driver's warmSiblingCells
    // calls BEFORE classifyOne runs, so the driver can await-load every
    // candidate ahead of time instead of resolveDefectOrAcquire discovering
    // the candidate list too late (synchronously, mid-classification) to
    // load anything.
    it("returns the resolveSetKeyForSlug candidate first, deduped against identity.setKey and against itself", () => {
      const io = {
        resolveSetKeyForSlug: () => "bowman-mega",
        productAncestry: () => ["bowman-mega", "bowman-chrome-mega-box"], // includes a dup of the resolved key and identity.setKey
        productRefinementsOf: () => [],
        siblingSetKeysToAlsoCheck: () => ["bowman-mega"], // dup again
      };
      const identity = { setKey: "bowman-chrome-mega-box" };
      const candidates = resolveSiblingSetKeyCandidates({ setName: "2026 Bowman Mega Box Baseball" }, { sport: "baseball", year: 2026 }, identity, io);
      expect(candidates).toEqual(["bowman-mega"]);
    });

    it("is the SAME candidate list resolveDefectOrAcquire's part (a) actually probes -- proven by matching KEY-DEFECT outcomes", () => {
      const deps = makeDeps({ inferSetKeyFromTitle: () => "bowman-chrome-mega-box" });
      const row = {
        id: "s-warm",
        title: "2026 Bowman Mega Box Baseball #ES-19 Base",
        hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-mega-box:ES-19:Base:raw",
        cardYear: 2026,
        cardNumber: "ES-19",
        playerName: "Paul Skenes",
        setName: "2026 Bowman Mega Box Baseball",
      };
      const siblingTables = {
        resolveSetKeyForSlug: (_sport: string, setName: string, year: number) =>
          year >= 2026 && /bowman/i.test(setName) && /mega/i.test(setName) && !/chrome/i.test(setName) ? "bowman-mega" : null,
      };
      const io = makeIo(
        {
          "2026|bowman-chrome-mega-box": [],
          "2026|bowman-mega": [
            { id: "hiq:baseball:2026:bowman-mega:es-19:base:no-auto", cardNumber: "ES-19", isAuto: false, printRun: null, playerName: "Paul Skenes", source: "checklistinsider" },
          ],
        },
        siblingTables,
      );
      // The exact candidate list the driver's warmSiblingCells would have
      // pre-warmed for this row/identity:
      const candidates = resolveSiblingSetKeyCandidates(row, { sport: "baseball", year: 2026 }, { setKey: "bowman-chrome-mega-box" }, io);
      expect(candidates).toEqual(["bowman-mega"]);
      // And with that cell present in the fake (standing in for "the driver
      // warmed it"), classifyOne finds the KEY-DEFECT.
      const result = classifyOne(row, { sport: "baseball", year: 2026, setKey: "bowman-chrome-mega-box" }, deps, io);
      expect(result.classification).toBe("KEY-DEFECT");
    });

    it("MUTATION CHECK: an UNWARMED sibling cell (getCellIndex returns empty for it, simulating the pre-fix missing-load) makes the SAME fixture read ACQUIRE", () => {
      const deps = makeDeps({ inferSetKeyFromTitle: () => "bowman-chrome-mega-box" });
      const row = {
        id: "s-unwarmed",
        title: "2026 Bowman Mega Box Baseball #ES-20 Base",
        hobbyiqCardId: "hiq:baseball:2026:bowman-chrome-mega-box:ES-20:Base:raw",
        cardYear: 2026,
        cardNumber: "ES-20",
        playerName: "Paul Skenes",
        setName: "2026 Bowman Mega Box Baseball",
      };
      const siblingTables = {
        resolveSetKeyForSlug: (_sport: string, setName: string, year: number) =>
          year >= 2026 && /bowman/i.test(setName) && /mega/i.test(setName) && !/chrome/i.test(setName) ? "bowman-mega" : null,
      };
      // bowman-mega is NEVER present in cellsByKey -- exactly what
      // io.getCellIndex(year, "bowman-mega") returns when loadCatalogCell was
      // never awaited for it (the live defect): {rows: [], byNumber: new Map()}.
      const io = makeIo({ "2026|bowman-chrome-mega-box": [] }, siblingTables);
      const result = classifyOne(row, { sport: "baseball", year: 2026, setKey: "bowman-chrome-mega-box" }, deps, io);
      expect(result.classification).toBe(ACQUIRE_CLASSIFICATION);
      // Same card, same sibling table, same real row live in card_catalog --
      // the ONLY difference from the previous test is whether the driver
      // warmed the sibling cell first. This is the exact shape of the live
      // defect (rank 1/2/4/5 in PR #2439's first run), and why warmSiblingCells
      // must run before classifyOne in the CLI driver, never left to
      // getCellIndex alone.
    });
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

  it("BUG FIX (bb25 tracer, C:/tmp/bb25_trace_1530/RESULT.md, 2026-09-26): reads cardNumber from detail.identity.cardNumber when the top-level detail.cardNumber is absent, exactly the STALE-NO-ROW branch's shape", () => {
    // classifyOne's STALE-NO-ROW branch (~line 362 pre-fix numbering) sets
    // detail.identity.cardNumber but never a top-level detail.cardNumber --
    // reading detail.cardNumber alone silently reads `undefined` for every
    // STALE-NO-ROW-sourced row. Live symptom: the "2025/bowmans-best/Base
    // 899 / 660" ACQUIRE rows both show distinctCardNumbers=0 despite having
    // hundreds of sales, because every contributing sale's cardNumber was
    // silently dropped on the floor here.
    const agg = new Map();
    foldIntoAggregate(agg, "baseball", 2025, { title: "2025 Bowman's Best #B25-1 Base" }, {
      name: "STALE-NO-ROW",
      detail: {
        from: "hiq:baseball:2025:bowman:B25-1:Base:raw",
        to: "hiq:baseball:2025:bowmans-best:b25-1:base:no-auto",
        identity: { setKey: "bowmans-best", cardNumber: "B25-1", parallel: "Base", isAuto: false, printRun: null },
      },
      classification: ACQUIRE_CLASSIFICATION,
    });
    const entry = [...agg.values()][0];
    // Prefix must be derived from the REAL cardNumber (B25-1 has no letter-
    // dash prefix per extractInsertPrefix's own rule -- bare numeric-suffixed
    // is still "base" here, but distinctCardNumbers must NOT be 0).
    expect(entry.cardNumbers.size).toBe(1);
    expect([...entry.cardNumbers]).toEqual(["B25-1"]);
  });

  it("BUG FIX: a STALE-NO-ROW row with an insert-prefixed cardNumber (e.g. RC-GH) buckets under that prefix, not the generic 'base' catch-all", () => {
    const agg = new Map();
    foldIntoAggregate(agg, "baseball", 2024, { title: "... #RC-GH ..." }, {
      name: "STALE-NO-ROW",
      detail: {
        from: "hiq:baseball:2024:topps-holiday:RC-GH:Base:raw",
        to: "hiq:baseball:2024:topps-holiday:rc-gh:base:no-auto",
        identity: { setKey: "topps-holiday", cardNumber: "RC-GH", parallel: "Base", isAuto: false, printRun: null },
      },
      classification: ACQUIRE_CLASSIFICATION,
    });
    const entry = [...agg.values()][0];
    expect(entry.prefix).toBe("RC");
    expect(entry.cardNumbers.has("RC-GH")).toBe(true);
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

describe("ad-hoc derived parallel slug is a SPELLING/STALE-ID class, never ACQUIRE (coordinator finding, 2026-09-26)", () => {
  // "2022 topps-chrome #221 is NOT an Image Variation (High-Number SP)":
  // parseHobbyIqCardId's `parallel` slug can be an ad-hoc fragment invented
  // from title text ("image-variation", "image-variation-ssp",
  // "ssp-refractor", "short-print(s)") rather than the card's REAL checklist
  // parallel name. No separate allowlist/classification is needed for this --
  // it is subsumed by the widened any-rung same-setKey check (defect 2's
  // fix): once the real checklist row for this cardNumber is found under its
  // true parallel, ANY backed hit at that cardNumber/setKey is a SPELLING
  // defect, regardless of what ad-hoc parallel label the sale itself carries.
  it("classifies a sale whose derived parallel is an ad-hoc title-slug ('image-variation') as SPELLING when the real checklist row exists under its true parallel name", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "topps-chrome" });
    const row = {
      id: "s-221-variation",
      title: "2022 Topps Chrome #221 High-Number SP Image Variation",
      hobbyiqCardId: "hiq:baseball:2022:topps-chrome:221:image-variation:raw",
      cardYear: 2022,
      cardNumber: "221",
      playerName: "Julio Rodriguez",
    };
    const io = makeIo({
      "2022|topps-chrome": [
        {
          id: "cat-221-real",
          cardNumber: "221",
          isAuto: false,
          printRun: null,
          playerName: "Julio Rodriguez",
          parallel: "High-Number Short Print", // the REAL checklist parallel name, not "Image Variation"
          source: "checklistinsider",
        },
      ],
    });
    const result = classifyOne(row, { sport: "baseball", year: 2022, setKey: "topps-chrome" }, deps, io);
    expect(result.classification).toBe("SPELLING");
    expect(result.detail!.foundSpelling).toBe("High-Number Short Print");
  });
});

describe("sold_comps cell query must not silently exclude CardHedge-shaped docs (coordinator finding, 2026-09-26)", () => {
  // The CLI driver's cell query (main(), not exercised by vitest -- no
  // Cosmos here) widened from `c.sport=@sp AND c.cardYear=@yr AND
  // c.setName=@sk` to an OR against STARTSWITH(hobbyiqCardId/cardId, 'hiq:
  // <sport>:<year>:<setKey>:'), because CardHedge-sourced sold_comps rows can
  // lack top-level sport/cardYear (soldCompsStore.service.ts's own
  // CF-SOLD-COMPS-SPORT comment: "320 cardhedge rows turned up with no
  // sport"; sport?/cardYear? are both optional on the writer's type). That
  // query itself can't run under vitest, so this test instead proves the
  // PURE classification path this worklist depends on tolerates a
  // CardHedge-shaped row (no sport/cardYear/setName at the top level, only a
  // resolved hobbyiqCardId) -- classifyOne/deriveIdentity never assumed those
  // fields either way; the fix is entirely in which rows the driver's cell
  // query HANDS to classifyOne, not in classifyOne itself.
  it("classifyOne classifies a CardHedge-shaped row (no top-level sport/setName fields, only a resolved hobbyiqCardId) correctly once it reaches the pipeline", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "topps" });
    const row = {
      id: "s-ch-noSport",
      title: "2024 Topps Baseball #99 Base Gunnar Henderson",
      hobbyiqCardId: "hiq:baseball:2024:topps:99:Base:raw",
      cardYear: 2024, // deriveIdentity falls back to row.cardYear when the title has no explicit year token deps.extractYearFromTitle would catch — present here so this test isolates the sport/setName omission the coordinator's finding is actually about, not deriveIdentity's own separate year-fallback behavior.
      cardNumber: "99",
      playerName: "Gunnar Henderson",
      // Deliberately absent: sport, setName -- the CardHedge shape the
      // coordinator's finding describes (soldCompsStore.service.ts:
      // "320 cardhedge rows turned up with no sport"). The driver's widened
      // cell query (main(), OR'd against STARTSWITH(hobbyiqCardId,...)) is
      // what lets a row like this reach classifyOne at all when c.sport/
      // c.setName can't match; classifyOne/deriveIdentity themselves already
      // tolerate a missing row.sport (storedIdentity: `row.sport ?? null`)
      // and never read row.setName as a hard requirement.
    };
    const io = makeIo({
      "2024|topps": [
        { id: "cat-99", cardNumber: "99", isAuto: false, printRun: null, playerName: "Gunnar Henderson", source: "checklistinsider" },
      ],
    });
    const result = classifyOne(row, { sport: "baseball", year: 2024, setKey: "topps" }, deps, io);
    expect(result.name).toBe("BACKED-DERIVED-ONLY");
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

// ═══════════════════════════════════════════════════════════════════════════
// v2 (2026-09-27) — live-trace defects from C:/tmp/*_trace_*/RESULT.md
// ═══════════════════════════════════════════════════════════════════════════

describe("(1) KEY-DEFECT-BY-PLAYER — bc26_mojo_trace shape: from-key row disagrees on player, a sibling agrees", () => {
  // Reproduces the "murakami-variation-mojo-refractor" finding: bowman-chrome
  // #9's OWN checklist row is Cody Bellinger (disagrees with the sale's
  // Munetaka Murakami), while bowman's #9 row IS Murakami. The old code had
  // no signal for this shape and either invented an ad-hoc parallel or fell
  // through to ACQUIRE.
  const deps = makeDeps({ inferSetKeyFromTitle: () => "bowman-chrome" });
  const row = {
    id: "s-murakami",
    title: "2026 Bowman Chrome Munetaka Murakami #9 Chrome Mojo Refractor",
    hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:9:murakami-variation-mojo-refractor:no-auto",
    cardYear: 2026,
    cardNumber: "9",
    playerName: "Munetaka Murakami",
    setName: "2026 Bowman Chrome Baseball",
  };
  const cellsByKey = {
    "2026|bowman-chrome": [
      { id: "cat-bc-9", cardNumber: "9", isAuto: false, printRun: null, playerName: "Cody Bellinger", parallel: "Mojo Refractor", source: "checklistcenter-2026-08-29" },
    ],
    "2026|bowman": [
      { id: "hiq:baseball:2026:bowman:9:mega-chrome-burgundy-mojo-refractor:no-auto:num-275", cardNumber: "9", isAuto: false, printRun: 275, playerName: "Munetaka Murakami", parallel: "Mega Chrome Burgundy Mojo Refractor", source: "checklistcenter-2026-08-29" },
    ],
  };
  const siblingTables = { productRefinementsOf: (k: string) => (k === "bowman-chrome" ? ["bowman"] : []) };

  it("classifies as KEY-DEFECT-BY-PLAYER, naming both the sibling setKey and the from-key's wrong player", () => {
    const io = makeIo(cellsByKey, siblingTables);
    const identity = { setKey: "bowman-chrome", isAuto: false, printRun: null };
    const result = checkKeyDefectByPlayer(row, { sport: "baseball", year: 2026 }, identity, "9", io);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe("KEY-DEFECT-BY-PLAYER");
    expect(result!.foundUnderSetKey).toBe("bowman");
    expect(result!.fromKeyWrongPlayer).toBe("Cody Bellinger");
  });

  it("resolveDefectOrAcquire reaches KEY-DEFECT-BY-PLAYER before the ordinary sibling search, never ACQUIRE", () => {
    const io = makeIo(cellsByKey, siblingTables);
    const identity = { setKey: "bowman-chrome", isAuto: false, printRun: null };
    const result = resolveDefectOrAcquire(row, { sport: "baseball", year: 2026 }, identity, "9", io);
    expect(result.classification).toBe("KEY-DEFECT-BY-PLAYER");
  });

  it("MUTATION CHECK: without checkKeyDefectByPlayer wired in, this exact fixture falls through the ordinary namesAgree-gated sibling search and resolves ACQUIRE", () => {
    // Prove the shape: the ordinary sibling loop in resolveDefectOrAcquire
    // ALSO checks `bowman`, and its row DOES agree by name -- so simply
    // removing the byPlayer check does not even reach the sibling loop with
    // a wrong signal, it reaches it fresh. This asserts the sibling loop by
    // itself, called directly (bypassing checkKeyDefectByPlayer), still
    // finds bowman -- i.e. resolveDefectOrAcquire's overall KEY-DEFECT-BY-
    // PLAYER verdict is not a fluke of the ordinary path; it fires strictly
    // BEFORE and INSTEAD OF a plain KEY-DEFECT for this fixture because
    // checkKeyDefectByPlayer runs first and returns a MORE SPECIFIC verdict.
    const io = makeIo(cellsByKey, siblingTables);
    const identity = { setKey: "bowman-chrome", isAuto: false, printRun: null };
    const byPlayerResult = checkKeyDefectByPlayer(row, { sport: "baseball", year: 2026 }, identity, "9", io);
    expect(byPlayerResult).not.toBeNull(); // the specific check fires
    // If a caller only had the FROM-key row and NO known sibling relationship
    // at all (no productRefinementsOf entry), checkKeyDefectByPlayer must
    // return null -- proving the check is gated on an actual sibling table
    // hit, not a blanket "any mismatch is a defect" rule.
    const ioNoSiblingTable = makeIo(cellsByKey, {});
    const noSiblingResult = checkKeyDefectByPlayer(row, { sport: "baseball", year: 2026 }, identity, "9", ioNoSiblingTable);
    expect(noSiblingResult).toBeNull();
  });

  it("does NOT fire when the from-key has no backed row at this number at all (nothing to explain)", () => {
    const io = makeIo({ "2026|bowman-chrome": [], "2026|bowman": cellsByKey["2026|bowman"] }, siblingTables);
    const identity = { setKey: "bowman-chrome", isAuto: false, printRun: null };
    const result = checkKeyDefectByPlayer(row, { sport: "baseball", year: 2026 }, identity, "9", io);
    expect(result).toBeNull();
  });

  it("does NOT fire when the sibling's row ALSO disagrees by name (no corroborating agreement anywhere)", () => {
    const io = makeIo(
      {
        "2026|bowman-chrome": cellsByKey["2026|bowman-chrome"],
        "2026|bowman": [{ id: "cat-bowman-9-other", cardNumber: "9", isAuto: false, printRun: null, playerName: "Someone Else Entirely", source: "checklistcenter-2026-08-29" }],
      },
      siblingTables,
    );
    const identity = { setKey: "bowman-chrome", isAuto: false, printRun: null };
    const result = checkKeyDefectByPlayer(row, { sport: "baseball", year: 2026 }, identity, "9", io);
    expect(result).toBeNull();
  });
});

describe("(2) SPLIT-IDENTITY — a checklist-backed hobbyiqCardId that disagrees with cardId is a pool split, not an unbacked sale", () => {
  it("classifies as SPLIT-IDENTITY when cardId and hobbyiqCardId are both hiq: slugs, disagree, and the hobbyiqCardId side is backed", () => {
    const row = {
      id: "ebay-user-purchase::split-1",
      cardId: "hiq:baseball:2026:bowman:cpa-vf:black-white-red-ink:auto",
      hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-vf:red-ink:auto",
      title: "2026 Bowman CPA-VF Red Ink Auto",
    };
    const io = {
      pointReadById(id: string) {
        if (id === "hiq:baseball:2026:bowman:cpa-vf:red-ink:auto") {
          return { id, source: "checklistcenter-2026-08-29", playerName: "Someone" };
        }
        return null;
      },
      isBacked,
    };
    const result = checkSplitIdentity(row, io);
    expect(result).not.toBeNull();
    expect(result!.classification).toBe("SPLIT-IDENTITY");
    expect(result!.cardId).toBe(row.cardId);
    expect(result!.hobbyiqCardId).toBe(row.hobbyiqCardId);
  });

  it("does NOT classify as SPLIT-IDENTITY when the two fields agree (COHERENT)", () => {
    const row = { id: "s1", cardId: "hiq:baseball:2025:topps:1:base:no-auto", hobbyiqCardId: "hiq:baseball:2025:topps:1:base:no-auto" };
    const io = { pointReadById: () => null, isBacked };
    expect(checkSplitIdentity(row, io)).toBeNull();
  });

  it("does NOT classify as SPLIT-IDENTITY for the vendor-partition design shape (cardId is a foreign bubble id)", () => {
    const row = { id: "s2", cardId: "1778542173652x303328120692600800", hobbyiqCardId: "hiq:baseball:2025:topps:1:base:no-auto" };
    const io = { pointReadById: () => ({ id: row.hobbyiqCardId, source: "checklistinsider" }), isBacked };
    expect(checkSplitIdentity(row, io)).toBeNull();
  });

  it("MUTATION CHECK: when the hobbyiqCardId side is NOT actually backed, this must NOT classify as SPLIT-IDENTITY (damage exists but isn't proven-real yet)", () => {
    const row = {
      id: "ebay-user-purchase::split-2",
      cardId: "hiq:baseball:2026:bowman:1:black-white-red-ink:auto",
      hobbyiqCardId: "hiq:baseball:2026:bowman:1:red-ink:auto",
      title: "...",
    };
    const io = { pointReadById: () => null, isBacked }; // nothing backed anywhere
    expect(checkSplitIdentity(row, io)).toBeNull();
  });

  it("classifyOne returns SPLIT-IDENTITY at the very top, before deriveIdentity/title parsing ever runs", () => {
    const deps = makeDeps();
    const row = {
      id: "ebay-user-purchase::split-3",
      cardId: "hiq:baseball:2026:bowman:cpa-vf:black-white-red-ink:auto",
      hobbyiqCardId: "hiq:baseball:2026:bowman:cpa-vf:red-ink:auto",
      title: "", // blank title -- would normally refuse with NO-NUMBER, proving SPLIT-IDENTITY is checked FIRST
    };
    const io = makeIo({}, {});
    const patchedIo = {
      ...io,
      pointReadById(id: string) {
        if (id === row.hobbyiqCardId) return { id, source: "checklistcenter-2026-08-29" };
        return null;
      },
    };
    const result = classifyOne(row, { sport: "baseball", year: 2026, setKey: "bowman" }, deps, patchedIo);
    expect(result.name).toBe("SPLIT-IDENTITY");
    expect(result.classification).toBe(SPLIT_IDENTITY_CLASSIFICATION);
  });

  it("foldIntoAggregate counts SPLIT-IDENTITY into its OWN (sport,year) bucket, separate from every destination-identity bucket", () => {
    const agg = new Map();
    foldIntoAggregate(agg, "baseball", 2026, { title: "split sale one" }, {
      name: "SPLIT-IDENTITY",
      detail: { cardId: "a", hobbyiqCardId: "b", segments: ["parallel"] },
      classification: "SPLIT-IDENTITY",
    });
    foldIntoAggregate(agg, "baseball", 2026, { title: "split sale two" }, {
      name: "SPLIT-IDENTITY",
      detail: { cardId: "c", hobbyiqCardId: "d", segments: ["setKey"] },
      classification: "SPLIT-IDENTITY",
    });
    // A genuinely different classification at the SAME (sport,year) must not
    // land in the SPLIT-IDENTITY bucket.
    foldIntoAggregate(agg, "baseball", 2026, { title: "acquire sale" }, {
      name: "CARD-MISSING",
      detail: { identity: { setKey: "topps", parallel: "Base", isAuto: false, printRun: null }, cardNumber: "1" },
      classification: "ACQUIRE",
    });
    expect(agg.size).toBe(2);
    const splitEntry = [...agg.values()].find((e: any) => e.classification === "SPLIT-IDENTITY")!;
    expect(splitEntry.salesCount).toBe(2);
  });
});

describe("(3) PAGINATION — the drain loops in this file never treat an empty page as end-of-results", () => {
  // idxrepro_2123's confirmed root cause: `if (resources.length === 0) break`
  // mistakes an empty INTERMEDIATE cross-partition page for done. This test
  // drives a fake Cosmos-shaped iterator (2 empty pages, then a data page,
  // matching the confirmed repro shape) through the SAME `while
  // (it.hasMoreResults())` contract this file's own cell loader uses, and
  // proves that contract -- unlike the broken early-break pattern -- drains
  // every row.
  function makeFakeIterator(pages: { resources: any[]; hasMore: boolean }[]) {
    let i = 0;
    return {
      hasMoreResults() {
        return i < pages.length;
      },
      async fetchNext() {
        const page = pages[i];
        i++;
        return { resources: page.resources, requestCharge: 1 };
      },
    };
  }

  it("a while(hasMoreResults()) drain collects rows from a data page arriving AFTER two empty pages", async () => {
    const it = makeFakeIterator([
      { resources: [], hasMore: true },
      { resources: [], hasMore: true },
      { resources: [{ id: "row-1" }, { id: "row-2" }], hasMore: false },
    ]);
    const collected: any[] = [];
    while (it.hasMoreResults()) {
      const page = await it.fetchNext();
      for (const r of page.resources || []) collected.push(r);
    }
    expect(collected.map((r) => r.id)).toEqual(["row-1", "row-2"]);
  });

  it("MUTATION CHECK: the broken `if (resources.length === 0) break` pattern loses the data page entirely on this exact fixture", async () => {
    const it = makeFakeIterator([
      { resources: [], hasMore: true },
      { resources: [], hasMore: true },
      { resources: [{ id: "row-1" }, { id: "row-2" }], hasMore: false },
    ]);
    const collected: any[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await it.fetchNext();
      if (!page.resources || page.resources.length === 0) break; // THE BUG
      for (const r of page.resources) collected.push(r);
    }
    expect(collected).toEqual([]); // proves the mutation undercounts to zero on this fixture
  });
});

describe("(4) AUTO-ONLY INSERT — der.autoByCardNumber flips a non-auto sale to ISAUTO-DEFECT without needing a backed row at the flipped value first", () => {
  it("classifies as ISAUTO-DEFECT when isCardNumberAutoSubset says the cardNumber is auto-only but the sale is stored non-auto", () => {
    const deps = makeDeps({
      inferSetKeyFromTitle: () => "panini-prizm",
      // Mirrors dist's isCardNumberAutoSubset consulting SCOPED_AUTO_ONLY_PREFIXES
      // for baseball|2025|panini-prizm's "SS-" prefix (Sensational Signatures).
      isCardNumberAutoSubset: (cardNumber: string) => /^SS-/i.test(cardNumber),
    });
    const row = {
      id: "s-ss-jw",
      title: "2025 Panini Prizm - Sensational Signatures Jaxon Wiggins #SS-JW Base",
      hobbyiqCardId: "hiq:baseball:2025:panini-prizm:ss-jw:base:no-auto",
      cardYear: 2025,
      cardNumber: "SS-JW",
      playerName: "Jaxon Wiggins",
    };
    const io = makeIo({}, {});
    const result = classifyOne(row, { sport: "baseball", year: 2025, setKey: "panini-prizm" }, deps, io);
    expect(result.name).toBe("ISAUTO-DEFECT-AUTO-ONLY-INSERT");
    expect(result.classification).toBe("ISAUTO-DEFECT");
  });

  it("does NOT fire when the sale is already stored/derived auto (nothing to flip)", () => {
    const deps = makeDeps({
      inferSetKeyFromTitle: () => "panini-prizm",
      isCardNumberAutoSubset: (cardNumber: string) => /^SS-/i.test(cardNumber),
    });
    const row = {
      id: "s-ss-jw-auto",
      title: "2025 Panini Prizm Sensational Signatures Jaxon Wiggins #SS-JW Auto",
      hobbyiqCardId: "hiq:baseball:2025:panini-prizm:ss-jw:base:auto",
      cardYear: 2025,
      cardNumber: "SS-JW",
      playerName: "Jaxon Wiggins",
    };
    const io = makeIo({ "2025|panini-prizm": [] }, {});
    const result = classifyOne(row, { sport: "baseball", year: 2025, setKey: "panini-prizm" }, deps, io);
    expect(result.name).not.toBe("ISAUTO-DEFECT-AUTO-ONLY-INSERT");
  });

  it("MUTATION CHECK: without isCardNumberAutoSubset wired (der.autoByCardNumber stays false), the SAME SS-JW fixture never reaches ISAUTO-DEFECT-AUTO-ONLY-INSERT and falls through to the ordinary path", () => {
    const deps = makeDeps({
      inferSetKeyFromTitle: () => "panini-prizm",
      isCardNumberAutoSubset: undefined, // simulate the dep never wired -- autoByCardNumber defaults false
    });
    const row = {
      id: "s-ss-jw-2",
      title: "2025 Panini Prizm - Sensational Signatures Jaxon Wiggins #SS-JW Base",
      hobbyiqCardId: "hiq:baseball:2025:panini-prizm:ss-jw:base:no-auto",
      cardYear: 2025,
      cardNumber: "SS-JW",
      playerName: "Jaxon Wiggins",
    };
    const io = makeIo({ "2025|panini-prizm": [] }, {});
    const result = classifyOne(row, { sport: "baseball", year: 2025, setKey: "panini-prizm" }, deps, io);
    expect(result.name).not.toBe("ISAUTO-DEFECT-AUTO-ONLY-INSERT");
    expect(result.classification).toBe(ACQUIRE_CLASSIFICATION); // absent the signal, falls through as before the fix
  });

  it("foldIntoAggregate aggregates ISAUTO-DEFECT-AUTO-ONLY-INSERT rows using the destination identity like any other worklist bucket", () => {
    const agg = new Map();
    foldIntoAggregate(agg, "baseball", 2025, { title: "#SS-JW Base" }, {
      name: "ISAUTO-DEFECT-AUTO-ONLY-INSERT",
      detail: { identity: { setKey: "panini-prizm", cardNumber: "SS-JW", parallel: "Base", isAuto: false, printRun: null }, cardNumber: "SS-JW" },
      classification: "ISAUTO-DEFECT",
    });
    expect(agg.size).toBe(1);
    const entry = [...agg.values()][0];
    expect(entry.classification).toBe("ISAUTO-DEFECT");
    expect(entry.salesCount).toBe(1);
  });
});

describe("(5) UNREGISTERED-PRODUCT — a product word present in the title but absent from the destination setKey's own words", () => {
  it("finds 'living' in a title mis-keyed under bare topps (2024 Topps Living Set shape)", () => {
    const sales = [
      { title: "2024 Topps Living Baseball #737 Base", setKey: "topps" },
      { title: "2024 Topps Living Shohei Ohtani #729 PSA 10 Gem Mint", setKey: "topps" },
      { title: "2024 TOPPS LIVING SET #737 CEDDANNE RAFAELA *ROOKIE PSA 9 MINT*", setKey: "topps" },
    ];
    const tokens = collectUnregisteredProductTokens(sales);
    const living = tokens.find((t: any) => t.token === "living");
    expect(living).toBeDefined();
    expect(living!.salesCount).toBe(3);
  });

  it("does NOT flag a token whose own word already appears in the destination setKey (registered)", () => {
    const sales = [{ title: "2025 Topps Heritage Baseball #100 Base", setKey: "topps-heritage" }];
    const tokens = collectUnregisteredProductTokens(sales);
    expect(tokens.find((t: any) => t.token === "heritage")).toBeUndefined();
  });

  it("ranks tokens by sales count descending", () => {
    const sales = [
      { title: "... Living ...", setKey: "topps" },
      { title: "... Living ...", setKey: "topps" },
      { title: "... Heritage ...", setKey: "topps" },
    ];
    const tokens = collectUnregisteredProductTokens(sales);
    expect(tokens[0].token).toBe("living");
    expect(tokens[0].salesCount).toBe(2);
  });

  it("supports caller-supplied extraTokens beyond the closed candidate list", () => {
    const sales = [{ title: "2024 Topps Update Baseball #1 Base", setKey: "topps" }];
    const tokens = collectUnregisteredProductTokens(sales, ["update"]);
    expect(tokens.find((t: any) => t.token === "update")).toBeDefined();
  });

  it("MUTATION CHECK: an empty sales array yields no tokens, never a spurious default", () => {
    expect(collectUnregisteredProductTokens([])).toEqual([]);
  });
});

describe("(6) DERIVED-ONLY — the exact rung has a row, but its source is not checklist-strict", () => {
  it("classifies as DERIVED-ONLY when io.catalogAuthorityOf says the exact-rung row is 'derived', not 'checklist'", () => {
    // Uses the same deps/id shape as the "BACKED-DERIVED-ONLY" fixture above
    // (title "#52 Refractor" -> fake parser derives parallel "Refractor",
    // isAuto false, printRun null) so der.slug === storedSlug and this test
    // isolates the ONE thing it's meant to prove: an exact-rung row present
    // but NOT checklist-authority reads DERIVED-ONLY, not STALE.
    const deps = makeDeps({ inferSetKeyFromTitle: () => "bowman-chrome" });
    const row = {
      id: "s-derived-52",
      title: "2026 Bowman Chrome Baseball #52 Refractor",
      hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:52:Refractor:raw",
      cardYear: 2026,
      cardNumber: "52",
      playerName: "Shohei Ohtani",
    };
    const io = {
      ...makeIo({
        "2026|bowman-chrome": [
          { id: "cat-52-derived", cardNumber: "52", isAuto: false, printRun: null, playerName: "Shohei Ohtani", parallel: "Refractor", source: "ingest-auto-seed" },
        ],
      }),
      catalogAuthorityOf: (source: string) => (source === "ingest-auto-seed" ? "derived" : "checklist"),
    };
    const result = classifyOne(row, { sport: "baseball", year: 2026, setKey: "bowman-chrome" }, deps, io);
    expect(result.name).toBe("DERIVED-ONLY");
    expect(result.classification).toBe("DERIVED-ONLY");
    expect(result.detail!.authority).toBe("derived");
  });

  it("does NOT fire (falls through to ordinary classification) when io.catalogAuthorityOf is not wired", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "bowman-chrome" });
    const row = {
      id: "s-derived-53",
      title: "2026 Bowman Chrome Baseball #53 Mojo Refractor",
      hobbyiqCardId: "hiq:baseball:2026:bowman-chrome:53:mojo-refractor:no-auto",
      cardYear: 2026,
      cardNumber: "53",
      playerName: "Someone Rookie",
    };
    const io = makeIo({
      "2026|bowman-chrome": [
        { id: "cat-53-derived", cardNumber: "53", isAuto: false, printRun: null, playerName: "Someone Rookie", parallel: "Mojo Refractor", source: "ingest-auto-seed" },
      ],
    }); // no catalogAuthorityOf
    const result = classifyOne(row, { sport: "baseball", year: 2026, setKey: "bowman-chrome" }, deps, io);
    expect(result.name).not.toBe("DERIVED-ONLY");
  });

  it("MUTATION CHECK: when the exact-rung row IS checklist authority, this must classify as BACKED-DERIVED-ONLY/STALE (already-backed), never DERIVED-ONLY", () => {
    const deps = makeDeps({ inferSetKeyFromTitle: () => "topps" });
    const row = {
      id: "s-checklist-10",
      title: "2024 Topps Baseball #10 Base",
      hobbyiqCardId: "hiq:baseball:2024:topps:10:Base:raw",
      cardYear: 2024,
      cardNumber: "10",
      playerName: "Corbin Carroll",
    };
    const io = {
      ...makeIo({
        "2024|topps": [{ id: "cat10", cardNumber: "10", isAuto: false, printRun: null, playerName: "Corbin Carroll", source: "checklistinsider" }],
      }),
      catalogAuthorityOf: (source: string) => (source === "checklistinsider" ? "checklist" : "derived"),
    };
    const result = classifyOne(row, { sport: "baseball", year: 2024, setKey: "topps" }, deps, io);
    expect(result.name).toBe("BACKED-DERIVED-ONLY"); // isBacked already true -- exactRung catches it first
    expect(result.classification).toBe("STALE");
  });

  it("foldIntoAggregate carries the found authority into classificationDetail for a DERIVED-ONLY entry", () => {
    const agg = new Map();
    foldIntoAggregate(agg, "baseball", 2026, { title: "derived-only sale" }, {
      name: "DERIVED-ONLY",
      detail: { identity: { setKey: "bowman-chrome", cardNumber: "52", parallel: "Mojo Refractor", isAuto: false, printRun: null }, cardNumber: "52", authority: "derived" },
      classification: "DERIVED-ONLY",
    });
    const entry = [...agg.values()][0];
    expect(entry.classificationDetail).toBe("derived");
    expect(entry.classification).toBe("DERIVED-ONLY");
  });
});

describe("rankWithinClassification orders the new classes sensibly (ACQUIRE and DERIVED-ONLY first, SPLIT-IDENTITY last)", () => {
  it("orders ACQUIRE, then DERIVED-ONLY, then KEY-DEFECT, KEY-DEFECT-BY-PLAYER, SPELLING, ISAUTO-DEFECT, SPLIT-IDENTITY", () => {
    const base = { sport: "baseball", year: 2026, setKey: "x", prefix: "base", parallel: "Base", isAuto: false, printRun: null, distinctCardNumbers: 1, exampleTitles: [] };
    const ranked = [
      { ...base, salesCount: 1, classification: "SPLIT-IDENTITY" },
      { ...base, salesCount: 1, classification: "ISAUTO-DEFECT" },
      { ...base, salesCount: 1, classification: "SPELLING" },
      { ...base, salesCount: 1, classification: "KEY-DEFECT-BY-PLAYER" },
      { ...base, salesCount: 1, classification: "KEY-DEFECT" },
      { ...base, salesCount: 1, classification: "DERIVED-ONLY" },
      { ...base, salesCount: 1, classification: "ACQUIRE" },
    ];
    const out = rankWithinClassification(ranked);
    expect(out.map((r: any) => r.classification)).toEqual([
      "ACQUIRE", "DERIVED-ONLY", "KEY-DEFECT", "KEY-DEFECT-BY-PLAYER", "SPELLING", "ISAUTO-DEFECT", "SPLIT-IDENTITY",
    ]);
  });
});
