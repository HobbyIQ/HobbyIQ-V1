// ---------------------------------------------------------------------------
// insertSetTitleReader.ts
//
// R66/R67/R70 (Drew, 2026-09-19). THE DEFECT: a sale whose title names a
// NAMED INSERT SET of its own product ("2024 Panini Totally Certified
// Portraits #8 Brock Bowers", "1997 Fleer Decade of Excellence #1 Wade
// Boggs") derives to the BASE card of that number -- another player's card.
// Measured on the 20,840-row R32 export, 1,775 titles name a known insert of
// their own product and ~97% lose the name entirely.
//
// R66 -- the title reader must recognise named insert sets.
// R67 -- a named insert set is its own PRODUCT KEY (`<setKey>-<root-slug>`);
//        colours/tiers ride the parallel, exactly as they do for the base
//        card. Keys are registered in `catalog/productSetKeys.ts`.
// R70 -- when a title names an insert set of its own product that has NO
//        registered product key, the sale is PARKED: kept, counted, out of
//        every price pool, never pooled on the base card. The parked list is
//        the registration queue.
//
// WHERE THIS LIVES, AND WHY. This module is pure (no I/O beyond the one JSON
// read, memoised) and is consulted ONLY from the two writers
// (`soldCompsStore.service.ts`, `persistVendorSalesToPool.service.ts`) as an
// async-free pre-step, before the slug is derived. It does NOT live in
// `parseTitleIdentity.service.ts` or `hobbyIqCardId.service.ts` -- both are
// declared derivation-stamp inputs (`scripts/lib/derivation-version.cjs`),
// and a change to what a re-derivation says needs the census re-baseline
// ceremony. Rewriting the WRITER's `setKey`/`setName` input before either of
// those stamp-input modules ever sees it changes what gets WRITTEN without
// changing what either of them, in isolation, DERIVES from a given
// (sport, year, setKey, title) -- so the I9 stamp does not move.
//
// THE VOCABULARY SOURCE. `data/checklist-parallel-names.json`'s
// `insertSets[]` per (sport, year, setKey): each entry is `{ root, children }`
// -- a coloured child ("Illusionists Orange") is its own root when the
// checklist carries no bare parent (the Illusions/Zenith coverage gap;
// see the reader's own tests). Matching a child still identifies the insert;
// R67's registered-key composition is always `${setKey}-${slugify(root)}`,
// checked EXACTLY against `catalog/productSetKeys.ts` (never a fuzzy/prefix
// match, which would risk pulling in an unrelated registered product).
//
// THE OVER-REACH GUARD (R66 step 2, landed first on
// `r66/insert-title-reader-0919-0200`, reused here). 35 insert roots in the
// committed corpus are built ENTIRELY of their own product's setKey words
// ("Certified" on panini-certified, "Select" on panini-select, "Flawless" on
// panini-flawless). Without the guard, every base sale of those products
// would read as naming an insert. `isProductWord` is the same per-(setKey)
// authority `rematch-finish-vocab.cjs` uses for the census reader; there is
// no second list to keep in step.
//
// THE PLAYER-SPAN GUARD (new here, R66 step 1's own requirement). A root
// that overlaps the recognised PLAYER NAME token span never matches when the
// writer knows the player -- "Young Guns" must never fire on a sale of Trae
// Young or Chase Young. This is a narrower, WRITE-TIME version of the
// scoping problem `statedFinishFromChecklist.ts` solved for its own
// cross-product frequency floor; here it is trivial, because the writer
// already holds a resolved player name and the corpus is already scoped to
// one product, so simple token-overlap is sufficient and safe.
//
// THE PARALLEL-COLLISION GUARD. A root that is ALSO listed in the product's
// own `parallels[]` is a finish family riding the base card (Panini
// Certified's "Mirror", "Mirror Black" / "Mirror Gold" are ordinary colour
// children of it) -- not a proper-noun insert set. Refuse the match; the
// existing finish-word readers already own that name.
//
// TWO INSERTS NAMED IN ONE TITLE. Never choose between them -- park with a
// distinct reason (`two-inserts-named`) rather than guess which one the sale
// is regardless. This is deliberately DIFFERENT from R67's registered-key
// mechanism because there is no "longest match wins" answer when the two
// roots name two different products' games: guessing either one risks
// filing the sale on the wrong card.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { productEntry } from "../catalog/productSetKeys.js";

