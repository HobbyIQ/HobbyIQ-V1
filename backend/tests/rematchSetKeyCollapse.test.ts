/**
 * CF-COLLAPSE-IS-FORBIDDEN + CF-UNSUPPORTED-IS-A-GAP
 * (Drew, 2026-09-03, rulings V1 and V6).
 *
 * V1  Product-family COLLAPSE is forbidden. Every ruled pair below is two
 *     DIFFERENT cards. The specialized product must be a normalizeSetKey fixed
 *     point, the derivation must never read its title as the flagship, and the
 *     classifier must refuse the collapse BY NAME and never make it writable.
 *     The OTHER direction -- a stored generic/defaulted key against a derived
 *     product the TITLE names -- is strictly-more-specific and is IMPROVE.
 *
 * V6  UNSUPPORTED setKeys are added by row count, largest first. 4,202,405
 *     rows are UNDERIVABLE for `setkey-unknown-unsupported` alone. A key is
 *     SUPPORTED when the derivation can mint it and normalizeSetKey holds it
 *     as a fixed point. Recognizing a key is NOT a claim that its destinations
 *     are checklist-backed -- no synthetic parallels.
 *
 * EVERY TITLE IN THIS FILE IS A REAL ONE, sampled by the 32-slot census
 * (aggregate: 16,513,790 rows classified; 1,461,057 CONFLICT changed:setKey).
 * The pins assert the DERIVED KEY, not the regex that produces it, so the
 * implementation may be rewritten as long as the ruling holds.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

const require = createRequire(import.meta.url);
const K = require("../scripts/lib/rematch-classify.cjs");

type Identity = Record<string, unknown>;
const id = (over: Identity = {}): Identity => ({
  sport: "baseball", cardYear: 2024, setKey: "", cardNumber: "1",
  parallel: "Base", isAuto: false, printRun: null, ...over,
});

/**
 * THE RULED PAIRS, each with the census title that proves the shape and the
 * number of times the census SAMPLED it. `stored` is the key the row carries;
 * `flagship` is what the derivation used to produce from that title.
 */
