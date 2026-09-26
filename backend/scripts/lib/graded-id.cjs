"use strict";
/**
 * graded-id.cjs -- the grade-aware id splitter, OUTSIDE backend/src.
 *
 * CF-A-RESLUG-THAT-CHANGES-THE-RUNG-CARRIES-THE-RUNG'S-TEXT (2026-09-26,
 * relocate-catalog-rows-by-list.cjs review). `rungChangeFields` and the
 * `patchFields` heal action both need to tell a graded-child id
 * (`hiq:...:no-auto:cgc-10`) apart from a malformed one, because the bare
 * `parseHobbyIqCardId` returns null for EVERY graded child -- the grade tail
 * is not part of the card-id grammar -- and treating that null as "nothing to
 * add" silently waived the whole rung-text requirement for exactly the rows
 * most likely to be a curated fold's destination.
 *
 * catalogRowOps.service.ts already has this splitter --
 * `parseSlugWithGrade`, private to that module, used by `buildIncoming` --
 * but exporting it is a `backend/src` change, and tonight's merge authority
 * for #2431 excludes `backend/src`. So this file MIRRORS that function's
 * logic, verbatim, so the lane can use the identical grammar without either
 * touching backend/src or re-implementing something subtly different.
 *
 * MIRRORED FROM (read before changing either file):
 *   backend/src/services/catalog/catalogRowOps.service.ts,
 *   `function parseSlugWithGrade(slug)` (as of 2026-09-26, ~L514-527):
 *
 *     const direct = parseHobbyIqCardId(slug);
 *     if (direct) return { parsed: direct, parentSlug: slug, gradeTier: null };
 *     const cut = slug.lastIndexOf(":");
 *     if (cut <= 0) return null;
 *     const head = slug.slice(0, cut);
 *     const tier = slug.slice(cut + 1);
 *     // A tier is one segment (guaranteed by the lastIndexOf split), is not
 *     // the print-run segment, and is not empty.
 *     if (!tier || tier.startsWith("num-")) return null;
 *     const parsed = parseHobbyIqCardId(head);
 *     if (!parsed) return null;
 *     return { parsed, parentSlug: head, gradeTier: tier };
 *
 * WHAT THIS MEANS FOR "grader name". The real function carries NO allow-list
 * of grader names (psa/sgc/bgs/cgc/...) at all -- ANY non-empty trailing
 * segment that is not the print-run segment (`num-*`) and whose HEAD parses
 * as a card is accepted as a grade tier, decimal grades (`sgc-9-5`) included
 * by construction (the splitter never inspects the tier's own shape beyond
 * "not `num-*`, not empty"). Verified live against the built dist/ function
 * (2026-09-26): `parseSlugWithGrade("hiq:baseball:2020:topps:1:base:no-
 * auto:nonsense-tail")` returns `gradeTier: "nonsense-tail"`. A tighter
 * allow-list here would DIVERGE from the real grammar the moved rows are
 * actually judged against, so this mirror stays exactly as permissive.
 *
 * PARITY IS PINNED, NOT ASSUMED. tests/gradedIdParity.test.ts drives >=12
 * fixture ids through both this file's `parseSlugWithGrade` and, wherever a
 * built tree is available in the test run, the REAL
 * catalogRowOps.parseSlugWithGrade (loaded read-only via
 * createRequire(dist/...) -- a private function is still reachable off the
 * module object if a caller reaches in, but this file never does that at
 * runtime; the test does it ONLY to prove parity, never to substitute for
 * this mirror in the lane itself). If the real function's structure ever
 * changes, that parity test is the tripwire: update the header above AND this
 * file together, in the same PR that touches catalogRowOps.service.ts.
 */

/**
 * Parse a slug that may carry a trailing grade-tier segment.
 *
 * @param {string} slug
 * @param {(id: string) => object | null} parseId  the real
 *   parseHobbyIqCardId (or an equivalent) -- injected rather than required
 *   at module load, so this file has no hard dependency on a built tree and
 *   callers that already loaded dist/ (as the lane does) pass their own copy
 *   straight through, exactly as `parseSlugWithGrade`'s own call sites do.
 * @returns {{ parsed: object, parentSlug: string, gradeTier: string | null } | null}
 */
function parseSlugWithGrade(slug, parseId) {
  const direct = parseId(slug);
  if (direct) return { parsed: direct, parentSlug: slug, gradeTier: null };
  const cut = String(slug ?? "").lastIndexOf(":");
  if (cut <= 0) return null;
  const head = slug.slice(0, cut);
  const tier = slug.slice(cut + 1);
  // A tier is one segment (guaranteed by the lastIndexOf split), is not the
  // print-run segment, and is not empty.
  if (!tier || tier.startsWith("num-")) return null;
  const parsed = parseId(head);
  if (!parsed) return null;
  return { parsed, parentSlug: head, gradeTier: tier };
}

module.exports = { parseSlugWithGrade };
