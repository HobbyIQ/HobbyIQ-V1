// CF-TITLE-PARALLEL-MATCH-SHARED (Drew, 2026-07-19). Shared post-
// fetch title verification. Extracted from listingRange.routes.ts so
// canonicalFmv's warmPoolFromEbayBrowseEnded can use the same logic
// (previously it wrote input.parallel onto ebay-browse-ended sold_comps
// rows without checking the listing title actually matched → same
// cross-parallel pollution class as retired warmPoolFromCh).
//
// Any code path that ingests external listings/comps into sold_comps
// filtered by parallel MUST run this before writing, to guarantee the
// stored parallel matches the actual card. Otherwise a "Blue Refractor"
// query returning a "Blue X-Fractor" listing writes it with the wrong
// parallel and permanently corrupts FMV downstream.

const DISTINCTIVE_TOKENS = [
  "x-fractor", "xfractor", "shimmer", "speckle", "wave", "reptilian",
  "lazer", "sapphire", "aqua", "ice", "mojo", "sepia", "true",
  "border", "sky", "pattern", "geometric", "logofractor", "logo",
  "prizm", "hyper", "silver", "cracked",
];

const BARE_COLORS = ["blue", "orange", "red", "green", "gold", "purple", "black", "pink", "yellow", "sepia"];

/** Post-fetch title verification. Enforces cardNumber presence,
 *  parallel keyword presence, dominant color presence, and exclusion
 *  of competing distinctive tokens. Returns true when the listing's
 *  title is plausibly for the target parallel.
 *
 *  The four gates:
 *    1. cardNumber (if specified) MUST appear in the title
 *    2. Every distinctive parallel token in the target MUST appear
 *    3. Dominant color word (Blue / Gold / etc.) MUST appear when
 *       the target has one
 *    4. Distinctive tokens NOT in the target MUST NOT appear
 *       (prevents "Blue Refractor" query from matching Blue X-Fractor)
 */
export function titleMatchesParallel(
  title: string,
  targetParallel: string | null,
  targetCardNumber: string | null,
): boolean {
  const t = title.toLowerCase();
  const parallel = (targetParallel ?? "").toLowerCase().trim();

  if (targetCardNumber && targetCardNumber.trim().length > 0) {
    const cn = targetCardNumber.trim().toLowerCase();
    const cnRe = new RegExp(`#?\\b${cn.replace(/[-.]/g, "\\$&")}\\b`);
    if (!cnRe.test(t)) return false;
  }

  if (!parallel) return true;

  const targetDistinctive = DISTINCTIVE_TOKENS.filter((tok) => parallel.includes(tok));
  for (const tok of targetDistinctive) {
    const stripped = tok.replace("-", "");
    if (!t.includes(tok) && !t.includes(stripped)) return false;
  }

  const targetColor = BARE_COLORS.find((c) => new RegExp(`\\b${c}\\b`).test(parallel));
  if (targetColor && !new RegExp(`\\b${targetColor}\\b`).test(t)) return false;

  const targetNoDistinctive = DISTINCTIVE_TOKENS.filter((tok) => !parallel.includes(tok));
  for (const tok of targetNoDistinctive) {
    if (t.includes(tok)) return false;
  }

  return true;
}
