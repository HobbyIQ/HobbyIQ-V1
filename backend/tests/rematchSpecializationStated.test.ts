/**
 * CF-A-TIFFANY-SALE-IS-A-TIFFANY-CARD, applied to the Great Rematch.
 * SPECIALIZATION-STATED — the IMPROVE subclass, and the five legs it stands on.
 *
 * THE ROW THAT MOTIVATED IT. Drew's 1987 Topps Traded Tiffany Greg Maddux #70T
 * (PSA 10) published $148.32 against a $910–$1,560 market, because 23 Tiffany
 * PSA 10 sales sat in the flagship pool `hiq:baseball:1987:topps:70t:base:no-auto`
 * beside ~121 non-Tiffany Traded PSA 10 sales at ~$150. #1715 taught the parser
 * to read "Traded Tiffany", but the classifier returned CONFLICT
 * (changed:setKey) for 341 of the pool's 365 rows, so the rematch could not
 * repair a single one. #1715 said so in its own body: "That gate needs a
 * separate ruling." This is that ruling, and these are its pins.
 *
 * The titles below are the REAL ones from the pool, not invented fixtures.
 *
 * THE TWO MUTATION PINS ARE THE LOAD-BEARING TESTS. Everything else here
 * asserts the subclass does what it says; those two assert it stops doing it
 * when a leg is removed:
 *
 *   1. DROP THE title-states-every-word LEG (L2) — a title that never says
 *      "tiffany" must not reach topps-traded-tiffany. Without L2 the subclass
 *      is not evidence, it is the ladder guessing, and it would re-key the
 *      ~121 plain Traded sales onto the Tiffany card — the exact collision
 *      inverted, at 5x the row count.
 *   2. ACCEPT derived-from-base AS BACKING (L3) — `derived-from-base-checklist-*`
 *      mints a specialization's catalog rows by COPYING the flagship's, so it
 *      answers "does this specialization list this card?" YES for every card in
 *      the parent set. Accepting it would make the checklist gate a tautology.
 *      Measured: all 453 `bowman-tiffany` catalog rows carry that source.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { productAncestry, productEntry, SAME_NUMBER_PARALLEL_SETS, isSameNumberParallelSet } from "../src/services/catalog/productSetKeys.js";
import { normalizeSetKey, computeHobbyIqCardId } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";
import { MINTS as SOCCER_TITLES } from "./soccerLeagueSetKeysFromTitle.test.js";

/** The keys #1715 taught the parser, each with a title that states it. */
const TIFFANY_MINT_CASES: ReadonlyArray<readonly [string, string]> = [
  ["1987 Topps Traded Tiffany Greg Maddux #70T", "topps-traded-tiffany"],
  ["1987 Topps Traded Greg Maddux #70T", "topps-traded"],
  ["1988 Topps Tiffany George Brett #400", "topps-tiffany"],
  ["1990 Bowman Tiffany Greg Maddux #27", "bowman-tiffany"],
];

/**
 * The mirrored edges no other corpus in this file reaches, each with a title
 * that states the product:
 *
 *   `topps-tier-one`  — the soccer corpus reaches it only in its Bundesliga
 *                       spelling; the bare product is its own edge.
 *   the Bowman Draft trio (#1912) — the Paper spelling is deliberate: the
 *                       parser's Paper rule reads "1st Paper" / "Paper
 *                       Prospect", which is how the product is written, and a
 *                       bare "Bowman Draft Paper" is `bowman-draft`.
 */
const OTHER_MINT_TITLES: readonly string[] = [
  "2021 Topps Tier One Shohei Ohtani Auto",
  "2024 Bowman Draft Cooper Flagg #BD-1",
  "2024 Bowman Draft 1st Paper Prospect Cooper Flagg #BDP-1",
  "2024 Bowman Draft Sapphire Edition Cooper Flagg #BDC-1",
];

/** The title each unmintable key WOULD be minted from, once it has a rule. */
const MINTABLE_PROBES: Readonly<Record<string, string>> = {
  "fleer-tiffany": "1996 Fleer Tiffany Chipper Jones #300",
  "fleer-glossy": "1996 Fleer Glossy Derek Jeter #185",
  "fleer-update-tiffany": "1997 Fleer Update Tiffany Vladimir Guerrero #U12",
  "fleer-update-glossy": "1997 Fleer Update Glossy Nomar Garciaparra #U3",
  "fleer-tradition-tiffany": "1999 Fleer Tradition Tiffany Ken Griffey Jr #100",
  sp: "1994 SP Alex Rodriguez #15 Foil",
  "sp-championship": "1995 SP Championship Chipper Jones #12",
  "upper-deck-minors": "1994 Upper Deck Minors Derek Jeter #1",
  "upper-deck-black-diamond": "1999 Upper Deck Black Diamond Ken Griffey Jr #D24",
  "score-rookie-and-traded": "1992 Score Rookie & Traded Mike Piazza #T1",
  "pacific-prism": "1997 Pacific Prism Ken Griffey Jr #10",
  "pacific-crown-collection": "1998 Pacific Crown Collection Mark McGwire #250",
  "pacific-gold-crown-die-cuts": "1998 Pacific Gold Crown Die Cuts Sammy Sosa #12",
};

/**
 * MEASURED, NOT ASSUMED: the mirrored keys NO title can mint today.
 *
 * Taken by running `inferSetKeyFromTitle` over a real-shaped title for each
 * (2026-09-06). Every one comes back as its FLAGSHIP, so the ladder edge
 * exists and the derivation can never reach it — the "silently dead edge" the
 * pin below exists to forbid:
 *
 *   1996 Fleer Tiffany / Glossy            -> fleer        (not fleer-tiffany)
 *   1997 Fleer Update Tiffany / Glossy     -> fleer-update
 *   1999 Fleer Tradition Tiffany           -> fleer
 *   1994 SP, 1995 SP Championship          -> unknown
 *   1994 Upper Deck Minors                 -> upper-deck
 *   1999 Upper Deck Black Diamond          -> upper-deck
 *   1992 Score Rookie & Traded             -> score
 *   1997 Pacific Prism / Crown Collection /
 *        Gold Crown Die Cuts               -> pacific
 *
 * They are LISTED rather than fixed here because each needs its own parser
 * rule and its own evidence, which is a different change from #1863's soccer
 * ruling. The list is the point: a key may sit here only deliberately, and the
 * pin fails the day a NEW edge is added without a rule — which is exactly how
 * the 66 soccer edges would have been caught had this pin existed.
 */
const KNOWN_UNMINTABLE: readonly string[] = [
  "fleer-tiffany",
  "fleer-glossy",
  "fleer-update-tiffany",
  "fleer-update-glossy",
  "fleer-tradition-tiffany",
  "sp",
  "sp-championship",
  "upper-deck-minors",
  "upper-deck-black-diamond",
  "score-rookie-and-traded",
  "pacific-prism",
  "pacific-crown-collection",
  "pacific-gold-crown-die-cuts",
];

const require_ = createRequire(import.meta.url);
const K = require_("../scripts/lib/rematch-classify.cjs");

// ── the real Maddux fixtures ────────────────────────────────────────────────

