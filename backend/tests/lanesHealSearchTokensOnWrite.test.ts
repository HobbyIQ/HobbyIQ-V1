// CF-DERIVED-FIELDS-ARE-NEVER-HAND-ROLLED (#1614, 2026-09-07).
//
// WHY THIS FILE EXISTS. The catalog-token-coverage canary sat red at 14.17%
// STALE searchTokens, and the obvious reading — "the day's reslugs and rekeys
// drifted the derived fields, re-run the backfill without missing-only" — was
// wrong twice over. Measured on a 5,040-row sample of prod card_catalog on
// 2026-09-07:
//
//     checked 5,040   stale 503   (9.98%)
//
//     stale by source                          stale by patch shadow
//       250  baseballcardpedia-ladders-08-29     499  none
//       116  baseballcardpedia                     4  setKeyBefore
//        83  baseballcardpedia-ladders-09-04
//        40  baseballcardpedia-graded
//
// 499 of 503 carried NO `<field>Before` shadow, so patchCatalogRowFields had
// never touched them; every stale row carried `searchText: undefined` and a
// token array missing exactly the hyphen FRAGMENTS of its card number. The
// rows were not drifted by a later lane at all — they were minted that way.
//
// The author was ingest-checklist-csv-to-catalog.cjs, which hand-rolled a
// FOURTH tokenizer inline at its write site: a Set that split on whitespace
// only. Replaying that expression against a probed prod row reproduced its
// stored tokens byte for byte:
//
//     ingest inline  ["2015","sn-bh","billy","hamilton","bowman","chrome"]
//     prod row       ["2015","sn-bh","billy","hamilton","bowman","chrome",...]
//     builders want  [... ,"sn-bh","sn","bh", ...]
//
// So a user typing "sn" or "ppa" — either half of a hyphenated card number —
// missed the only index-accelerated predicate catalogSearch has.
//
// AND THE LANE THE FINDING SENDS YOU TO WOULD HAVE MADE IT WORSE.
// backfill-searchtokens-all-sports.cjs carried a PRIVATE COPY of the builders
// that read only the cardsight row shape, so on a canonical row it saw neither
// setKey nor cardNumber:
//
//     private copy  "bo bichette sn-bh 2015"
//     shared        "bo bichette bowman chrome sn-bh 2015"
//
// It would have written tokens the canary then classified as stale, and
// stamped __searchIndexedAt on them so the damage read as coverage.
//
// THIS FILE PINS:
//   1. No catalog writer hand-rolls searchTokens. The one shape is
//      rebuildSearchFields / the shared searchTokenBuilders module.
//   2. The all-sports lane imports the shared builders and holds no private
//      buildSearchText/buildSearchTokens of its own.
//   3. The lane has a recompute-stale mode, because a missing-only scan can
//      never select a stale row.
//   4. The regression case itself: a hyphenated card number keeps its
//      fragments, and the old inline tokenizer fails that test.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const scripts = join(__dirname, "..", "scripts");
const read = (p: string) => readFileSync(join(scripts, p), "utf8");

const { buildSearchText, buildSearchTokens, classifyRowTokens } = require_(
  join(scripts, "comp-quality", "searchTokenBuilders.cjs"),
);

describe("the ingest lane no longer hand-rolls its tokens", () => {
  const src = read("ingest-checklist-csv-to-catalog.cjs");

  it("mints derived fields through rebuildSearchFields", () => {
    expect(src).toContain("rebuildSearchFields");
    // Imported from catalogRowOps, the same derivation deriveCatalogEntry and
    // moveCatalogRow use — never a local re-spelling.
    expect(src).toMatch(/rebuildSearchFields[\s\S]{0,120}catalogRowOps\.service\.js/);
  });

  it("carries no inline searchTokens literal at its write site", () => {
    // The exact shape of the defect: `searchTokens:` followed by an array
    // built on the spot. A future edit that reintroduces one fails here.
    expect(src).not.toMatch(/searchTokens:\s*Array\.from/);
    expect(src).not.toMatch(/searchTokens:\s*\[/);
  });
});

describe("the all-sports backfill shares the canary's builders", () => {
  const src = read("backfill-searchtokens-all-sports.cjs");

  it("imports searchTokenBuilders rather than defining its own", () => {
    expect(src).toContain("searchTokenBuilders.cjs");
    // A private copy is what let the writer and the canary disagree silently.
    expect(src).not.toMatch(/function\s+buildSearchText\s*\(/);
    expect(src).not.toMatch(/function\s+buildSearchTokens\s*\(/);
  });

  it("has a recompute-stale mode, because missing-only cannot select a stale row", () => {
    expect(src).toContain("recompute-stale");
    // The verdict must be the canary's own function, not a second opinion.
    expect(src).toContain("classifyRowTokens");
  });

  it("drops the missing-tokens predicate in recompute-stale mode", () => {
    // A stale row has a non-empty array, so it satisfies NEITHER half of the
    // missing predicate. Leaving the predicate on would make the mode a no-op.
    expect(src).toMatch(/RECOMPUTE_STALE\s*\?\s*""/);
  });
});

describe("the regression itself: hyphenated card numbers keep their fragments", () => {
  // The exact prod row probed on 2026-09-07.
  const row = {
    playerName: "Billy Hamilton",
    setKey: "bowman-chrome",
    setName: "2015 Bowman Chrome",
    year: 2015,
    cardNumber: "SN-BH",
    parallel: null,
  };

  it("the builders emit both halves of SN-BH", () => {
    const tokens = buildSearchTokens(buildSearchText(row));
    expect(tokens).toContain("sn-bh");
    expect(tokens).toContain("sn");
    expect(tokens).toContain("bh");
  });

  it("the OLD inline tokenizer does not — and classifies as stale", () => {
    // Verbatim replay of what stood at the ingest write site.
    const old = Array.from(
      new Set(
        [
          String(row.year),
          String(row.cardNumber).toLowerCase(),
          ...row.playerName.toLowerCase().split(/\s+/),
          ...row.setKey.split("-"),
        ].filter(Boolean),
      ),
    );
    expect(old).not.toContain("sn");
    expect(old).not.toContain("bh");
    // This is precisely what the canary was counting.
    expect(classifyRowTokens({ ...row, searchTokens: old })).toBe("stale");
  });

  it("a row minted the new way classifies ok", () => {
    const tokens = buildSearchTokens(buildSearchText(row));
    expect(classifyRowTokens({ ...row, searchTokens: tokens })).toBe("ok");
  });
});
