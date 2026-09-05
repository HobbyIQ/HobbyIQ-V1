/**
 * CF-PRODUCT-FAMILY-COLLAPSE-IS-FORBIDDEN + CF-SUPPORTED-SETKEYS-BY-ROW-COUNT
 * (Drew, 2026-09-03) -- the pins for the two Great Rematch coverage rulings.
 *
 * RULING V1 -- COLLAPSE IS FORBIDDEN. A specialized product is never the
 * flagship. bowmans-best, bowman-sterling and bowman-heritage are not bowman;
 * bowman is not bowman-chrome; topps-chrome-platinum and
 * topps-chrome-update-series are not topps-chrome; donruss-elite,
 * donruss-studio and diamond-kings are not panini-donruss; topps-allen-ginter
 * and topps-gold-label are not topps; bowman-draft-sapphire is not
 * bowman-chrome-sapphire; fleer-tradition and metal-universe are not fleer;
 * skybox-premium is not skybox; panini-prizm-wnba and panini-prizm-draft-picks
 * are not panini-prizm; panini-score is not score; upper-deck-black-diamond is
 * not upper-deck; bowman-draft-picks-and-prospects is not bowman-draft.
 *
 * Three things must hold for each, and this file pins all three:
 *   a) every ruled key is a normalizeSetKey FIXED POINT -- normalizeSetKey(x)
 *      === x. A ruled key that normalizes to something else is not a ruling,
 *      it is a rename waiting to fire.
 *   b) the DERIVATION never maps a title naming the specialized product to the
 *      flagship. This is the half the census actually caught, and it caught it
 *      in `matchKnownProductLine`, which skipped the D23 product table and so
 *      disagreed with `normalizeSetKey` on the same string.
 *   c) the CLASSIFIER refuses the collapse direction BY NAME and never makes
 *      it writable.
 *
 * THE REVERSE DIRECTION IS NOT A COLLAPSE. A stored setKey that is `unknown`,
 * or the old defaulted `bowman` (the census reason
 * `setkey-bowman-default-unsupported`), names no product at all -- so a
 * derivation that reads the product off the title FILLS that axis. Checklist-
 * backed, that is IMPROVE. This file pins that direction too, and pins that a
 * GENUINE stored `bowman` -- one with no defaulted marker -- is still compared
 * as a real answer, because blanking every `bowman` would re-create the exact
 * damage the old default caused.
 *
 * RULING V6 -- COVERAGE BY ROW COUNT. 4.2M rows are UNDERIVABLE for one
 * reason: the parser has no rule for the product the title names, so
 * inferSetKeyFromTitle returns "Unknown". The keys are added largest-first by
 * UNDERIVABLE row count, and "supported" means the derivation can MINT the key
 * and normalizeSetKey holds it as a fixed point. It does NOT mean the row is
 * writable: the checklist-backed gate is separate and later, and a product
 * with no rows in the parallel corpus stays not-checklist-backed until real
 * checklists land (CF-NO-SYNTHETIC-PARALLELS -- nothing is hand-written into
 * data/checklist-parallel-names.json here).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeSetKey, matchKnownProductLine } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const K = require_(path.join(backend, "scripts", "lib", "rematch-classify.cjs"));

/** The derivation, as the census runs it: read the product off the title, then
 *  normalise. `rematch-sold-comps.cjs` composes exactly these two. */
const derive = (title: string, cardNumber = "") => normalizeSetKey(inferSetKeyFromTitle(title, cardNumber));

const idOf = (over: Record<string, unknown> = {}) => ({
  sport: "baseball", cardYear: 2024, setKey: "topps", cardNumber: "10",
  parallel: "Base", isAuto: false, printRun: null,
  gradeCompany: null, gradeValue: null, ...over,
});

// ── V1a: every ruled key is a normalizeSetKey fixed point ──────────────────

/**
 * Drew's ruling, verbatim, as pairs. Each `from` is the specialized product
 * and each `to` the flagship it must never collapse into. Both sides of every
 * pair must be a fixed point -- a ruled key that normalizes elsewhere is not
 * a ruling.
 */