/** The Tiffany title, verbatim from the pool. */
const TIFFANY_TITLE = "1987 TOPPS TRADED TIFFANY #70T GREG MADDUX RC CUBS HOF PSA 10";
/** The ~$150 population that shares the pool — Traded, NOT Tiffany. */
const TRADED_TITLE = "1987 Topps Traded Greg Maddux #70T Cubs Rookie PSA 10";

const STORED_FLAGSHIP = {
  sport: "baseball", cardYear: 1987, setKey: "topps", cardNumber: "70T",
  parallel: "Base", isAuto: false, printRun: null, gradeCompany: "PSA", gradeValue: 10,
};
const row = (title: string, over: Record<string, unknown> = {}) => ({
  id: "sale-1", title, source: "ebay-scrape",
  cardId: "hiq:baseball:1987:topps:70t:base:no-auto", ...over,
});
type Opts = Record<string, unknown>;
const classify = (title: string, derivedSetKey: string, o: Opts = {}) => K.classifyRow({
  row: row(title, (o.rowOver as object) ?? {}),
  stored: { ...STORED_FLAGSHIP, ...((o.storedOver as object) ?? {}) },
  derived: { ...STORED_FLAGSHIP, ...((o.storedOver as object) ?? {}), ...((o.derivedOver as object) ?? {}), setKey: derivedSetKey },
  checklistBacked: o.checklistBacked !== false,
  storedSlug: "hiq:baseball:1987:topps:70t:base:no-auto",
  derivedBackedStrict: o.derivedBackedStrict !== false,
  storedFlagshipListsCardNumber: o.storedFlagshipListsCardNumber === undefined ? false : o.storedFlagshipListsCardNumber,
});

describe("SPECIALIZATION-STATED — the Maddux row is repairable", () => {
  it("the Tiffany title on a flagship row is IMPROVE, writable, and names its subclass", () => {
    const res = classify(TIFFANY_TITLE, "topps-traded-tiffany");
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.subclass).toBe("SPECIALIZATION-STATED");
    expect(res.writable).toBe(true);
    expect(res.reasons.join(" ")).toContain("specialization:topps->topps-traded-tiffany");
    expect(res.reasons.join(" ")).toContain("title-states:traded+tiffany");
  });

  it("WITHOUT the subclass this row is CONFLICT changed:setKey — the state #1715 left", () => {
    // The same row with the two catalog facts withheld is exactly what the
    // committed classifier returned for 341 of the pool's 365 rows.
    const res = K.classifyRow({
      row: row(TIFFANY_TITLE), stored: STORED_FLAGSHIP,
      derived: { ...STORED_FLAGSHIP, setKey: "topps-traded-tiffany" },
      checklistBacked: true, storedSlug: "hiq:baseball:1987:topps:70t:base:no-auto",
    });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons).toContain("changed:setKey");
  });

  it("the plain Traded sale goes to topps-traded, never to the Tiffany key", () => {
    // The 5:1 majority of the pool. It moves out of flagship too — but to its
    // OWN card. A repair that merely relocated the collision would be no fix.
    const res = classify(TRADED_TITLE, "topps-traded");
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.subclass).toBe("SPECIALIZATION-STATED");
    expect(res.reasons.join(" ")).toContain("title-states:traded");
    expect(res.reasons.join(" ")).not.toContain("tiffany");
  });
});

describe("the five legs, each refused by name", () => {
  it("L1 — a setKey that is not a ladder descendant is not a specialization", () => {
    // topps -> topps-chrome is a different product, not a refinement this
    // subclass may assert, and the title saying "chrome" changes nothing.
    const res = classify("1987 Topps Chrome #70T Greg Maddux", "topps-chrome");
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    // A non-candidate is NOT tagged: 16.3M rows each carrying "this was never
    // a Tiffany row" is a count of the corpus, not of the defect.
    expect(res.reasons.join(" ")).not.toContain("not-specialization-stated");
  });

  it("L1 — the COLLAPSE direction stays refused; the ladder is not symmetric", () => {
    const res = K.classifyRow({
      row: row(TIFFANY_TITLE, { cardId: "hiq:baseball:1987:topps-tiffany:70t:base:no-auto" }),
      stored: { ...STORED_FLAGSHIP, setKey: "topps-tiffany" },
      derived: { ...STORED_FLAGSHIP, setKey: "topps" },
      checklistBacked: true, derivedBackedStrict: true, storedFlagshipListsCardNumber: false,
      storedSlug: "hiq:baseball:1987:topps-tiffany:70t:base:no-auto",
    });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("setkey-collapses-distinct-product");
  });

  it("L2 — a title that does not state every distinguishing word is refused", () => {
    const res = classify("1987 Topps Traded Greg Maddux #70T", "topps-traded-tiffany");
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("not-specialization-stated:title-does-not-state:tiffany");
  });

  it("L3 — a derived identity with no STRICT checklist backing is refused", () => {
    const res = classify(TIFFANY_TITLE, "topps-traded-tiffany", { derivedBackedStrict: false });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("derived-not-checklist-backed");
  });

  it("L4 — a moved cardNumber, grade or auto flag takes the row out of the subclass", () => {
    for (const over of [{ cardNumber: "70" }, { gradeValue: 9 }, { isAuto: true }]) {
      const res = classify(TIFFANY_TITLE, "topps-traded-tiffany", { derivedOver: over });
      expect(res.klass, JSON.stringify(over)).toBe(K.CONFLICT);
      expect(res.writable, JSON.stringify(over)).toBe(false);
      expect(res.reasons.join(" "), JSON.stringify(over)).toContain("identity-axis-moved");
    }
  });

  it("L5 — a flagship whose own checklist LISTS this card number is not eligible", () => {
    // 1987 Topps #70 is a real card. A title mentioning a trade must never
    // re-key a genuine flagship sale off its own pool.
    const res = classify(TIFFANY_TITLE, "topps-traded-tiffany", { storedFlagshipListsCardNumber: true });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("flagship-checklist-lists-this-card");
  });

  it("L5 — an UNDECLARED family whose flagship LISTS this card number is refused", () => {
    // 1987 Topps #70 is a real card. A title mentioning a trade must never
    // re-key a genuine flagship sale off its own pool. `topps -> topps-traded`
    // is NOT a same-number parallel set — #70T is not #70 — so L5 stays on.
    const res = classify(TRADED_TITLE, "topps-traded", { storedFlagshipListsCardNumber: true });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("flagship-checklist-lists-this-card");
    expect(res.reasons.join(" ")).toContain("not-specialization-stated");
  });

  it("L5 — an UNANSWERED coverage question is a refusal on an undeclared family", () => {
    const res = classify(TRADED_TITLE, "topps-traded", { storedFlagshipListsCardNumber: null });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("flagship-coverage-unknown");
  });

  it("a caller that supplies NEITHER catalog fact gets no subclass at all", () => {
    // The defaults are the safe answers. A consumer of this module that has
    // not been taught the subclass cannot accidentally arm it.
    const res = K.classifyRow({
      row: row(TIFFANY_TITLE), stored: STORED_FLAGSHIP,
      derived: { ...STORED_FLAGSHIP, setKey: "topps-traded-tiffany" },
      checklistBacked: true, storedSlug: "hiq:baseball:1987:topps:70t:base:no-auto",
    });
    expect(res.subclass).toBeUndefined();
    expect(res.writable).toBe(false);
  });
});

