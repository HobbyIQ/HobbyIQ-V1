/**
 * THE PARALLEL LADDER IS PART OF THE CHECKLIST, and an Atomic Refractor is a
 * ROW in it -- not a listing, and not a Refractor.
 *
 * Drew's two 1997 Bowman's Best Preview Derek Jeter #BBP4 ATOMIC REFRACTOR
 * holdings are withheld because the catalog has no checklist-backed row for
 * that card. The only row at
 *
 *   hiq:baseball:1997:bowmans-best:bbp4:atomic-refractor:no-auto
 *
 * is `source: "ebay-user-purchase"` -- Drew's own import, pricing itself off
 * itself -- and the 3,810 other `bowmans-best` 1997 rows are the exploded
 * baseballcardpedia card-BACK scrape, whose parallel column holds player names
 * ("82 Derek Jeter", "45 Mark McGwire"). Not one of them is a parallel.
 *
 * THE CHECKLIST EXISTS AND WE HAD IT ALL ALONG. The lane's manifest carries the
 * whole 1997 Bowman's Best ladder as sibling set pages, every one still at
 * `seededStatus: "missing"`:
 *
 *   set-13646  1997 Bowman Bowman's Best Preview            (base)
 *   set-13647  1997 Bowman Bowman's Best Preview Refractor
 *   set-13648  1997 Bowman Bowman's Best Preview Atomic Refractor
 *
 * Fetched politely on 2026-09-05, set-13648 serves 142,214 bytes, 20 card
 * headers, 20 hidden inputs, and card #4 is Derek Jeter. The page was never the
 * problem.
 *
 * TWO DEFECTS IN THE SLUG READER KEPT IT OUT, and each one costs a pool:
 *
 * 1. CF-A-QUALIFIED-REFRACTOR-IS-NOT-A-REFRACTOR. `SLUG_PARALLEL_TAIL` had no
 *    `-atomic-refractors` entry, so the slug fell through to the bare
 *    `-refractors?$` and emitted parallel "Refractor", moving the discarded
 *    word into `subset` ("Atomic"). 24 rung pages across the manifest, 21 of
 *    them Atomic. rematch-classify's V3 rule already names this exact pair as a
 *    LOSS -- "Pooling an Atomic Refractor with a plain Refractor is one card,
 *    two rows, a split pool, a wrong FMV" -- and parallelLadders.ts declares
 *    "Atomic Refractor" a rung of its own at /100. Every other reader agreed;
 *    the one that MINTS the rows did not.
 *
 * 2. CF-A-PREVIEW-INSERT-KEEPS-THE-PREVIEWED-PRODUCTS-KEY. The brand walk reads
 *    left to right and stopped at `bowman`, so the Preview landed on flagship
 *    Bowman with subset "Bowmans Best Preview Atomic". The pool disagrees: every
 *    Preview sale carries a `BBP<n>` number no flagship Bowman card has, and the
 *    resolver already lands them on `bowmans-best`.
 *
 * THE SPLIT IS LIVE, MEASURED IN sold_comps ON 2026-09-05, in both directions:
 *
 *   hiq:baseball:1997:bowmans-best:bbp2:atomic-refractor:no-auto    17 sales
 *   hiq:baseball:1997:bowman:bbp4:atomic-refractor:no-auto          12 sales
 *   hiq:baseball:1996:bowman:bbp30:atomic-refractor:no-auto         17 sales
 *   hiq:baseball:1996:bowmans-best:bbp8:atomic-refractor:no-auto    11 sales
 *
 * ...and one title reading "BOWMAN'S BEST PREVIEW ATOMIC REFRACTOR #BBP2"
 * resolved to `:refractor:` outright, which is defect 1 reaching the pool.
 *
 * The scope of each rule is pinned as hard as its effect. A rule that reparented
 * every "Bowman's Best" slug would drag the Topps Stadium Club edition of the
 * same insert -- basketball and football cards whose pool says
 * `topps-stadium-club` -- onto a baseball product's key, creating one split
 * while closing another. So the leading brand is part of the match, and the
 * counter-case is pinned beside the case.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FETCHER = path.join(HERE, "..", "scripts", "fetchSportsCardChecklist.cjs");
const FIX = path.join(HERE, "fixtures", "sportscardchecklist");

const {
  parseSetUrl,
  parallelFromSlug,
  parallelTailOf,
  splitParentAndSubset,
  buildRows,
  autoEvidence,
  QUALIFIED_REFRACTOR,
  NESTED_PRODUCT_SLUGS,
  SET_CARD_NUMBER_PREFIX,
  applyCardNumberPrefix,
} = require_(FETCHER);

const html = (n: string) => fs.readFileSync(path.join(FIX, `${n}.trimmed.html`), "utf8");

/** The three real 1997 Bowman's Best Preview URLs, as the manifest carries them. */
const BASE_URL =
  "https://www.sportscardchecklist.com/set-13646/1997-bowman-bowmans-best-preview-baseball-trading-card-checklist";
