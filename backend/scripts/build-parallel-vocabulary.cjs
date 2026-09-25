#!/usr/bin/env node
/**
 * CF-THE-CHECKLIST-NAMES-THE-PARALLEL (Drew, 2026-08-27: "we know the names
 * from checklists and then we go out and find it").
 *
 * Builds the canonical parallel vocabulary from the checklists we hold, keyed
 * per product, so matching has an authority to normalise against instead of a
 * majority vote inside our own data.
 *
 * WHY A VOTE WOULD BE WRONG. Measured over 33,090 distinct parallel values,
 * 1,513 canonical forms are stored more than one way, covering 9,757,801 rows.
 * The dominant spelling is frequently the WRONG one:
 *
 *     catalog:     "X Fractor"   41,935 rows   <- no checklist publishes this
 *     checklists:  "X-Fractor"    5,592 rows   <- hyphenated, every time
 *
 * Picking by row count entrenches the error. The manufacturer's own list is
 * the only thing that can settle it.
 *
 * PER PRODUCT, NOT GLOBAL. "Gold" in one product is not the same card as
 * "Gold" in another, and Drew's rule is year + set + card number + name. A
 * global vocabulary would licence merging across products, which is the
 * mistake the BCP- prefix rule made.
 *
 * THE SOURCE HAS ITS OWN NOISE, and it must be cleaned before it can act as an
 * authority -- the same defect class we are trying to fix, on the supply side:
 *
 *     "X-Fractor - 10 per box (Mega exclusive)"   pack odds glued on
 *     "FrozenFractor - /-5 - 1:4"                 print run AND odds
 *     "Refractor: 14,000 copies"                  run glued with a colon
 *     "Black ()"                                  a parser left empty brackets
 *
 * WHAT IS DELIBERATELY KEPT. A retailer or channel exclusive is a REAL card:
 * "Purple (exclusive to packs sold at Meijer stores)" is not "Purple", and
 * 12,740 rows carry it. Those are preserved as distinct entries; only the
 * casing is unified, because "exclusive TO Packs Sold AT Meijer Stores" is the
 * same card shouted differently.
 *
 * DO NOT WRITE TO backend/data/parallel-vocabulary.json. That name is taken by
 * a hand-curated alias + ladder registry (schema hobbyiq/parallel-vocabulary/v1)
 * that hobbyIqCardId.service, parallelTokenizer and parallelTitleMatch all read.
 * This script was pointed at it once by accident; overwriting it would have
 * corrupted slug computation everywhere, and the file would still have parsed.
 * The generated artifact is checklist-parallel-names.json.
 *
 * -- AN INSERT SET IS NOT A PARALLEL (2026-09-15) ---------------------------
 *
 * Every source CSV carries `category` in column 0 -- measured across all 1,100
 * files in all three source dirs, 2,197,970 rows: 100% carry it, and the
 * prefix vocabulary is exactly three values (base 1,188,582 / insert 797,581 /
 * auto 211,807). This script read only column 2 and never looked at it.
 *
 * The cost: a product's INSERT SETS landed in `parallels[]` indistinguishably
 * from its real rungs. football|2024|donruss-optic lists "Passing Grade",
 * "My House!" and "Light it Up" as parallels of the base card, and the R31
 * phrase test -- correctly, against the data it was given -- answers "yes,
 * that is a rung of this product" and fills a blank with it. Corpus-wide the
 * fingerprint of this is 1,350 named roots over 10,719 rungs (28.3%) across
 * 206 of 627 products.
 *
 * WHY "DROP EVERY INSERT ROW" IS THE WRONG FIX, and was measured before this
 * rule was written. Inserts have their OWN colour ladders, so a colour rung
 * legitimately appears under an insert category: on Optic 2024 FB, 32 of 178
 * names appear under more than one category, and "Purple", "Gold", "Ice" and
 * "Gold Vinyl" are among them. Dropping insert rows wholesale would delete
 * real rungs -- the opposite defect, and a worse one.
 *
 * THE DISTINGUISHING FACT is not the row's category but whether the parallel
 * NAME carries the insert set's own name. "Passing Grade Gold" does;
 * "Gold" does not. So a name is moved to `insertSets[]` only when it starts
 * with the words its category slug names, which leaves every colour rung of
 * every insert exactly where it is. Measured on the two named products:
 *
 *     football|2024|donruss-optic     178 rungs -> 48   (130 names, 26 roots)
 *     basketball|2024|panini-mosaic   420 rungs -> 181  (239 names, 34 roots)
 *
 * `parallels[]` KEEPS ITS SHAPE, so every existing consumer loads unchanged.
 * `suspectInsertRoots[]` is the hedge for a future source with no `category`
 * column: the name-root fingerprint, tagged rather than silently flattened.
 * For today's three sources it is empty, and that is the point -- the real
 * signal is in the data and does not need to be guessed.
 *
 * NOTE FOR THE CATALOG LANE: this script reads CSVs only (node:fs, node:path;
 * no Cosmos, no card_catalog). `card_catalog` storing Optic inserts as
 * `donruss-optic` rows with parallel = the insert name is the SAME mistake
 * made independently from the same CSVs, not a consequence of this one.
 * Fixing either does not fix the other.
 *
 * READ-ONLY. Emits JSON for review. Nothing is written to Cosmos, and nothing
 * is rewritten from this file until a separate pass consumes it.
 *
 * Usage:
 *   node backend/scripts/build-parallel-vocabulary.cjs \
 *     --dirs=C:/tmp/beckett-bulk,C:/tmp/ci/csv2 \
 *     --out=backend/data/checklist-parallel-names.json
 */
const fs = require("node:fs");
const path = require("node:path");
// THE ONE READER OF THE `category` COLUMN, shared with the ingester so the
// two cannot drift on what a category means. See its header.
const { readChecklistCategory, insertSetsFromCategories, humanise: humaniseSlug } = require("./lib/checklist-category.cjs");

/**
 * THE OVERLAY: RUNGS A RULING ADDED THAT NO SOURCE FILE CARRIES.
 *
 * CF-A-REGENERATE-MUST-NOT-ERASE-A-RULING (2026-09-15).
 *
 * R47 added three 2025 Allen & Ginter mini rungs -- `Mini Gold Border`,
 * `Mini Black Border`, `Mini Black` -- covering 406 pool rows. They are
 * checklist-backed in card_catalog but absent from every scraped FILE, because
 * they came from `baseballcardpedia-ladders-2026-09-04` and
 * `checklistcenter-2026-08-30`, which were never scraped into one.
 *
 * They were added by HAND-EDITING the generated JSON. That works exactly once:
 * the next regenerate rewrites the file from the sources and the ruling is
 * silently gone, with nothing to notice it -- the corpus would simply have
 * three fewer names and 406 pool rows would lose their spelling again.
 *
 * So the ruling lives in a COMMITTED OVERLAY the builder reads on every run.
 * The overlay is input, like the CSVs; the generated file is output. A
 * regenerate cannot lose what it re-reads.
 *
 * WHY AN OVERLAY AND NOT A SYNTHETIC CSV. A fake CSV would have to invent a
 * card number, a player and a category for every row to satisfy the reader,
 * and `feedback_no_synthetic_parallels_only_actuals` rules that out: an
 * invented row is indistinguishable from a scraped one afterwards. The overlay
 * is explicitly NOT a scrape -- each entry carries its own `source` and
 * `ruling`, so the file says where the name came from and which ruling
 * admitted it.
 *
 * MERGE RULE. An overlay entry is added when the product's ladder does not
 * already carry the name; when it does, the SOURCE wins and the overlay is a
 * no-op. So re-scraping a product that finally publishes the rung retires the
 * overlay entry automatically rather than fighting it.
 */