describe("G1–G6 and the provenance tier still apply", () => {
  it("a PROTECTED row is report-only forever, subclass or no subclass", () => {
    const res = classify(TIFFANY_TITLE, "topps-traded-tiffany", { rowOver: { source: "ebay-user-purchase" } });
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.subclass).toBe("SPECIALIZATION-STATED");
    expect(res.tier).toBe(K.PROTECTED);
    expect(res.writable).toBe(false);          // the subclass never overrides the tier
  });

  it("GUARD 5 — a lot title still refuses, even with all five legs held", () => {
    const res = classify(
      "1987 Topps Traded Tiffany Complete Set #1-132 Greg Maddux",
      "topps-traded-tiffany",
      { rowOver: {}, derivedOver: {} },
    );
    // The lot guard fires on a cardNumber the derivation filled or changed;
    // here the number is unchanged, so what this pins is that the subclass
    // routes through improveRefusals AT ALL — the refusal array exists and is
    // consulted, which is what makes G1–G6 reachable from this arm.
    expect(res.klass).toBe(K.IMPROVE);
    expect(Array.isArray(res.improveRefusals)).toBe(true);
  });

  it("a finish-family collision refuses the write while the family is unruled", () => {
    const res = classify(TIFFANY_TITLE, "topps-traded-tiffany", {
      rowOver: { cardId: "hiq:baseball:1987:topps:70t:green-refractor:no-auto" },
      storedOver: { parallel: "Green Wave" },
      derivedOver: { parallel: "Green Wave" },
    });
    // Whatever the family predicate decides, a refusal must reach `writable`
    // through improveRefusals and never be bypassed by the subclass.
    if (res.finishFamilyCollision) {
      expect(res.writable).toBe(false);
      expect(res.improveRefusals.join(" ")).toContain("finish-family-collision");
    }
  });
});

describe("L3 — the strict source allowlist, measured against the real container", () => {
  // Every source string below is a REAL `c.source` value from card_catalog,
  // read on 2026-09-04 (`SELECT c.source, COUNT(1) GROUP BY c.source`, 100+
  // distinct values). The subtractive first draft of this gate —
  // `CHECKLIST_SOURCE_RE && !DERIVED_SOURCE_RE` — was wrong in BOTH directions
  // on them, which is why the leg is an allowlist. See STRICT_CHECKLIST_SOURCES.

  it("TRUSTED — the real scrapes, including the ones the loose regex never matched", () => {
    const trusted = [
      // the false negatives that motivated the allowlist
      "drew-google-sheet-scraped-2026-09-01",   // 735 rows: the 1987 Topps
                                                // Tiffany checklist ITSELF (#1615)
      "bccp", "bccp-graded",                    // 1.6M rows, baseballcardpedia's short name
      "hobbymonitor-2026-09-04", "hobbymonitor-scraped-2026-08-31",
      "cardboardconnection-scraped-2026-08-17", "cardboard-connection-scraped-2026-08-14",
      "baseball-almanac", "baseball-almanac-graded",
      "bbm-japan-official-pdf-2026-08-12", "pokemon-tcg-data-scraped-2026-08-14",
      "cardpedia-drew-ruling-2026-09-01",
      // and the ones it did match, which must keep working
      "checklistinsider-2026-08-27", "checklistcenter-2026-08-29",
      "checklistcenter-html-graded", "beckett-checklist-2026-08-27",
      "beckett-scraped-2026-09-04", "tcdb-2026-08-12", "tcgdex-scraped-2026-08-16-graded",
      "baseballcardpedia", "baseballcardpedia-ladders-2026-08-29-graded",
      "cardboardchecklist-scraped-2026-08-14", "checklist",
    ];
    for (const s of trusted) expect(K.isStrictChecklistSource(s), s).toBe(true);
  });

  it("REFUSED — derived, seeded and sales-attested rows are not evidence", () => {
    // The circularity this leg exists to break: each of these asserts a
    // specialization lists a card BECAUSE something already assumed it did.
    for (const s of [
      "derived-from-base-checklist-2026-08-23",          // all 453 bowman-tiffany rows
      "derived-from-base-checklist-2026-08-23-graded",
      "ingest-auto-seed", "ingest-auto-seed-graded", "ingest-auto-seed-graded-graded",
      "ingest-auto-seed-graded-attested",
      "sales-attested", "sales-attested-graded", "sales-attested-unnumbered",
      "tree-builder-v1",
    ]) expect(K.isStrictChecklistSource(s), s).toBe(false);
  });

  it("REFUSED — rows minted from sales, from a vendor, or from an explode", () => {
    // These would have passed a merely-loosened regex, and none of them is a
    // checklist. `catalog-explode-actuals` is the CF-EXPLODED-SPINE shape;
    // `pool` and `sold-comps-stub` are sales wearing another name; cardhedge
    // and cardsight are VENDORS, and vendors never mint catalog rows.
    for (const s of [
      "catalog-explode-actuals-2026-08-12", "catalog-explode-actuals-2026-08-12-graded",
      "pool", "sold-comps-stub-2026-08-12", "sold-comps-stub-scarcity-scraped-2026-08-16",
      "subset-unfold", "subset-unfold-graded",
      "cardhedge", "cardhedge-graded", "cardsight", "cardsight-graded",
      "ebay-browse", "ebay-user-purchase", "ebay-user-sale", "user-verified",
      "holding-seeded-2026-08-11", "bccp-product-structure", "clc-product-structure",
      "undefined", "", null, undefined,
    ]) expect(K.isStrictChecklistSource(s), String(s)).toBe(false);
  });

  it("a source invented tomorrow is refused until someone adds it deliberately", () => {
    // The whole point of an allowlist over a denylist: the default for an
    // unknown source is NO, because a false yes here moves a sale onto a card
    // that may never have been printed.
    expect(K.isStrictChecklistSource("some-new-scraper-2027-01-01")).toBe(false);
  });

  it("the ingest suffixes and date stamps are stripped, so a re-scrape needs no code change", () => {
    for (const [raw, want] of [
      ["beckett-checklist-2026-08-27", "beckett-checklist"],
      ["checklistinsider-2026-08-27-graded", "checklistinsider"],
      ["ingest-auto-seed-graded-graded", "ingest-auto-seed"],
      ["sales-attested-unnumbered-graded", "sales"],
      ["bccp-graded-graded", "bccp"],
      // `-scraped` names the INGEST VERB, not the source: the same publisher
      // appears as both `tcdb-2026-08-12` and `tcgdex-scraped-2026-08-16`, so
      // it is stripped with the other suffixes rather than doubling the list.
      ["tcgdex-scraped-2026-08-16-graded", "tcgdex"],
      ["cardboardchecklist-scraped-2026-08-14", "cardboardchecklist"],
      ["hobbymonitor-scraped-2026-08-31", "hobbymonitor"],
    ] as Array<[string, string]>) {
      expect(K.normalizeCatalogSource(raw), raw).toBe(want);
    }
    // and the trusted answer survives a future date
    expect(K.isStrictChecklistSource("beckett-checklist-2027-03-15")).toBe(true);
  });

  it("the ORDINARY IMPROVE gate is untouched — same answers, one read", () => {
    // The runner's `checklistBacked` was refactored to share one cached
    // catalog read with the strict gate, and its two regex tests (on `source`
    // and on `sources.join(",")`) became one test on the joined string. The
    // regex is unanchored, so that is the same predicate — and it has to be,
    // because widening or narrowing the ORDINARY gate would silently change
    // the IMPROVE population across all 16.3M rows, which is a different
    // ruling nobody made. This pins the equivalence.
    const RE = /checklist|beckett|tcdb|insider|bcp|baseballcardpedia|tcgdex/i;
    const before = (src: string, sources: string[]) => RE.test(src) || RE.test(sources.join(","));
    const after = (src: string, sources: string[]) => RE.test(`${src},${sources.join(",")}`);
    const cases: Array<[string, string[]]> = [
      ["beckett-checklist-2026-08-27", []],
      ["", ["tcdb-2026-08-12"]],
      ["cardhedge", ["checklistinsider-2026-08-27"]],
      ["cardhedge", []],
      ["", []],
      ["pool", ["ingest-auto-seed"]],
      ["drew-google-sheet-scraped-2026-09-01", []],   // false in BOTH — the gap L3 closes
    ];
    for (const [src, sources] of cases) {
      expect(after(src, sources), `${src}|${sources}`).toBe(before(src, sources));
    }
  });

  it("the 1987 Topps Tiffany case the first draft got wrong", () => {
    // The census refused 1,576 1987 topps-tiffany rows for "no backing" while
    // 735 rows of their backing sat in card_catalog under a name the loose
    // regex did not know. This is that bug, pinned.
    const CHECKLIST_SOURCE_RE = /checklist|beckett|tcdb|insider|bcp|baseballcardpedia|tcgdex/i;
    const src = "drew-google-sheet-scraped-2026-09-01";
    expect(CHECKLIST_SOURCE_RE.test(src)).toBe(false);   // the loose regex missed it
    expect(K.isStrictChecklistSource(src)).toBe(true);   // the allowlist does not
  });
});

