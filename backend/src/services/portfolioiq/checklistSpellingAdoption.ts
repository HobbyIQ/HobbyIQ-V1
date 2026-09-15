// ---------------------------------------------------------------------------
// checklistSpellingAdoption.ts
//
// CF-THE-CHECKLIST-SPELLS-ITS-OWN-RUNGS (round-2 parallel-ladder probe,
// 2026-09-15).
//
// THE MEASUREMENT. `parallel-ladder-plan-2026-09-15.md` split the audit's
// "37% of sports rows sit at a parallel nothing backs" bucket into three
// causes, and only one of them is a data problem at all:
//
//     SPELLING       938,802 rows   a backed rung EXISTS, named with or
//                                   without the product's family word
//     WRONG PRODUCT   84,605 rows   the rung is backed under a SIBLING
//     TRUE GAP       302,516 rows   nothing backs it anywhere -- acquire
//
// The single largest cell, `baseball/2025/panini-prizm` at 333,931 rows, is
// 100% spelling: the catalog already holds 165 rungs including `Silver Prizms`
// and `Red Ice Prizms`, while the pool writes `Silver` and `Red Ice`. An
// acquirer sent there would buy a ladder we already own.
//
// This module closes that lane. It is the vocabulary map the plan calls for,
// and it is the mechanism two standing rulings already describe: "colour alias
// per checklist" (census rulings 2026-09-03) and market-language normalization
// ("True {Color}" = "{Color} Refractor").
//
// -- THE RULE, AND WHY EACH CLAUSE IS THERE ---------------------------------
//
// For an identity's own (sport, year, setKey) cell: if EXACTLY ONE checklist
// rung either equals the stated finish or extends it by that product's rung
// family word (Prizm/Refractor/Holo/Mosaic...), derive the checklist's
// spelling. Zero candidates or two-or-more: leave the stated finish exactly as
// it is. Never guess, and never Base.
//
//   "Silver"  on baseball|2025|panini-prizm  -> 1 candidate  -> Silver Prizms
//   "Red Ice" on baseball|2025|panini-prizm  -> 1 candidate  -> Red Ice Prizms
//   "Blue"    on baseball|2025|panini-prizm  -> 4 candidates -> UNCHANGED
//                (Blue Ice / Blue / Blue Pulsar / Blue Shimmer FOTL Prizms)
//
// EXACTLY-ONE IS THE WHOLE SAFETY PROPERTY. `Blue` and `Green` each have four
// same-colour rungs on that one product, and picking any of them would be the
// FINISH-FAMILY-COLLISION shape the pipeline already refuses to blanket-decide
// elsewhere. A tie is the product genuinely having more than one rung by that
// name, and it is not ours to resolve -- the same tie-refusal
// `bareColourAliasFromChecklist` carries for the same reason.
//
// THE SUFFIX MUST BE A FAMILY WORD, NOT ANY WORD. Measured over the corpus,
// the most common TRAILING words in rung names are `gold` (2,719), `blue`
// (1,122), `black` (1,071) -- colours. An "extends by one word" rule with no
// vocabulary would adopt "Blue" -> "Silver Blue", inventing a card by reading
// two rungs as one. So the extension must be a word that names the product's
// STOCK -- what the rung is printed on -- never another colour or pattern.
//
// AND THE TIE IS COUNTED BEFORE THAT FILTER RUNS, WHICH IS LOAD-BEARING. An
// earlier draft filtered to family-word suffixes and THEN counted, which made
// a genuine four-way ambiguity look unique: of `Blue Prizms`, `Blue Ice
// Prizms`, `Blue Pulsar Prizms` and `Blue Shimmer FOTL Prizms`, only the first
// survives the filter, so the draft adopted it -- silently choosing one of
// four real, distinct cards. Caught by testing the rule against the very
// product the probe named. Count every rung the text is a prefix of; only if
// there is exactly ONE may its suffix be examined.
//
// -- WHY THIS IS NOT A SYNTHETIC PARALLEL -----------------------------------
//
// Every value this can return is a rung the product's OWN checklist lists
// verbatim. It never mints a name, never crosses to a sibling product (that is
// the R34/R35 re-key lane, a different fix), and never changes which CARD the
// identity names -- only how that one rung is spelled. The colour word is
// invariant by construction: an adoption is a strict extension of the stated
// text, so the stated colour survives into the answer. `spellingAdoptionNeverChangesTheColour`
// pins that over the whole corpus.
//
// DIRECTION OF SAFETY. This WRITES, so it is biased to leaving the pool alone:
// two candidates, no candidates, no product in the corpus, or a stated finish
// that is already a listed rung all mean "no adoption". A row left spelled the
// pool's way is still findable and still correct about the card; a row moved
// to the wrong rung is a split pool.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanParallelName } from "./parallelNameVocabulary.js";