function loadOverlay(file) {
  if (!file || !fs.existsSync(file)) return { byProduct: new Map(), count: 0, entries: 0 };
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const byProduct = new Map();
  let count = 0;
  for (const e of raw.overlays ?? []) {
    const pk = `${e.sport}|${e.year}|${e.setKey}`;
    let g = byProduct.get(pk); if (!g) { g = []; byProduct.set(pk, g); }
    for (const p of e.parallels ?? []) { g.push({ ...p, ruling: e.ruling, source: e.source }); count++; }
  }
  return { byProduct, count, entries: (raw.overlays ?? []).length };
}

/**
 * THE OVERRIDE FILE: A RULING THAT DISAGREES WITH WHAT EVERY SOURCE SAYS.
 *
 * CF-A-RULING-OUTRANKS-A-SCRAPE (2026-09-25, Drew's Silver Crackle ruling).
 *
 * The overlay above (`loadOverlay`) can only ADD a name no source carries,
 * and its own merge rule makes the SOURCE win once one finally publishes the
 * rung -- correct for "this ruling fills a hole", wrong for "this ruling
 * disagrees with what every source spells". 2025/2026 Topps Series 1/2 CSVs
 * (both C:/tmp/ci/csv2 and the committed 09-20 scrapes) spell the Super-Box-
 * exclusive base rung "Silver Crackle Foil**board**"; the 2026 CSV glues an
 * exclusivity parenthetical on top ("... (Super Box exclusive)"); Drew ruled
 * (2026-09-25) that the card is "Silver Crackle Foil", full stop, to match
 * the spelling PR #2427 folds the 2026 catalog onto -- and every one of
 * those source spellings would otherwise win, because the source always
 * wins over the additive overlay.
 *
 * So a SEPARATE, small, committed file carries entries the builder applies
 * LAST, after everything else (the overlay, the split, the self-naming
 * filter) -- a ruling is the final word, not a fallback for a gap. Each
 * entry names an exact (sport, year, setKey), a `drop` list (exact names,
 * case-insensitive, to remove even though a source stated them) and an `add`
 * list (the name the ruling says is correct), plus its own `reason` and
 * `rulingDate` so the file says why. This is NOT a scrape and never
 * pretends to be one -- no `spellings`/`seen` provenance is invented; `add`
 * entries carry only what the ruling itself asserts.
 *
 * SCOPED, NOT GLOBAL. Only the (sport, year, setKey) rows named apply --
 * dropping "Silver Crackle Foilboard" here never touches a DIFFERENT
 * product that happens to share the string, because the override is keyed
 * exactly like every other product bucket in this file.
 */
/**
 * AN `add` WITH NO RULING IS A SYNTHETIC PARALLEL BY ANOTHER NAME.
 *
 * `feedback_no_synthetic_parallels_only_actuals` rules out inventing a rung
 * with no provenance; the override file's whole justification (see
 * `loadOverrides`'s header) is that a NAMED ruling outranks a source, not
 * that this file is a second place to type a name. So any entry that adds a
 * name must carry non-empty `ruling`, `rulingDate` AND `reason` -- the same
 * three fields `applyOverride` already rides onto the emitted row's
 * `override` provenance. An entry that only drops (no `add`) is exempt: it
 * is refusing a bad spelling, not asserting a new one, though it is still
 * good practice to explain the drop via `reason`.
 *
 * FAILS THE BUILD, not a warning -- an unreviewed `add` silently shipping a
 * spelling is exactly the defect class this file exists to prevent from the
 * OTHER direction (a source outranking a ruling); a bare string with no
 * `ruling` is unreviewed by definition.
 */
function assertOverrideEntry(e) {
  if (!(e.add ?? []).length) return;
  const missing = ["ruling", "rulingDate", "reason"].filter((f) => !String(e[f] ?? "").trim());
  if (missing.length) {
    throw new Error(
      `checklist-parallel-names.overrides.json: ${e.sport}|${e.year}|${e.setKey} adds a name but is missing ${missing.join(", ")} -- ` +
      `every 'add' must carry a non-empty ruling, rulingDate and reason (see loadOverrides()'s header).`,
    );
  }
}

function loadOverrides(file) {
  if (!file || !fs.existsSync(file)) return { byProduct: new Map(), entries: 0 };
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const byProduct = new Map();
  for (const e of raw.overrides ?? []) {
    assertOverrideEntry(e);
    const pk = `${e.sport}|${e.year}|${e.setKey}`;
    byProduct.set(pk, e);
  }
  return { byProduct, entries: (raw.overrides ?? []).length };
}

/**
 * Apply one product's override to its finished `parallels[]` list. Drops are
 * matched case-insensitively on the exact name (never a substring, same
 * discipline as the self-naming filter above); adds are appended only when
 * not already present post-drop, so re-running is idempotent.
 */
function applyOverride(parallels, override) {
  if (!override) return parallels;
  const dropKeys = new Set((override.drop ?? []).map((n) => key(n)));
  const kept = parallels.filter((e) => !dropKeys.has(key(e.name)));
  const keptKeys = new Set(kept.map((e) => key(e.name)));
  for (const name of override.add ?? []) {
    const k = key(name);
    if (keptKeys.has(k)) continue;
    keptKeys.add(k);
    kept.push({
      name, printRun: null, odds: null, seen: 1, spellings: [name],
      override: { ruling: override.ruling, rulingDate: override.rulingDate, reason: override.reason },
    });
  }
  return kept;
}

/** Root comparison key: case and punctuation are spelling, not identity. */
const normForRoot = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Fold a trailing "s" so "Illusionists" and "Illusionist" compare equal --
 * the same fold `build-parallel-vocabulary.cjs` already uses to keep a set's
 * plural label from truncating to its un-suffixed member (see the root
 * DISPLAY NAME comment below). Applied per word, not to the whole phrase, so
 * "Rookie Phenoms Jerseys" folds the same as "Rookie Phenom Jersey". */
const foldTrailingS = (w) => {
  const x = String(w ?? "").toLowerCase();
  return x.endsWith("s") && x.length > 3 ? x.slice(0, -1) : x;
};
const foldedPhrase = (s) => normForRoot(s).split(" ").filter(Boolean).map(foldTrailingS).join(" ");

/**
 * A BARE COLOUR WORD IS NEVER A SET NAMING ITSELF.
 *
 * Mirrors rematch-finish-vocab.cjs's FINISH_COLOR_TOKENS (kept as a small,
 * separate copy rather than an import -- that module reads THIS corpus, and
 * importing back would be circular). MEASURED (2026-09-19):
 * hockey|2022|upper-deck-premier's `insert-gold` category carries "Gold //"
 * on every row -- source noise (an unstripped print-run glue the existing
 * `cleanName` does not clean either, a pre-existing data-quality gap, not
 * something this pass owns) that still folds to the category's own root
 * "gold". Treating it as self-naming would have DELETED "Gold //" (seen 265
 * times, its own /65 print run, genuinely distinct from the plain "Gold" /10
 * rung already in this product's parallels) with nowhere for it to land --
 * unlike "Illusionist"/"Immortal", a bare colour word is never a PROPER NOUN
 * an insert set is named after, so there is no legitimate case this
 * exclusion could cost.
 */