describe("the two IMPROVE arms are gated by ONE function", () => {
  // The refactor this PR made: `allImproveRefusals` is the single site that
  // appends the family-collision refusal and the derivation defects, and both
  // the ordinary IMPROVE path and the SPECIALIZATION-STATED arm call it. If
  // that ever splits into two copies, `rematchDerivationDefects.test.ts`'s
  // mutation checks -- which revert those pushes BY SOURCE STRING and assert
  // exactly one site -- would guard only one arm, and the other would be a
  // silent bypass. These pins fail first, and say why.
  const src = readFileSync(
    new URL("../scripts/lib/rematch-classify.cjs", import.meta.url),
    "utf8",
  );

  it("each refusal push has exactly ONE site in the shipped source", () => {
    for (const line of [
      "  refusals.push(...derivationRefused);",
      '  if (family.qualifies) refusals.push("finish-family-collision:not-writable-until-ruled");',
    ]) {
      expect(src.split(`
${line}
`), line).toHaveLength(2);
    }
  });

  it("every IMPROVE arm calls allImproveRefusals — none restates its pushes", () => {
    // SIX CALL sites and exactly one definition:
    //   1. the ordinary IMPROVE arm
    //   2. SPECIALIZATION-STATED (this file's subject)
    //   3. SELLER-NAME-AUTO (CF-A-SELLER-NAME-IS-NOT-A-SIGNATURE, 2026-09-04),
    //      which rides the same gate from the AGREE path.
    //   4. GRADE-FROM-TITLE (Drew, 2026-09-06) — the field backfill, which
    //      also rides the gate from the AGREE path.
    //   5. YEAR-FROM-TITLE-VINTAGE (Drew, 2026-09-06) — from the CONFLICT path.
    //   6. SPORT-FROM-PRODUCT (Drew, 2026-09-06) — from the CONFLICT path.
    //
    // The NUMBER is incidental; the invariant is that it equals the number of
    // arms and that the definition stays singular. A new arm that restated the
    // pushes instead of calling this would leave itself unguarded by the
    // mutation checks that revert them — which is the whole reason this pin
    // counts rather than trusting the reader.
    //
    // `const refusals = ` is what distinguishes a call from the
    // `function allImproveRefusals({` declaration, which contains the same
    // characters.
    expect(src.split("const refusals = allImproveRefusals({").length - 1).toBe(6);
    expect(src.split("function allImproveRefusals").length - 1).toBe(1);
  });

  it("the subclass arm is refused by the SAME guards as the ordinary arm", () => {
    // Driven through the exported helper directly, so the claim is about the
    // function rather than about one fixture reaching it.
    const args = {
      row: row(TIFFANY_TITLE), stored: STORED_FLAGSHIP,
      derived: { ...STORED_FLAGSHIP, setKey: "topps-traded-tiffany" },
      axes: { same: [], filled: [], dropped: [], changed: ["setKey"] },
      parserSaysLot: false, family: { qualifies: false },
    };
    expect(K.allImproveRefusals({ ...args, derivationRefused: [] })).toEqual([]);
    expect(K.allImproveRefusals({ ...args, derivationRefused: ["D1-title-names-stored-finish"] }))
      .toContain("D1-title-names-stored-finish");
    expect(K.allImproveRefusals({ ...args, derivationRefused: [], family: { qualifies: true } }).join(" "))
      .toContain("finish-family-collision");
  });
});