const RULED: Array<{ stored: string; flagship: string; title: string; sampled: number }> = [
  // Bowman family
  { stored: "bowmans-best", flagship: "bowman", sampled: 267, title: "2004 Bowman's Best Baseball #BB-IS Base" },
  { stored: "bowmans-best", flagship: "bowman-chrome", sampled: 79, title: "2024 Bowman's Best Baseball #B24-GW Refractor" },
  { stored: "bowman-sterling", flagship: "bowman", sampled: 22, title: "2007 Bowman Sterling Basketball #KMA Base" },
  { stored: "bowman-heritage", flagship: "bowman", sampled: 64, title: "2007 Bowman Heritage - Brandon Webb #15 Rainbow Foil Diamondbacks" },
  { stored: "bowman-best-university", flagship: "bowman", sampled: 9, title: "2025 Bowman Best University Football #BOA-TTA Base" },
  { stored: "bowman-draft-picks-and-prospects", flagship: "bowman-draft", sampled: 49, title: "Brandon Morrow 2007 Bowman Draft Picks & Prospects #BDP13 Mariners" },
  { stored: "bowman-chrome-mega-box", flagship: "bowman-chrome", sampled: 10, title: "2024 Bowman Chrome Mega Box Baseball #17 Base" },
  // Sapphire -- an edition, and the two Sapphire products are not each other
  { stored: "bowman-draft-sapphire", flagship: "bowman-chrome-sapphire", sampled: 68, title: "2025 Bowman Draft Sapphire Baseball #BDC-64 Base" },
  // Topps Chrome family
  { stored: "topps-chrome-update-series", flagship: "topps-chrome", sampled: 186, title: "2024 Topps Chrome Update Baseball #USC186 Aqua" },
  { stored: "topps-chrome-platinum", flagship: "topps-chrome", sampled: 117, title: "2023 Topps Chrome Platinum Baseball #84 X-Fractor" },
  { stored: "topps-chrome-black", flagship: "topps-chrome", sampled: 58, title: "2026 Topps Chrome Black Baseball #188 Base" },
  // Topps flagship specializations
  { stored: "topps-allen-ginter", flagship: "topps", sampled: 180, title: "2007 Topps Allen & Ginter's #90 Miguel Cabrera - Raw" },
  { stored: "topps-gold-label", flagship: "topps", sampled: 4, title: "2026 Topps Gold Label Baseball #12 Class 1" },
  { stored: "topps-traded", flagship: "topps", sampled: 30, title: "1984 Topps Traded Baseball #70T Base" },
  { stored: "topps-total", flagship: "topps", sampled: 9, title: "2006 Topps Total Football #SI25 Base" },
  { stored: "topps-composite", flagship: "topps", sampled: 13, title: "2023 Topps Composite Football #MA-5 Base" },
  { stored: "topps-finest-flashbacks", flagship: "topps-finest", sampled: 22, title: "2021 Topps Finest Flashbacks Roger Clemens Refractor #214 Red Sox" },
  // Donruss -- Panini-owned, so the flagship key is LONGER than its children
  { stored: "donruss-elite", flagship: "panini-donruss", sampled: 170, title: "2025 Donruss Elite Football #PP-AJE Base" },
  { stored: "donruss-studio", flagship: "panini-donruss", sampled: 61, title: "Roberto Alomar 2001 Donruss Studio #27 Indians MLB" },
  { stored: "diamond-kings", flagship: "panini-donruss", sampled: 26, title: "2003 Donruss Diamond Kings Baseball #TT-9 Base" },
  // Prizm
  { stored: "panini-prizm-wnba", flagship: "panini-prizm", sampled: 61, title: "2024 Panini Prizm WNBA Basketball #5 Base" },
  { stored: "panini-prizm-draft-picks", flagship: "panini-prizm", sampled: 42, title: "2025 Panini Prizm Draft Picks Football #160 Silver" },
  // Panini Score is the modern Panini product; Score is the manufacturer
  { stored: "panini-score", flagship: "score", sampled: 55, title: "2025 Panini Score Football #33 Base" },
  // Fleer
  { stored: "fleer-tradition", flagship: "fleer", sampled: 71, title: "Jon Lieber 2001 Fleer Tradition #216 Cubs MLB" },
  { stored: "fleer-tradition-update", flagship: "fleer", sampled: 12, title: "Ryan Minor 1998 Fleer Tradition Update #U92 Orioles MLB" },
  { stored: "metal-universe", flagship: "fleer", sampled: 49, title: "1998 Metal Universe Baseball #84 Base" },
  { stored: "flair", flagship: "fleer", sampled: 8, title: "1993 Fleer Flair Wade Boggs #245 - Raw 10" },
  // Skybox
  { stored: "skybox-premium", flagship: "skybox", sampled: 69, title: "1994 Skybox Premium Basketball #R9 Base" },
  { stored: "skybox-molten-metal", flagship: "skybox", sampled: 16, title: "1998 Skybox Molten Metal Basketball #141 Base" },
  { stored: "skybox-thunder", flagship: "skybox", sampled: 9, title: "1998 Skybox Thunder Basketball #7LO Base" },
  // Upper Deck
  { stored: "upper-deck-black-diamond", flagship: "upper-deck", sampled: 26, title: "1998 Upper Deck Black Diamond Basketball #8 Double" },
  { stored: "upper-deck-retro", flagship: "upper-deck", sampled: 8, title: "1998 Upper Deck Retro Baseball #B11 Base" },
  { stored: "upper-deck-mvp", flagship: "upper-deck", sampled: 4, title: "1999 Upper Deck MVP Baseball #55 Base" },
  { stored: "spx-finite", flagship: "spx", sampled: 12, title: "1998 SPx Finite Baseball #240 Spectrum" },
];

/**
 * V6: the UNSUPPORTED keys added, ranked by the UNDERIVABLE row count they
 * will reclassify. `underivable` is the population estimate scaled from the
 * census sample (4,272,116 UNDERIVABLE rows over 11,155 parsed sample lines);
 * `catalogRows` / `checklistBacked` are read-only counts from card_catalog on
 * 2026-09-03. A key with checklistBacked 0 is SUPPORTED but its destinations
 * stay not-checklist-backed until checklists land -- no synthetic parallels.
 */