interface InsertSetEntry {
  root?: string;
  children?: string[];
}
interface ParallelEntry {
  name?: string;
}
interface ProductEntry {
  sport?: string;
  year?: number;
  setKey?: string;
  parallels?: ParallelEntry[];
  insertSets?: InsertSetEntry[];
}
interface ParallelCorpus {
  products?: Record<string, ProductEntry>;
}

/** Same candidate list `parallelNameVocabulary.ts` uses, for the same reason:
 *  compiled `dist/` and source `src/` both sit three levels under the
 *  package root where `data/` lives; the cwd-relative forms cover tests.
 *  `INSERT_SET_CORPUS_OVERRIDE` is a test-only seam (mirrors
 *  `rematch-finish-vocab.cjs`'s `REMATCH_PARALLEL_CORPUS`) for pinning this
 *  module's guards against a small synthetic fixture rather than the whole
 *  shipped corpus. */
const CORPUS_CANDIDATES = (): string[] => {
  const override = process.env.INSERT_SET_CORPUS_OVERRIDE;
  if (override) return [override];
  return [
    join(__dirname, "..", "..", "..", "data", "checklist-parallel-names.json"),
    join(process.cwd(), "data", "checklist-parallel-names.json"),
    join(process.cwd(), "backend", "data", "checklist-parallel-names.json"),
    join(process.cwd(), "dist", "data", "checklist-parallel-names.json"),
  ];
};

const lower = (v: unknown): string => String(v ?? "").trim().toLowerCase();

/** A minimum token length so a corpus fragment ("a", "of") is never treated
 *  as a meaningful setKey/root word. Mirrors `rematch-finish-vocab.cjs`'s
 *  `MIN_TOKEN_LEN`, kept independent on purpose -- this module must not
 *  depend on a script-lib `.cjs`, which is not on the runtime's module path. */
const MIN_TOKEN_LEN = 3;

/** The tokens a setKey is made of. `topps-heritage-chrome` -> topps,
 *  heritage, chrome -- each of which, ON THAT PRODUCT, names the set. */
function setKeyTokens(setKey: string): string[] {
  return lower(setKey)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= MIN_TOKEN_LEN);
}