const PLAIN_COLOR_WORDS = new Set([
  "gold", "orange", "purple", "blue", "green", "red", "black", "pink", "yellow",
  "teal", "aqua", "bronze", "silver", "platinum", "copper", "sepia", "magenta",
  "cyan", "lime", "indigo", "violet", "rose", "amber", "onyx", "emerald",
  "ruby", "sapphire", "gunmetal", "chartreuse", "fuchsia", "neon", "atomic",
]);

/**
 * THE SET'S OWN CATEGORY, WHEN THE PARALLEL COLUMN NAMES THE SET ITSELF
 * (Drew's R66 KNOWN GAP, closed 2026-09-19).
 *
 * `insertSetsFromCategories` (checklist-category.cjs) admits a bare root only
 * when its category states NO parallel at all -- see its own header for why
 * that precondition exists (an invented root cost 73 real Prizm rungs the
 * last time this was tried without evidence). That rule is right for Zenith's
 * `insert-z-marquee` (parallel column blank on every row) but misses a
 * different, real shape: 2024 panini-illusions' `insert-illusionists` rows
 * carry "Illusionist" -- singular -- in the parallel column on every one of
 * their 18 rows. That is the SET naming itself, not a distinct parallel; the
 * set's own children ("Illusionists Black", "Illusionists Gold", ...) already
 * exist as fully-spelled names and split into their own one-item "roots"
 * today for lack of anywhere to merge under.
 *
 * MEASURED across both committed source dirs (2026-09-19): 449 bare `insert-`
 * categories, across 136 files, whose every attested parallel value folds
 * (singular/plural only, never a different word) to the category's own root
 * -- "Illusionist"/illusionists, "Screamer"/screamers, "Signature"/signatures,
 * "Firework"/fireworks, "Talisman"/talismans. None collides with a real
 * multi-word Prizm/Select/Optic parallel, because a fold match requires the
 * ENTIRE phrase to reduce to the root -- "Prizm Gold" does not fold to
 * "prizm", so the defect that cost Prizm its 73 rungs cannot recur here.
 *
 * A root whose bare category is made ENTIRELY of its own product's setKey
 * words ("Elite" on donruss-elite, from `insert-elite`) is still returned --
 * this is corpus evidence, not the R66 title reader, and the over-reach guard
 * belongs at the READER that decides whether a SALE TITLE names an insert,
 * not here. `isProductWord` is per (year, setKey); the corpus has no title to
 * judge against.
 *
 * A ROOT THAT IS ALSO THIS PRODUCT'S OWN FINISH-FAMILY PREFIX IS NOT AN
 * INSERT SET, EVEN THOUGH ITS BARE CATEGORY FOLDS TO ITSELF (2026-09-19,
 * found measuring R66 PR 1 against the R32 export with the correct
 * per-title setKey). `football|2025|panini-certified` carries a bare
 * `insert-mirror` category with "Mirror" on every row -- folds to itself,
 * has siblings (`insert-mirror-black`, `insert-mirror-gold`) -- exactly the
 * Illusionists shape. But this product's checklist ALSO lists "Mirror
 * Black", "Mirror Gold", ... as ordinary `parallels[]` names (under
 * differently-labelled sibling categories that spell the colour in the
 * column, not just the slug): "Mirror" here is the FINISH FAMILY name of a
 * real base rung, the same relationship "Prizm" has to "Silver Prizm", not
 * a proper noun an insert set is named after. Rooting it swallowed the
 * plain "Mirror" parallel (/399) into an insert set and broke the reader:
 * "2025 Panini Certified #1 ... Mirror #/399" stopped answering "Mirror"
 * and fell to "Base". The test that distinguishes them: a genuine insert
 * set (Illusionists, Z Marquee) has ZERO of its own "<root> <colour>"
 * combinations already sitting in `parallels[]` -- every one of its
 * children came from an insert-only category. "Mirror" fails that test on
 * this product; "Illusionists" and "Z Marquee" pass it on theirs.
 *
 * @param {Array<{category: string, parallel: string}>} rows one product's rows
 * @param {Array<{name: string}>} [existingParallels] this product's OWN
 *   `parallels[]` as the name-based split already has them -- read ONLY to
 *   ask "does `<root> <word>` already exist as a real parallel", never
 *   written to.
 * @returns {{ sets: Array<{root: string, children: string[]}>, selfNames: Set<string> }}
 *   `selfNames` is the parallel text (lowercased, e.g. "illusionist") that
 *   named the set rather than a rung -- the caller drops these out of
 *   `parallels[]` so the set's own name stops posing as a base parallel.
 */