const SUPPORTED: Array<{ key: string; title: string; underivable: number; catalogRows: number; checklistBacked: number }> = [
  { key: "topps-chrome-sapphire", underivable: 150510, catalogRows: 48576, checklistBacked: 43023, title: "2025 Topps Chrome Sapphire Football #125 Gold" },
  { key: "topps-finest", underivable: 116042, catalogRows: 223575, checklistBacked: 183074, title: "2025 Topps Finest #119 Luther Burden III Chicago Bears" },
  { key: "panini-origins", underivable: 104553, catalogRows: 25114, checklistBacked: 23958, title: "2025 Panini Origins Football #31 Red" },
  { key: "bowman-chrome-sapphire", underivable: 83489, catalogRows: 14454, checklistBacked: 9410, title: "2023 Bowman Chrome Sapphire Edition Baseball #320 Orange" },
  { key: "leaf", underivable: 76213, catalogRows: 15787, checklistBacked: 2980, title: "2023 Leaf Perfect Game Karson Grout Auto MA-KG2 Marble 1/1" },
  { key: "panini-hoops", underivable: 74298, catalogRows: 2680, checklistBacked: 0, title: "2014 Panini Hoops Basketball #157 Base" },
  { key: "panini-photogenic", underivable: 54000, catalogRows: 16501, checklistBacked: 16501, title: "2025 Panini PhotoGenic Football #51 Purple" },
  { key: "panini-certified", underivable: 52851, catalogRows: 17476, checklistBacked: 17363, title: "2025 Panini Certified Football #FBC-ITA Red" },
  { key: "topps-chrome-update-sapphire", underivable: 49021, catalogRows: 19729, checklistBacked: 18709, title: "2024 Topps Chrome Update Series Sapphire Edition - Gold #USCS348" },
  { key: "panini-rookies-and-stars", underivable: 48255, catalogRows: 211, checklistBacked: 0, title: "2025 Panini Rookies & Stars Football #113 Preferred" },
  { key: "panini-prospect-edition", underivable: 45191, catalogRows: 25634, checklistBacked: 24140, title: "Jacob Misiorowski 2024 Panini Prospect Edition - Aces #25 (RC)" },
  { key: "panini-zenith", underivable: 40213, catalogRows: 6288, checklistBacked: 4862, title: "2024 Panini Zenith Football #12 Base" },
  { key: "panini-prestige", underivable: 39830, catalogRows: 15187, checklistBacked: 13569, title: "2024 Panini Prestige Football #243 Base" },
  { key: "flair", underivable: 39830, catalogRows: 8280, checklistBacked: 2540, title: "1994 Flair USA #38 Larry Johnson - Raw" },
  { key: "panini-court-kings", underivable: 29106, catalogRows: 13996, checklistBacked: 13464, title: "2024 Panini Court Kings Basketball #25 Base" },
  { key: "donruss-studio", underivable: 26042, catalogRows: 1191, checklistBacked: 0, title: "1994 Studio Baseball #172 Base" },
  { key: "panini-diamond-kings", underivable: 25660, catalogRows: 16577, checklistBacked: 16448, title: "2021 Panini Diamond Kings Baseball #D-8 Base" },
  { key: "bowmans-best", underivable: 24128, catalogRows: 88526, checklistBacked: 51573, title: "2023 BOWMANS BEST HENRY BOLTE AUTO - Raw 10" },
  { key: "panini-crusade", underivable: 23362, catalogRows: 13116, checklistBacked: 10961, title: "Endy Rodriguez 2024 Panini Crusade Apprentice Signatures RC Auto #AS" },
  { key: "panini-impeccable", underivable: 19532, catalogRows: 24989, checklistBacked: 23013, title: "2025 Impeccable Silver NFL Shield #8 Tyler Warren RC" },
];

// ═══ V1.1 -- every ruled key is a normalizeSetKey FIXED POINT ═══════════════

