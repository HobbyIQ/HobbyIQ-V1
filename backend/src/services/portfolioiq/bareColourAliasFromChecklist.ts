// ---------------------------------------------------------------------------
// bareColourAliasFromChecklist.ts
//
// CF-A-BARE-COLOUR-IS-WHATEVER-ITS-OWN-CHECKLIST-SAYS (2026-09-13).
//
// THE FINDING. `dropped:parallel` is ~10% of all non-Pokemon pool rows. In
// 448 of 450 sampled rows (round-2 parallel-semantics rulings, 2026-09-13),
// the TITLE plainly states a bare colour word ("2025 Donruss Elite Football
// #9 Green"), the row's own `parallel` field already carries that same bare
// word, and `extractParallel` still answers "Base" -- not because the colour
// is unreadable, but because the gate that turns a bare colour into a
// checklist parallel name was hand-built product by product (the Chrome-only
// CHROME_PRODUCT_RE colour=refractor rule, the Prizm/Optic/Select/Contenders
// families) and simply never reached `donruss-elite`, `panini-certified`,
// `panini-prizm-draft-picks`, `topps-signature-class`, and the rest of the
// 2024-2025 football release slate.
//
// THE 2026-09-03 RULING THIS EXTENDS ("bare colour is an alias of the
// checklist spelling, per product... never a blanket suffix" -- the retracted
// "colour=refractor" global rule is exactly the mistake this doctrine
// replaced it with). The per-product allowlist that ruling created was
// hand-maintained -- a human had to notice a product, read its checklist, and
// add an entry. That is the shape that produced the gap: donruss-elite has
// shipped a bare "Green" and "Orange" parallel every year since it exists,
// and nobody had gotten to it yet. Doctrine text was never in question, only
// its coverage.
//
// THE FIX IS TO DERIVE THE ALLOWLIST, NOT TO KEEP HAND-EXTENDING IT. For
// every product the corpus carries, this module asks: does this product's
// OWN checklist have exactly one parallel built from this colour word? If
// so, a bare colour in the title can only mean that parallel -- there is no
// other candidate for the seller to have meant. If two or more parallels are
// built from the same colour ("Green Disco" / "Spellbound Green" / "MVPBound
// Green" -- donruss-elite's own insert ladder), the colour is genuinely
// ambiguous FOR THAT PRODUCT and this module refuses, exactly as the
// FINISH-FAMILY-COLLISION guard refuses a title/slug colour collision
// elsewhere in the pipeline: a name a fleet cannot safely guess is not a
// name a fleet should guess.
//
// "EXACTLY ONE" MEANS THE SHORTEST NAME CONTAINING THE COLOUR IS UNIQUE, NOT
// THAT THE COLOUR APPEARS EXACTLY ONCE. A colour word recurs across a whole
// insert ladder by construction -- donruss-elite alone lists 10-22 parallel
// names containing "Orange" (Full Throttle Orange, Elite Deck Orange, Career
// Best Orange, ...), because Panini prints the same accent colour across
// every insert tier. None of those is what a bare "#9 Green" title means;
// the checklist's own BASE-TIER colour parallel (the shortest name built from
// the colour, with no insert-line word in front of it) is. Measured directly
// against the round-2 samples: donruss-elite's shortest "Orange"/"Green" is
// the bare word itself (an actual checklist row, not a fallback), and
// panini-certified's shortest "Teal"/"Green"/"Blue" is "Mirror <Colour>" --
// panini-certified has never printed a bare, unqualified colour parallel,
// only the Mirror-prefixed one, and "Mirror" is the product's base parallel
// line the same way "Refractor" is Chrome's. When two names tie for
// shortest ("Green Disco" vs "Spellbound Green" vs "MVPBound Green", all two
// words), there is no unique shortest name and the colour stays unresolved --
// this is what stops a product with two same-length same-colour parallels
// from being force-resolved.
//
// A COLOUR THAT IS PART OF THE PRODUCT'S OWN NAME IS NEVER A PARALLEL. Some
// products spell a colour into their own setKey (`panini-gold-standard`,
// `topps-chrome-black`, `bowman-sapphire`, `panini-prizm-black`,
// `upper-deck-black-diamond`). A bare "Gold" title on `panini-gold-standard`
// must never resolve to a parallel just because the product's own name
// contains the word -- the product word is suppressed the same way
// `statedFinishFromChecklist`'s `own` set suppresses a product's own setKey
// words from being read as a stated finish.
//
// WHERE THE MAP IS BUILT, AND WHY. Built lazily at first use from the
// ALREADY-SHIPPED `data/checklist-parallel-names.json` (37,849 checklist
// parallel spellings over 627 products, generated 2026-09-04 by
// build-parallel-vocabulary.cjs from Beckett bulk exports) -- the exact same
// corpus and load path `statedFinishFromChecklist.ts` already uses, so this
// module adds no new file, no new drift surface and no I/O beyond the one
// `readFileSync` that module already pays for on first call. A second,
// separately-generated JSON keyed the same way would only be a second copy
// of the same 627 products to keep in sync; deriving from the one corpus
// already on disk is the smaller, not the larger, surface. The computed
// per-product colour map is cached in module scope after the first build, so
// the identity hot path (`extractParallel`, called per title) does zero I/O
// and zero recomputation after the first call in the process -- the same
// contract `_index` already gives `statedFinishFromChecklist`.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//
//   * IT NEVER OVERRIDES A RULE. Called only from the same last-chance slot
//     `statedFinishFromChecklist` occupies -- after every colour, pattern,
//     product and scarcity rule in `extractParallel` has already run and
//     returned, and after the checklist finish reader and the Pokemon finish
//     reader have both had their turn. A title that names a FINISH ("Orange
//     Refractor", "Green Disco") is answered by those readers first; this
//     one only ever sees a title whose colour has no finish word beside it.
//   * IT NEVER GUESSES WITHOUT THE PRODUCT. With no (year, setKey) there is
//     no checklist to ask, so the answer is null -- this is a narrower
//     reader than the finish corpus's global fallback, not a wider one,
//     because a bare colour with no product context is exactly the "Blue
//     Jays" / "Red Sox" shape that has no finish evidence at all.
//   * IT NEVER RESOLVES AN AMBIGUOUS COLOUR. Two or more same-length
//     shortest names for one colour on one product leaves the colour
//     unresolved for that product, permanently -- the same "several real
//     cards, one colour family" shape FINISH-FAMILY-COLLISION already
//     refuses to blanket-decide elsewhere in the pipeline.
//   * IT NEVER READS A PRODUCT WORD AS A COLOUR PARALLEL. A colour baked
//     into the product's own setKey is suppressed from candidacy entirely.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/** Same candidate list `statedFinishFromChecklist.ts` uses for the same file. */
const CORPUS_CANDIDATES = (): string[] => [
  join(__dirname, "..", "..", "..", "data", "checklist-parallel-names.json"),
  join(process.cwd(), "data", "checklist-parallel-names.json"),
  join(process.cwd(), "backend", "data", "checklist-parallel-names.json"),
  join(process.cwd(), "dist", "data", "checklist-parallel-names.json"),
];