const ATOMIC_URL =
  "https://www.sportscardchecklist.com/set-13648/1997-bowman-bowmans-best-preview-atomic-refractor-baseball-trading-card-checklist";
const REFRACTOR_URL =
  "https://www.sportscardchecklist.com/set-13647/1997-bowman-bowmans-best-preview-refractor-baseball-trading-card-checklist";

/** What the lane would stage for one set URL: the rung, the parent and the rows. */
function stage(url: string, fixture: string) {
  const parsed = parseSetUrl(url);
  expect(parsed, `the URL must parse: ${url}`).toBeTruthy();
  const parallel = parallelFromSlug(parsed.rest);
  const parent = splitParentAndSubset(parsed.rest, parallelTailOf(parsed.rest));
  const page = html(fixture);
  // The SET KEY reaches buildRows exactly as it does in main(), because a
  // ruled product may number its cards with its own prefix. Staging without
  // it would test a pipeline the lane does not run.
  const { rows, stats } = buildRows(page, {
    parallel,
    isAuto: autoEvidence(page, parsed.rest),
    setKey: parent.parentSetKey,
  });
  return { parsed, parallel, parent, rows, stats };
}

// ── the Atomic Refractor is a row ────────────────────────────────────────────

describe("1997 Bowman's Best Preview Atomic Refractor mints at :atomic-refractor:", () => {
  const staged = stage(ATOMIC_URL, "1997-bowman-bowmans-best-preview-atomic-refractor");

  it("the slug names the rung in full -- Atomic Refractor, not Refractor", () => {
    expect(staged.parallel).toBe("Atomic Refractor");
  });

  it("the page is the whole 20-card ladder, both anchors agreeing", () => {
    // The live page served 20 headers and 20 hidden inputs. A rung page that
    // parsed short would be a lost row, never an exempted one.
    expect(staged.stats.headers).toBe(20);
    expect(staged.stats.hiddenRows).toBe(20);
    expect(staged.stats.anchorMismatch).toBe(false);
    expect(staged.stats.parsed).toBe(20);
    expect(staged.stats.skipped).toBe(0);
    expect(staged.rows).toHaveLength(20);
  });

  it("card 4 is Derek Jeter, and he carries the Atomic Refractor rung", () => {
    // Drew's withheld holding, from a checklist page rather than his own import.
    // BBP4, not 4: Drew's 2026-09-06 ruling makes the Preview its own product
    // and its cards carry the set's OWN numbering, which is what the market
    // writes on every Preview sale.
    const jeter = staged.rows.find((r: any) => r.cardNumber === "BBP4");
    expect(jeter).toBeTruthy();
    expect(jeter.player).toBe("Derek Jeter");
    expect(jeter.parallel).toBe("Atomic Refractor");
  });

  it("EVERY row carries the rung -- a ladder page is one rung over its cards", () => {
    expect(staged.rows.every((r: any) => r.parallel === "Atomic Refractor")).toBe(true);
  });

  it("the rung is in the PARALLEL column, never smuggled into the subset", () => {
    // "Atomic" in `subset` is the shape the old reader produced: it made the
    // page look like a subset of the base product rather than a rung of it.
    // "Atomic" in `subset` was the pre-#1846 shape. The subset is now EMPTY
    // for a different reason (Drew, 2026-09-06): the Preview is the PRODUCT,
    // so there is no subset left over to carry -- and still never a rung.
    expect(staged.parent.subset).toBe("");
    expect(staged.parent.subset).not.toMatch(/atomic/i);
    expect(staged.rows.every((r: any) => r.subset === "")).toBe(true);
    expect(staged.rows.every((r: any) => r.category === "base")).toBe(true);
  });

  it("printRun stays BLANK -- the page states none and blank means unknown", () => {
    expect(staged.rows.every((r: any) => r.printRun === "")).toBe(true);
  });

  it("isAuto is false on every row -- no autograph evidence on the page", () => {
    expect(staged.rows.every((r: any) => r.isAuto === "false")).toBe(true);
  });
});