describe("V1 -- a ruled key MUST be a normalizeSetKey fixed point", () => {
  const everyRuledKey = [
    ...new Set([...RULED.map((r) => r.stored), ...RULED.map((r) => r.flagship), ...SUPPORTED.map((s) => s.key)]),
  ].sort();

  for (const key of everyRuledKey) {
    it(`normalizeSetKey("${key}") === "${key}"`, () => {
      expect(normalizeSetKey(key)).toBe(key);
    });
  }

  it("the fixed-point property is idempotent under a second pass", () => {
    // A key that normalizes to itself once but not twice would still split a
    // pool -- the writers call normalizeSetKey on whatever they already hold.
    for (const key of everyRuledKey) {
      expect(normalizeSetKey(normalizeSetKey(key))).toBe(key);
    }
  });
});

// ═══ V1.2 -- the derivation never reads a specialized title as the flagship ══

describe("V1 -- the derivation never maps a specialized title to its flagship", () => {
  for (const { stored, flagship, title, sampled } of RULED) {
    it(`"${title.slice(0, 62)}" -> ${stored}, NOT ${flagship} (${sampled} sampled)`, () => {
      const derived = normalizeSetKey(inferSetKeyFromTitle(title, "") || "");
      expect(derived).toBe(stored);
      expect(derived).not.toBe(flagship);
    });
  }

  it("every ruled pair is a DISTINCT pair -- specialized is never its flagship", () => {
    for (const { stored, flagship } of RULED) expect(stored).not.toBe(flagship);
  });
});

// ═══ V1.3 -- the classifier REFUSES the collapse by name, never writable ════