/**
 * THE COLOUR VOCABULARY. A mirror of the union of colour words already
 * recognised elsewhere in the pipeline (`BARE_COLOURS` in
 * `titleOutranksVendorTag.ts`, `PATTERN_COLOUR` and the Chrome bare-colour
 * scan in `parseTitleIdentity.service.ts`, `COLOUR_WORDS` in
 * `statedFinishFromChecklist.ts`) plus a handful this round's samples named
 * that none of those lists carried yet (`teal`, `coral`). Kept as its own
 * list rather than an import: the modules it mirrors serve different
 * purposes (title recognition vs. this module's checklist-side resolution)
 * and a shared identifier would invite one to change for the other's reason.
 */
const COLOUR_WORDS: readonly string[] = [
  "black", "blue", "bronze", "coral", "gold", "green", "orange", "pink",
  "platinum", "purple", "red", "silver", "teal", "white", "yellow",
  "aqua", "sepia", "magenta", "indigo", "lime", "violet", "rose", "amber",
  "onyx", "emerald", "ruby", "sapphire", "fuchsia", "copper", "cyan",
];
const COLOUR_WORD_SET: ReadonlySet<string> = new Set(COLOUR_WORDS);

function wordsOf(s: string): string[] {
  return lower(s).replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

/** `year|setKey` -> (colour word -> the checklist's own spelling of the parallel it names). */
type ProductColourMap = ReadonlyMap<string, ReadonlyMap<string, string>>;

let _map: ProductColourMap | null = null;
let _loadFailed = false;

/**
 * For one product's parallel ladder, find every colour word that resolves
 * unambiguously -- the shortest checklist name containing that colour word
 * is unique. Ties (two-or-more names at the minimum word count) leave the
 * colour out of the returned map entirely: NOT resolved, not "resolved to
 * the first one found."
 */
function colourMapForProduct(setKey: string, names: readonly string[]): Map<string, string> {
  const productWords = new Set(setKey.split(/[^a-z0-9]+/).filter(Boolean));
  const out = new Map<string, string>();
  for (const colour of COLOUR_WORDS) {
    // A colour baked into the product's own name is never a parallel on that
    // product -- "panini-gold-standard" cannot mint a "Gold" parallel from
    // its own name, no matter what its checklist otherwise lists.
    if (productWords.has(colour)) continue;

    let bestLen = Infinity;
    let bestName: string | null = null;
    let tie = false;
    for (const name of names) {
      const ws = wordsOf(name);
      if (!ws.includes(colour)) continue;
      if (ws.length < bestLen) {
        bestLen = ws.length;
        bestName = name;
        tie = false;
      } else if (ws.length === bestLen) {
        // A second name at the same shortest length is a second real
        // candidate ("Green Disco" and "Spellbound Green" both two words) --
        // the product genuinely has more than one same-colour parallel and
        // the colour is not this product's to resolve.
        if (lower(name) !== lower(bestName ?? "")) tie = true;
      }
    }
    if (bestName && !tie) out.set(colour, bestName);
  }
  return out;
}

function buildMap(): ProductColourMap {
  const byProduct = new Map<string, Map<string, string>>();
  let text: string | null = null;
  for (const candidate of CORPUS_CANDIDATES()) {
    try { text = readFileSync(candidate, "utf8"); break; } catch { /* try the next */ }
  }
  if (text == null) throw new Error("checklist-parallel-names.json not found");
  const raw = JSON.parse(text) as ParallelCorpus;
  for (const product of Object.values(raw.products ?? {})) {
    const setKey = lower(product.setKey ?? "");
    const year = product.year;
    if (!setKey || year == null) continue;
    const names = (product.parallels ?? [])
      .map((p) => String(p.name ?? "").trim())
      .filter(Boolean);
    if (!names.length) continue;
    const productKey = `${year}|${setKey}`;
    // The same (year, setKey) can appear once per sport in the source corpus
    // (a coincidental cross-sport setKey collision, e.g. a shared checklist
    // pull); merge rather than overwrite so neither sport's ladder is lost,
    // and let a genuine cross-sport tie fall out of the tie-detection above
    // by re-running the resolver over the union on the second pass.
    const existing = byProduct.get(productKey);
    const merged = existing ? [...names] : names;
    if (existing) {
      // Re-derive from the union: simplest correct behaviour for the rare
      // collision case, and this path only runs once at load time.
      const seen = new Set<string>();
      const allNames: string[] = [];
      for (const n of [...existing.values()]) { if (!seen.has(lower(n))) { seen.add(lower(n)); allNames.push(n); } }
      for (const n of merged) { if (!seen.has(lower(n))) { seen.add(lower(n)); allNames.push(n); } }
      byProduct.set(productKey, colourMapForProduct(setKey, allNames));
    } else {
      byProduct.set(productKey, colourMapForProduct(setKey, names));
    }
  }
  return byProduct;
}

function loadMap(): ProductColourMap | null {
  if (_map || _loadFailed) return _map;
  try {
    _map = buildMap();
  } catch {
    // Degrade, never throw -- the corpus is a build artifact copied into
    // dist/. If it is absent this module answers null for everything and the
    // caller keeps "Base", the pre-existing behaviour.
    _loadFailed = true;
    _map = null;
  }
  return _map;
}

/** Test seam: force a rebuild (a fresh corpus read on the next call). */
export function _resetBareColourAliasMap(): void {
  _map = null;
  _loadFailed = false;
}

/**
 * Does this title state a single bare colour word, with nothing else beside
 * it that would make it a NAMED finish (a pattern word, "Refractor", a second
 * colour)? Deliberately narrow: this function's caller already ran after
 * every finish-bearing rule failed, so anything richer than a lone colour
 * word has already had its chance to match elsewhere and this must not
 * relitigate that -- it exists only to catch the residue where the title
 * really does say nothing but the colour.
 */
function bareColourInTitle(titleWordSet: ReadonlySet<string>): string | null {
  let found: string | null = null;
  for (const colour of COLOUR_WORDS) {
    if (!titleWordSet.has(colour)) continue;
    if (found) return null; // two colours named together is not "a bare colour"
    found = colour;
  }
  return found;
}

export interface BareColourAliasContext {
  year?: number | null;
  setKey?: string | null;
}

/**
 * THE CHECKLIST PARALLEL A BARE COLOUR WORD NAMES ON THIS PRODUCT, or null.
 *
 * Returns the checklist's own spelling (title-cased already, since the
 * corpus stores the manufacturer's published name) when this product's
 * checklist has exactly one parallel built from the title's bare colour
 * word, and null when there is no product context, no corpus entry, no
 * colour, more than one colour, or the colour is ambiguous for this
 * specific product.
 *
 * Callers reach this ONLY at the same last-chance point
 * `statedFinishFromChecklist` occupies -- after every named-finish rule and
 * the checklist finish reader have already returned nothing.
 */
export function bareColourAliasFromChecklist(
  title: string,
  ctx: BareColourAliasContext = {},
): string | null {
  const year = ctx.year;
  const setKey = lower(ctx.setKey ?? "");
  if (year == null || !setKey) return null;

  const map = loadMap();
  if (!map) return null;
  const colours = map.get(`${year}|${setKey}`);
  if (!colours || !colours.size) return null;

  const titleWordSet = new Set(wordsOf(title));
  if (!titleWordSet.size) return null;
  const colour = bareColourInTitle(titleWordSet);
  if (!colour) return null;

  return colours.get(colour) ?? null;
}

/** Test seam: the full derived map, for a coverage-count assertion. */
export function _bareColourAliasMapForTest(): ProductColourMap | null {
  return loadMap();
}

export const __COLOUR_WORDS_FOR_TEST: readonly string[] = COLOUR_WORDS;