// ── the Refractor rung is still its own, different row ───────────────────────

describe("the plain Refractor rung is untouched and still distinct", () => {
  it("the Refractor slug still yields exactly Refractor", () => {
    const parsed = parseSetUrl(REFRACTOR_URL);
    expect(parallelFromSlug(parsed.rest)).toBe("Refractor");
  });

  it("Atomic and plain are DIFFERENT rungs -- that is the whole point", () => {
    const atomic = parallelFromSlug(parseSetUrl(ATOMIC_URL).rest);
    const plain = parallelFromSlug(parseSetUrl(REFRACTOR_URL).rest);
    expect(atomic).not.toBe(plain);
    // ...and the specific one is not a mere prefix-trim of the family name,
    // which is what the genericization rule refuses on stored rows.
    expect(atomic).toContain(plain);
    expect(atomic).not.toBe(plain);
  });
});

// ── the base page is unchanged ───────────────────────────────────────────────

describe("the base page still stages base cards with a blank parallel", () => {
  const staged = stage(BASE_URL, "1997-bowman-bowmans-best-preview");

  it("no rung is invented for a slug that names none", () => {
    expect(staged.parallel).toBe("");
    expect(staged.rows.every((r: any) => r.parallel === "")).toBe(true);
  });

  it("it is the same 20 cards, Jeter at BBP4", () => {
    expect(staged.rows).toHaveLength(20);
    const jeter = staged.rows.find((r: any) => r.cardNumber === "BBP4");
    expect(jeter.player).toBe("Derek Jeter");
  });

  it("base and Atomic Refractor are the same cards at two rungs", () => {
    // One card, two rows, two pools -- correctly, because they ARE two cards.
    const atomic = stage(ATOMIC_URL, "1997-bowman-bowmans-best-preview-atomic-refractor");
    expect(atomic.rows.map((r: any) => r.cardNumber))
      .toEqual(staged.rows.map((r: any) => r.cardNumber));
    expect(atomic.rows.map((r: any) => r.player))
      .toEqual(staged.rows.map((r: any) => r.player));
  });
});

// ── the preview keeps the previewed product's key ────────────────────────────

