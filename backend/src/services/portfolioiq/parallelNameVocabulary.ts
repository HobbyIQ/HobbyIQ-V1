// ---------------------------------------------------------------------------
// parallelNameVocabulary.ts
//
// CF-A-PARALLEL-NAME-IS-A-NAME-THE-CHECKLIST-SPELLS (post-wave audit,
// 2026-09-15).
//
// The 1,300-row post-wave identity audit found 66 sports CONFLICT rows where
// the deriver KEPT a parallel and mangled its name -- "sometimes into
// something that is not a parallel at all". Two shapes, both reproduced
// verbatim against the live parser before this module existed:
//
//   "2024 Topps Update Baseball #US294 Yellow"
//       -> "Yellow - 1:1 Hanger EA;"          raw checklist text, leaked whole
//   "2025 Topps Update Baseball #US319 Pink Diamante Foil"
//       -> "Pink Diamante Foil - Hanger exclusive"
//   "2023 Topps Chrome Platinum Baseball #250 Rose Gold Mini-Diamond Refractor"
//       -> "Rose Gold Mini"                   truncated mid-name
//
// WHY THE CORPUS ITSELF CARRIES THE POLLUTION. `data/checklist-parallel-names
// .json` is scraped from checklist pages, and a checklist prints a rung's name
// next to its PACK ODDS on the same line. So the corpus genuinely holds
// `Refractor - 1:1 Jumbo;`, `Negative Refractor - 1:89 Hobby; 1:27 Jumbo;`,
// `Yellow (Hanger exclusive)` and `Aqua - 1 per pack (Fanatics Box exclusive)`
// as parallel "names". They are not names. They are a name plus the odds at
// which you pull it, and the odds belong to the pack, not to the card.
//
// THIS IS NOT A NEW VOCABULARY. `statedFinishFromChecklist.ts` already strips
// exactly this tail -- `stripOddsTail` + `normaliseName` -- before it indexes
// the corpus, which is why that reader never leaked. The defect is that the
// stripping lives INSIDE that one module and the OTHER readers of the same
// file (`bareColourAliasFromChecklist.ts`, and the hand regexes in
// `parseTitleIdentity.service.ts`) each re-read the raw names. So this module
// is the extraction of an existing, already-correct rule to the one place
// every reader can share -- not a second opinion about what a name is.
//
// -- WHAT "CLEAN" MEANS, AND WHY IT IS THE CORPUS THAT DECIDES ---------------
//
// A cleaned name must be a name the checklist actually spells. That is the
// whole test, and it is the same doctrine `feedback_no_synthetic_parallels_
// only_actuals` states: every parallel we write traces to a scraped source.
// So `cleanParallelName` never invents and never truncates to a fragment:
//
//   1. A name that is in the vocabulary VERBATIM is kept, untouched. The
//      corpus is the authority; if it lists the string, the string is a name.
//   2. Otherwise the odds/annotation tail is stripped, and the result is kept
//      ONLY if the vocabulary lists it.
//   3. Otherwise the answer is the LONGEST vocabulary name the text starts
//      with -- a real, whole, listed name, never a fragment of one.
//   4. Otherwise there is no answer. `null`, and the caller withholds rather
//      than writing a string no checklist has ever printed.
//
// Step 3 is what refuses "Rose Gold Mini": the vocabulary holds `Rose Gold
// Mini-Diamond Refractor` and `Rose Gold Refractor` but never a bare `Rose
// Gold Mini`, so a text starting "Rose Gold Mini-Diamond Refractor" resolves
// to the whole rung and a text that really is only "Rose Gold Mini" resolves
// to nothing rather than minting half a card's name.
//
// -- DIRECTION OF SAFETY ----------------------------------------------------
//
// This module WRITES an identity, so its errors are not free -- the same
// reasoning `statedFinishFromChecklist` records for its own narrowness. It is
// therefore biased to refusing: a refusal keeps the row where it already is
// and is recoverable, while a fragment is a new, wrong, confident address that
// splits a comp pool. Absent beats wrong.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface ParallelCorpus {
  products?: Record<string, { parallels?: { name?: string }[] }>;
}

/** Same candidate list every other reader of this corpus uses, in the same
 *  order: compiled `dist/services/...` and source `src/services/...` both sit
 *  three levels under the package root where `data/` lives, and the
 *  cwd-relative forms cover tests and scripts. */
