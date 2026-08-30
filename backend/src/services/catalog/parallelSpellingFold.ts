/**
 * parallelSpellingFold -- when two checklist SOURCES spell one rung two ways,
 * fold the spellings so the two rows meet. Comparison only; nothing is stored.
 *
 * CF-A-SPELLING-IS-NOT-A-SECOND-CARD (Drew, 2026-08-30 12:50Z, D31):
 * "two checklist SOURCES spelling ONE card two ways at the SAME print run is a
 * spelling, not two cards -- the majority spelling among the checklist sources
 * for that product wins; tie -> the longer form."
 *
 * -- WHY THIS IS NOT normalizeParallel -------------------------------------
 *
 * `normalizeParallel` (hobbyIqCardId.service) is the INGEST function: it turns
 * a parallel NAME into the slug a row is STORED under, and D31 deliberately
 * removed its colour-implies-refractor rules ("Mojo" is written as said). It
 * must stay that way: a product-level colour<->refractor equation destroys
 * Panini Prizm, where Silver and Silver Prizm are different cards
 * (memory: project_colour_equals_refractor_ruling).
 *
 * This function answers a DIFFERENT question, and only ever inside one
 * (year, number, auto, player, printRun) group that has ALREADY been proven to
 * be one card: "are these two strings the same rung spelled by two scrapers?"
 * It never renames a row, never decides a card's identity on its own, and its
 * output is never written to Cosmos -- `foldSpelling` is a grouping key, and
 * `chooseSpelling` picks which EXISTING row's spelling survives.
 *
 * -- WHAT IT FOLDS, AND THE ROWS THAT PROVE EACH ---------------------------
 *
 * Measured over the 112,169-row R2 scope (2026-08-30, read-only):
 *
 *   refractors-refractor  6,321  beckett writes the section plural AND the
 *                                rung: `refractors-refractor`, while
 *                                checklistcenter writes `refractor`.
 *   superfractor family   4,222  `superfractors`, `superfractor-1-refractor`,
 *                                `superfractors-11`.
 *   trailing plural       2,380  `refractors` for `refractor`.
 *   base- glue            2,018  D28's population: `base-refractor` is the
 *                                "Base Cards" section heading glued onto the
 *                                rung, not a rung called "Base Refractor".
 *   bw / black-and-white    525  `bw-mini-diamond-refractor` vs
 *                                `black-and-white-mini-diamond-refractor`.
 *   ampersand               135  `black-&-white-...` for `black-and-white-...`.
 *
 * The 2021 CPA-AM /499 rung is the pin: checklistcenter says `base-refractor`,
 * beckett says `refractors-refractor`, bccp says `refractor`. Three strings,
 * one card, and before this fold three groups that each abstained
 * "single-setkey".
 *
 * -- WHAT IT REFUSES TO FOLD -----------------------------------------------
 *
 * A bare colour and `<colour>-refractor` are NOT folded here. D31 is explicit
 * that no vocabulary rule equates a colour with its refractor; they are the
 * same card only when two different SOURCES spell them at the SAME print run,
 * which is a fact about the GROUP, not about the strings. That decision lives
 * in cpaProductRule where the sources and print runs are in hand. From ONE
 * source at two print runs they are two cards, and folding them here would
 * silently merge a /50 Gold with a /499 Gold Refractor.
 *
 * Pure: no I/O, no clock.
 */

/** The finish words that carry a section-plural or a duplicated suffix. */
const FINISHES = ["refractor", "prizm", "chrome", "foil", "wave", "shimmer", "sparkle", "atomic"] as const;

/**
 * The "Base Cards" section heading D28 strips, as a comparison-time prefix.
 *
 * D28's `clean-base-cards-parallel-slug` is the WRITER: it needs subset
 * evidence before it will strip a bare `base-`, because "Base Variation
 * Refractor" is a real rung. Here we are only deciding whether two rows in a
 * proven-identical group are the same rung, so `base-x` and `x` fold: if both
 * spellings exist in one group, one of them is the glue. A row whose whole
 * parallel is `base` is untouched -- that IS the rung.
 */
function stripBaseGlue(slug: string): string {
  let s = slug;
  if (s.startsWith("base-cards-")) s = s.slice("base-cards-".length);
  else if (s.startsWith("base-") && s !== "base") s = s.slice("base-".length);
  return s || slug;
}

