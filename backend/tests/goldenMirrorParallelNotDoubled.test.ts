/**
 * CF-GOLDEN-MIRROR-IS-NOT-DOUBLED (2026-09-28, PR #2495 review).
 *
 * "Golden Mirror" is a NAMED variation kind, already read correctly by
 * variationVocabulary.ts's readVariationFromTitle (the `{ re: "golden\\s+
 * mirror", kind: "golden mirror", standalone: true }` entry composes
 * "Golden Mirror Variation" / "Golden Mirror Variation SSP" on its own). Two
 * DIFFERENT defects sat in parseTitleIdentity.service.ts's reconciliation of
 * that answer against `extractParallel`'s own, separate, cruder rules —
 * both traced to the same root cause: `extractParallel` knows nothing about
 * named KINDS, and the old ternary let its answer outrank one anyway.
 *
 *   1. DOUBLING. `extractParallel` ALSO independently matched "golden
 *      mirror" (a bare `return "Golden Mirror"`, no "variation" word) and
 *      canonicalVariationName("Golden Mirror") is null (it names no
 *      "variation"/"image variation" word), so the ternary's ELSE branch
 *      concatenated the two: "Golden Mirror Variation" + " " + "Golden
 *      Mirror" = "Golden Mirror Variation Golden Mirror", slug
 *      `golden-mirror-variation-golden-mirror` — a dead address no
 *      checklist row, nor any other sale, has ever occupied.
 *
 *   2. LOSS (found fixing #1). On a title that ALSO carries "Image
 *      Variation" or "SSP" as separate words ("Golden Mirror Image
 *      Variation", "Golden Mirror Variation SSP"), removing defect #1's
 *      bare "Golden Mirror" line let `extractParallel`'s OTHER rules
 *      (bare "Image Variation" / the SSP tier read) fire instead, and
 *      canonicalVariationName("Image Variation") IS truthy — so the
 *      ternary's TRUE branch returned "Image Variation" alone, discarding
 *      "Golden Mirror Variation" ENTIRELY. The opposite failure: not a
 *      doubled address, but the wrong one, indistinguishable from a plain
 *      Image Variation SP/SSP card of the same number.
 *
 * THE FIX. `parseListingIdentity`'s reconciliation ternary is now gated on
 * `variation.kind`: whenever the vocabulary named a KIND (non-null), that
 * `finish` is authoritative outright and `extractParallel`'s answer is never
 * consulted — a named kind, by construction, is at least as specific as
 * anything the family-level whitelist can independently rediscover about
 * the same title. `extractParallel`'s own redundant "golden mirror" line is
 * removed rather than reconciled, since the vocabulary already owns this
 * kind. The compose/override path (used for genuinely un-kinded reads, e.g.
 * "SP-Chrome" -> "Image Variation Chrome", or a trailing colour on "Image
 * Variation Gold Speckle Refractor") is UNCHANGED for every title where
 * `variation.kind` is null — pinned below alongside the Golden Mirror cases
 * so a future edit cannot fix one at the other's expense again.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";

const require_ = createRequire(__filename);

const { parseListingIdentity } = require_(
  join(__dirname, "..", "dist", "services", "portfolioiq", "parseTitleIdentity.service.js"),
) as { parseListingIdentity: (title: string, opts?: Record<string, unknown>) => { parallel: string | null } };

const { computeHobbyIqCardId } = require_(
  join(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"),
) as { computeHobbyIqCardId: (c: Record<string, unknown>) => string };

describe("Golden Mirror: parseListingIdentity → the same slug, five real-shaped titles", () => {
  // Five real-shaped titles covering every phrasing sellers use: bare kind
  // word, the label form, the checklist's own "Image Variation" wording, the
  // tiered SSP form, and a bare kind word on a DIFFERENT card number/series
  // (Series 2's own #331, the exact shape PR #2495's reslug list targets).
  const cases: Array<[string, string]> = [
    ["2024 Topps Update Elly De La Cruz Golden Mirror SP #US50", "Golden Mirror Variation"],
    ["2024 Topps Update Series Golden Mirror Image Variation Bobby Witt Jr #US100", "Golden Mirror Variation"],
    ["2023 Topps Series 1 Julio Rodriguez Golden Mirror #330", "Golden Mirror Variation"],
    ["2023 Topps Golden Mirror Variation SSP Corbin Carroll #150", "Golden Mirror Variation SSP"],
    ["2023 Topps Series 2 Charlie Morton Golden Mirror #331", "Golden Mirror Variation"],
  ];

  for (const [title, wantParallel] of cases) {
    it(`"${title}" → parallel "${wantParallel}", never doubled or lost`, () => {
      const r = parseListingIdentity(title);
      expect(r.parallel).toBe(wantParallel);
      expect(r.parallel).not.toMatch(/Golden Mirror.*Golden Mirror/);
      expect(r.parallel).not.toBe("Image Variation");
      expect(r.parallel).not.toBe("SSP");
      expect(r.parallel).not.toBe("Image Variation SSP");
    });
  }

  it("computeHobbyIqCardId lands the parsed identity on the canonical Golden Mirror row id — #331 Charlie Morton, the exact Series 2 row PR #2495's reslug list targets", () => {
    const r = parseListingIdentity("2023 Topps Series 2 Charlie Morton Golden Mirror #331");
    const id = computeHobbyIqCardId({
      sport: "baseball",
      year: 2023,
      setKey: "topps",
      cardNumber: "331",
      parallel: r.parallel,
      isAuto: false,
      printRun: null,
    });
    expect(id).toBe("hiq:baseball:2023:topps:331:golden-mirror-variation:no-auto");
    expect(id).not.toContain("golden-mirror-variation-golden-mirror");
    expect(id).not.toBe("hiq:baseball:2023:topps:331:image-variation:no-auto");
  });

  it("computeHobbyIqCardId lands Series 1 #1 Juan Soto on the canonical row id staged in PR #2495's new checklist package", () => {
    const r = parseListingIdentity("2023 Topps Series 1 Juan Soto Golden Mirror Image Variation #1");
    const id = computeHobbyIqCardId({
      sport: "baseball",
      year: 2023,
      setKey: "topps",
      cardNumber: "1",
      parallel: r.parallel,
      isAuto: false,
      printRun: null,
    });
    expect(id).toBe("hiq:baseball:2023:topps:1:golden-mirror-variation:no-auto");
  });
});

describe("Golden Mirror: the un-kinded compose/override path is unaffected (regression guard)", () => {
  // These titles carry NO named kind (variation.kind is null) -- the exact
  // population the ternary's compose/override branch exists to sharpen.
  // Pinned here so a future attempt to "simplify" the kind gate cannot
  // silently re-break this path while fixing something else. Expected
  // values are parseListingIdentity's OWN pre-existing answers (verified
  // against the pre-fix code with `git stash`) -- note this parser is
  // independent of ebayTitleParser.service.ts's parseListingTitle (pinned
  // separately in variationIsACard.test.ts), and the two do not always
  // agree on a stock-qualifier's exact composed spelling; "SSP-Chrome"
  // reads as the bare tier marker "SSP" here, unchanged by this fix.
  const cases: Array<[string, string]> = [
    ["2020 Bowman Draft Bobby Witt Jr #BD152 SP-Chrome PSA 9 MINT", "Image Variation Chrome"],
    ["2020 BOWMAN DRAFT #BD152 BOBBY WITT JR. SP-CHROME MINT 9", "Image Variation Chrome"],
    ["2023 Topps Series 1 Corbin Carroll #150 SSP-Chrome PSA 10", "SSP"],
    ["2021 Bowman Draft Marcelo Mayer BD-1 SP Paper PSA 10", "Image Variation Paper"],
    ["2024 Topps Chrome Shohei Ohtani Image Variation Gold Speckle Refractor /50 #1", "Image Variation Gold Speckle Refractor"],
  ];
  for (const [title, wantParallel] of cases) {
    it(`"${title}" → parallel "${wantParallel}" (unchanged by the kind gate)`, () => {
      const r = parseListingIdentity(title);
      expect(r.parallel).toBe(wantParallel);
    });
  }
});

describe("Bowman/Chrome 'Mirror' finishes unrelated to Golden Mirror are unaffected", () => {
  // No OTHER registered finish uses the bare word "mirror" in extractParallel
  // or the KINDS table -- confirmed by inspection (grep for /mirror/i across
  // parseTitleIdentity.service.ts and variationVocabulary.ts's KINDS array
  // turns up only the golden-mirror entries this fix touches). These two
  // titles carry "mirror" only as part of "Golden Mirror" itself, on
  // products this ruling explicitly covers (2023/2024 Topps flagship /
  // Update), so they assert the fix's own targeted population rather than
  // a hypothetical unrelated "Mirror" rung — there is no such rung today.
  it("a title with 'mirror' ONLY inside 'Golden Mirror' resolves to the one kind, not a bare 'Mirror' finish", () => {
    const r = parseListingIdentity("2024 Topps Chrome Update Bobby Witt Jr Golden Mirror #CU50");
    expect(r.parallel).toBe("Golden Mirror Variation");
    expect(r.parallel).not.toMatch(/^Mirror$/);
  });

  it("a title naming neither 'golden' nor 'mirror' never reads a Golden Mirror finish", () => {
    const r = parseListingIdentity("2024 Topps Chrome Bobby Witt Jr #1 Base PSA 10");
    expect(r.parallel).not.toMatch(/mirror/i);
  });
});