interface ParallelCorpusProduct {
  sport?: string;
  year?: number;
  setKey?: string;
  parallels?: { name?: string }[];
}
interface ParallelCorpus {
  products?: Record<string, ParallelCorpusProduct>;
}

const lower = (s: string): string => String(s ?? "").toLowerCase();

/** Same candidate list every other reader of this corpus uses. */
const CORPUS_CANDIDATES = (): string[] => [
  join(__dirname, "..", "..", "..", "data", "checklist-parallel-names.json"),
  join(process.cwd(), "data", "checklist-parallel-names.json"),
  join(process.cwd(), "backend", "data", "checklist-parallel-names.json"),
  join(process.cwd(), "dist", "data", "checklist-parallel-names.json"),
];

/**
 * THE RUNG FAMILY WORDS -- what a card is PRINTED ON, never what colour it is.
 *
 * A manufacturer's stock word is the half of a rung name the pool routinely
 * drops, because collectors say "Silver" for "Silver Prizm" and "Aqua" for
 * "Aqua Refractor". Those are the same card; `market language normalization`
 * already rules that "True {Color}" = "{Color} Refractor" for the same reason.
 *
 * DELIBERATELY NOT A COLOUR OR A PATTERN. The corpus's most common trailing
 * words are colours (`gold` 2,719, `blue` 1,122, `black` 1,071), and admitting
 * them would let "Blue" adopt "Silver Blue" -- two rungs read as one. Pattern
 * words (`ice`, `pulsar`, `shimmer`, `scope`, `wave`) are excluded for the
 * identical reason: `Blue` vs `Blue Ice` vs `Blue Pulsar` are three DIFFERENT
 * cards on 2025 panini-prizm, and the exactly-one gate below is what protects
 * them -- but only if a pattern word is not treated as a mere spelling.
 *
 * Plural forms are carried because checklists head a section in the plural
 * ("Silver Prizms") while the card is singular -- the same plural-tolerance
 * `checklistListsParallel` already applies.
 */
const RUNG_FAMILY_WORDS: ReadonlySet<string> = new Set([
  "prizm", "prizms",
  "refractor", "refractors",
  "holo", "holos", "holofoil", "holofoils", "holographic",
  "mosaic", "mosaics",
  "optic",
  "foil", "foils", "foilboard",
  "chrome",
  "xfractor", "x-fractor", "xfractors",
  "parallel", "parallels",
  "sapphire",
  "velocity",
  "disco",
  "cracked-ice",
  "prism", "prisms",
]);

interface AdoptionIndex {
  /** `sport|year|setKey` -> that product's cleaned rung names. */
  readonly byProduct: ReadonlyMap<string, readonly string[]>;
}

let _index: AdoptionIndex | null = null;
let _loadFailed = false;