describe("a Bowman's Best Preview is its OWN product, not Bowman and not Bowman's Best", () => {
  // SUPERSEDES #1846's destination, keeping its anchor. That PR moved the
  // Preview off flagship Bowman and onto `bowmans-best`, which was the right
  // direction and the wrong address: the insert has its own BBP numbering, so
  // minting it on the parent's key put twenty different cards at twenty
  // addresses Bowman's Best #1-#20 already owned (60 rows, 2026-09-06).
  it.each([BASE_URL, REFRACTOR_URL, ATOMIC_URL])(
    "%s lands on bowmans-best-preview, with no subset left over",
    (url) => {
      const parsed = parseSetUrl(url);
      const parent = splitParentAndSubset(parsed.rest, parallelTailOf(parsed.rest));
      expect(parent.parentSetKey).toBe("bowmans-best-preview");
      // The Preview IS the product now, so nothing remains to carry as a
      // subset -- which is what keeps `sub-` out of the minted ids.
      expect(parent.subset).toBe("");
    },
  );

  it("BOTH SPORTS reach the one key -- it is one insert", () => {
    // The basketball edition was packed out in Stadium Club and is the SAME
    // twenty-card product; the sport segment of the id keeps the rosters apart.
    for (const rest of [
      "topps-stadium-club-bowmans-best-preview",
      "topps-stadium-club-bowmans-best-preview-refractors",
      "topps-stadium-club-bowmans-best-preview-atomic-refractors",
    ]) {
      const parent = splitParentAndSubset(rest, parallelTailOf(rest));
      expect(parent.parentSetKey).toBe("bowmans-best-preview");
      expect(parent.subset).toBe("");
    }
  });

  it("the card number is the SET's own, and the prefix comes from the set's convention", () => {
    // The baseball pages print bare `1`..`20`; the basketball pages of the SAME
    // insert print `BBP1`..`BBP20`. Both are the same twenty-card product, and
    // the market writes BBP on every Preview sale -- so the bare number is the
    // SOURCE's shorthand, and reading it verbatim is what put the insert inside
    // the parent's number space.
    const rows = stage(ATOMIC_URL, "1997-bowman-bowmans-best-preview-atomic-refractor").rows;
    expect(rows.map((r: any) => r.cardNumber))
      .toEqual(Array.from({ length: 20 }, (_, i) => `BBP${i + 1}`));
    // The prefix is a property of the ruled KEY, never of a page.
    expect(Object.keys(SET_CARD_NUMBER_PREFIX)).toEqual(["bowmans-best-preview"]);
  });

  it("a number that already carries the prefix is left alone -- re-parsing is idempotent", () => {
    // The basketball pages arrive pre-prefixed. Applying it twice would mint
    // `BBPBBP1`, so the rule is written to recognise what it would have added.
    expect(applyCardNumberPrefix("BBP1", "bowmans-best-preview")).toBe("BBP1");
    expect(applyCardNumberPrefix("bbp1", "bowmans-best-preview")).toBe("bbp1");
    expect(applyCardNumberPrefix(applyCardNumberPrefix("1", "bowmans-best-preview"), "bowmans-best-preview"))
      .toBe("BBP1");
  });

  it("ONLY a bare number, and ONLY under the ruled key -- CARD NUMBER IS VERBATIM elsewhere", () => {
    // The narrowing, stated as the cases it refuses. A number shape we do not
    // understand is left exactly as the source printed it, and no other
    // product's numbering is touched at all.
    expect(applyCardNumberPrefix("12a", "bowmans-best-preview")).toBe("12a");
    expect(applyCardNumberPrefix("BNR-1", "bowmans-best-preview")).toBe("BNR-1");
    expect(applyCardNumberPrefix("1", "bowmans-best")).toBe("1");
    expect(applyCardNumberPrefix("1", "topps-stadium-club")).toBe("1");
    expect(applyCardNumberPrefix("1", "")).toBe("1");
  });

  it("THE COUNTER-CASE: a Stadium Club page that is NOT the Preview keeps its key", () => {
    // #1846's counter-case, on the slug it is still about. The Preview itself
    // now reaches the ruled key from BOTH hosts (above) -- but that must not
    // become "any slug naming Stadium Club and Bowman goes to the insert".
    // A Stadium Club page that names no Preview keeps `topps-stadium-club`.
    const rest = "topps-stadium-club-atomic-refractors";
    const parent = splitParentAndSubset(rest, parallelTailOf(rest));
    expect(parent.parentSetKey).toBe("topps-stadium-club");
    // ...and it still gets the right RUNG, because that rule is independent.
    expect(parallelFromSlug(rest)).toBe("Atomic Refractor");
  });

  it("every nested rule is anchored to a HOST BRAND, never to the insert name", () => {
    // Scope proved on the regexes themselves. Each rule names the brand the
    // cards were packed out in; an unanchored form would claim any slug that
    // merely CONTAINS the insert name, which is the leak #1846 pinned and
    // which this ruling's second host makes it tempting to reintroduce.
    expect(NESTED_PRODUCT_SLUGS).toHaveLength(3);
    for (const [re] of NESTED_PRODUCT_SLUGS) {
      expect(re.source.startsWith("^"), `${re.source} must be anchored`).toBe(true);
    }
    const keys = NESTED_PRODUCT_SLUGS.map(([, k]: [RegExp, string]) => k);
    expect(keys).toEqual(["bowmans-best-preview", "bowmans-best-preview", "bowmans-best"]);

    // ORDER IS LOAD-BEARING: the Preview rule is consulted before the shorter
    // `bowman-bowmans-best` rule, or the parent claims the slug and the insert
    // lands back inside the number space it collided with.
    const previewRe = NESTED_PRODUCT_SLUGS[0][0];
    const parentRe = NESTED_PRODUCT_SLUGS[2][0];
    expect(previewRe.test("bowman-bowmans-best-preview-atomic-refractors")).toBe(true);
    expect(parentRe.test("bowman-bowmans-best-preview-atomic-refractors")).toBe(true);
    expect(NESTED_PRODUCT_SLUGS.findIndex(([r]: [RegExp, string]) => r === previewRe))
      .toBeLessThan(NESTED_PRODUCT_SLUGS.findIndex(([r]: [RegExp, string]) => r === parentRe));

    // The parent rule is still Bowman-only, so a Stadium Club slug that is not
    // the Preview never reaches a baseball product's key.
    expect(parentRe.test("topps-stadium-club-bowmans-best")).toBe(false);
  });

  it("bowmans-best is a RULED product key, so this invents no vocabulary", () => {
    // The local list must not drift from the product table, the same pin
    // PRODUCT_TAIL_RE and PARENT_BRANDS already carry. `bowmans-best` is
    // declared with `parent: "bowman"` -- which is exactly the relationship
    // this rule encodes: the cards came from Bowman, they price as Bowman's Best.
    const table = fs.readFileSync(
      path.join(HERE, "..", "src", "services", "catalog", "productSetKeys.ts"), "utf8",
    );
    for (const [, key] of NESTED_PRODUCT_SLUGS) {
      expect(table, `${key} must be a declared product`).toContain(`P("${key}"`);
    }
    expect(table).toContain('P("bowmans-best", { parent: "bowman" })');
  });

  it("a standalone Bowman's Best page is unaffected -- it was already right", () => {
    for (const rest of ["bowmans-best", "bowmans-best-refractors", "bowmans-best-atomic-refractors"]) {
      expect(splitParentAndSubset(rest, parallelTailOf(rest)).parentSetKey).toBe("bowmans-best");
    }
  });
});