describe("the mirrored ladder is a cache, not a second source of truth", () => {
  it("every mirrored edge matches productSetKeys.ts", () => {
    for (const key of K.LADDER_MIRRORED_KEYS) {
      const ancestry = productAncestry(key);
      expect(ancestry, key).toContain(K.SPECIALIZATION_PARENTS[key]);
      // and the mirror's parent is the TABLE's immediate parent, not merely
      // some ancestor — a mirror one rung off would admit a wider move.
      expect(productEntry(key)?.parent, key).toBe(K.SPECIALIZATION_PARENTS[key]);
    }
  });

  it("bowman-tiffany is the ONE documented exception, and it is documented as one", () => {
    // A ruled DISTINCT key (setkey-reconciliation.json: 453 catalog rows,
    // 1989–1991) that productSetKeys.ts carries no entry for. The mirror holds
    // the edge; this pin fails the day the table gains it, so the exception is
    // retired deliberately rather than drifting.
    expect(K.SPECIALIZATION_PARENTS["bowman-tiffany"]).toBe("bowman");
    expect(productEntry("bowman-tiffany")).toBeNull();
    expect(K.LADDER_MIRRORED_KEYS).not.toContain("bowman-tiffany");
  });

  it("every mirrored key is a normalizeSetKey FIXED POINT", () => {
    // A ruled key that normalizes to something else is not a ruling, it is a
    // rename waiting to fire — the same assertion rematchCollapseAndCoverage
    // makes of the collapse ruling, pointed the other way.
    for (const key of Object.keys(K.SPECIALIZATION_PARENTS)) {
      expect(normalizeSetKey(key), key).toBe(key);
    }
  });

  it("the post-#1715 parser actually MINTS each mirrored key from a title", () => {
    // A ladder edge the derivation can never reach is an edge that repairs
    // nothing. This is the leg that would have been silently dead before #1715.
    for (const [title, expected] of TIFFANY_MINT_CASES) {
      expect(normalizeSetKey(inferSetKeyFromTitle(title)), title).toBe(expected);
    }
  });

  it("EVERY mirrored key has a title that mints it — no silently dead edge", () => {
    // The test above names four keys by hand, so it could only ever speak for
    // those four: when #1863's 66 soccer products were mirrored it stayed
    // green while every one of their edges was unreachable, which is exactly
    // the "silently dead" failure its own comment warns about. The corpus in
    // soccerLeagueSetKeysFromTitle.test.ts holds a real-shaped title per
    // soccer key; this pin asserts the mirror carries no key that NO corpus
    // can mint, so the next ladder edge added without a parser rule fails
    // here rather than repairing nothing in silence.
    const minted = new Set<string>(
      [
        ...TIFFANY_MINT_CASES.map(([title]) => title),
        ...OTHER_MINT_TITLES,
        ...SOCCER_TITLES.map(([title]) => title),
      ].map((title) => normalizeSetKey(inferSetKeyFromTitle(title))),
    );
    const unreachable = Object.keys(K.SPECIALIZATION_PARENTS)
      .filter((k) => !minted.has(k))
      .filter((k) => !KNOWN_UNMINTABLE.includes(k));
    expect(unreachable, "mirrored keys no title in the corpora mints").toEqual([]);
  });

  it("the unmintable list is exact — a key that GAINS a rule leaves it", () => {
    // The exemption above is a debt register, not a waiver. If someone teaches
    // the parser one of these products, this fails and the name comes off the
    // list, so the register can only ever shrink by being paid down.
    const stillDead = KNOWN_UNMINTABLE.filter(
      (k) => !MINTABLE_PROBES[k] || normalizeSetKey(inferSetKeyFromTitle(MINTABLE_PROBES[k])) !== k,
    );
    expect(stillDead, "keys still unmintable").toEqual([...KNOWN_UNMINTABLE]);
    // and every listed key is really a mirrored edge, not a stale name.
    for (const k of KNOWN_UNMINTABLE) expect(K.SPECIALIZATION_PARENTS[k], k).toBeTruthy();
  });
});

describe("the apply plumbing rides the IMPROVE arm — no new scope", () => {
  it("scope=improve arms a SPECIALIZATION-STATED row", () => {
    const res = classify(TIFFANY_TITLE, "topps-traded-tiffany");
    const armed = K.parseApplyScope("improve").classes;
    expect(K.applyKindOf(res)).toBe(K.IMPROVE);
    expect(K.writableUnderScope(res, armed)).toBe(true);
  });

  it("scope=base-eviction does NOT arm it", () => {
    const res = classify(TIFFANY_TITLE, "topps-traded-tiffany");
    expect(K.writableUnderScope(res, K.parseApplyScope("base-eviction").classes)).toBe(false);
  });

  it("the subclass introduces no new apply class", () => {
    expect(Object.values(K.APPLY_CLASSES)).not.toContain("SPECIALIZATION-STATED");
  });
});

// ── THE MUTATION PINS ───────────────────────────────────────────────────────
//
// Each reverts ONE leg of the subclass and asserts the corpus goes red. A leg
// whose removal changes no test is a leg that was never doing anything.

describe("MUTATION PINS", () => {
  it("PIN 1 — dropping the title-states-every-word leg (L2) admits the wrong card", () => {
    // The mutation: `specializationStatedEvidence` without its L2 check.
    const mutated = (title: string) => {
      const ev = K.specializationStatedEvidence({
        row: row(title), stored: STORED_FLAGSHIP,
        derived: { ...STORED_FLAGSHIP, setKey: "topps-traded-tiffany" },
        axes: { same: [], filled: [], dropped: [], changed: ["setKey"] },
        derivedBacked: true, storedFlagshipListsCardNumber: false,
      });
      const withoutL2 = ev.failed.filter((r: string) => !String(r).startsWith("title-does-not-state") && r !== "no-distinguishing-words");
      return { real: ev.qualifies, mutated: withoutL2.length === 0 };
    };
    // The ~121 plain Traded sales. WITH L2 they are refused; WITHOUT it they
    // qualify — and the fleet would move every one onto the Tiffany card,
    // recreating the collision inverted and 5x larger.
    const plain = mutated(TRADED_TITLE);
    expect(plain.real).toBe(false);        // the shipped code refuses it
    expect(plain.mutated).toBe(true);      // the mutant admits it  => the pin bites
    // And the leg is not vacuously refusing everything: the real Tiffany
    // title still qualifies under the shipped code.
    expect(mutated(TIFFANY_TITLE).real).toBe(true);
  });

  it("PIN 2 — accepting derived-from-base as backing (L3) makes the gate a tautology", () => {
    // `derived-from-base-checklist-*` mints a specialization's catalog rows by
    // COPYING the flagship's, so it says YES for every card in the parent set.
    // The strict predicate is duplicated here as the runner computes it; this
    // pin is what fails if someone widens it back to CHECKLIST_SOURCE_RE.
    const CHECKLIST = /checklist|beckett|tcdb|insider|bcp|baseballcardpedia|tcgdex/i;
    const DERIVED = /derived-from-base|auto-seed|sales-derived|sales-attested|tree-builder/i;
    const strict = (src: string) => CHECKLIST.test(src) && !DERIVED.test(src);
    const loose = (src: string) => CHECKLIST.test(src);

    // The real source on all 453 bowman-tiffany catalog rows.
    const derivedSrc = "derived-from-base-checklist-2026-08-23";
    expect(loose(derivedSrc)).toBe(true);    // the LOOSE predicate is fooled
    expect(strict(derivedSrc)).toBe(false);  // the STRICT one is not => the pin bites
    // A real scrape still passes, or the gate would refuse everything and
    // "safe" would just mean "does nothing".
    expect(strict("beckett-checklist-2026-08-30")).toBe(true);
    expect(strict("tcdb-checklist-scrape")).toBe(true);
    // And each excluded kind is excluded by name.
    for (const s of ["auto-seed-2026-07", "sales-derived-checklist", "sales-attested-checklist", "tree-builder-v1-checklist"]) {
      expect(strict(s), s).toBe(false);
    }

    // The classifier half: a row backed ONLY by a derived source is refused.
    expect(classify(TIFFANY_TITLE, "topps-traded-tiffany", { derivedBackedStrict: false }).writable).toBe(false);
    expect(classify(TIFFANY_TITLE, "topps-traded-tiffany", { derivedBackedStrict: true }).writable).toBe(true);
  });
});