/**
 * Collapse a plural or duplicated finish suffix.
 *   refractors-refractor -> refractor      (beckett's section plural + rung)
 *   refractor-refractor  -> refractor
 *   refractors           -> refractor
 * Applied per finish word so `green-refractors-refractor` -> `green-refractor`
 * keeps its colour.
 */
function collapseFinish(slug: string): string {
  let s = slug;
  for (const fin of FINISHES) {
    s = s.replace(new RegExp(`(?:^|-)${fin}s-${fin}$`), `-${fin}`);
    s = s.replace(new RegExp(`(?:^|-)${fin}-${fin}$`), `-${fin}`);
    s = s.replace(new RegExp(`(?:^|-)${fin}s$`), `-${fin}`);
    s = s.replace(/^-/, "");
  }
  return s || slug;
}

/**
 * The superfractor spellings. `superfractors`, `superfractor-1-refractor` and
 * `superfractors-11` are all the 1/1 superfractor; the trailing digits are the
 * checklist's print-run footnote glued into the name (the same footnote-glue
 * shape as the spine parallel names in the rebuild plan), not a rung number.
 */
function collapseSuperfractor(slug: string): string {
  if (!/superfractors?/.test(slug)) return slug;
  const prefix = slug.replace(/superfractors?[-\d]*(?:-refractor)?.*$/, "");
  return `${prefix}superfractor`.replace(/^-/, "") || "superfractor";
}

/** `&` and the spelled-out `and`, plus the `bw` abbreviation, are one word. */
function normalizeConjunctions(slug: string): string {
  return slug
    .replace(/&/g, "-and-")
    .replace(/(^|-)b-?w(-|$)/g, "$1black-and-white$2")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The comparison key for a parallel slug: two rows whose `foldSpelling` agree
 * are the same rung spelled two ways. NOT a stored value.
 */
export function foldSpelling(parallelSlug: string | null | undefined): string {
  const raw = String(parallelSlug ?? "").toLowerCase().trim().replace(/\s+/g, "-");
  if (!raw) return "";
  let s = normalizeConjunctions(raw);
  s = stripBaseGlue(s);
  s = collapseSuperfractor(s);
  s = collapseFinish(s);
  return s.replace(/-{2,}/g, "-").replace(/^-|-$/g, "") || raw;
}

/** True when two slugs are one rung spelled two ways. */
export function sameSpelling(a: string | null | undefined, b: string | null | undefined): boolean {
  const fa = foldSpelling(a);
  return fa !== "" && fa === foldSpelling(b);
}

/** One candidate spelling, as `chooseSpelling` needs to see it. */
export type SpellingCandidate = {
  parallelSlug: string;
  source: string;
  isChecklist: boolean;
};

/**
 * Which spelling survives, per D31: the MAJORITY spelling among the checklist
 * sources for that product; a tie goes to the LONGER form.
 *
 * "Majority among the CHECKLIST sources" -- a derived or wiki row's spelling
 * never votes, because it was not transcribed from the printed checklist. When
 * no checklist row is present the caller has no ruling to apply and the
 * candidates fall back to the same tie-break, which is stable and never
 * invents a string that no row carries.
 *
 * Each SOURCE votes once for a spelling, not each ROW: a scraper that emitted
 * the same spelling 40 times is one transcription, and letting rows vote would
 * hand the ruling to whichever scrape ran longest.
 */
export function chooseSpelling(candidates: SpellingCandidate[]): string | null {
  const usable = (candidates ?? []).filter((c) => String(c?.parallelSlug ?? "").trim() !== "");
  if (usable.length === 0) return null;

  const voters = usable.filter((c) => c.isChecklist);
  const pool = voters.length > 0 ? voters : usable;

  const bySpelling = new Map<string, Set<string>>();
  for (const c of pool) {
    const slug = String(c.parallelSlug).toLowerCase().trim();
    const set = bySpelling.get(slug) ?? new Set<string>();
    set.add(String(c.source ?? "").toLowerCase().trim());
    bySpelling.set(slug, set);
  }

  let best: string | null = null;
  let bestVotes = -1;
  for (const [slug, sources] of [...bySpelling.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const votes = sources.size;
    if (votes > bestVotes) { best = slug; bestVotes = votes; continue; }
    if (votes === bestVotes && best !== null && slug.length > best.length) best = slug;
  }
  return best;
}