/** Normalised comparison key: case and punctuation are spelling, not identity. */
function key(s: string): string {
  return lower(s).replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

function loadIndex(): AdoptionIndex | null {
  if (_index || _loadFailed) return _index;
  try {
    let text: string | null = null;
    for (const candidate of CORPUS_CANDIDATES()) {
      try { text = readFileSync(candidate, "utf8"); break; } catch { /* next */ }
    }
    if (text == null) throw new Error("checklist-parallel-names.json not found");
    const raw = JSON.parse(text) as ParallelCorpus;
    const byProduct = new Map<string, string[]>();
    for (const [k, product] of Object.entries(raw.products ?? {})) {
      const parts = k.split("|");
      const sport = lower(product.sport ?? parts[0] ?? "");
      const year = product.year ?? Number(parts[1]);
      const setKey = lower(product.setKey ?? parts[2] ?? "");
      if (!sport || !year || !setKey) continue;
      const bucket = `${sport}|${year}|${setKey}`;
      let names = byProduct.get(bucket);
      if (!names) { names = []; byProduct.set(bucket, names); }
      for (const parallel of product.parallels ?? []) {
        // The corpus's raw names carry pack odds; the cleaner is the one place
        // that rule lives (CF-A-PARALLEL-NAME-IS-A-NAME-THE-CHECKLIST-SPELLS).
        // Adopting an uncleaned name would write `Yellow - 1:1 Hanger EA;`
        // onto a sale, which is the defect the sibling commit just closed.
        const cleaned = cleanParallelName(String(parallel.name ?? "").trim());
        if (cleaned && !names.includes(cleaned)) names.push(cleaned);
      }
    }
    _index = { byProduct };
    return _index;
  } catch {
    _loadFailed = true;
    return null;
  }
}

/** Test seam: force a reload. */
export function _resetSpellingAdoption(): void {
  _index = null;
  _loadFailed = false;
}

export interface SpellingAdoptionContext {
  readonly sport?: string | null;
  readonly year?: number | null;
  readonly setKey?: string | null;
}

/**
 * The checklist's own spelling of the rung this finish names, or null when the
 * corpus does not unambiguously say.
 *
 * Returns null -- meaning "leave the stated finish exactly as it is" -- for
 * every uncertainty: no product in the corpus, no candidate, more than one
 * candidate, or a blank/Base input. It never returns Base and never returns a
 * name from a different product.
 */
export function checklistSpellingFor(
  statedFinish: string | null | undefined,
  ctx: SpellingAdoptionContext = {},
): string | null {
  const stated = String(statedFinish ?? "").trim();
  if (!stated) return null;
  // Base is not a rung to be respelled; it is the absence of one.
  if (/^base$/i.test(stated)) return null;

  const sport = lower(ctx.sport ?? "");
  const setKey = lower(ctx.setKey ?? "");
  const year = ctx.year;
  if (!sport || !setKey || year == null) return null;

  const index = loadIndex();
  if (!index) return null;
  const names = index.byProduct.get(`${sport}|${year}|${setKey}`);
  if (!names || !names.length) return null;

  const statedKey = key(stated);
  if (!statedKey) return null;

  // ALREADY THE CHECKLIST'S SPELLING. Nothing to adopt, and saying so is not
  // the same as failing -- the caller keeps what it has either way, but this
  // must not count as an adoption in the banner.
  for (const name of names) if (key(name) === statedKey) return null;

  // EVERY RUNG THIS TEXT COULD BE, BEFORE ANY FILTERING.
  //
  // THE TIE MUST BE MEASURED OVER ALL OF THEM, NOT OVER THE SURVIVORS. Filter
  // first and a genuine ambiguity looks unique: on baseball|2025|panini-prizm,
  // `Blue` extends into `Blue Prizms`, `Blue Ice Prizms`, `Blue Pulsar Prizms`
  // and `Blue Shimmer FOTL Prizms`. Only the first has a pure family-word
  // suffix, so filtering before counting leaves exactly one candidate and
  // adopts it -- silently picking one of four real, distinct cards. Measured
  // while building this module; it is the whole reason the two steps are
  // separate.
  //
  // So: collect every rung the stated text is a prefix of, and if there is
  // more than one, the product genuinely has more than one rung by this name
  // and it is not ours to resolve. That is the same tie-refusal
  // `bareColourAliasFromChecklist` carries, for the same reason.
  const extensions: string[] = [];
  for (const name of names) {
    const nameKey = key(name);
    if (!nameKey.startsWith(`${statedKey} `)) continue;
    if (!extensions.includes(name)) extensions.push(name);
  }
  if (extensions.length !== 1) return null;

  // THE ONE CANDIDATE MUST BE A RESPELLING, NOT A DIFFERENT RUNG. Its added
  // words must ALL name the product's stock (Prizm/Refractor/Holo...). A
  // colour or pattern word in the suffix means the checklist is naming a
  // different card that merely starts with the same words.
  const only = extensions[0];
  const suffix = key(only).slice(statedKey.length).trim().split(" ").filter(Boolean);
  if (!suffix.length) return null;
  if (!suffix.every((w) => RUNG_FAMILY_WORDS.has(w))) return null;
  return only;
}

/**
 * REPORT-ONLY COUNTER for the census/apply banner (`spelling-adopted N`).
 *
 * Deliberately a plain counter the driver reads and prints, not a mutation:
 * this lane is being MEASURED before it is applied, which is the same
 * report-then-apply discipline the census lanes already follow. The rematch
 * can size the 938,802-row estimate against what the derivation actually does.
 */
let _adopted = 0;

/** Count one adoption. Called by the deriver when it takes a checklist spelling. */
export function noteSpellingAdopted(): void {
  _adopted += 1;
}

/** How many adoptions this process has made. */
export function spellingAdoptedCount(): number {
  return _adopted;
}

/** Reset the counter (per run, and for tests). */
export function resetSpellingAdoptedCount(): void {
  _adopted = 0;
}