// ── every other rule the fetcher already had still stands ────────────────────

describe("the qualified rung narrows nothing that already worked", () => {
  it.each([
    ["topps-chrome-refractors", "Refractor", "topps-chrome"],
    ["topps-chrome-gold-refractors", "Gold Refractor", "topps-chrome"],
    ["topps-chrome-refractors-gold", "Gold Refractor", "topps-chrome"],
    ["topps-chrome-black-refractors", "Black Refractor", "topps-chrome"],
    ["bowman-chrome-refractors", "Refractor", "bowman-chrome"],
  ])("%s -> %s on %s", (rest, parallel, parent) => {
    expect(parallelFromSlug(rest)).toBe(parallel);
    expect(splitParentAndSubset(rest, parallelTailOf(rest)).parentSetKey).toBe(parent);
  });

  it("a ruled product is still never reparented onto its brand", () => {
    // The Tiffany and junk-wax rulings sit ABOVE the nested rule and must win.
    for (const rest of ["topps-tiffany-traded", "fleer-update-glossy", "score-rookie-and-traded", "upper-deck-minors"]) {
      expect(splitParentAndSubset(rest, parallelTailOf(rest)).parentSetKey).toBe("");
    }
  });

  it("an insert page still carries a BLANK parallel and the insert as subset", () => {
    const rest = "topps-chrome-cards-that-never-were";
    expect(parallelFromSlug(rest)).toBe("");
    expect(splitParentAndSubset(rest, parallelTailOf(rest)).subset).toBe("Cards That Never Were");
  });

  it("a slug naming no qualifier is still a plain Refractor", () => {
    expect(parallelFromSlug("bowmans-best-refractors")).toBe("Refractor");
  });

  it("every qualified rung is a name the catalog already spells", () => {
    // No invented vocabulary: each label is "<Qualifier> Refractor", the form
    // parallelLadders.ts and the pool both use.
    for (const [slug, label] of QUALIFIED_REFRACTOR) {
      expect(label.endsWith(" Refractor")).toBe(true);
      expect(label).not.toBe("Refractor");
      expect(slug).not.toContain("refractor");
    }
  });
});