describe("V1 -- a collapse is refused with a named reason and is NEVER writable", () => {
  for (const { stored, flagship, title } of RULED) {
    it(`${stored} -> ${flagship} is a named CONFLICT, writable=false`, () => {
      const r = K.classifyRow({
        row: { id: "r1", cardId: "hiq:x", source: "tca-ebay", title },
        stored: id({ setKey: stored }),
        derived: id({ setKey: flagship }),
        checklistBacked: true,
      });
      expect(r.klass).toBe(K.CONFLICT);
      expect(r.writable).toBe(false);
      // NAMED -- the reason carries the pair, so the census can count the
      // ruling rather than reporting an undifferentiated `changed:setKey`.
      expect(r.reasons.join(" ")).toContain(`collapses-distinct-product:${stored}->${flagship}`);
    });
  }

  it("derivationCollapsesProduct detects EVERY ruled pair", () => {
    for (const { stored, flagship } of RULED) {
      expect(K.derivationCollapsesProduct({ setKey: stored }, { setKey: flagship }))
        .toBe(`${stored}->${flagship}`);
    }
  });

  it("a collapse that ALSO fills a blank axis is still refused", () => {
    // The audit's shape: the collapse read as an improvement because it filled
    // `parallel` somewhere else, and IMPROVE never looked at setKey.
    const r = K.classifyRow({
      row: { id: "r1", source: "tca-ebay", title: "2024 Bowman's Best Baseball #BB-IS" },
      stored: id({ setKey: "bowmans-best", parallel: "" }),
      derived: id({ setKey: "bowman", parallel: "Refractor" }),
      checklistBacked: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/collapses-distinct-product/);
  });

  it("improveRefusals still names the collapse on the IMPROVE path", () => {
    const stored = id({ setKey: "bowman-chrome", cardNumber: "BCP-1" });
    const refusals = K.improveRefusals({
      row: { title: "2022 Bowman BCP-1" },
      stored,
      derived: { ...stored, setKey: "bowman", parallel: "Refractor" },
      axes: { same: [], filled: ["parallel"], dropped: [], changed: ["setKey"] },
    });
    expect(refusals.join(" ")).toMatch(/improve-setkey-collapses-distinct-product/);
  });

  it("every ruled specialized key is in DISTINCT_PRODUCT_SETKEYS", () => {
    for (const { stored } of RULED) expect(K.DISTINCT_PRODUCT_SETKEYS).toContain(stored);
  });
});

// ═══ V1.4 -- the REVERSE direction is IMPROVE ══════════════════════════════

describe("V1 -- generic/defaulted stored -> title-named derived is IMPROVE", () => {
  it("stored `unknown` + a title naming Topps Chrome is a FILL, not a change", () => {
    const r = K.classifyRow({
      row: { id: "r1", source: "tca-ebay", title: "JAMESON WILLIAMS 2025 TOPPS CHROME WHITE REFRACTOR /30 #97 LIONS" },
      stored: id({ setKey: "unknown", parallel: "White Refractor", printRun: 30 }),
      derived: id({ setKey: "topps-chrome", parallel: "White Refractor", printRun: 30 }),
      checklistBacked: true,
    });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.axes.filled).toContain("setKey");
    expect(r.writable).toBe(true);
  });

  it("the old default `bowman` over a title that never says Bowman counts as BLANK", () => {
    // setkey-bowman-default-unsupported -- 60,810 census rows. Any title with
    // "baseball" or "rookie" used to become a Bowman card.
    const r = K.classifyRow({
      row: { id: "r1", source: "tca-ebay", title: "2007-08 Upper Deck Artifacts Rookie #236 TOBIAS ENSTROM 101/599" },
      stored: id({ setKey: "bowman", printRun: 599 }),
      derived: id({ setKey: "upper-deck", printRun: 599 }),
      checklistBacked: true,
    });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.axes.filled).toContain("setKey");
  });

  it("the ruling's own example: bowman + \"Bowman University Chrome\" -> bowman-chrome", () => {
    // The title DOES say bowman, so the defaulted-key test declines it. What
    // qualifies this row is that the derived key strictly refines the stored
    // one AND the title names the added segment.
    const r = K.classifyRow({
      row: { id: "r1", source: "tca-ebay", title: "2025 Bowman University Chrome #BU-1 Refractor" },
      stored: id({ setKey: "bowman", parallel: "Refractor" }),
      derived: id({ setKey: "bowman-chrome", parallel: "Refractor" }),
      checklistBacked: true,
    });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.axes.filled).toContain("setKey");
  });

  it("an IMPROVE-shaped row that is NOT checklist-backed stays CONFLICT", () => {
    // The second gate is untouched: a match proves nothing unless backed.
    const r = K.classifyRow({
      row: { id: "r1", source: "tca-ebay", title: "2025 Topps Chrome #97 White Refractor" },
      stored: id({ setKey: "unknown", parallel: "White Refractor" }),
      derived: id({ setKey: "topps-chrome", parallel: "White Refractor" }),
      checklistBacked: false,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.reasons.join(" ")).toContain("not-checklist-backed");
  });

  // ── the negatives that keep the rung honest ──────────────────────────────

  it("a REAL bowman row is not blank -- bowman -> topps over a Bowman title is CONFLICT", () => {
    const r = K.classifyRow({
      row: { id: "r1", source: "tca-ebay", title: "1953 Bowman Color #96 Sal Maglie PSA NM 7" },
      stored: id({ setKey: "bowman", cardYear: 1953 }),
      derived: id({ setKey: "topps", cardYear: 1953 }),
      checklistBacked: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.axes.changed).toContain("setKey");
  });

  it("an ABSENT title is not evidence the key was defaulted", () => {
    // `!/bowman/.test("")` is true, which would call every titleless stored
    // `bowman` blank on no evidence at all. Absent beats wrong.
    expect(K.storedSetKeyIsDefaulted("bowman", "")).toBe(false);
    expect(K.storedSetKeyIsDefaulted("bowman", null)).toBe(false);
    expect(K.storedSetKeyIsDefaulted("bowman", "2020 Bowman #45 Mookie Betts")).toBe(false);
    expect(K.storedSetKeyIsDefaulted("bowman", "2007-08 Upper Deck Artifacts #236")).toBe(true);
    // `unknown` names no product under any reading, title or no title.
    expect(K.storedSetKeyIsDefaulted("unknown", "")).toBe(true);
  });

  it("a refinement the title does NOT name is refused", () => {
    // "2020 Bowman #45" names nothing beyond Bowman; deriving bowman-chrome
    // from it would be inventing the product, not reading it.
    expect(K.derivationRefinesProduct({ setKey: "bowman" }, { setKey: "bowman-chrome" },
      "2020 Bowman #45 Mookie Betts Red Sox")).toBeNull();
    expect(K.derivationRefinesProduct({ setKey: "bowman" }, { setKey: "bowman-chrome" },
      "2025 Bowman University Chrome #BU-1 Refractor")).toBe("bowman->bowman-chrome");
  });

  it("the two directions of one pair coexist -- and never both fire", () => {
    const title = "2025 Bowman University Chrome #BU-1 Refractor";
    expect(K.derivationCollapsesProduct({ setKey: "bowman-chrome" }, { setKey: "bowman" }))
      .toBe("bowman-chrome->bowman");
    expect(K.derivationRefinesProduct({ setKey: "bowman" }, { setKey: "bowman-chrome" }, title))
      .toBe("bowman->bowman-chrome");
    // No pair is ever both a collapse and a refinement in the SAME direction.
    for (const { stored, flagship } of RULED) {
      const collapse = K.derivationCollapsesProduct({ setKey: stored }, { setKey: flagship });
      const refine = K.derivationRefinesProduct({ setKey: stored }, { setKey: flagship }, "chrome update platinum black sapphire draft picks prospects");
      expect(collapse && refine).toBeFalsy();
    }
  });
});