describe("SAME-NUMBER PARALLEL SETS — the ruling read onto L5 (Drew, 2026-09-04)", () => {
  // CF-A-TIFFANY-SALE-IS-A-TIFFANY-CARD. Commit eed10b9b, "a Tiffany sale is a
  // Tiffany card", moved 2,760 rows out of the base pools on this reasoning: a
  // sale whose title says Tiffany belongs to the Tiffany product, full stop.
  //
  // #1725 shipped L5 as an unconditional test and it refused the whole Tiffany
  // family by construction — 6,113 rows measured 2026-09-04, 7,076
  // topps -> topps-tiffany and 794 bowman -> bowman-tiffany by key pair —
  // because a Tiffany set REPRINTS the flagship's checklist on the flagship's
  // own numbers. The flagship genuinely lists the number, so L5's answer is not
  // merely yes, it is UNINFORMATIVE: the number is shared by design and cannot
  // separate the two cards. Only the title can, and under the ruling it is
  // sufficient — because L3 still demands the CHILD'S own checklist row from a
  // real scraped source before anything moves.

  /** A 1987 Topps Tiffany row: the flagship's number, reprinted. */
  const tiffanyParallel = (o: Opts = {}) => K.classifyRow({
    row: row("1987 Topps Tiffany Barry Bonds #320 PSA 10", { cardId: "hiq:baseball:1987:topps:320:base:no-auto" }),
    stored: { ...STORED_FLAGSHIP, cardNumber: "320" },
    derived: { ...STORED_FLAGSHIP, cardNumber: "320", setKey: "topps-tiffany" },
    checklistBacked: true,
    // 1987 Topps really does list #320 — that is the whole point of the family.
    storedFlagshipListsCardNumber: true,
    derivedBackedStrict: o.derivedBackedStrict !== false,
    storedSlug: "hiq:baseball:1987:topps:320:base:no-auto",
  });

  it("THE RULING — a Tiffany title on a flagship-listed number is IMPROVE and writable", () => {
    // The 1987 Tiffany checklist is real: 735 rows from
    // drew-google-sheet-scraped-2026-09-01, landed by #1615. Title says which
    // product; checklist says the card was printed. Both hold, so the row moves.
    const res = tiffanyParallel();
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.subclass).toBe(K.SPECIALIZATION_STATED);
    expect(res.writable).toBe(true);
    expect(res.reasons.join(" ")).toContain("specialization:topps->topps-tiffany");
    expect(res.reasons.join(" ")).toContain("title-states:tiffany");
    // and L5 did not fire, though the flagship DOES list the number
    expect(res.reasons.join(" ")).not.toContain("flagship-checklist-lists-this-card");
    expect(res.specializationEvidence.sameNumberParallelSet).toBe(true);
  });

  it("THE RULING, OTHER HALF — the same title with NO real Tiffany checklist stays CONFLICT", () => {
    // Every year but 1987: the `topps-tiffany` catalog rows are synthetic
    // `derived-from-base-checklist-*`, minted by COPYING the flagship's. L3
    // refuses them, so the row is pending a checklist — NOT moved on a name.
    // This is the leg that keeps the widening from being a tautology.
    const res = tiffanyParallel({ derivedBackedStrict: false });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("derived-not-checklist-backed");
    // and it is the ONLY thing holding it back — the census counts exactly this
    // shape as pendingChecklist.
    const ev = K.specializationStatedEvidence({
      row: row("1987 Topps Tiffany Barry Bonds #320 PSA 10"),
      stored: { ...STORED_FLAGSHIP, cardNumber: "320" },
      derived: { ...STORED_FLAGSHIP, cardNumber: "320", setKey: "topps-tiffany" },
      axes: { same: [], filled: [], dropped: [], changed: ["setKey"] },
      derivedBacked: false, storedFlagshipListsCardNumber: true,
    });
    expect(ev.failed).toEqual(["derived-not-checklist-backed"]);
  });

  it("bowman -> bowman-tiffany is declared, and moves on the same two facts", () => {
    // 1989 Bowman lists #220 and its Tiffany reprints it at #220.
    const res = K.classifyRow({
      row: row("1989 Bowman Tiffany Ken Griffey Jr #220 RC", { cardId: "hiq:baseball:1989:bowman:220:base:no-auto" }),
      stored: { ...STORED_FLAGSHIP, cardYear: 1989, setKey: "bowman", cardNumber: "220" },
      derived: { ...STORED_FLAGSHIP, cardYear: 1989, setKey: "bowman-tiffany", cardNumber: "220" },
      checklistBacked: true, derivedBackedStrict: true,
      storedFlagshipListsCardNumber: true,
      storedSlug: "hiq:baseball:1989:bowman:220:base:no-auto",
    });
    expect(res.klass).toBe(K.IMPROVE);
    expect(res.writable).toBe(true);
  });

  it("AN UNDECLARED FAMILY KEEPS L5 STRICT — the widening is per-pair, not global", () => {
    // `topps -> topps-traded` is a real ladder edge with a title that states
    // its distinguishing word, so L1, L2 and L4 all hold. It is NOT a
    // same-number parallel set — the Traded set numbers #1T–#132T — so if the
    // flagship lists the number, that number IS informative and L5 refuses.
    expect(isSameNumberParallelSet("topps-traded", "topps")).toBe(false);
    const res = classify(TRADED_TITLE, "topps-traded", { storedFlagshipListsCardNumber: true });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("flagship-checklist-lists-this-card");
  });

  it("o-pee-chee is deliberately NOT declared — a different product, not a parallel", () => {
    // OPC is a separate Canadian product with its own checklist and its own
    // numbering, which diverges from Topps in many years. The number carries
    // information there, so L5 must keep asking — and L1 refuses it anyway,
    // since productSetKeys.ts gives o-pee-chee no parent.
    expect(isSameNumberParallelSet("o-pee-chee", "topps")).toBe(false);
    expect(K.isSameNumberParallelSet("o-pee-chee", "topps")).toBe(false);
    expect(productEntry("o-pee-chee")?.parent ?? null).toBeNull();
    expect(K.isSpecializationOf("o-pee-chee", "topps")).toBe(false);
  });

  it("the declaration does NOT widen L1 — every declared pair is already a ladder edge", () => {
    // Declaring a pair turns off ONE leg. It does not add a ladder edge, mint a
    // product, or relax L2/L3/L4.
    for (const e of SAME_NUMBER_PARALLEL_SETS) {
      expect(K.isSpecializationOf(e.setKey, e.parent), `${e.parent}->${e.setKey}`).toBe(true);
    }
  });

  it("the mirror is a cache, not a second source of truth", () => {
    // Same contract as SPECIALIZATION_PARENTS: productSetKeys.ts is the
    // authority and this asserts the .cjs mirror agrees pair for pair, in both
    // directions, so neither can gain an entry the other lacks.
    const key = (e: { setKey: string; parent: string }) => `${e.parent}->${e.setKey}`;
    const authority = SAME_NUMBER_PARALLEL_SETS.map(key).slice().sort();
    const mirror = (K.SAME_NUMBER_PARALLEL_SETS as { setKey: string; parent: string }[]).map(key).slice().sort();
    expect(mirror).toEqual(authority);
    for (const e of SAME_NUMBER_PARALLEL_SETS) {
      expect(K.isSameNumberParallelSet(e.setKey, e.parent), key(e)).toBe(true);
      expect(isSameNumberParallelSet(e.setKey, e.parent), key(e)).toBe(true);
      // and the pair is DIRECTIONAL: the collapse direction is never declared.
      expect(K.isSameNumberParallelSet(e.parent, e.setKey), key(e)).toBe(false);
    }
  });

  it("every declared child is a ladder descendant of its declared parent", () => {
    // A declaration for a pair the ladder does not carry would be dead code
    // that looks like a permission.
    for (const e of SAME_NUMBER_PARALLEL_SETS) {
      expect(K.SPECIALIZATION_PARENTS[e.setKey], e.setKey).toBe(e.parent);
    }
  });

  it("every declared key is a normalizeSetKey FIXED POINT", () => {
    for (const e of SAME_NUMBER_PARALLEL_SETS) {
      expect(normalizeSetKey(e.setKey), e.setKey).toBe(e.setKey);
      expect(normalizeSetKey(e.parent), e.parent).toBe(e.parent);
    }
  });

  it("PIN 3 — declaring a family that is NOT a same-number reprint moves real cards", () => {
    // THE MUTATION: add `topps -> topps-traded` to the declaration. The pin is
    // that this is not a harmless widening — it takes a genuine 1987 Topps #70
    // sale, whose title happens to say "traded", off its own real pool.
    const ev = K.specializationStatedEvidence({
      row: row("1987 Topps #70 Greg Maddux traded to the Cubs PSA 10"),
      stored: STORED_FLAGSHIP,
      derived: { ...STORED_FLAGSHIP, setKey: "topps-traded" },
      axes: { same: [], filled: [], dropped: [], changed: ["setKey"] },
      derivedBacked: true,
      storedFlagshipListsCardNumber: true,   // 1987 Topps #70 IS a real card
    });
    expect(ev.qualifies).toBe(false);                              // shipped code refuses
    expect(ev.failed).toContain("flagship-checklist-lists-this-card");
    // the mutant declares the pair, so L5 is skipped and nothing else refuses:
    const mutant = ev.failed.filter((r: string) => r !== "flagship-checklist-lists-this-card");
    expect(mutant.length === 0).toBe(true);                        // => the pin bites
  });

  it("PIN 4 — turning L5 off for EVERY family, not the declared ones, is the wrong widening", () => {
    // The narrower mutation: make the skip unconditional. That is the version
    // the ruling explicitly did not authorize — Drew ruled on same-numbered
    // PARALLEL SETS, not on every ancestor edge.
    const ev = K.specializationStatedEvidence({
      row: row(TRADED_TITLE), stored: STORED_FLAGSHIP,
      derived: { ...STORED_FLAGSHIP, setKey: "topps-traded" },
      axes: { same: [], filled: [], dropped: [], changed: ["setKey"] },
      derivedBacked: true, storedFlagshipListsCardNumber: true,
    });
    expect(ev.qualifies).toBe(false);
    expect(ev.failed).toContain("flagship-checklist-lists-this-card");
    // unconditional-skip mutant:
    const mutant = ev.failed.filter((r: string) => r !== "flagship-checklist-lists-this-card" && r !== "flagship-coverage-unknown");
    expect(mutant.length === 0).toBe(true);   // it would qualify => the pin bites
  });
});