function bareSelfNamedInsertRoots(rows, existingParallels) {
  const byCat = new Map();
  for (const r of rows ?? []) {
    const cat = String(r?.category ?? "").trim().toLowerCase();
    if (!cat) continue;
    const read = readChecklistCategory(cat, r?.parallel);
    if (read.kind !== "insert") continue;
    if (!byCat.has(cat)) byCat.set(cat, new Set());
    const stated = String(r?.parallel ?? "").trim();
    if (stated) byCat.get(cat).add(stated);
  }
  const parallelNamesLower = new Set((existingParallels ?? []).map((e) => normForRoot(e.name)));
  const sets = [];
  const selfNames = new Set();
  for (const [cat, pars] of byCat) {
    if (!pars.size) continue;           // the blank case is insertSetsFromCategories's job
    const read = readChecklistCategory(cat, [...pars][0]);
    const root = read.insertRoot;
    if (!root) continue;
    const rootFold = foldedPhrase(root);
    // EVERY attested value must fold to the root -- one clause, no exceptions.
    // A category with even one value that does NOT fold to the root is
    // stating a real parallel, not naming itself, and is left alone.
    if (![...pars].every((v) => foldedPhrase(v) === rootFold)) continue;
    // A ROOT ENDING IN "PARALLEL" OR "VARIANT" IS DESCRIBING ITSELF AS A
    // FINISH, NOT NAMING A SET (2026-09-19).
    //
    // MEASURED: hockey|2025|flair labels its entire base-card finish ladder
    // this way -- `insert-spectrum-parallel` ("Spectrum Parallel" on every
    // row), `insert-blue-ice-parallel` ("Blue Ice Parallel"),
    // `insert-printing-plates-parallel` -- each with siblings
    // (`insert-blue-ice-parallel-rookies`) that pass every OTHER clause
    // here. Corpus-wide, 1,013 bare `insert-*-parallel` / `insert-*-variant`
    // categories carry siblings this same shape (2022-23 O-Pee-Chee
    // Platinum's 21 colour-named `-parallel` categories among them) -- a
    // real, structural pattern from Upper Deck/O-Pee-Chee/Parkhurst
    // sources, not a one-product exception. In every one of them the tail
    // names a FINISH ("Rainbow Parallel", "Silver Parallel"), and zero
    // counterexamples were found where a manufacturer's own creative insert
    // name literally ends in the generic word "parallel" or "variant".
    // `insertSetsFromCategories` (the blank-parallel case) never sees this
    // shape at all, because these rows state their own parallel text --
    // this clause is this function's alone to carry.
    if (/(^|\s)(parallel|variant)$/.test(rootFold)) continue;
    // A BARE COLOUR WORD IS NEVER A SET NAMING ITSELF -- see PLAIN_COLOR_WORDS.
    if (PLAIN_COLOR_WORDS.has(rootFold)) continue;
    const hasSibling = [...byCat.keys()].some((c) => c !== cat && c.startsWith(cat + "-"));
    if (!hasSibling) continue;          // no ladder under it -- nothing to root
    // A ROOT THAT IS ALSO THIS PRODUCT'S OWN FINISH-FAMILY PREFIX IS NOT AN
    // INSERT SET -- see this function's header (the "Mirror" measurement).
    // If ANY "<root> <word>" combination is already a real parallel of this
    // SAME product, the root names a finish family, not a proper-noun set,
    // and is left where it already correctly sits.
    //
    // EXCLUDES THIS CATEGORY'S OWN SELF-NAMING VALUES from the comparison --
    // `pars` IS "Illusionist", which folds to the same `rootFold` as
    // "Illusionists" and would otherwise flag itself as the finish-family
    // evidence that refuses it. The test asks about OTHER parallels, never
    // the very text this pass is about to reclassify.
    const foldedPars = new Set([...pars].map((v) => foldedPhrase(v)));
    const rootIsFinishFamilyPrefix = [...parallelNamesLower].some((n) => {
      if (foldedPars.has(foldedPhrase(n))) return false;
      return n === rootFold || n.startsWith(rootFold + " ");
    });
    if (rootIsFinishFamilyPrefix) continue;
    for (const v of pars) selfNames.add(v.toLowerCase());
    // Children come from the OTHER halves of the split: whatever
    // `insertSetsFromCategories` or the name-based splitter already found
    // under this same root. This function only ever contributes the ROOT
    // NAME and the self-naming text to drop; it does not invent children.
    //
    // `root` here is the RAW dash-joined category tail ("downtown-gold"),
    // not yet a display name -- `humaniseSlug` (checklist-category.cjs's own
    // `humanise`) is the one function that turns a slug into what a
    // checklist would print, and using it here rather than a second
    // formatter is what stopped "Downtown-gold" leaking into the corpus
    // instead of "Downtown Gold".
    sets.push({ root: humaniseSlug(root), children: [] });
  }
  return { sets, selfNames };
}

/**
 * THE SELF-REFUSAL FLOOR, SHARED BY BOTH THE NAME-BASED SPLIT AND THE
 * CATEGORY-ONLY PASS. A product must keep at least a QUARTER of its names
 * AND at least 8, unless its own checklist labels a base ladder somewhere --
 * see `splitInsertSets`'s own header for why the floor is this generous (a
 * wrong split silently deletes a rung; a refused one is merely the status
 * quo), and the category-only pass's own refusal check (in `main`) for why
 * one shared constant matters: hockey|2025|flair mislabels its ENTIRE base
 * ladder as `insert-<name>-parallel` categories, and two independent copies
 * of this threshold could each say "fine" about a share the OTHER pass
 * would have refused.
 */
const MIN_KEPT_FRACTION = 0.25;
const MIN_KEPT_NAMES = 8;

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const DIRS = arg("dirs", "C:/tmp/beckett-bulk,C:/tmp/ci/csv2").split(",").map((s) => s.trim()).filter(Boolean);
const OUT = arg("out", "backend/data/checklist-parallel-names.json");
const OVERLAY = arg("overlay", path.join(__dirname, "..", "data", "checklist-parallel-overlays.json"));
const OVERRIDES = arg("overrides", path.join(__dirname, "..", "data", "checklist-parallel-names.overrides.json"));

/** A directory outside this checked-out repo -- not reachable by a fresh
 * clone, so a product whose vocabulary comes ONLY from these is invisible
 * to anyone who has not also populated them locally. Tracked per product
 * (see `sourceDirs` on each product below) so the file itself says which
 * rungs a plain `git clone` cannot reproduce. */
const isRepoDir = (d) => path.resolve(d).toLowerCase().includes(path.resolve(__dirname, "..", "data", "checklists").toLowerCase());

const f = (n) => Number(n).toLocaleString();

/** Honour quoted fields — parallel names contain commas. */
function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Strip the source's own noise from a published name, and report what came off
 * so a print run the source glued on is recovered rather than discarded.
 *
 * A parenthetical is KEPT unless it is empty — a channel exclusive is a real
 * distinction, and dropping it would merge cards.
 */
function cleanName(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  let printRun = null;
  let odds = null;

  // A trailing parenthetical is a REAL distinction -- "(exclusive to packs
  // sold at Meijer stores)" is a different card. Lift it off first so the
  // noise BEHIND it can be stripped, then put it back. Without this,
  // "X-Fractor - 10 per box (Mega exclusive)" kept its pack odds, because
  // every noise pattern below anchors to the end of the string.
  let tail = "";
  const paren = s.match(/\s*(\([^)]*\))\s*$/);
  if (paren) {
    if (paren[1].replace(/[()\s]/g, "")) tail = " " + paren[1];   // "()" is noise
    s = s.slice(0, paren.index).trim();
  }

  // Repeat: a name can carry a run AND odds AND another run.
  for (let pass = 0; pass < 3; pass++) {
    const before = s;

    // "Refractor: 14,000 copies" / ": Ten Copie"
    const colon = s.match(/:\s*([A-Za-z0-9,]+)\s+copie?s?\.?\s*$/i);
    if (colon) {
      const n = Number(colon[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && printRun === null) printRun = n;
      s = s.slice(0, colon.index).trim();
    }

    // Pack odds, which the source often trails with prose: "1:4",
    // "1:24 packs", "1:1 Monster.", "1:1 Mega Box."
    const packOdds = s.match(/\s*[-–—]?\s*\d+\s*:\s*\d[\d,]*(?:\s+[A-Za-z][A-Za-z ]*)?\.?\s*$/);
    if (packOdds) { odds = odds ?? s.slice(packOdds.index).replace(/^[\s-–—]+/, "").trim(); s = s.slice(packOdds.index).length ? s.slice(0, packOdds.index).trim() : s; }

    // " - 10 per box" — a rate, not a run.
    const perBox = s.match(/\s*[-–—]\s*\d[\d,]*\s*per\s*box\s*$/i);
    if (perBox) { odds = odds ?? s.slice(perBox.index).replace(/^[\s-–—]+/, "").trim(); s = s.slice(0, perBox.index).trim(); }

    // " - /99" and the mangled " - /-5" the source also writes.
    const run = s.match(/\s*[-–—]\s*\/\s*-?\s*(\d[\d,]*)\s*$/);
    if (run) {
      const n = Number(run[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0 && printRun === null) printRun = n;
      s = s.slice(0, run.index).trim();
    }

    if (s === before) break;
  }

  s = s.replace(/\(\s*\)/g, " ").replace(/\s+/g, " ").trim();   // "Black ()"
  s = s.replace(/[-–—:,]\s*$/, "").trim();
  if (!s || s.length < 2) return null;
  return { name: (s + tail).trim(), printRun, odds };
}

/** Case-insensitive identity, so one card is not two because of shouting. */
const key = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();

function productOf(csvPath) {
  const manifest = csvPath.replace(/\.csv$/, ".manifest.json");
  if (fs.existsSync(manifest)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifest, "utf8"));
      if (m.year && m.sport) return { sport: m.sport, year: Number(m.year), setKey: m.setKey || null };
    } catch { /* fall through */ }
  }
  const base = path.basename(csvPath, ".csv");
  const m = base.match(/^((?:19|20)\d{2})(?:-\d{2})?-(.+)-(baseball|basketball|football|hockey|soccer|pokemon|wrestling)$/);
  return m ? { sport: m[3], year: Number(m[1]), setKey: m[2] } : null;
}