const CORPUS_CANDIDATES = (): string[] => [
  join(__dirname, "..", "..", "..", "data", "checklist-parallel-names.json"),
  join(process.cwd(), "data", "checklist-parallel-names.json"),
  join(process.cwd(), "backend", "data", "checklist-parallel-names.json"),
  join(process.cwd(), "dist", "data", "checklist-parallel-names.json"),
];

const lower = (s: string): string => String(s ?? "").toLowerCase();

/** A comparison key: case and punctuation are spelling, not identity. The
 *  corpus spells the same rung `Rose Gold Mini-Diamond Refractor` and `Rose
 *  Gold Mini Diamond Refractor` on different products, and both are the card. */
function key(s: string): string {
  return lower(s).replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * THE ANNOTATION TAIL. Verbatim the rule `statedFinishFromChecklist.ts`'s
 * `stripOddsTail` already applies before indexing, kept character-identical so
 * the two cannot drift -- `parallelNameCleanerMirrorsStatedFinish` in the test
 * file asserts they agree on every name in the shipped corpus.
 *
 * Three shapes, each measured in the corpus:
 *   " - 1:1 Hanger EA;"    an odds run introduced by a dash then a ratio
 *   "; 1:27 Jumbo;"        a semicolon and everything after it
 *   " (Hanger exclusive)"  a trailing parenthetical naming a pack or odds
 */
/** The same vocabulary as a WHOLE-WORD test, for the dash-tail form. `ea` and
 *  `se` are the checklist's abbreviations for the pack ("Hanger EA"). */
const RETAILER_OR_ODDS_WORD_RE =
  /^(?:hobby|retail|blaster|jumbo|hanger|mega|value|target|walmart|fanatics|exclusive|exclusives|only|per|pack|packs|box|boxes|tin|odds|ea|se|ae|\d+|\d+\s*:\s*\d+|\d+:\d+)$/i;

const RETAILER_OR_ODDS_PAREN_RE =
  /\b(?:hobby|retail|blaster|jumbo|hanger|mega|value|target|walmart|fanatics|exclusive|per\s+pack|per\s+box|box|pack|packs|tin|odds|\d+\s*:\s*\d+)\b/i;

/** Strip the pack-odds / retailer annotation a checklist prints beside a rung's
 *  name. Exported for the mirror test; callers want `cleanParallelName`. */
export function stripParallelAnnotation(s: string): string {
  let withoutTail = String(s ?? "")
    .replace(/\s[-–—]\s*\d+\s*:.*$/s, "")
    .replace(/;.*$/s, "")
    .trim();
  // A DASH TAIL THAT NAMES A PACK IS AN ANNOTATION EVEN WITH NO RATIO IN IT.
  // `stripOddsTail` only ever saw the ratio form because it runs on names it
  // then matches against a TITLE, and a pack word in a title is harmless. Here
  // the name is WRITTEN, so `Pink Diamante Foil - Hanger exclusive` reaches a
  // sale's identity whole. The tail is removed only when what follows the dash
  // is entirely pack/odds vocabulary -- never when it is part of the rung's
  // name ("Black & White - Red Ink" keeps its tail, `red` and `ink` are not
  // pack words).
  const dashTail = withoutTail.match(/^(.*?)\s[-–—]\s*([^-–—]+)$/s);
  if (dashTail) {
    const tailWords = lower(dashTail[2]).split(/[^a-z0-9:]+/).filter(Boolean);
    const allAnnotation = tailWords.length > 0
      && tailWords.every((w) => RETAILER_OR_ODDS_WORD_RE.test(w));
    if (allAnnotation && dashTail[1].trim()) withoutTail = dashTail[1].trim();
  }
  const parenMatch = withoutTail.match(/\s*(\([^()]*\))\s*$/);
  if (parenMatch && RETAILER_OR_ODDS_PAREN_RE.test(parenMatch[1])) {
    return withoutTail.slice(0, parenMatch.index).trim();
  }
  return withoutTail;
}

interface Vocab {
  /** key -> the corpus's own display spelling for that key. */
  readonly byKey: ReadonlyMap<string, string>;
  /** Every key, longest first, for the longest-prefix walk. */
  readonly keysLongestFirst: readonly string[];
}

let _vocab: Vocab | null = null;
let _loadFailed = false;

function loadVocab(): Vocab | null {
  if (_vocab || _loadFailed) return _vocab;
  try {
    let text: string | null = null;
    for (const candidate of CORPUS_CANDIDATES()) {
      try { text = readFileSync(candidate, "utf8"); break; } catch { /* try the next */ }
    }
    if (text == null) throw new Error("checklist-parallel-names.json not found");
    const raw = JSON.parse(text) as ParallelCorpus;
    const byKey = new Map<string, string>();
    for (const product of Object.values(raw.products ?? {})) {
      for (const parallel of product.parallels ?? []) {
        const name = String(parallel.name ?? "").trim();
        if (!name) continue;
        // ONLY THE CLEANED SPELLING IS THE VOCABULARY, and that is the whole
        // point. Seeding the raw name too would make every polluted string a
        // "listed name" of itself, so step 1 below would match it verbatim and
        // hand it straight back -- which is exactly the leak this module
        // exists to close, reintroduced by the index. Measured while building
        // this: with raw names seeded, `Yellow - 1:1 Hanger EA;` round-tripped
        // unchanged.
        //
        // A first writer wins: the corpus's own first spelling of a key is the
        // one we answer with, which keeps the answer stable across runs.
        const form = stripParallelAnnotation(name);
        const k = key(form);
        if (!k) continue;
        if (!byKey.has(k)) byKey.set(k, form);
      }
    }
    const keysLongestFirst = [...byKey.keys()].sort((a, b) => b.length - a.length);
    _vocab = { byKey, keysLongestFirst };
    return _vocab;
  } catch {
    // The corpus is a build artifact copied into dist/. If it is absent this
    // module answers null for everything and every caller keeps the answer it
    // already had -- the pre-existing behaviour. Degrade, never throw.
    _loadFailed = true;
    return null;
  }
}

/** Test seam: force a vocabulary reload. */
export function _resetParallelNameVocabulary(): void {
  _vocab = null;
  _loadFailed = false;
}

/** Is this exact text a name the checklist corpus spells? */
export function isVocabularyParallelName(s: string): boolean {
  const v = loadVocab();
  if (!v) return false;
  const k = key(s);
  return k ? v.byKey.has(k) : false;
}

/**
 * The checklist's own name for what this text names, or null when the corpus
 * spells no such rung.
 *
 * The four steps are in the module header. The one thing to hold onto: every
 * value this can return is a WHOLE name the corpus lists, so it cannot mint a
 * rung a checklist has never printed.
 */
export function cleanParallelName(raw: string | null | undefined): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const v = loadVocab();
  // NO CORPUS IS NOT A LICENCE TO REWRITE. With the vocabulary absent this
  // module has no opinion, and the honest answer is the caller's own text --
  // unchanged, exactly as before this module existed.
  if (!v) return text;

  // 1. VERBATIM. The corpus lists it; the corpus is the authority.
  const exact = v.byKey.get(key(text));
  if (exact) return exact;

  // 2. THE SAME NAME WITH ITS ODDS TAIL REMOVED.
  const stripped = stripParallelAnnotation(text);
  if (stripped && stripped !== text) {
    const hit = v.byKey.get(key(stripped));
    if (hit) return hit;
  }

  // 3. THE LONGEST LISTED NAME THIS TEXT STARTS WITH -- BUT ONLY WHEN WHAT IT
  //    LEAVES BEHIND IS ANNOTATION.
  //
  //    The brief asks for "the longest name in the vocabulary that the text
  //    starts with", and the unguarded form of that rule is itself a
  //    fragment-minter: `Rose Gold Mini` starts with the listed name `Rose
  //    Gold`, so the unguarded rule answers "Rose Gold" -- a DIFFERENT, real
  //    card, which is worse than refusing, because it is confidently wrong
  //    rather than absent. Measured while building this module.
  //
  //    So a prefix may only win when the residue is pack/odds vocabulary the
  //    strip above did not recognise. A residue of real words means the text
  //    names a rung this corpus does not list, and the answer is none.
  const k = key(text);
  for (const candidate of v.keysLongestFirst) {
    if (k === candidate) return v.byKey.get(candidate) ?? null;
    if (!k.startsWith(`${candidate} `)) continue;
    const residue = k.slice(candidate.length).trim().split(" ").filter(Boolean);
    if (residue.length && residue.every((w) => RETAILER_OR_ODDS_WORD_RE.test(w))) {
      return v.byKey.get(candidate) ?? null;
    }
    return null;
  }

  // 4. NO LISTED NAME. Absent beats wrong.
  return null;
}