describe("SLUG CASE — the re-keyed row must land BYTE-EQUAL on the checklist row's slug", () => {
  // WHY THIS PIN EXISTS. The SPECIALIZATION-STATED census prints derived
  // identities in their DISPLAY form — `baseball:1986:topps-traded:91T:Base:no-auto`,
  // uppercase number suffix, capitalized parallel — because `renderIdentity`
  // renders the identity FIELDS, which keep the case the title had. The
  // catalog's checklist rows are keyed by the canonical SLUG, which is
  // lowercase: `hiq:baseball:1987:topps-traded:70t:base:no-auto`.
  //
  // Those two are different strings, and only one of them is a pool key. If the
  // apply ever wrote the rendered form — or built the slug by concatenating the
  // identity fields — the re-keyed row would land on `...:70T:Base:...` while
  // the checklist row and every already-correct sale sit on `...:70t:base:...`.
  // The row would leave the flagship pool and NOT join the Tiffany pool: it
  // would mint a third, one-row pool. A repair that splits the pool it was
  // meant to join is worse than the defect, and it would be invisible in the
  // census, whose counts are computed from identities and not from slugs.
  //
  // The guarantee is structural: `deriveIdentity` builds `slug`/`baseSlug`
  // through `computeHobbyIqCardId`, `deriveCatalogEntry` builds the catalog
  // row's id through THE SAME function, and the apply writes `keep.cardId` and
  // `keep.hobbyiqCardId` from that slug — never from `identity`. These pins
  // assert each link, so a later edit that "helpfully" formats the id breaks a
  // test rather than a pool.

  const comps = (o: Record<string, unknown> = {}) => ({
    sport: "baseball", year: 1987, setKey: "topps-traded-tiffany", cardNumber: "70T",
    parallel: "Base", isAuto: false, printRun: null, playerName: "Greg Maddux",
    gradeCompany: null, gradeValue: null, ...o,
  });

  it("the builder LOWERCASES the number suffix and the parallel", () => {
    // The exact strings the census printed vs the exact strings the catalog holds.
    const display = computeHobbyIqCardId(comps({ cardNumber: "70T", parallel: "Base" }) as never);
    const canonical = computeHobbyIqCardId(comps({ cardNumber: "70t", parallel: "base" }) as never);
    expect(display).toBe(canonical);                       // byte-equal
    expect(display).toBe("hiq:baseball:1987:topps-traded-tiffany:70t:base:no-auto");
    expect(display).not.toContain("70T");
    expect(display).not.toContain("Base");
  });

  it("the 1986 #91T row the census printed lands on the lowercase slug", () => {
    // "baseball:1986:topps-traded:91T:Base:no-auto" — verbatim from run 33855128210.
    const slug = computeHobbyIqCardId(comps({ year: 1986, setKey: "topps-traded", cardNumber: "91T" }) as never);
    expect(slug).toBe("hiq:baseball:1986:topps-traded:91t:base:no-auto");
  });

  it("the SALE's slug and the CHECKLIST row's slug are the same function, so they are byte-equal", () => {
    // The load-bearing claim. `deriveCatalogEntry` (cardCatalog.service.ts)
    // mints the catalog row's id/hobbyiqCardId through computeHobbyIqCardId,
    // and `deriveIdentity` (rematch-sold-comps.cjs) mints the sale's
    // destination slug through the same one. Same inputs, same string.
    const fromSale = computeHobbyIqCardId(comps({ cardNumber: "70T", parallel: "Base" }) as never);
    const fromChecklist = computeHobbyIqCardId(comps({ cardNumber: "70t", parallel: "base", playerName: "MADDUX, GREG" }) as never);
    expect(fromSale).toBe(fromChecklist);
    // and the same holds for the Tiffany parallels this PR moves
    for (const [setKey, num] of [["topps-tiffany", "320"], ["bowman-tiffany", "220"]] as const) {
      const a = computeHobbyIqCardId(comps({ setKey, cardNumber: num.toUpperCase(), parallel: "Base" }) as never);
      const b = computeHobbyIqCardId(comps({ setKey, cardNumber: num.toLowerCase(), parallel: "base" }) as never);
      expect(a, setKey).toBe(b);
      expect(a, setKey).toBe(`hiq:baseball:1987:${setKey}:${num.toLowerCase()}:base:no-auto`);
    }
  });

  it("the APPLY writes cardId and hobbyiqCardId from the SLUG, never from the rendered identity", () => {
    // A source pin, in the same spirit as "each refusal push has exactly ONE
    // site": the writer must assign both id fields from the one `target`
    // binding, and `target` must come from `der.slug` / `der.baseSlug`.
    const runner = readFileSync(
      new URL("../scripts/rematch-sold-comps.cjs", import.meta.url), "utf8",
    );
    expect(runner).toContain("const target = cand.kind === K.BASE_EVICTION ? der.baseSlug : der.slug;");
    expect(runner).toContain("keep.cardId = target;");
    expect(runner).toContain("keep.hobbyiqCardId = target;");
    // both fields from ONE binding — never two separately-built strings
    expect(runner.split("keep.hobbyiqCardId = target;")).toHaveLength(2);
    // and the slug itself is built by the canonical builder, not concatenated
    expect(runner).toContain("const slug = deps.computeHobbyIqCardId({");
    expect(runner).toContain("const baseSlug = deps.computeHobbyIqCardId({");
    // the rendered identity is a REPORTING artifact and must never be a key
    expect(runner).not.toContain("cardId = K.renderIdentity");
    expect(runner).not.toContain("hobbyiqCardId = K.renderIdentity");
  });

  it("MUTATION — uppercasing the number in the writer splits the pool it means to join", () => {
    // THE MUTATION: `keep.cardId = target.toUpperCase()`-style damage, modelled
    // as a slug built from the DISPLAY-cased fields by concatenation instead of
    // through the builder. The pin is that this is not cosmetic: the string
    // stops matching the checklist row, so the sale lands in a pool of one.
    const canonical = computeHobbyIqCardId(comps({ cardNumber: "70T", parallel: "Base" }) as never);
    const mutant = ["hiq", "baseball", "1987", "topps-traded-tiffany", "70T", "Base", "no-auto"].join(":");
    expect(mutant).not.toBe(canonical);                    // => the pin bites
    expect(mutant.toLowerCase()).toBe(canonical);          // and ONLY case differs
    // The checklist row this sale is meant to join is keyed by `canonical`.
    // A row written at `mutant` is not in that pool and not in the flagship
    // pool either — it is a new, one-row pool, and FMV would project a trend
    // from a single sale.
    expect(canonical.split(":")[4]).toBe("70t");
    expect(canonical.split(":")[5]).toBe("base");
  });
});

