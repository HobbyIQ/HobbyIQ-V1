"use strict";
/**
 * CF-A-PUBLICATION-YEAR-IS-NOT-THE-PRODUCT-YEAR (2026-09-06).
 *
 * A hobbymonitor release URL may end in the year the page was PUBLISHED rather
 * than the year the product was issued:
 *
 *     /release/2024-topps-finest-football2025    ->  "2024 Topps Finest Football"
 *     /release/2024-panini-select-baseball-2025  ->  "2024 Panini Select Baseball"
 *
 * The enumeration that mints backend/data/ingest-universe.json read that
 * trailing number as the product `year`, so 20 hobbymonitor entries were queued
 * a year later than the product they name. fetchHobbyMonitorChecklist.cjs
 * writes that `--year` and that `--set-name` into ONE manifest, so every
 * card_catalog row those entries minted inherited the disagreement -- 69,325
 * rows whose own setName contradicts their own year field (#1904 census, #1912).
 *
 * THE SET NAME IS THE AUTHORITY, AND THAT IS MEASURED. For topps-finest/
 * football the checklist corpus holds 40,092 rows at 2024 against 13,655
 * hobbymonitor rows at 2025. The title a source prints above its own checklist
 * is a transcription of the product; a number in a URL path is a CMS artifact.
 *
 * A SPLIT SEASON IS NOT THIS DEFECT, and this is the load-bearing half of the
 * rule. "2024/25 Panini Select Basketball" carrying year 2025 is a season year
 * of its OWN label, and per #1852 (CF-A-SPLIT-YEAR-IS-STILL-A-YEAR) that is
 * legitimate. The corpus is consistent about which end it takes -- 75,896 rows
 * on the second season year against 0 on the first (#1912) -- and consistency,
 * not which end is chosen, is what keeps a product's cards in one pool. So this
 * function admits EITHER season year of a split label and marks only a year
 * that is neither. Collapsing the split cases to the leading year would CREATE
 * the inconsistency the rule exists to prevent, which is why they are pinned by
 * name in the test.
 *
 * WHY A SEPARATE MODULE. build-ingest-universe-manifest.cjs is top-to-bottom
 * side effects: requiring it reads the enumeration artifact and REWRITES the
 * committed manifest. A test that wants this rule must be able to import it
 * without minting anything, so the rule lives here and the builder requires it.
 */

/**
 * The product years a setName legitimately admits.
 *
 *   "2024 Topps Finest Football"       -> [2024]
 *   "2024/25 Panini Select Basketball" -> [2024, 2025]   (either season year)
 *   "2024 25 Topps Chrome"             -> [2024, 2025]   (space/hyphen variants)
 *   "Topps Chrome"                     -> []             (states no year)
 *
 * An empty array means the name states no leading year, so there is nothing to
 * check a queued year against and the caller must leave it alone. Blank is
 * unknown, never a licence to guess.
 *
 * @param {unknown} setName
 * @returns {number[]}
 */
function productYearsOf(setName) {
  const s = String(setName ?? "").trim();
  const lead = /^(\d{4})/.exec(s);
  if (!lead) return [];
  const first = Number(lead[1]);
  // A split-season label spells the second year as two digits ("2024/25",
  // "2024-25", "2024 25") or, in a URL-derived name, as four ("2021-22").
  const split = /^(\d{4})\s*[/\-\u2013 ]\s*(\d{2}|\d{4})\b/.exec(s);
  if (!split) return [first];
  const tail = split[2];
  const second = tail.length === 2
    ? Number(String(first).slice(0, 2) + tail)
    : Number(tail);
  // The century roll: "1999/00" means 2000, not 1900.
  const rolled = tail.length === 2 && second < first ? second + 100 : second;
  // A pair that is not consecutive is not a season, so the label states one
  // year only -- "2021-22-2022-23" (a checklistcenter dual-season URL) must not
  // be read as admitting 2021.
  return rolled === first + 1 ? [first, rolled] : [first];
}

/**
 * Does a queued `year` disagree with what its own setName states?
 * Returns the corrected year, or null when there is nothing to correct.
 */
function correctedYear(setName, year) {
  if (year == null) return null;
  const admissible = productYearsOf(setName);
  if (!admissible.length) return null;
  return admissible.includes(Number(year)) ? null : admissible[0];
}

module.exports = { productYearsOf, correctedYear };