// ═══ V6 -- the supported setKeys ═══════════════════════════════════════════

describe("V6 -- UNSUPPORTED setKeys added by UNDERIVABLE row count", () => {
  it("is ranked largest-first, as the ruling requires", () => {
    const counts = SUPPORTED.map((s) => s.underivable);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  for (const { key, title, catalogRows, checklistBacked } of SUPPORTED) {
    it(`${key}: derivable from its title, and a fixed point (catalog ${catalogRows} rows, ${checklistBacked} backed)`, () => {
      // 1. THE DERIVATION CAN MINT IT.
      expect(normalizeSetKey(inferSetKeyFromTitle(title, "") || "")).toBe(key);
      // 2. normalizeSetKey HOLDS IT AS A FIXED POINT.
      expect(normalizeSetKey(key)).toBe(key);
      // 3. THE FINISH VOCABULARY ANSWERS FOR IT. The corpus view is defined
      //    for every key -- a key the corpus does not list falls back to the
      //    global union and still suppresses its OWN setKey words, which is
      //    what the product-word guard needs. No synthetic parallels are added
      //    to reach this: an unlisted key is recognized, not invented.
      const vocab = K.VOCAB.vocabularyFor(2024, key);
      expect(vocab).toBeTruthy();
      for (const token of K.VOCAB.setKeyTokens(key)) {
        expect(K.VOCAB.isProductWord(token, key)).toBe(true);
        // its own set words are never read as a finish on its own cards
        expect(vocab.isFinishToken(token)).toBe(false);
      }
    });
  }

  it("no supported key derives to `unknown` or the defaulted `bowman`", () => {
    // Both are what the runner refuses (setkey-unknown-unsupported /
    // setkey-bowman-default-unsupported). A key that still lands on either has
    // not actually been made supported.
    for (const { key, title } of SUPPORTED) {
      const derived = normalizeSetKey(inferSetKeyFromTitle(title, "") || "");
      expect(derived).not.toBe("unknown");
      expect(derived).not.toBe("");
      if (derived === "bowman") expect(/bowman/i.test(title)).toBe(true);
      expect(derived).toBe(key);
    }
  });

  it("a key with no checklist-backed catalog rows is still SUPPORTED", () => {
    // DOCTRINE: no synthetic parallels. panini-hoops, panini-rookies-and-stars
    // and donruss-studio have catalog rows but ZERO checklist-backed ones.
    // They are recognized by the derivation; their destinations stay
    // not-checklist-backed until checklists land, which the classifier's
    // second gate -- untouched here -- is what enforces.
    const unbacked = SUPPORTED.filter((s) => s.checklistBacked === 0);
    expect(unbacked.length).toBeGreaterThan(0);
    for (const { key, title } of unbacked) {
      expect(normalizeSetKey(inferSetKeyFromTitle(title, "") || "")).toBe(key);
    }
    // ...and an unbacked destination is NOT writable, whatever else improved.
    const r = K.classifyRow({
      row: { id: "r1", source: "tca-ebay", title: "2014 Panini Hoops Basketball #157 Base" },
      stored: id({ setKey: "unknown" }),
      derived: id({ setKey: "panini-hoops" }),
      checklistBacked: false,
    });
    expect(r.writable).toBe(false);
    expect(r.reasons.join(" ")).toContain("not-checklist-backed");
  });
});

// ═══ MUTATION REDS ═════════════════════════════════════════════════════════

describe("mutation -- each guard is what stops its own defect", () => {
  it("M1: reverting the ruled-pair table lets bowmans-best -> bowman through", () => {
    // The structural test alone MISSES this pair: "bowmans" is not the segment
    // "bowman", so neither the prefix nor the segment test fires.
    expect(K.derivationCollapsesProduct({ setKey: "bowmans-best" }, { setKey: "bowman" }))
      .toBe("bowmans-best->bowman");
    const structuralOnly = (s: string, d: string) => (s.startsWith(`${d}-`) || s.split("-").includes(d) ? `${s}->${d}` : null);
    expect(structuralOnly("bowmans-best", "bowman")).toBeNull();
  });

  it("M2: the structural test misses the pairs where the flagship is LONGER", () => {
    // Panini owns Donruss, so donruss-elite -> panini-donruss looks like a
    // refinement to any truncation-shaped test.
    const structuralOnly = (s: string, d: string) => (s.startsWith(`${d}-`) || s.split("-").includes(d) ? `${s}->${d}` : null);
    for (const [s, d] of [["donruss-elite", "panini-donruss"], ["donruss-studio", "panini-donruss"], ["diamond-kings", "panini-donruss"]]) {
      expect(structuralOnly(s, d)).toBeNull();
      expect(K.derivationCollapsesProduct({ setKey: s }, { setKey: d })).toBe(`${s}->${d}`);
    }
  });

  it("M3: the structural test reads the lateral Sapphire move as no collapse", () => {
    // bowman-draft-sapphire and bowman-chrome-sapphire share `bowman` and
    // `sapphire`; neither is a prefix of the other.
    const structuralOnly = (s: string, d: string) => (s.startsWith(`${d}-`) || s.split("-").includes(d) ? `${s}->${d}` : null);
    expect(structuralOnly("bowman-draft-sapphire", "bowman-chrome-sapphire")).toBeNull();
    expect(K.derivationCollapsesProduct({ setKey: "bowman-draft-sapphire" }, { setKey: "bowman-chrome-sapphire" }))
      .toBe("bowman-draft-sapphire->bowman-chrome-sapphire");
  });

  it("M4: without the derivation rules, every ruled title reads as its flagship", () => {
    // The defect this PR fixes: the parser read only the flagship brand.
    // Reverting a rule means its title derives the flagship again -- so the
    // pin for each pair in V1.2 is the mutation check for its own rule.
    for (const { stored, title } of RULED) {
      expect(normalizeSetKey(inferSetKeyFromTitle(title, "") || "")).toBe(stored);
    }
  });

  it("M5: without the CONFLICT-side reason, a collapse is an unnamed changed:setKey", () => {
    const r = K.classifyRow({
      row: { id: "r1", source: "tca-ebay", title: "2024 Topps Chrome Update Baseball #USC186 Aqua" },
      stored: id({ setKey: "topps-chrome-update-series", parallel: "Aqua" }),
      derived: id({ setKey: "topps-chrome", parallel: "Aqua" }),
      checklistBacked: true,
    });
    // Reverted, `reasons` would be exactly ["changed:setKey"] -- the ruling
    // and the ordinary disagreements in one undifferentiated pile.
    expect(r.reasons).not.toEqual(["changed:setKey"]);
    expect(r.reasons.join(" ")).toContain("collapses-distinct-product");
  });

  it("M6: without the absent-title guard, a titleless bowman row becomes writable", () => {
    // The shape the existing classifier pin caught: no title, stored `bowman`,
    // derived `bowman-chrome` -- reclassified from CONFLICT to a writable
    // IMPROVE on no evidence whatsoever.
    const r = K.classifyRow({
      row: { id: "r1", cardId: "hiq:x", source: "cardhedge" },
      stored: id({ cardYear: 2026, setKey: "bowman", cardNumber: "CPA-JG", parallel: "Refractor", isAuto: true }),
      derived: id({ cardYear: 2026, setKey: "bowman-chrome", cardNumber: "CPA-JG", parallel: "Refractor", isAuto: true }),
      checklistBacked: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.axes.changed).toContain("setKey");
    expect(r.writable).toBe(false);
  });
});