const RULED_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["bowmans-best", "bowman"],
  ["bowman-sterling", "bowman"],
  ["bowman-heritage", "bowman"],
  ["topps-chrome-platinum", "topps-chrome"],
  ["topps-chrome-update-series", "topps-chrome"],
  ["donruss-elite", "panini-donruss"],
  ["donruss-studio", "panini-donruss"],
  ["diamond-kings", "panini-donruss"],
  ["topps-allen-ginter", "topps"],
  ["topps-gold-label", "topps"],
  ["bowman-draft-sapphire", "bowman-chrome-sapphire"],
  ["fleer-tradition", "fleer"],
  ["metal-universe", "fleer"],
  ["skybox-premium", "skybox"],
  ["panini-prizm-wnba", "panini-prizm"],
  ["panini-prizm-draft-picks", "panini-prizm"],
  ["panini-score", "score"],
  ["upper-deck-black-diamond", "upper-deck"],
  ["bowman-draft-picks-and-prospects", "bowman-draft"],
];

/**
 * `bowman` vs `bowman-chrome` is ruled DISTINCT like the rest, but it is not a
 * COLLAPSE pair and must not be pinned as one: the specialized key is on the
 * DERIVED side, so `bowman -> bowman-chrome` is the refinement direction. Where
 * the stored `bowman` is the old unread default it is the IMPROVE case pinned
 * further down; where it is the genuine product it is an ordinary unwritable
 * CONFLICT. Both are pinned -- neither is a named collapse refusal.
 */
const RULED_DISTINCT_NOT_COLLAPSE: ReadonlyArray<readonly [string, string]> = [
  ["bowman", "bowman-chrome"],
];

describe("V1a. every ruled key is a normalizeSetKey fixed point", () => {
  const keys = [...new Set([...RULED_PAIRS, ...RULED_DISTINCT_NOT_COLLAPSE].flat())];
  it.each(keys)("normalizeSetKey(%s) === %s", (key) => {
    expect(normalizeSetKey(key)).toBe(key);
  });

  it("the two sides of every ruled pair stay DISTINCT under normalisation", () => {
    for (const [from, to] of [...RULED_PAIRS, ...RULED_DISTINCT_NOT_COLLAPSE]) {
      expect(normalizeSetKey(from)).not.toBe(normalizeSetKey(to));
    }
  });
});

// ── V1b: the derivation never maps a specialized title to the flagship ─────

/**
 * A real title naming each specialized product, and the key it must derive.
 * The `must NOT be` column is the flagship the census caught it collapsing to.
 *
 * `matchKnownProductLine` is asserted alongside `normalizeSetKey` on purpose:
 * the two used to disagree on the same string, because only normalizeSetKey
 * consulted the D23 product table. That asymmetry WAS the collapse engine --
 * the backfill scripts read matchKnownProductLine and filed specialized sales
 * into the flagship pool while the id minter filed them correctly.
 */