/** Normalise free text to lowercase, alphanumeric-and-space tokens. */
function normaliseWords(s: string): string[] {
  return lower(s)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Deterministic slug for composing a candidate registered key
 *  (`${setKey}-${slugify(root)}`). Deliberately a small local
 *  implementation rather than importing `hobbyIqCardId.service.ts`'s
 *  `slugify` -- that file is a declared derivation-stamp input and this
 *  module must not create even a read-only coupling to it. */
function slugifyRoot(s: string): string {
  return lower(s)
    .replace(/[^a-z0-9\s-]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Is this token the PRODUCT's own name on this card, rather than an insert
 *  or a finish? Read from the setKey itself so it works for every product,
 *  not only the ones some hand list happens to name. */
function isProductWord(token: string, setKey: string): boolean {
  const t = lower(token);
  return t.length > 0 && setKeyTokens(setKey).includes(t);
}

/** A root whose every word is a product word cannot distinguish an insert
 *  sale from a base sale (R66 over-reach guard). A root that merely CONTAINS
 *  a product word survives -- "Select Certified" on panini-select is a real
 *  insert, and its other word carries the meaning. */
function allWordsAreProductWords(root: string, setKey: string): boolean {
  const words = normaliseWords(root);
  return words.length > 0 && words.every((w) => isProductWord(w, setKey));
}

/**
 * PARALLEL-COLLISION GUARD -- is this candidate a FINISH FAMILY riding the
 * base card, rather than a proper-noun insert set?
 *
 * SINGLE-WORD ROOTS ONLY, exact match against `parallels[]` -- the same
 * scope the proven `rematch-finish-vocab.cjs` census reader uses
 * (`parallelNames.has(n) && !n.includes(" ")`), reused rather than
 * reinvented. `panini-certified`'s "Mirror" is refused this way: never
 * itself a bare parallel name, but a single word, and "Mirror Black" /
 * "Mirror Gold" ARE ordinary parallels of the same product -- the same
 * relationship "Prizm" has to "Silver Prizm" (a finish family, not a proper
 * noun).
 *
 * DELIBERATELY NOT EXTENDED TO MULTI-WORD ROOTS. A prefix test ("does some
 * parallel start with this root plus a word") looked like the natural
 * generalisation and was tried; it wrongly refused `panini-illusions`'s
 * "Trophy Collection" -- a REAL, separately registered insert
 * (`panini-illusions-trophy-collection`) whose checklist source ALSO scrapes
 * its coloured children ("Trophy Collection Blue", "... Gold", ...) into
 * `parallels[]`, a corpus-building artifact of that one product's source
 * page, not evidence that "Trophy Collection" is a generic finish family the
 * way "Mirror" is. A multi-word proper noun is not ambiguous with a colour
 * word the way a single word can be; the risk of a false refusal there
 * measurably outweighs the false-positive class this guard closes for
 * single-word roots.
 */
function isFinishFamilyOfParallels(rootNorm: string, parallelNames: ReadonlySet<string>): boolean {
  return !rootNorm.includes(" ") && parallelNames.has(rootNorm);
}

/**
 * GENERIC-CARD-ATTRIBUTE ROOTS -- a BARE SINGLE WORD that describes the
 * card, not how it is printed, is never sufficient on its own to name an
 * insert (found measuring this module against the R32 export, 2026-09-19).
 *
 * `football|2024|panini-select` and `basketball|2024|panini-prizm` both
 * carry a corpus root literally spelled "Rookie" whose OWN children are
 * "Rookie Penmanship", "Rookie Signatures", "Rookie Variations" -- three
 * distinct real insert sets the corpus builder folded under their shared
 * first word, not one card set named "Rookie". Matching the bare root
 * against a title is worse than absent: EVERY ordinary rookie-card sale of
 * these products ("2024 Panini Select #23 ... RC") contains the word
 * "rookie" and would park, at scale (162 + 104 + 115 rows in the 20,840-row
 * measurement, more than any genuine insert root). The multi-word children
 * ("Rookie Penmanship", "Rookie Phenom Jerseys") are untouched by this list
 * and remain fully matchable -- a title that actually states one of those
 * names still matches on it.
 *
 * The same judgment already exists, hand-made, in
 * `scripts/lib/rematch-finish-vocab.cjs`'s `CORPUS_STOPWORDS` ("rookie" /
 * "rookies" / "dual" / "triple" / "quad" / "gold" -- "these describe the
 * CARD or the SLAB, not how it is printed"). This is the narrow subset of
 * that same list that also appears as a BARE single-word insert root
 * somewhere in the committed corpus; kept independent (not imported from the
 * `.cjs`, which is not on this runtime's module path) so this module stays a
 * pure ESM leaf.
 */
const GENERIC_SINGLE_WORD_ROOTS = new Set([
  "rookie", "rookies", "dual", "triple", "quad", "gold", "auto", "autos",
  "signature", "signatures", "relic", "relics", "patch", "patches",
  "jersey", "prospect", "prospects", "base",
]);

/** A single-word root that is a generic card attribute is refused; a
 *  multi-word root ("Rookie Phenom Jerseys") is untouched. */
function isGenericSingleWordRoot(root: string): boolean {
  const words = normaliseWords(root);
  return words.length === 1 && GENERIC_SINGLE_WORD_ROOTS.has(words[0]);
}

/**
 * A BARE NUMBER IS NEVER AN INSERT NAME. `basketball|2024|panini-totally-
 * certified` carries a corpus root literally spelled "2024" -- a year-badge
 * checklist section header, not a proper noun -- with real children
 * ("2024 Mirror Blue"). Matching the bare root would catch every title of
 * that year: found measuring this module against the R32 export (37 rows on
 * this one product alone). `2020`-`2024` are the only such roots in the
 * committed corpus, all the same shape.
 */
function isBareNumberRoot(root: string): boolean {
  return /^\d+$/.test(root.trim());
}

interface ProductIndexEntry {
  /** insert root/child names -> the ROOT they belong to (both normalised). */
  namesToRoot: Map<string, string>;
  /** every distinct root, normalised. */
  roots: Set<string>;
  /** normalised parallel names, for the parallel-collision guard. */
  parallelNames: Set<string>;
}

interface Index {
  /** key: `${sport}|${year}|${setKey}` (all lowercased) */
  byProduct: Map<string, ProductIndexEntry>;
}

let _index: Index | null | undefined;

function buildIndex(): Index | null {
  let text: string | null = null;
  for (const candidate of CORPUS_CANDIDATES()) {
    try { text = readFileSync(candidate, "utf8"); break; } catch { /* try the next */ }
  }
  if (text == null) return null;
  let doc: ParallelCorpus;
  try { doc = JSON.parse(text) as ParallelCorpus; } catch { return null; }

  const byProduct = new Map<string, ProductIndexEntry>();
  for (const product of Object.values(doc.products ?? {})) {
    const sport = lower(product.sport);
    const year = product.year;
    const setKey = lower(product.setKey);
    if (!sport || !setKey || typeof year !== "number") continue;
    const pk = `${sport}|${year}|${setKey}`;

    const parallelNames = new Set<string>();
    for (const p of product.parallels ?? []) {
      const n = normaliseWords(String(p?.name ?? "")).join(" ");
      if (n) parallelNames.add(n);
    }

    const namesToRoot = new Map<string, string>();
    const roots = new Set<string>();
    for (const is of product.insertSets ?? []) {
      const rootRaw = String(is?.root ?? "").trim();
      if (!rootRaw) continue;
      const rootNorm = normaliseWords(rootRaw).join(" ");
      if (!rootNorm) continue;
      // OVER-REACH GUARD: a root built entirely of this product's own setKey
      // words is not an insert of itself.
      if (allWordsAreProductWords(rootRaw, setKey)) continue;
      // PARALLEL-COLLISION GUARD: a name the same product's `parallels[]`
      // also lists (exactly, or as "<root> <word>") is a finish family riding
      // the base card, not a proper noun insert set.
      if (isFinishFamilyOfParallels(rootNorm, parallelNames)) continue;
      // GENERIC-SINGLE-WORD-ROOT GUARD: a bare root that is a card-attribute
      // word ("Rookie") rather than a proper noun is not itself a matchable
      // insert -- its own children carry the real names. The root is simply
      // never indexed; a multi-word child of it (e.g. "Rookie Signatures",
      // handled below) is unaffected.
      const rootIsGeneric = isGenericSingleWordRoot(rootRaw) || isBareNumberRoot(rootRaw);
      if (!rootIsGeneric) {
        roots.add(rootNorm);
        if (!namesToRoot.has(rootNorm)) namesToRoot.set(rootNorm, rootNorm);
      }
      for (const child of is?.children ?? []) {
        const childNorm = normaliseWords(String(child ?? "")).join(" ");
        if (!childNorm) continue;
        if (parallelNames.has(childNorm)) continue;
        // A child that is ITSELF just the generic word or a bare number (a
        // root "Rookie"/"2024" whose own children list includes the bare
        // root spelling again) is the same non-answer as the root -- skip it
        // too.
        if (rootIsGeneric && (isGenericSingleWordRoot(childNorm) || isBareNumberRoot(childNorm))) continue;
        // WHEN THE ROOT IS GENERIC, THE CHILD IS ITS OWN IDENTITY. "Rookie"
        // names nothing; "Rookie Penmanship" and "Rookie Signatures" are two
        // DIFFERENT real insert sets folded under it by the corpus builder.
        // Mapping both to `rootNorm` ("rookie") would make R67's registered-
        // key composition ask for `<setKey>-rookie` for either one -- the
        // wrong candidate key, and indistinguishable from the OTHER real
        // child. So each child stands for itself here, never for the
        // generic root.
        const effectiveRoot = rootIsGeneric ? childNorm : rootNorm;
        if (!namesToRoot.has(childNorm)) namesToRoot.set(childNorm, effectiveRoot);
      }
    }
    if (namesToRoot.size === 0) continue;
    byProduct.set(pk, { namesToRoot, roots, parallelNames });
  }
  return { byProduct };
}

function index(): Index | null {
  if (_index === undefined) {
    try { _index = buildIndex(); } catch { _index = null; }
  }
  return _index;
}

/** Test seam: force a reload (a fixture corpus, or a fresh read after the
 *  shipped corpus changes underneath a long-running process). */
export function _resetInsertSetTitleReaderIndex(): void {
  _index = undefined;
}

export interface InsertNamedInTitle {
  /** The insert's ROOT name (its checklist-scraped spelling, space-joined,
   *  lowercased) -- e.g. "uptowns", "trophy collection". Always the ROOT
   *  even when a coloured CHILD is what the title actually stated. */
  root: string;
  /** The full matched name as it appears in the corpus (root or child) --
   *  e.g. "illusionists orange". Longest match wins. */
  matchedName: string;
  /** The product key this insert is registered under in
   *  `catalog/productSetKeys.ts`, or null when nothing registers it. A null
   *  here is the R70 park signal. */
  registeredKey: string | null;
}

/**
 * Does this title name a KNOWN insert set of its OWN product
 * (sport + year + setKey)? Longest match wins. Returns null when nothing in
 * that product's own insert vocabulary is stated -- absent beats wrong, and
 * an unknown vocabulary (Zenith, whose corpus carries no insertSets at all)
 * is not evidence of anything.
 *
 * `playerName` -- when the caller has already resolved a player name for this
 * sale, a candidate root/child that OVERLAPS the player's own name (shares at
 * least one word) never matches: "Young" inside "Trae Young" or "Chase Young"
 * is the player's own surname, not Upper Deck's "Young Guns" naming itself --
 * the exact residual PR #2306 (the census reader's own measurement) left
 * open. This is disqualifying-only and deliberately errs toward refusing: a
 * missed insert name is recoverable (the row stays exactly where it is
 * today), while a player-name collision minting the wrong product key is not.
 * "Young Guns" naming itself beside an UNRELATED player's title still matches
 * normally -- only a player whose OWN name shares a word with the candidate
 * is excluded.
 */
export function insertSetNamedInTitle(input: {
  title: string | null | undefined;
  sport: string | null | undefined;
  year: number | null | undefined;
  setKey: string | null | undefined;
  playerName?: string | null | undefined;
}): InsertNamedInTitle[] {
  const sport = lower(input.sport);
  const setKey = lower(input.setKey);
  const year = typeof input.year === "number" ? input.year : Number(input.year);
  const title = String(input.title ?? "");
  if (!sport || !setKey || !Number.isFinite(year) || !title.trim()) return [];

  const idx = index();
  if (!idx) return [];
  const entry = idx.byProduct.get(`${sport}|${year}|${setKey}`);
  if (!entry || entry.namesToRoot.size === 0) return [];

  const titleWords = normaliseWords(title);
  const titleNorm = ` ${titleWords.join(" ")} `;
  const playerTokens = new Set(normaliseWords(input.playerName ?? ""));

  // Every name (root or child) the title states as a WHOLE-TOKEN, contiguous
  // phrase. Whole-token match on normalised tokens: substring alone would let
  // "certified" inside a longer unrelated word match, and a name embedded
  // inside a different name ("Rookies" inside "Rookies Autographs") is
  // handled by "longest match wins" over the full set, not by excluding the
  // shorter one structurally.
  const matches: { name: string; root: string }[] = [];
  for (const [name, root] of idx.byProduct.get(`${sport}|${year}|${setKey}`)!.namesToRoot) {
    if (!titleNorm.includes(` ${name} `)) continue;
    // PLAYER-SPAN GUARD: the candidate shares at least one word with the
    // resolved player name -- a surname collision ("Young" in "Trae Young"
    // vs. Upper Deck's "Young Guns"), not the insert naming itself.
    const nameWords = name.split(" ").filter(Boolean);
    if (playerTokens.size > 0 && nameWords.some((w) => playerTokens.has(w))) {
      continue;
    }
    matches.push({ name, root });
  }
  if (matches.length === 0) return [];

  // Longest match wins on a title with exactly one insert family named
  // ("Rookie Phenom Jerseys Gold" over "Rookie Phenom Jerseys"). When the
  // title states names from TWO DIFFERENT ROOTS, both are reported (longest
  // per root) so the caller can apply R70's "two inserts named" rule --
  // never picking between two different products' games.
  const bestByRoot = new Map<string, { name: string; root: string }>();
  for (const m of matches) {
    const prior = bestByRoot.get(m.root);
    if (!prior || m.name.length > prior.name.length) bestByRoot.set(m.root, m);
  }

  // CROSS-ROOT SUBSUMPTION (found measuring this module against the R32
  // export, 2026-09-19). Two DIFFERENT roots can each list a name that is a
  // SUFFIX/PREFIX token-run of the other's -- Score's plain "Rookies" root
  // (generic, so its child "Rookies Artist's Proof" stands for itself) and
  // Score's separate "Hot Rookies" root both carry an "...Artist's Proof"
  // child, and "Hot Rookies Artist's Proof" contains "Rookies Artist's
  // Proof" as a trailing token run. That is one insert named once, not two
  // named at once -- the same "longest match wins" rule the per-root pass
  // above applies, extended across roots: a match whose token run is fully
  // contained inside a LONGER match is dropped.
  let candidates = [...bestByRoot.values()];
  candidates = candidates.filter((m) => {
    const mTokens = ` ${m.name} `;
    return !candidates.some((other) => other !== m && other.name.length > m.name.length
      && (` ${other.name} `).includes(mTokens));
  });

  const results: InsertNamedInTitle[] = [];
  for (const { name, root } of candidates) {
    // R67 KEY COMPOSITION TRIES THE MATCHED NAME BEFORE THE CORPUS ROOT
    // (found measuring this module against the R32 export, 2026-09-19).
    //
    // The corpus's OWN `root` grouping is sometimes coarser than the real
    // card sets it groups: `football|2024|donruss-optic` files "Downtown!",
    // "Downtown Duos" and "Downtown Legends" -- three separately registered
    // product keys (`donruss-optic-downtown`, `-downtown-duos`,
    // `-downtown-legends`) -- under ONE root object literally spelled
    // "downtown", with the real names appearing only in `children`. Composing
    // the candidate key from `root` alone would send a title stating
    // "Downtown Duos" to the bare Downtown key -- a different, real product.
    //
    // So the candidate key is tried from the FULL matched name's own token
    // prefixes, longest first, falling back to the root only once no prefix
    // of the matched name itself resolves. A title matching only the bare
    // root (no child) still finds it: `name === root` in that case, so the
    // longest prefix tried IS the root.
    const nameWords = name.split(" ").filter(Boolean);
    let registeredKey: string | null = null;
    for (let take = nameWords.length; take >= 1; take--) {
      const candidateKey = `${setKey}-${slugifyRoot(nameWords.slice(0, take).join(" "))}`;
      const found = productEntry(candidateKey);
      if (found) { registeredKey = found.setKey; break; }
    }
    // Fall back to the corpus's own root grouping only when no prefix of the
    // stated name resolved on its own -- e.g. a coloured child ("Illusionists
    // Orange") whose root IS the real identity ("Illusionists Orange" itself,
    // since that product has no bare parent; see the coverage-gap tests).
    if (!registeredKey && root !== name) {
      const rootKey = `${setKey}-${slugifyRoot(root)}`;
      const found = productEntry(rootKey);
      if (found) registeredKey = found.setKey;
    }
    results.push({ root, matchedName: name, registeredKey });
  }
  // Deterministic order: longest matched name first, so a single-insert
  // result is always results[0].
  results.sort((a, b) => b.matchedName.length - a.matchedName.length);
  return results;
}