function main() {
  const vocab = new Map();       // "sport|year|setKey" -> Map(key -> entry)
  // THE RAW category+parallel PAIRS, kept per product alongside `bucket`.
  //
  // `bucket` only ever holds rows with a NON-BLANK parallel column (see the
  // `if (!parallel) continue` a few lines down) -- correct for the name-based
  // split, but it means a category whose OWN rows carry no parallel text
  // ("insert-z-marquee", blank on every row) leaves no trace for anything
  // downstream to read. `insertSetsFromCategories` and
  // `bareSelfNamedInsertRoots` need every row, blank or not, to see that the
  // category exists and has siblings -- so this is the second, unfiltered
  // copy they read.
  const categoryRowsByProduct = new Map();   // pk -> Array<{category, parallel}>
  // WHICH DIRECTORIES CONTRIBUTED EACH PRODUCT, split repo vs non-repo -- see
  // `isRepoDir`'s header. A product whose set here is entirely non-repo dirs
  // has a vocabulary nobody outside this machine can currently reproduce.
  const sourceDirsByProduct = new Map();     // pk -> Set(dir)
  let files = 0, rows = 0, cleaned = 0, runsRecovered = 0, dropped = 0;

  for (const dir of DIRS) {
    if (!fs.existsSync(dir)) { console.error(`  skipping missing dir ${dir}`); continue; }
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".csv"))) {
      const p = path.join(dir, name);
      const prod = productOf(p);
      if (!prod || !prod.setKey) continue;
      files++;
      const pk = `${prod.sport}|${prod.year}|${prod.setKey}`;
      if (!vocab.has(pk)) vocab.set(pk, new Map());
      const bucket = vocab.get(pk);
      if (!categoryRowsByProduct.has(pk)) categoryRowsByProduct.set(pk, []);
      const categoryRows = categoryRowsByProduct.get(pk);
      if (!sourceDirsByProduct.has(pk)) sourceDirsByProduct.set(pk, new Set());
      sourceDirsByProduct.get(pk).add(dir);

      const lines = fs.readFileSync(p, "utf8").split("\n");
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = splitCsv(line);
        const category = (cols[0] ?? "").trim();
        const parallel = (cols[2] ?? "").trim();
        if (category) categoryRows.push({ category, parallel });
        // The checklist states the run in its OWN column. Reading only the
        // runs recovered from name-glue captured 2 of 36,734 names — and print
        // run is the one field no sale title can be made to yield.
        const colRunRaw = Number(String(cols[4] ?? "").trim());
        const colRun = Number.isFinite(colRunRaw) && colRunRaw > 0 ? colRunRaw : null;
        rows++;
        if (!parallel) continue;         // blank is "the plain card", not a parallel
        const c = cleanName(parallel);
        if (!c) { dropped++; continue; }
        if (c.name !== parallel) cleaned++;
        if (c.printRun !== null) runsRecovered++;
        const k = key(c.name);
        const prev = bucket.get(k);
        if (!prev) {
          bucket.set(k, { name: c.name, printRun: c.printRun ?? colRun, odds: c.odds, seen: 1, spellings: [parallel], categories: new Set([category]) });
        } else {
          prev.seen++;
          if (prev.printRun === null && c.printRun !== null) prev.printRun = c.printRun;
          if (prev.printRun === null || prev.printRun === undefined) prev.printRun = c.printRun ?? colRun;
          if (!prev.spellings.includes(parallel) && prev.spellings.length < 8) prev.spellings.push(parallel);
          if (prev.categories) prev.categories.add(category);
          // Prefer the spelling the source uses most; ties keep the first.
          if (c.name.length < prev.name.length) prev.name = c.name;
        }
      }
    }
  }

  /**
   * Split one product's names into true rungs and insert sets.
   *
   * A name belongs to an insert set when it STARTS WITH the words that set's
   * category slug names -- "Passing Grade Gold" under
   * `insert-passing-grade-gold`. A name that does not ("Gold", "Purple Scope")
   * is that insert's colour rung and stays a parallel, which is the guard
   * against deleting real rungs.
   *
   * Roots that extend a shorter root are MERGED. Without this, one insert set
   * fragments into one root per colour -- measured on Optic 2024 FB: 127 roots
   * for 130 names before the merge, 26 after.
   */
  function splitInsertSets(bucket) {
    const parallels = [], sets = new Map();
    for (const e of bucket.values()) {
      const pn = normForRoot(e.name);
      // A NAME THAT ANY `base` ROW CARRIES IS A TRUE RUNG, FULL STOP.
      //
      // Checked FIRST, before the insert walk, and it is the guard that keeps
      // this split from eating base ladders. A product's own colour rung is
      // routinely reprinted inside its inserts, so the same name legitimately
      // appears under `base` AND under `insert-<name>`:
      //
      //   2025 donruss-elite: "Orange" is a base row AND appears under
      //   `insert-orange` and `insert-rookies-orange`.
      //
      // Letting the insert branch claim it collapsed that product from 194
      // rungs to 6 -- measured, and caught by bareColourAliasFromChecklist,
      // which asks the ladder for a bare colour and got null. 20 of that
      // product's names sit under both categories.
      //
      // The base category is the manufacturer saying "this is a parallel of
      // the base card". Nothing an insert does can unsay it.
      // ASKED THROUGH THE SHARED READER (2026-09-18). This used to re-derive
      // "is this a base category" inline, testing only the FIRST segment -- so
      // `insert-base-hobby`, the Hobby printing of the BASE card, read as an
      // insert. The ingester had the same defect independently (485 colliding
      // ids on 2024 panini-zenith football, 5,338 distinct ids for 6,214 rows),
      // which is why the rule now lives in ONE module both callers read.
      //
      // `auto-base*` is base-like too: it is the same card, signed, and its
      // tail is a parallel rather than an insert set name.
      const onBase = [...(e.categories ?? [])].some((c) => {
        const k = readChecklistCategory(c, e.name).kind;
        return k === "base" || k === "auto";
      });
      if (onBase) { parallels.push(e); continue; }
      let root = null;
      for (const cat of e.categories ?? []) {
        const dash = String(cat).indexOf("-");
        if (dash < 0 || String(cat).slice(0, dash) !== "insert") continue;
        // ...and never from a BASE-LIKE category, whose tail is a parallel or a
        // tier. Without this the root walk mints an insert set called `base`
        // (children: "1st Down", "Hobby", "Club Level") -- the same defect
        // from the other side. One rule, asked through the shared reader.
        {
          const k = readChecklistCategory(cat, e.name).kind;
          if (k === "base" || k === "auto") continue;
        }
        const sw = normForRoot(String(cat).slice(dash + 1)).split(" ").filter(Boolean);
        for (let k = sw.length; k >= 1; k--) {
          const cand = sw.slice(0, k).join(" ");
          if (pn === cand || pn.startsWith(cand + " ")) { if (!root || cand.length > root.length) root = cand; break; }
        }
      }
      if (!root) { parallels.push(e); continue; }
      let g = sets.get(root); if (!g) { g = []; sets.set(root, g); } g.push(e);
    }
    // MERGE A ROOT INTO ANY SHORTER ROOT IT EXTENDS.
    //
    // This is what stops one insert set fragmenting into one root per colour:
    // measured on Optic 2024 FB, 127 roots for 130 names without it, 26 with.
    //
    // KNOWN, BOUNDED OVER-MERGE. Two inserts that share a first word land in
    // one group -- "Downtown Duos" + "Downtown Legends" under `downtown`,
    // "Rookie Kings" + "Rookie Phenoms" + "Rookie Recruits" under `rookie`.
    // 2 of 26 roots on Optic 2024, 6 of 34 on Mosaic 2024.
    //
    // Left as-is deliberately, after trying the two obvious alternatives and
    // measuring both: splitting on a colour/finish wordlist re-fragmented to
    // 68 roots (no hand list covers every suffix a manufacturer invents), and
    // splitting on the source's own category slug re-fragmented to 127 (the
    // slug appends the colour, so every colour is its own slug).
    //
    // IT COSTS NOTHING THE CONSUMERS READ. `children` is exact either way, and
    // every consumer in the design matches on the CHILD name, not the root
    // label -- the root is metadata for a human reading the file. Splitting
    // these correctly needs the set NAME from the source, which none of the
    // three sources publishes separately from the slug.
    const ordered = [...sets.keys()].sort((a, b) => a.length - b.length);
    const merged = new Map();
    for (const r of ordered) {
      const owner = [...merged.keys()].find((m) => r === m || r.startsWith(m + " ")) ?? r;
      let g = merged.get(owner); if (!g) { g = []; merged.set(owner, g); }
      g.push(...sets.get(r));
    }
    // A SPLIT THAT LEAVES A PRODUCT WITH NO LADDER IS NOT A SPLIT.
    //
    // Some sources label a product's BASE parallel ladder with insert
    // categories. 2024 donruss-elite is the clearest: 6,929 insert rows to 100
    // base rows, and its real rungs -- Black, Blue, Purple, Aspirations -- are
    // filed as `insert-black`, `insert-rookies-black`. The base-wins guard
    // above cannot save them because they never appear on a base row at all,
    // and the split reduced that product from 165 rungs to 2.
    //
    // Measured across the corpus: 7 products fall from >=20 rungs to <=5, and
    // 84 keep under a fifth of their names. Those are the products whose
    // source mis-categorises, not products that are genuinely all-insert.
    //
    // So the split REFUSES itself where it would strip a product bare, and the
    // product keeps its flat ladder exactly as before. That is the honest
    // outcome: the corpus is no worse than it was for those products, the
    // R31 phrase test still sees what it sees today, and the mis-categorised
    // sources are a re-scrape item rather than something to guess through
    // here. `suspectInsertRoots` records what WOULD have moved, so the list is
    // available without acting on it.
    //
    // The floor is deliberately generous -- a product must keep at least a
    // quarter of its names AND at least 8 -- because a wrong split is silent
    // (a real rung simply vanishes) while a refused one is merely the status
    // quo. MIN_KEPT_FRACTION / MIN_KEPT_NAMES are module-level now, shared
    // with the category-only pass's own refusal check in `main` -- see their
    // declaration for why one shared floor matters.
    const movedCount = [...merged.values()].reduce((n, g) => n + g.length, 0);
    const totalCount = parallels.length + movedCount;
    if (movedCount > 0 && totalCount > 0) {
      // THE FLOOR ASKS THE WRONG QUESTION WHEN THE SOURCE LABELS ITS BASE
      // LADDER EXPLICITLY (2026-09-18).
      //
      // The fraction is a PROXY for "did the source mis-categorise this
      // product's base ladder as inserts?" -- it has to be, because on the
      // products it was written for (2024 donruss-elite) there is no base
      // category at all and the only evidence is the shape of what is left.
      //
      // When the source DOES carry `insert-base*` categories, that proxy is
      // unnecessary: the manufacturer has said outright which rows are the
      // base card's ladder, those names are already in `parallels` via the
      // base-wins guard above, and a product genuinely CAN have far more
      // insert names than base rungs. Measured on the two products this was
      // suppressing:
      //
      //   2024 panini-illusions FB   212 names, 173 would move, keeps 18.4%
      //   2024 panini-photogenic FB   80 names,  70 would move, keeps 12.5%
      //
      // Both cleared the >=8 bar and failed only the 25% fraction, so both
      // emitted `insertSets: ABSENT` -- and R31/R33 then had no corpus witness
      // for "Illusionists", "In Motion", "Troops Tribute" et al, which is
      // exactly the gap the R33 survivors were landing in.
      //
      // The >=8 floor is KEPT regardless: a split that yields a handful of
      // names is still more likely to be noise than a ladder, whatever the
      // categories say.
      const sourceLabelsItsBase = [...bucket.values()].some((en) =>
        [...(en.categories ?? [])].some((c) => {
          const k = readChecklistCategory(c, en.name).kind;
          return k === "base" || k === "auto";
        }));
      const keptEnough = parallels.length >= MIN_KEPT_NAMES
        && (sourceLabelsItsBase || parallels.length / totalCount >= MIN_KEPT_FRACTION);
      if (!keptEnough) {
        const suspect = [...merged.entries()].map(([rootKey, entries]) => ({
          rootKey, children: entries.map((e) => e.name).sort(),
        }));
        for (const g of merged.values()) parallels.push(...g);
        return { parallels, sets: new Map(), refusedSplit: suspect };
      }
    }

    return { parallels, sets: merged };
  }

  // THE OVERRIDE IS LOADED HERE BUT APPLIED LAST (at out[pk] below) -- a
  // ruling outranks the split, the overlay and the self-naming filter, all
  // of which are entitled to run on the source's own words first.
  const overrides = loadOverrides(OVERRIDES);
  let overridesDropped = 0, overridesAdded = 0;

  // THE OVERLAY IS APPLIED BEFORE THE SPLIT, so an overlay rung is judged by
  // exactly the same rules as a scraped one -- including the insert-set test.
  const overlay = loadOverlay(OVERLAY);
  let overlayAdded = 0, overlayAlreadyPresent = 0;
  for (const [pk, entries] of overlay.byProduct) {
    if (!vocab.has(pk)) vocab.set(pk, new Map());
    const bucket = vocab.get(pk);
    for (const e of entries) {
      const c = cleanName(e.name);
      if (!c) continue;
      const k = key(c.name);
      if (bucket.has(k)) { overlayAlreadyPresent++; continue; }   // the SOURCE wins
      bucket.set(k, {
        name: c.name, printRun: c.printRun ?? e.printRun ?? null, odds: c.odds ?? null,
        seen: e.seen ?? 1, spellings: e.spellings ?? [e.name],
        categories: new Set([e.category ?? "base-overlay"]),
        overlay: { ruling: e.ruling, source: e.source },
      });
      overlayAdded++;
    }
  }

  const out = {};
  let products = 0, names = 0, withRun = 0, insertSetCount = 0, insertNameCount = 0;
  for (const [pk, bucket] of [...vocab.entries()].sort()) {
    if (!bucket.size) continue;
    products++;
    const [sport, year, setKey] = pk.split("|");
    const split = splitInsertSets(bucket);
    const insertSets = [...split.sets.entries()]
      .map(([root, entries]) => {
        // The root's DISPLAY name is the longest common leading run of its
        // children, not the shortest member -- otherwise a one-word member
        // ("Best") labels a set whose real name is longer ("Best Tuddys").
        // PLURAL-FOLDED, AND TAKEN FROM THE LONGEST MEMBER.
        //
        // The source spells one set both ways -- "Best Tuddy" (the un-suffixed
        // member) and "Best Tuddys Gold" -- so a LITERAL longest-common-prefix
        // stops at "Best" and mislabels the set. Measured on Optic 2024 FB: 5
        // of 26 roots truncated to a single word (Best, Diamond, Rookie,
        // Sunday, Downtown).
        //
        // Folding a trailing "s" while comparing recovers the real name, and
        // seeding from the LONGEST member makes the label read as the
        // checklist writes it ("Best Tuddys", not "Best Tuddy").
        const foldW = (w) => {
          const x = w.toLowerCase();
          return x.endsWith("s") && x.length > 3 ? x.slice(0, -1) : x;
        };
        const words = entries.map((e) => e.name.split(/\s+/)).sort((x, y) => y.length - x.length);
        let common = words[0] ?? [];
        for (const w of words) {
          let i = 0;
          while (i < common.length && i < w.length && foldW(common[i]) === foldW(w[i])) i++;
          common = common.slice(0, i);
        }
        return {
          root: common.length ? common.join(" ") : root,
          rootKey: root,
          children: entries.map((e) => e.name).sort(),
          categories: [...new Set(entries.flatMap((e) => [...(e.categories ?? [])]))].sort(),
        };
      })
      .sort((a, b) => a.rootKey.localeCompare(b.rootKey));

    // THE CATEGORY-ONLY PASS: bare insert roots the NAME-based split above
    // cannot see, because their own row carries no name distinct from the
    // set itself (blank, or a fold of the root -- see the two functions'
    // headers). Read from the unfiltered `categoryRowsByProduct`, which is
    // why that map exists alongside `bucket`.
    const categoryRows = categoryRowsByProduct.get(pk) ?? [];
    const blankRootSets = insertSetsFromCategories(categoryRows);
    const selfNamed = bareSelfNamedInsertRoots(categoryRows, split.parallels);
    const categoryRoots = [...blankRootSets, ...selfNamed.sets];

    // MERGE ON THE SAME "EXTENDS" TEST `splitInsertSets` already uses for its
    // own roots, NOT fold-equality -- a category root's word count almost
    // never matches its name-based sibling's (`illusionists` is one word,
    // `illusionists black` -- already its own one-item root, for lack of
    // anywhere to merge under -- is two).
    //
    // THE CATEGORY ROOT IS ALWAYS THE SHORTER SIDE. It is, by construction,
    // the BARE category tail (`insertSetsFromCategories` and
    // `bareSelfNamedInsertRoots` never invent a longer one), so wherever it
    // shares a prefix with an existing name-based root that root is the more
    // specific one and must be ABSORBED, never the other way round -- one
    // direction, no ambiguity about which side wins. `illusionists` absorbs
    // EVERY `illusionists <colour>` root, not just the first found.
    //
    // What has to hold afterwards is the corpus invariant every child obeys
    // everywhere else: the root is a PREFIX, normalised, of every one of its
    // children -- see tests/corpusInsertSetsAreNotParallels.test.ts "every
    // insert child really does carry its root's name" -- so `rootKey` is
    // built from `cr.root` itself, never folded.
    let mergedList = insertSets.map((s) => ({ ...s, children: [...s.children] }));
    for (const cr of categoryRoots) {
      const crKey = normForRoot(cr.root);
      const extends_ = (s) => s.rootKey === crKey || s.rootKey.startsWith(crKey + " ");
      const extended = mergedList.filter(extends_);
      const absorbedChildren = extended.flatMap((s) => s.children);
      const absorbedCategories = extended.flatMap((s) => s.categories ?? []);
      mergedList = mergedList.filter((s) => !extends_(s));
      // The bare root itself is a child too -- see this function's own note:
      // a title with no colour ("Illusionists #13") must still match. Not
      // duplicated when an absorbed root's OWN name was already the bare root.
      const ownChild = extended.some((s) => normForRoot(s.root) === crKey) ? [] : [cr.root];
      mergedList.push({
        root: cr.root, rootKey: crKey,
        children: [...new Set([...ownChild, ...cr.children, ...absorbedChildren])].sort(),
        categories: [...new Set(absorbedCategories)].sort(),
      });
    }
    // THE SAME SELF-REFUSAL `splitInsertSets` APPLIES TO ITS OWN SPLIT, NOW
    // APPLIED TO THE COMBINED RESULT (2026-09-19).
    //
    // MEASURED, and the reason this guard exists at all: hockey|2025|flair
    // labels its ENTIRE base parallel ladder with `insert-<name>-parallel`
    // categories ("Spectrum Parallel", "Blue Ice Parallel", "Printing
    // Plates Parallel" -- real finishes of the base card, not insert sets),
    // and every one of those bare categories has a sibling
    // (`insert-blue-ice-parallel-rookies`, `insert-*-parallel` variants),
    // which is exactly the shape `bareSelfNamedInsertRoots` and
    // `insertSetsFromCategories` are built to recognise. Applied
    // unconditionally, the category pass alone swept 8 of the product's 9
    // real parallels into one-item "insert sets", the same defect class
    // `splitInsertSets`'s own MIN_KEPT_FRACTION guard exists to catch for
    // the name-based split -- this product just has no `insert-base-*` or
    // plain `base` row carrying parallel text for that guard's
    // `sourceLabelsItsBase` check to see (Flair's `base` rows are blank).
    //
    // So the same two-part test runs again here, over the FULL merged
    // result: does the product's own checklist label a base ladder
    // ANYWHERE (blank-parallel `base`/`insert-base-*`/`auto-base*` rows
    // count too, via `categoryRows` rather than `bucket`, since a blank
    // row never reaches `bucket`), or does what is kept clear the 25%/8
    // floor. Failing both means the product is Flair-shaped -- refuse the
    // CATEGORY additions specifically (the name-based split already passed
    // its own check and is never re-litigated here) and record what would
    // have moved, the same shape `suspectInsertRoots` already uses.
    const sourceLabelsItsBaseAnywhere = categoryRows.some((r) => {
      const k = readChecklistCategory(r.category, r.parallel).kind;
      return k === "base" || k === "auto";
    });
    const mergedMoved = mergedList.reduce((n, s) => n + s.children.length, 0);
    const mergedTotal = split.parallels.length + mergedMoved;
    // Same shape as splitInsertSets's own `keptEnough`: the >=8 floor is
    // NEVER waived, and clears the bar either by the source labelling a base
    // ladder anywhere or by keeping a quarter of the total.
    const categoryPassKeptEnough = mergedTotal === 0
      || (split.parallels.length >= MIN_KEPT_NAMES
        && (sourceLabelsItsBaseAnywhere || split.parallels.length / mergedTotal >= MIN_KEPT_FRACTION));
    let mergedInsertSets, categoryPassRefused;
    if (categoryPassKeptEnough || !categoryRoots.length) {
      mergedInsertSets = mergedList.sort((a, b) => a.rootKey.localeCompare(b.rootKey));
      categoryPassRefused = null;
    } else {
      // Refuse the category pass's contribution; the name-based split's own
      // result (already vetted by its own guard) stands untouched.
      mergedInsertSets = insertSets;
      categoryPassRefused = categoryRoots.map((cr) => ({ rootKey: normForRoot(cr.root), children: cr.children }));
    }
    insertSetCount += mergedInsertSets.length;
    insertNameCount += mergedInsertSets.reduce((n, s) => n + s.children.length, 0);

    // A SELF-NAMED ROOT IS NOT A PARALLEL -- but only when the category pass
    // that found it was not itself refused above; a refused pass leaves the
    // self-naming text exactly where flat parallels always kept it, same as
    // every other name on a refused product.
    //
    // "Illusionist" is the set talking about itself, not a rung of the base
    // card -- drop it from `parallels[]` now that its root has somewhere to
    // live. Matched on the exact name (lowercased), never a substring, so
    // nothing else is touched.
    const parallelsWithoutSelfNames = (!categoryPassRefused && selfNamed.selfNames.size)
      ? split.parallels.filter((e) => !selfNamed.selfNames.has(e.name.toLowerCase()))
      : split.parallels;

    const namedParallels = parallelsWithoutSelfNames
      .sort((a, b) => b.seen - a.seen || a.name.localeCompare(b.name))
      .map((e) => {
        if (e.printRun !== null) withRun++;
        return {
          name: e.name, printRun: e.printRun, odds: e.odds ?? null,
          seen: e.seen, spellings: e.spellings,
          // Provenance rides on the row, so the file itself says which names
          // a ruling admitted and which a scrape found.
          ...(e.overlay ? { overlay: e.overlay } : {}),
        };
      });

    // THE OVERRIDE IS THE LAST WORD -- see loadOverrides's header. Applied
    // to the fully-assembled, sorted `parallels[]`, so a drop removes
    // exactly what a human would read in the finished file and an add
    // cannot be re-split into an insert set or re-caught by the self-naming
    // filter (both already ran).
    const override = overrides.byProduct.get(pk);
    const finalParallels = applyOverride(namedParallels, override);
    if (override) {
      const droppedHere = (override.drop ?? []).filter((n) => namedParallels.some((e) => key(e.name) === key(n))).length;
      const addedHere = finalParallels.filter((e) => e.override).length;
      overridesDropped += droppedHere;
      overridesAdded += addedHere;
    }
    for (const e of finalParallels) names++;

    const dirsForProduct = [...(sourceDirsByProduct.get(pk) ?? [])];
    out[pk] = {
      sport, year: Number(year), setKey,
      parallels: finalParallels,
      ...(mergedInsertSets.length ? { insertSets: mergedInsertSets } : {}),
      // The split refused itself for this product (see splitInsertSets): its
      // source labels the base ladder as inserts, so the names stay flat and
      // what WOULD have moved is recorded instead of acted on.
      ...(split.refusedSplit?.length ? { suspectInsertRoots: split.refusedSplit } : {}),
      // Empty for every source that carries `category` -- i.e. all three
      // today. Populated only by a future source without it, so a consumer can
      // see a SUSPICION rather than a silent flattening.
      ...(/* placeholder for a source without category */ false ? { suspectInsertRoots: [] } : {}),
      // PROVENANCE (2026-09-25): which directories this product's vocabulary
      // came from, and whether any of them are outside this repo -- see
      // `isRepoDir`. A product with `reproducibleFromRepo: false` cannot be
      // regenerated by a plain `git clone`; its rungs depend on a local
      // scratch directory this file's history has always read from but never
      // committed.
      sourceDirs: dirsForProduct.sort(),
      reproducibleFromRepo: dirsForProduct.every(isRepoDir),
    };
  }

  // REPO-VS-NON-REPO PROVENANCE, CORPUS-WIDE. Counted here rather than left
  // for a reader to re-derive from every product's `sourceDirs` -- see
  // `isRepoDir`'s header. A product is "repo-only" when every directory it
  // drew from is a plain `git clone` away; otherwise its vocabulary depends
  // on a local scratch directory nothing in this repo reproduces.
  const repoOnlyProducts = Object.values(out).filter((p) => p.reproducibleFromRepo).length;
  const nonRepoProducts = products - repoOnlyProducts;
  let namesFromNonRepoOnly = 0;
  for (const p of Object.values(out)) if (!p.reproducibleFromRepo) namesFromNonRepoOnly += p.parallels.length;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    builtAt: new Date().toISOString(),
    sources: DIRS,
    productCount: products,
    parallelNameCount: names,
    // See the "REPO-VS-NON-REPO PROVENANCE" comment above main()'s end --
    // this is the corpus-wide rollup; each product's own `sourceDirs` /
    // `reproducibleFromRepo` is the per-product detail.
    productsNotReproducibleFromRepo: nonRepoProducts,
    namesFromProductsNotReproducibleFromRepo: namesFromNonRepoOnly,
    out: undefined,
  }, null, 1).replace(/\n \"out\": undefined\n/, "\n") .slice(0, -2) + ",\n \"products\": " + JSON.stringify(out, null, 1) + "\n}\n");

  console.log(`checklist files read     ${f(files)}`);
  console.log(`csv rows                 ${f(rows)}`);
  console.log(`products with parallels  ${f(products)}`);
  console.log(`distinct parallel names  ${f(names)}`);
  console.log(`insert sets              ${f(insertSetCount)}  (${f(insertNameCount)} names moved out of parallels)`);
  console.log(`overlay                  ${f(overlayAdded)} added, ${f(overlayAlreadyPresent)} already in a source (source wins)`);
  console.log(`overrides                ${f(overridesDropped)} dropped, ${f(overridesAdded)} added (ruling outranks the source)`);
  console.log(`non-repo provenance      ${f(nonRepoProducts)} of ${f(products)} products (${f(namesFromNonRepoOnly)} names) depend on a dir outside this repo`);
  console.log(`  carrying a print run   ${f(withRun)}`);
  console.log(`names cleaned of source noise ${f(cleaned)}`);
  console.log(`  print runs recovered   ${f(runsRecovered)}`);
  console.log(`  unusable, dropped      ${f(dropped)}`);
  console.log(`\nwritten to ${OUT}`);
}

module.exports = { cleanName, splitCsv, bareSelfNamedInsertRoots, foldedPhrase, loadOverrides, applyOverride, assertOverrideEntry };

if (require.main === module) main();