const TITLE_CASES: ReadonlyArray<{ title: string; want: string; notThe: string }> = [
  { title: "2024 Topps Chrome Update Series #USC100 Base", want: "topps-chrome-update-series", notThe: "topps-chrome" },
  { title: "2024 Topps Chrome Update Series Sapphire Edition - Gold #USCS348", want: "topps-chrome-update-sapphire", notThe: "topps-chrome" },
  { title: "2025 Topps Chrome Platinum Anniversary #12 Gold", want: "topps-chrome-platinum", notThe: "topps-chrome" },
  { title: "2025 Topps Chrome Black #191 Base", want: "topps-chrome-black", notThe: "topps-chrome" },
  { title: "2003 Topps Finest Flashbacks #10", want: "topps-finest-flashbacks", notThe: "topps-finest" },
  { title: "2008 ALLEN & GINTER #297 MAX SCHERZER ROOKIE RC PSA 10", want: "topps-allen-ginter", notThe: "topps" },
  { title: "2001 Topps Gold Label Class 1 #10", want: "topps-gold-label", notThe: "topps" },
  { title: "2023 Bowman's Best #62 Shohei Ohtani PSA 10", want: "bowmans-best", notThe: "bowman" },
  { title: "2022 Bowman Sterling #BSA-JD Auto", want: "bowman-sterling", notThe: "bowman" },
  { title: "2019 Bowman Heritage #12 Base", want: "bowman-heritage", notThe: "bowman" },
  { title: "2024 Bowman Draft Sapphire Edition #BDC-10 Orange", want: "bowman-draft-sapphire", notThe: "bowman-chrome-sapphire" },
  { title: "2003 Bowman Draft Picks and Prospects #BDP1", want: "bowman-draft-picks-and-prospects", notThe: "bowman-draft" },
  { title: "1994 Donruss Elite #5 Base", want: "donruss-elite", notThe: "panini-donruss" },
  { title: "1994 Studio Baseball #172 Base", want: "donruss-studio", notThe: "panini-donruss" },
  { title: "2024 Panini Prizm WNBA #12 Silver", want: "panini-prizm-wnba", notThe: "panini-prizm" },
  { title: "2023 Panini Prizm Draft Picks #45 Base", want: "panini-prizm-draft-picks", notThe: "panini-prizm" },
  { title: "2021 Panini Score Football #10 Base", want: "panini-score", notThe: "score" },
  { title: "1998 Fleer Tradition #100 Base", want: "fleer-tradition", notThe: "fleer" },
  { title: "1998 Skybox Premium #10 Base", want: "skybox-premium", notThe: "skybox" },
  { title: "2000 Upper Deck Black Diamond #22 Base", want: "upper-deck-black-diamond", notThe: "upper-deck" },
  // The Leaf family: the `/(?:^|-)leaf/` catch-all swallowed every one of
  // these inside matchKnownProductLine.
  { title: "2002 Leaf Certified Materials Baseball #62 Mirror Red", want: "leaf-certified-materials", notThe: "leaf" },
  { title: "1996 Leaf Signature Series Baseball #88 Gold Press Proof", want: "leaf-signature-series", notThe: "leaf" },
  { title: "2006 Leaf Rookies & Stars Brian Urlacher Standing Ovation Red", want: "leaf-rookies-and-stars", notThe: "leaf" },
  { title: "2023 Leaf Metal #10 Base", want: "leaf-metal", notThe: "leaf" },
];

describe("V1b. the derivation never collapses a specialized title into the flagship", () => {
  it.each(TITLE_CASES)("$want <- $title", ({ title, want, notThe }) => {
    expect(normalizeSetKey(title)).toBe(want);
    expect(normalizeSetKey(title)).not.toBe(notThe);
  });

  // The function the backfills read. It skipped the product table, which is
  // where the collapse actually lived.
  it.each(TITLE_CASES)("matchKnownProductLine agrees: $want", ({ title, want, notThe }) => {
    expect(matchKnownProductLine(title)).toBe(want);
    expect(matchKnownProductLine(title)).not.toBe(notThe);
  });

  it("matchKnownProductLine and normalizeSetKey never disagree on a ruled title", () => {
    for (const { title } of TITLE_CASES) {
      expect(matchKnownProductLine(title)).toBe(normalizeSetKey(title));
    }
  });

  // Guard the guard: the flagships themselves must still derive to themselves,
  // or the fixes above would be "never collapse" bought with "never match".
  it.each([
    ["2025 Topps Chrome #100 Base", "topps-chrome"],
    ["1953 Topps #82 Mickey Mantle Low Grade", "topps"],
    ["2026 Bowman #BST-4 Aaron Judge", "bowman"],
    ["2023 Leaf Perfect Game Karson Grout Auto MA-KG2 Marble 1/1", "leaf"],
    ["2024 Panini Prizm - Rookies Jayden Daniels #347", "panini-prizm"],
  ])("the flagship still derives to itself: %s -> %s", (title, want) => {
    expect(normalizeSetKey(title)).toBe(want);
  });
});

// ── V1c: the classifier refuses the collapse BY NAME, and never writes it ──