// ── mutation reds ────────────────────────────────────────────────────────────

/** Load a mutated copy of the fetcher and hand it to `fn`. */
function withMutant(from: string, to: string, tag: string, fn: (m: any) => void) {
  const original = fs.readFileSync(FETCHER, "utf8");
  expect(original, `the mutation target must exist verbatim: ${from}`).toContain(from);
  const mutated = original.replace(from, to);
  expect(mutated).not.toBe(original);
  const tmp = path.join(HERE, "..", "scripts", `.mutated-${tag}-${process.pid}.cjs`);
  try {
    fs.writeFileSync(tmp, mutated);
    fn(require_(tmp));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

describe("drop the section reader and the Atomic Refractor rows are lost", () => {
  it("empty QUALIFIED_REFRACTOR -> Jeter's rung collapses onto plain Refractor", () => {
    withMutant(
      'const QUALIFIED_REFRACTOR = [\n  ["atomic", "Atomic Refractor"],',
      "const QUALIFIED_REFRACTOR = [\n  // reader removed",
      "qualified",
      (m) => {
        const parsed = m.parseSetUrl(ATOMIC_URL);
        const page = html("1997-bowman-bowmans-best-preview-atomic-refractor");
        const mutantParallel = m.parallelFromSlug(parsed.rest);

        // THE LOSS, stated as the row it costs: with the reader gone, every one
        // of the 20 Atomic Refractor rows is minted as a plain Refractor -- the
        // same slug the set-13647 page already owns. One card, two pools.
        expect(mutantParallel).toBe("Refractor");
        const { rows } = m.buildRows(page, { parallel: mutantParallel, isAuto: false });
        expect(rows.filter((r: any) => r.parallel === "Atomic Refractor")).toHaveLength(0);
        expect(rows.filter((r: any) => r.parallel === "Refractor")).toHaveLength(20);

        // ...and the shipped fetcher disagrees with the mutant on exactly this.
        expect(parallelFromSlug(parsed.rest)).toBe("Atomic Refractor");
        expect(parallelFromSlug(parsed.rest)).not.toBe(mutantParallel);
      },
    );
  });

  it("the mutant collides Atomic with the page that IS the plain Refractor", () => {
    // Proved as a COLLISION, not merely a different string: the two set pages
    // would stage identical (cardNumber, parallel) identities for 20 cards.
    withMutant(
      'const QUALIFIED_REFRACTOR = [\n  ["atomic", "Atomic Refractor"],',
      "const QUALIFIED_REFRACTOR = [\n  // reader removed",
      "collide",
      (m) => {
        const atomic = m.parallelFromSlug(m.parseSetUrl(ATOMIC_URL).rest);
        const plain = m.parallelFromSlug(m.parseSetUrl(REFRACTOR_URL).rest);
        expect(atomic).toBe(plain);           // the collision
        expect(parallelFromSlug(parseSetUrl(ATOMIC_URL).rest))
          .not.toBe(parallelFromSlug(parseSetUrl(REFRACTOR_URL).rest)); // shipped: distinct
      },
    );
  });

  it("drop the nested-product rule -> the Preview is minted onto flagship Bowman", () => {
    withMutant(
      "  const nested = nestedProduct(r);\n  if (nested) return nested;",
      "  // nested rule removed",
      "nested",
      (m) => {
        const parsed = m.parseSetUrl(ATOMIC_URL);
        const parent = m.splitParentAndSubset(parsed.rest, m.parallelTailOf(parsed.rest));
        expect(parent.parentSetKey).toBe("bowman");
        expect(parent.subset).toBe("Bowmans Best Preview");
        // The shipped fetcher puts it on the ruled key of its own.
        expect(splitParentAndSubset(parsed.rest, parallelTailOf(parsed.rest)).parentSetKey)
          .toBe("bowmans-best-preview");
      },
    );
  });

  it("unanchor the PARENT rule -> a Stadium Club page is dragged onto a baseball key", () => {
    // The scope pin as a mutation, on the rule it is still about. The Preview
    // reaches its own key from both hosts by DESIGN; the parent's rule must
    // stay Bowman-only, or an ordinary Stadium Club page whose slug merely
    // contains "bowmans-best" lands on a baseball product's key.
    withMutant(
      '[/^bowman-(bowmans-best)(?:-|$)/, "bowmans-best"],',
      '[/(?:^|-)(bowmans-best)(?:-|$)/, "bowmans-best"],',
      "unanchored",
      (m) => {
        const rest = "topps-stadium-club-bowmans-best-atomic-refractors";
        expect(m.splitParentAndSubset(rest, m.parallelTailOf(rest)).parentSetKey)
          .toBe("bowmans-best");
        expect(splitParentAndSubset(rest, parallelTailOf(rest)).parentSetKey)
          .toBe("topps-stadium-club");
      },
    );
  });

  it("REORDER the nested rules -> the Preview lands back inside the parent's numbers", () => {
    // The order pin as a mutation. With the parent's rule consulted first it
    // claims `bowman-bowmans-best-preview...` on its own prefix, and the
    // insert is minted onto `bowmans-best` again -- which is precisely the
    // 2026-09-06 incident: 60 rows at addresses Bowman's Best #1-#20 owns.
    withMutant(
      [
        '  [/^bowman-(bowmans-best-preview)(?:-|$)/, "bowmans-best-preview"],',
        '  [/^topps-stadium-club-(bowmans-best-preview)(?:-|$)/, "bowmans-best-preview"],',
        '  [/^bowman-(bowmans-best)(?:-|$)/, "bowmans-best"],',
      ].join("\n"),
      [
        '  [/^bowman-(bowmans-best)(?:-|$)/, "bowmans-best"],',
        '  [/^bowman-(bowmans-best-preview)(?:-|$)/, "bowmans-best-preview"],',
        '  [/^topps-stadium-club-(bowmans-best-preview)(?:-|$)/, "bowmans-best-preview"],',
      ].join("\n"),
      "reordered",
      (m) => {
        const parsed = m.parseSetUrl(ATOMIC_URL);
        expect(m.splitParentAndSubset(parsed.rest, m.parallelTailOf(parsed.rest)).parentSetKey)
          .toBe("bowmans-best");
        expect(splitParentAndSubset(parsed.rest, parallelTailOf(parsed.rest)).parentSetKey)
          .toBe("bowmans-best-preview");
      },
    );
  });

  it("drop the BBP prefix -> the insert lands inside the parent's number space", () => {
    // The card-number pin as a mutation, and the harm named as the rows it
    // costs. The baseball pages print bare 1..20; without the set's own
    // prefix those twenty cards are minted at 1..20 -- the numbers twenty
    // DIFFERENT Bowman's Best cards already carry.
    withMutant(
      'const SET_CARD_NUMBER_PREFIX = { "bowmans-best-preview": "BBP" };',
      'const SET_CARD_NUMBER_PREFIX = {};',
      "noprefix",
      (m) => {
        const parsed = m.parseSetUrl(ATOMIC_URL);
        const page = html("1997-bowman-bowmans-best-preview-atomic-refractor");
        const parent = m.splitParentAndSubset(parsed.rest, m.parallelTailOf(parsed.rest));
        const { rows } = m.buildRows(page, {
          parallel: m.parallelFromSlug(parsed.rest),
          isAuto: false,
          setKey: parent.parentSetKey,
        });
        expect(rows.map((r: any) => r.cardNumber).slice(0, 3)).toEqual(["1", "2", "3"]);
        // ...and the shipped fetcher numbers them as the market does.
        expect(stage(ATOMIC_URL, "1997-bowman-bowmans-best-preview-atomic-refractor")
          .rows.map((r: any) => r.cardNumber).slice(0, 3)).toEqual(["BBP1", "BBP2", "BBP3"]);
      },
    );
  });
});