describe("BLACK DIAMOND joins the ladder (R3, 2026-09-04)", () => {
  // THE ONE UPPER DECK CHILD THE LADDER COULD NOT SEE. Every other table
  // already agreed `upper-deck-black-diamond` is a distinct product that is a
  // release of `upper-deck` -- DISTINCT_PRODUCT_SETKEYS names it,
  // RULED_COLLAPSE_PAIRS carries the measured pair, productSetKeys.ts gives it
  // `parent: "upper-deck"` -- but `specializationAncestry` reads ONLY the
  // mirror, so L1 failed and the rows landed in CONFLICT.
  //
  // Measured read-only on prod 2026-09-04: 12 sold_comps rows for 1999 #D24
  // (Ken Griffey Jr.), every one stored at
  // `hiq:baseball:1999:upper-deck:d24:base:no-auto` while their own titles say
  // "1999 Upper Deck Black Diamond" / "1999 UD Black Diamond Dominance".
  const STORED = {
    sport: "baseball", cardYear: 1999, setKey: "upper-deck", cardNumber: "D24",
    parallel: "Base", isAuto: false, printRun: null, gradeCompany: null, gradeValue: null,
  };
  const DERIVED = { ...STORED, setKey: "upper-deck-black-diamond" };
  const TITLE = "1999 Upper Deck Black Diamond Baseball #D24 Base";

  it("mirrors the edge productSetKeys.ts already declares", () => {
    expect(K.SPECIALIZATION_PARENTS["upper-deck-black-diamond"]).toBe("upper-deck");
    expect(productEntry("upper-deck-black-diamond")?.parent).toBe("upper-deck");
    expect(productAncestry("upper-deck-black-diamond")).toContain("upper-deck");
    expect(K.isSpecializationOf("upper-deck-black-diamond", "upper-deck")).toBe(true);
  });

  it("classifies the D24 rows IMPROVE/SPECIALIZATION-STATED, and writable", () => {
    const r = K.classifyRow({
      row: { title: TITLE }, stored: STORED, derived: DERIVED,
      checklistBacked: true, derivedBackedStrict: true,
      storedSlug: "hiq:baseball:1999:upper-deck:d24:base:no-auto",
      storedFlagshipListsCardNumber: false,
    });
    expect(r.klass).toBe(K.IMPROVE);
    expect(r.subclass).toBe(K.SPECIALIZATION_STATED);
    expect(r.writable).toBe(true);
    expect(r.reasons.join(" ")).toContain("specialization:upper-deck->upper-deck-black-diamond");
    expect(r.reasons.join(" ")).toContain("title-states:black+diamond");
  });

  it("is NOT a same-number parallel set — the D-prefix still carries information", () => {
    // Black Diamond runs its own D-prefixed numbering (#D24) against the
    // flagship's plain 1-N, so L5 must keep asking whether the flagship lists
    // the number. Declaring it a same-number family would switch that gate off
    // for a family where the number genuinely separates two cards.
    expect(K.isSameNumberParallelSet("upper-deck-black-diamond", "upper-deck")).toBe(false);
    expect(K.SAME_NUMBER_PARALLEL_SETS.map((e: { setKey: string }) => e.setKey))
      .not.toContain("upper-deck-black-diamond");
  });

  it("still refuses when the title does not state the distinguishing words", () => {
    // L2 is what keeps the edge from moving every `upper-deck` row: a title
    // that never says "Black Diamond" is not evidence for Black Diamond.
    const r = K.classifyRow({
      row: { title: "1999 Upper Deck Baseball #D24 Ken Griffey Jr" },
      stored: STORED, derived: DERIVED, checklistBacked: true, derivedBackedStrict: true,
      storedSlug: "hiq:baseball:1999:upper-deck:d24:base:no-auto",
      storedFlagshipListsCardNumber: false,
    });
    expect(r.klass).toBe(K.CONFLICT);
    expect(r.writable).toBe(false);
  });

  it("MUTATION: dropping the mirrored edge sends the D24 rows back to CONFLICT", () => {
    // The revert this pin exists to catch. Reverting the one-line mirror entry
    // is what re-strands the 12 rows, and nothing else in the classifier says
    // so -- every other table still names the product.
    expect(K.LADDER_MIRRORED_KEYS).toContain("upper-deck-black-diamond");
    expect(K.specializationAncestry("upper-deck-black-diamond")).not.toEqual([]);
  });
});