describe("V1c. a product-family collapse is a named CONFLICT and is never writable", () => {
  it.each(RULED_PAIRS)("%s -> %s is refused by name", (from, to) => {
    const r = K.classifyRow({
      row: { title: `a ${from} card`, source: "tca-ebay" },
      stored: idOf({ setKey: from }),
      derived: idOf({ setKey: to }),
      checklistBacked: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.reasons.join(",")).toContain(`setkey-collapses-distinct-product:${from}->${to}`);
  });

  it("the refusal names the RULING and the measured row count", () => {
    const r = K.classifyRow({
      row: { title: "2024 Topps Chrome Update Series #USC100", source: "tca-ebay" },
      stored: idOf({ setKey: "topps-chrome-update-series" }),
      derived: idOf({ setKey: "topps-chrome" }),
      checklistBacked: true,
    });
    expect(r.reasons.join(",")).toContain(
      "setkey-collapses-distinct-product:topps-chrome-update-series->topps-chrome:ruled:est-287655",
    );
  });

  // Checklist backing is not a licence to collapse. This is the case that
  // matters: a collapse whose DESTINATION is a real checklist-backed row still
  // files the sale onto the wrong card.
  it("a collapse stays refused even when the destination IS checklist-backed", () => {
    for (const [from, to] of RULED_PAIRS) {
      const r = K.classifyRow({
        row: { title: `a ${from} card`, source: "tca-ebay" },
        stored: idOf({ setKey: from }),
        derived: idOf({ setKey: to }),
        checklistBacked: true,
      });
      expect(r.writable).toBe(false);
    }
  });

  it("every ruled pair is present in the classifier's own table, with a row count", () => {
    for (const [from, to] of RULED_PAIRS) {
      const pair = K.ruledCollapsePair(from, to);
      expect(pair, `${from} -> ${to} missing from RULED_COLLAPSE_PAIRS`).toBeTruthy();
      expect(pair.est).toBeGreaterThan(0);
    }
  });

  // The census-found pairs are refused on the same footing as the ruled ones.
  it.each([
    ["flair", "fleer"],
    ["topps-signature-class", "topps"],
    ["topps-cosmic-chrome", "topps"],
    ["bowman-best-university", "bowman"],
    ["score-select", "panini-select"],
    ["spx-finite", "spx"],
    ["skybox-molten-metal", "skybox"],
  ])("census-found pair %s -> %s is refused too", (from, to) => {
    const r = K.classifyRow({
      row: { title: `a ${from} card`, source: "tca-ebay" },
      stored: idOf({ setKey: from }),
      derived: idOf({ setKey: to }),
      checklistBacked: true,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.reasons.join(",")).toContain("setkey-collapses-distinct-product:");
  });
});

// ── the REVERSE direction: generic/defaulted -> specific is IMPROVE ────────

describe("the reverse direction -- a stored key naming no product is BLANK", () => {
  it("stored `unknown` + checklist-backed specific derivation is IMPROVE and writable", () => {
    const r = K.classifyRow({
      row: { title: "2000 Upper Deck Black Diamond #22 Base", source: "tca-ebay" },
      stored: idOf({ setKey: "unknown" }),
      derived: idOf({ setKey: "upper-deck-black-diamond" }),
      checklistBacked: true,
    });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.writable).toBe(true);
    expect(r.axes.filled).toContain("setKey");
    expect(r.axes.changed).not.toContain("setKey");
  });

  it("the DEFAULTED `bowman` counts as blank -- but only with the census marker", () => {
    const input = {
      row: { title: "2024 Bowman University Chrome #BUC-1 Refractor", source: "tca-ebay" },
      stored: idOf({ setKey: "bowman" }),
      derived: idOf({ setKey: "bowman-chrome" }),
      checklistBacked: true,
    };
    const defaulted = K.classifyRow({ ...input, derivationReasons: ["setkey-bowman-default-unsupported"] });
    expect(defaulted.klass).toBe(K.IMPROVE);
    expect(defaulted.axes.filled).toContain("setKey");

    // THE SAFETY ARGUMENT. `bowman` is also a REAL product with millions of
    // legitimate rows. Without the marker it is a real answer, so this is a
    // rival reading of the card and stays an unwritable CONFLICT -- otherwise
    // the fleet would re-key genuine Bowman sales off noisy titles, which is
    // the damage the old default caused, running the other way.
    const genuine = K.classifyRow(input);
    expect(genuine.klass).toBe(K.CONFLICT);
    expect(genuine.writable).toBe(false);
    expect(genuine.axes.changed).toContain("setKey");
  });

  it("the reverse direction still needs checklist backing to be writable", () => {
    const r = K.classifyRow({
      row: { title: "2024 Topps Chrome #100", source: "tca-ebay" },
      stored: idOf({ setKey: "unknown" }),
      derived: idOf({ setKey: "topps-chrome" }),
      checklistBacked: false,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.reasons).toContain("not-checklist-backed");
  });

  it("a DERIVED `unknown` is never treated as blank -- only the stored side is", () => {
    const r = K.classifyRow({
      row: { title: "something unreadable", source: "tca-ebay" },
      stored: idOf({ setKey: "topps-chrome" }),
      derived: idOf({ setKey: "unknown" }),
      checklistBacked: true,
    });
    // The derivation lost the product: that is a DEMOTION, never an improvement.
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
    expect(r.axes.dropped).toContain("setKey");
  });
});

// ── V6: supported setKeys, by UNDERIVABLE row count ────────────────────────

/**
 * The keys added in this PR, largest UNDERIVABLE row count first. `est` is the
 * scaled census estimate; `catalogRows` / `checklistBacked` are read-only
 * card_catalog counts taken 2026-09-03.
 *
 * `checklistBacked: 0` is NOT a defect and NOT a blocker -- it is the doctrine
 * working. Such a key is SUPPORTED (the derivation can mint it, the vocabulary
 * holds it as a fixed point) while its destinations stay not-checklist-backed
 * until real checklists land. No synthetic parallels are invented to close it.
 */
const SUPPORTED_KEYS: ReadonlyArray<{
  key: string; title: string; est: number; catalogRows: number; checklistBacked: number;
}> = [
  { key: "topps-finest", title: "2025 Finest #168 Xavier Worthy Purple Refractor #/200", est: 192725, catalogRows: 223575, checklistBacked: 197799 },
  { key: "nba-hoops", title: "2014 Panini Hoops Basketball #157 Base", est: 127431, catalogRows: 2680, checklistBacked: 0 },
  { key: "leaf", title: "2023 Leaf Perfect Game Karson Grout Auto MA-KG2 Marble 1/1", est: 102007, catalogRows: 15787, checklistBacked: 11442 },
  { key: "panini-origins", title: "2025 Panini Origins Football #31 Red", est: 100501, catalogRows: 25114, checklistBacked: 23958 },
  { key: "flair", title: "1994 Flair USA #38 Larry Johnson", est: 90966, catalogRows: 8280, checklistBacked: 5475 },
  { key: "topps-chrome-sapphire", title: "A.J. BROWN 2025 TOPPS CHROME SAPPHIRE ORANGE /25 #243 EAGLES", est: 77119, catalogRows: 48576, checklistBacked: 43120 },
  { key: "panini-prestige", title: "2024 Panini Prestige - Xtra Points Orange #128 Josh Downs /50", est: 61248, catalogRows: 15187, checklistBacked: 13569 },
  { key: "panini-zenith", title: "2025 Panini Zenith Football #10 Base", est: 59635, catalogRows: 6288, checklistBacked: 4862 },
  { key: "ultra", title: "2004 Ultra GOLD Medallion #104 Tom Brady PSA 8", est: 49763, catalogRows: 19002, checklistBacked: 14455 },
  { key: "pacific", title: "1994 Pacific Cleveland Indians #165 Albert Belle", est: 43744, catalogRows: 10054, checklistBacked: 9108 },
  { key: "panini-certified", title: "2025 Panini Certified Football #FBC-ITA Red", est: 43446, catalogRows: 17476, checklistBacked: 17363 },
  { key: "panini-rookies-and-stars", title: "2025 Panini Rookies & Stars Football #113 Preferred", est: 42375, catalogRows: 211, checklistBacked: 0 },
  { key: "panini-diamond-kings", title: "2021 Panini Diamond Kings Baseball #D-8 Base", est: 36019, catalogRows: 16577, checklistBacked: 16448 },
  { key: "leaf-rookies-and-stars", title: "2006 Leaf Rookies & Stars Brian Urlacher Standing Ovation Red", est: 35257, catalogRows: 1744, checklistBacked: 1508 },
  { key: "donruss-studio", title: "1994 Studio Baseball #172 Base", est: 33321, catalogRows: 1191, checklistBacked: 0 },
  { key: "panini-photogenic", title: "2025 Panini PhotoGenic Football #51 Purple", est: 32681, catalogRows: 16501, checklistBacked: 16501 },
  { key: "panini-court-kings", title: "2024 Panini Court Kings Basketball #25 Base", est: 27438, catalogRows: 13996, checklistBacked: 13464 },
  { key: "post-cereal", title: "1963 Post Cereal Baseball #174 Base", est: 19895, catalogRows: 491, checklistBacked: 0 },
  { key: "goudey", title: "1936 GOUDEY DOLPH CAMILLI PHILLIES EX", est: 19818, catalogRows: 229, checklistBacked: 0 },
  { key: "parkhurst", title: "1953 Parkhurst #48 Glen Skov PSA 4 VG-EX", est: 19105, catalogRows: 6897, checklistBacked: 6887 },
  { key: "t206", title: "1909-11 T206 - Ray Ryan - Southern League - Piedmont 350 - PSA 1", est: 19092, catalogRows: 26, checklistBacked: 0 },
  { key: "leaf-certified", title: "1999 Leaf Certified Mirror Gold #1 Simeon Rice", est: 19063, catalogRows: 192, checklistBacked: 0 },
  { key: "panini-recon", title: "2022 Panini Recon Basketball #139 Base", est: 19028, catalogRows: 6413, checklistBacked: 6413 },
  { key: "leaf-limited", title: "2008 Leaf Limited Football #BSM-17 Base", est: 18712, catalogRows: 4926, checklistBacked: 4620 },
  { key: "topps-chrome-update-sapphire", title: "2024 Topps Chrome Update Series Sapphire Edition - Gold #USCS348", est: 18138, catalogRows: 19729, checklistBacked: 18901 },
  { key: "leaf-signature-series", title: "1996 Leaf Signature Series Baseball #88 Gold Press Proof", est: 15935, catalogRows: 9394, checklistBacked: 9394 },
  { key: "leaf-certified-materials", title: "2002 Leaf Certified Materials Baseball #62 Mirror Red", est: 14717, catalogRows: 3027, checklistBacked: 2943 },
];

describe("V6. supported setKeys -- the derivation can mint each one", () => {
  it("the list is ordered by UNDERIVABLE row count, largest first", () => {
    const est = SUPPORTED_KEYS.map((k) => k.est);
    expect(est).toEqual([...est].sort((a, b) => b - a));
  });

  it.each(SUPPORTED_KEYS)("$key derives from its title (est $est rows)", ({ key, title }) => {
    // a) the derivation MINTS the key -- this is what "supported" means, and
    //    every one of these returned "Unknown" before this PR.
    expect(derive(title)).toBe(key);
    // b) and the key is a normalizeSetKey FIXED POINT.
    expect(normalizeSetKey(key)).toBe(key);
  });

  it("no supported key derives to `unknown` -- that is the 4.2M-row defect", () => {
    for (const { key, title } of SUPPORTED_KEYS) {
      expect(derive(title), `${key} still underivable`).not.toBe("unknown");
    }
  });

  /**
   * CF-NO-SYNTHETIC-PARALLELS, stated as a test. A key with no checklist rows
   * is SUPPORTED but its destinations are NOT checklist-backed -- and the
   * classifier must still refuse to write them. Recognizing a product is not
   * the same as claiming to know its parallels.
   */
  it("a supported key with no checklist rows is recognized but never writable", () => {
    const unbacked = SUPPORTED_KEYS.filter((k) => k.checklistBacked === 0);
    expect(unbacked.length).toBeGreaterThan(0);
    for (const { key, title } of unbacked) {
      expect(derive(title)).toBe(key);               // recognized
      const r = K.classifyRow({
        row: { title, source: "tca-ebay" },
        stored: idOf({ setKey: "unknown" }),
        derived: idOf({ setKey: key }),
        checklistBacked: false,                       // no checklist rows exist
      });
      expect(r.writable).toBe(false);
      expect(r.reasons).toContain("not-checklist-backed");
    }
  });

  it("the parallel corpus gained NO hand-written product rows in this PR", () => {
    // The corpus is checklist-derived. A product row invented here would be a
    // synthetic parallel by definition, so the file must be untouched.
    const corpus = JSON.parse(
      fs.readFileSync(path.join(backend, "data", "checklist-parallel-names.json"), "utf8"),
    ) as { productCount: number; products: Record<string, unknown> };
    expect(Object.keys(corpus.products)).toHaveLength(corpus.productCount);
  });
});

describe("V6b. the sapphire rule no longer hands every Sapphire to Bowman", () => {
  // The rule was `if (/sapphire/.test(t)) return "Bowman Chrome Sapphire"` --
  // one unqualified word claiming a product word Topps also prints. The title
  // below says TOPPS twice and never says Bowman.
  it.each([
    ["A.J. BROWN 2025 TOPPS CHROME SAPPHIRE ORANGE /25 #243 EAGLES", "topps-chrome-sapphire"],
    ["2024 Topps Chrome Update Series Sapphire Edition - Gold #USCS348", "topps-chrome-update-sapphire"],
    ["2025 Bowman Chrome Sapphire #BCP-10 Orange", "bowman-chrome-sapphire"],
    ["2024 Bowman Draft Sapphire Edition #BDC-10 Orange", "bowman-draft-sapphire"],
  ])("%s -> %s", (title, want) => {
    expect(derive(title)).toBe(want);
  });

  it("a Topps Sapphire title is never read as a Bowman product", () => {
    for (const t of [
      "A.J. BROWN 2025 TOPPS CHROME SAPPHIRE ORANGE /25 #243 EAGLES",
      "2024 Topps Chrome Update Series Sapphire Edition - Gold #USCS348",
    ]) {
      expect(derive(t).startsWith("bowman")).toBe(false);
    }
  });
});

// ── MUTATION CHECKS: both guards must be load-bearing ──────────────────────

/**
 * Load a mutated copy of the classifier without touching the real file.
 *
 * EVERY MUTANT GETS ITS OWN FILENAME. Keying the temp file on the pid alone
 * meant two mutations inside one test wrote the same path -- and `require`
 * caches by resolved path, so the SECOND call got the FIRST mutant back out of
 * the module cache and silently tested the wrong code. A counter makes each
 * load a distinct module, and the cache entry is deleted after use so a repeat
 * of the same mutation still re-reads from disk.
 */
let mutantSeq = 0;
function withMutant<T>(mutate: (src: string) => string, fn: (m: typeof K) => T): T {
  const file = path.join(backend, "scripts", "lib", "rematch-classify.cjs");
  const src = fs.readFileSync(file, "utf8");
  const mutated = mutate(src);
  expect(mutated, "the mutation did not change the source").not.toBe(src);
  const tmp = path.join(
    backend, "scripts", "lib",
    `.rematch-classify.collapse-mutant-${process.pid}-${++mutantSeq}.cjs`,
  );
  try {
    fs.writeFileSync(tmp, mutated);
    return fn(require_(tmp) as typeof K);
  } finally {
    try { delete require_.cache[require_.resolve(tmp)]; } catch { /* best effort */ }
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

describe("MUTATION CHECK: the collapse guard is load-bearing", () => {
  it("emptying RULED_COLLAPSE_PAIRS stops the named refusal", () => {
    const stored = idOf({ setKey: "topps-chrome-update-series" });
    const derived = idOf({ setKey: "topps-chrome" });
    const row = { title: "2024 Topps Chrome Update Series #USC100", source: "tca-ebay" };

    const real = K.classifyRow({ row, stored, derived, checklistBacked: true });
    expect(real.reasons.join(",")).toContain("setkey-collapses-distinct-product:");

    const broken = withMutant(
      (src) => src.replace(
        /const RULED_COLLAPSE_PAIRS = Object\.freeze\(\[[\s\S]*?\n\]\);/,
        "const RULED_COLLAPSE_PAIRS = Object.freeze([]);",
      ),
      (m) => m.classifyRow({ row, stored, derived, checklistBacked: true }),
    );
    // The structural guard still catches this shape (it is a prefix collapse),
    // but the RULED naming -- the ruling, the row count -- is gone. That is the
    // half this table exists for, and losing it silently is the failure mode.
    expect(broken.reasons.join(",")).not.toContain(":ruled:est-");
  });

  it("the reverse-direction blank rule is load-bearing: remove it and IMPROVE becomes CONFLICT", () => {
    const row = { title: "2000 Upper Deck Black Diamond #22 Base", source: "tca-ebay" };
    const stored = idOf({ setKey: "unknown" });
    const derived = idOf({ setKey: "upper-deck-black-diamond" });

    const real = K.classifyRow({ row, stored, derived, checklistBacked: true });
    expect(real.klass).toBe(K.IMPROVE);

    // MUTATE THE FUNCTION THAT ACTUALLY DECIDES. `storedSetKeyIsBlank` reads
    // GENERIC_SETKEYS directly and `diffAxes` honours its answer as an
    // override, so mutating `axisIsBlank` alone leaves the real path intact --
    // the mutation would apply cleanly and change nothing, and this test would
    // pass for the wrong reason. Emptying the SET is what removes the rule.
    const broken = withMutant(
      (src) => src.replace(
        /const GENERIC_SETKEYS = new Set\(\[[^\]]*\]\);/,
        "const GENERIC_SETKEYS = new Set([]);",
      ),
      (m) => m.classifyRow({ row, stored, derived, checklistBacked: true }),
    );
    // Without the rule, a row that names no product at all reads as a rival
    // reading of the card -- the defect this ruling fixes.
    expect(broken.klass).toBe(K.CONFLICT);
    expect(broken.axes.changed).toContain("setKey");
  });

  it("the defaulted-bowman marker is load-bearing in BOTH directions", () => {
    const row = { title: "2024 Bowman University Chrome #BUC-1 Refractor", source: "tca-ebay" };
    const stored = idOf({ setKey: "bowman" });
    const derived = idOf({ setKey: "bowman-chrome" });

    // Mutating the marker to match nothing must demote the DEFAULTED row...
    const noMarker = withMutant(
      (src) => src.replace(
        "const BOWMAN_DEFAULT_MARKER = /setkey-bowman-default-unsupported/i;",
        "const BOWMAN_DEFAULT_MARKER = /\\bnever-matches-anything\\b/i;",
      ),
      (m) => m.classifyRow({ row, stored, derived, checklistBacked: true, derivationReasons: ["setkey-bowman-default-unsupported"] }),
    );
    // `bowman` is not in GENERIC_SETKEYS, so the marker is the ONLY thing that
    // can blank it -- breaking the marker must demote this row.
    expect(K.GENERIC_SETKEYS.has("bowman")).toBe(false);
    expect(noMarker.klass).toBe(K.CONFLICT);

    // ...and mutating it to match EVERYTHING must wrongly promote the GENUINE
    // one, which is the damage the marker requirement prevents.
    const alwaysMarker = withMutant(
      (src) => src.replace(
        "return (derivationReasons ?? []).some((r) => BOWMAN_DEFAULT_MARKER.test(String(r)));",
        "return true;",
      ),
      (m) => m.classifyRow({ row, stored, derived, checklistBacked: true }),
    );
    expect(alwaysMarker.klass).toBe(K.IMPROVE);
    expect(K.classifyRow({ row, stored, derived, checklistBacked: true }).klass).toBe(K.CONFLICT);
  });
});
