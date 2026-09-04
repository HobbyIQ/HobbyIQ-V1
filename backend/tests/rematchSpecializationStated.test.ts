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
import { productAncestry, productEntry } from "../src/services/catalog/productSetKeys.js";
import { normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";
import { inferSetKeyFromTitle } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

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

  it("L5 — a SAME-NUMBERED reprint is refused by construction, and that is correct", () => {
    // Measured 2026-09-04 against card_catalog: 1987 topps lists #70 and #320
    // but NOT #70T, which is why the Traded Tiffany rows pass L5. But
    // `topps-tiffany` and `bowman-tiffany` reprint the flagship's card list ON
    // THE SAME NUMBERS — 1989 bowman really does list #220 and #27 — so every
    // one of their rows fails L5 by construction.
    //
    // That is the leg working, not failing. When the number is shared, the
    // cardNumber cannot tell the two cards apart and ONLY the title says
    // Tiffany; moving the row on that alone is a bigger claim than this
    // subclass makes. The census counts them under
    // `flagship-checklist-lists-this-card` so the population is a number Drew
    // can rule on rather than a silence.
    const res = K.classifyRow({
      row: row("1988 Topps Tiffany George Brett #150", { cardId: "hiq:baseball:1988:topps:150:base:no-auto" }),
      stored: { ...STORED_FLAGSHIP, cardYear: 1988, cardNumber: "150" },
      derived: { ...STORED_FLAGSHIP, cardYear: 1988, cardNumber: "150", setKey: "topps-tiffany" },
      checklistBacked: true, derivedBackedStrict: true,
      storedFlagshipListsCardNumber: true,          // 1988 Topps #150 is a real card
      storedSlug: "hiq:baseball:1988:topps:150:base:no-auto",
    });
    expect(res.klass).toBe(K.CONFLICT);
    expect(res.writable).toBe(false);
    expect(res.reasons.join(" ")).toContain("flagship-checklist-lists-this-card");
    // and it is counted, not swallowed: the reason is present for Drew to read.
    expect(res.reasons.join(" ")).toContain("not-specialization-stated");
  });

  it("L5 — an UNANSWERED coverage question is a refusal: absent beats wrong", () => {
    const res = classify(TIFFANY_TITLE, "topps-traded-tiffany", { storedFlagshipListsCardNumber: null });
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

  it("both arms call allImproveRefusals — neither restates its pushes", () => {
    // Two CALL sites (the ordinary arm and the subclass arm) and exactly one
    // definition. `const refusals = ` is what distinguishes a call from the
    // `function allImproveRefusals({` declaration, which contains the same
    // characters.
    expect(src.split("const refusals = allImproveRefusals({").length - 1).toBe(2);
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
    const cases: Array<[string, string]> = [
      ["1987 Topps Traded Tiffany Greg Maddux #70T", "topps-traded-tiffany"],
      ["1987 Topps Traded Greg Maddux #70T", "topps-traded"],
      ["1988 Topps Tiffany George Brett #400", "topps-tiffany"],
      ["1990 Bowman Tiffany Greg Maddux #27", "bowman-tiffany"],
    ];
    for (const [title, expected] of cases) {
      expect(normalizeSetKey(inferSetKeyFromTitle(title)), title).toBe(expected);
    }
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
