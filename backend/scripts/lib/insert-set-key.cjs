/**
 * CF-A-NAMED-INSERT-SET-IS-ITS-OWN-CARD-SET, the ingest side (R21 "Inserts
 * folds" + #2043 INSERT_SET_IS_A_PRODUCT + R30, Drew 2026-09-13).
 *
 * THE DEFECT THIS ENDS, measured 2026-09-13 on the staged 2014 Panini Prizm
 * FIFA World Cup file (5,462 rows, 136 sub-checklists):
 *
 *     5,462 upserts -> 2,949 distinct documents
 *
 * `ingest-checklist-csv-to-catalog.cjs` built every row's address from
 * (sport, year, setKey, cardNumber, parallel, printRun, isAuto) and never read
 * the CSV's `category` column. Card number "1", blank parallel, no auto, no
 * print run occurs TEN times in that one file -- the base card plus nine
 * different insert subsets, nine different players -- and all ten computed
 *
 *     hiq:soccer:2014:panini-prizm-fifa-world-cup:1:base:no-auto
 *
 * so they overwrote each other inside a single run. The "catalog rows written"
 * counter counts UPSERT CALLS, so it printed 5,462 and could not see it:
 * 2,513 rows were written and then destroyed by a later row of the same file,
 * and the last writer for each id decided which player the card is.
 *
 * That is the `one card, one row, one pool` invariant failing at the mint.
 *
 * THE RULE.
 *
 *   base, and every parallel RUNG of base   -> the product key, unchanged.
 *   a SAME-NUMBERED insert set or subset    -> its OWN card set key, and a
 *                                              parallel rung of that insert
 *                                              stays on the insert's key with
 *                                              the parallel field set.
 *
 * That is R30 stated for the ingest: "a SAME-NUMBERED SUBSET is its own card
 * set key, registered like an insert-set-as-product key". It is the same
 * ruling `panini-rookies-and-stars-rookies-signatures` and
 * `flair-showcase-row-0` already ship under -- those two came in as SEPARATE
 * FILES with their own manifest setKey, which is this rule applied by hand at
 * acquisition time. This module applies it to a file that carries its subsets
 * in the `category` column instead.
 *
 * SAME-NUMBERED IS THE TRIGGER, AND IT IS A MEASUREMENT, NOT A GUESS.
 *
 * Every ruling behind this -- R30's own words, the Flair Rows, the Rookies &
 * Stars autograph subsets, #1741's Johnson Reprints -- turns on the SAME fact:
 * two subsets of one product that number their cards alike, so the card number
 * cannot say which card it is and only the subset can. A product whose inserts
 * carry their own number ranges has no such problem, and its rows have always
 * landed at distinct addresses.
 *
 * Measured on the three 2026-09-13 acquisition directories, before any change:
 *
 *     tcdb     2014 Panini Prizm FIFA World Cup   5,462 rows -> 2,949 ids
 *     insider  11 files, 13,240 rows              ZERO collisions
 *     scc      37 files, 11,666 rows              6 collisions, all inside
 *                                                 one `base` category
 *
 * Insider's big 2025 Rookies & Stars file carries 157 insert categories across
 * 6,360 rows and mints 6,360 distinct ids: its inserts are numbered in their
 * own ranges, and separating them would split nothing, refuse a file that is
 * already correct, and demand 157 registry entries no card needs. So the rule
 * is scoped to where the harm is: a subset key is derived for the categories
 * that ACTUALLY CLASH on the product key, and nowhere else
 * (feedback: right guard, wrong scope -- measure the blast radius).
 *
 * A KEY THIS MODULE DERIVES IS A PROPOSAL, NEVER A MINT.
 *
 * `normalizeSetKey` is the authority on what a card set key IS. A key that is
 * not one of its FIXED POINTS cannot hold a pool: the deriver, the matcher and
 * the rematch all fold it somewhere else, and the rows would sit at an address
 * nothing else can reach. Measured on the World Cup candidates, on main,
 * 2026-09-13:
 *
 *     normalizeSetKey("panini-prizm-fifa-world-cup-guardians") -> "panini-prizm"
 *
 * -- not merely "not a fixed point" but a fold PAST the product key, onto the
 * bare flagship. Writing there would be strictly worse than the collision it
 * was meant to fix. So registration is the mechanism, exactly as R30 says:
 * both halves, `productSetKeys.ts` AND the anchored `normalizeSetKey` rule,
 * land in src FIRST, and until they do this module REFUSES the file and names
 * the keys to register.
 *
 * ABSENT BEATS WRONG. The alternative -- collapse onto the product key -- is
 * what produced the defect, and a partial write (base lands, inserts refused)
 * would leave the file half-ingested under a resume marker claiming it is
 * done. The unit of refusal is therefore the FILE.
 */

/** slugify, byte-compatible with hobbyIqCardId.service's, so a key this module
 *  proposes is spelled exactly as the slug generator would spell it. Kept
 *  local because this module must be requirable without a dist/ build -- the
 *  same reason lib/subset-identity.cjs is a copy. */
function slugifyKey(s) {
  return String(s === null || s === undefined ? "" : s)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * CF-A-SECTION-HEADING-IS-NOT-AN-INSERT-NAME. The `category` column carries
 * either a structural heading for the base print, or `insert-<slug>` /
 * `auto-<slug>` naming a real subset. These are the headings that name NO
 * subset -- the same family lib/subset-identity.cjs folds to "no claim", for
 * the same reason: they say which SECTION of a page a row sat in, not which
 * card set it belongs to.
 *
 * Deliberately small and deliberately exact-match: a guessed vocabulary here
 * would silently fold a real insert onto the product key, which is the harm
 * this module exists to end.
 */
const BASE_CATEGORIES = new Set([
  "", "base", "base-set", "base-cards", "base-card", "base-set-cards",
  "checklist", "checklist-base-set",
  // The bare, undifferentiated insert section: "this row is one of the
  // inserts on this page" names no insert (CF-INSERTS-IS-NOT-A-SUBSET-NAME).
  "insert", "inserts", "insert-set", "insert-sets", "inserts-and-parallels",
]);

/** The prefixes a scraper puts in front of a subset name in `category`. */
const CATEGORY_PREFIXES = ["insert-", "auto-", "subset-", "relic-", "parallel-"];

/**
 * The subset a row's category NAMES, as a slug -- or "" when the category is a
 * structural section heading and names none.
 *
 * THE PARALLEL IS STRIPPED OFF THE TAIL. Two staged scraper conventions put
 * the same fact in different places, and both must reach the same card set:
 *
 *   tcdb     category `insert-aerial-assault`   parallel "Gold Prizm"
 *   insider  category `insert-airborne-gold`    parallel "Airborne Gold"
 *
 * Measured across the three 2026-09-13 acquisition directories: every one of
 * insider's 188 prefixed (category, parallel) pairs has the slugified parallel
 * as the category's tail, and NONE of tcdb's 122 do -- so stripping a tail the
 * row's OWN parallel column already states is exact on both and invents
 * nothing on either. `insert-base-gold` + "Base Gold" strips to "base", which
 * BASE_CATEGORIES then reads as the base print's gold rung: the right answer,
 * and the reason the strip runs BEFORE the heading test.
 *
 * THE STRIP ONLY EVER REMOVES A SUFFIX, NEVER THE WHOLE NAME. Insider spells
 * the rung of a named insert by repeating the family in the parallel column:
 * category `insert-airborne-gold`, parallel "Airborne Gold". A strip that
 * allowed the remainder to be EMPTY would consume "airborne" too and read a
 * real insert set as the base print -- the exact collapse this module exists
 * to prevent, reintroduced by its own helper. So an exact equality between the
 * category and its parallel leaves the category ALONE: when a scraper names a
 * section after nothing but its rung, the section it belongs to is unstated,
 * and only the `-` suffix form carries a family to keep.
 *
 * A RUNG OF BASE IS STILL BASE, however the scraper spelled it. Insider writes
 * the base set's own parallels as `insert-base-gold`, `insert-base-preferred-
 * black`, `insert-base-true-blue` -- the word "base" and then the rung. Those
 * are the BASE CARD's rungs and belong on the product key with the parallel
 * field set, per the rule above; reading them as a `-base-gold` insert set
 * would split the base pool thirteen ways and refuse a file that has no
 * collision at all. So a category whose FIRST segment is a base-section
 * heading claims no subset, whatever follows it.
 */
function categorySubsetSlug(category, parallel) {
  let cat = slugifyKey(category);
  if (!cat) return "";
  for (const p of CATEGORY_PREFIXES) {
    if (cat.startsWith(p)) { cat = cat.slice(p.length); break; }
  }
  const par = slugifyKey(parallel);
  // Suffix only, and only when something is left: never strip to empty.
  if (par && cat.length > par.length + 1 && cat.endsWith("-" + par)) {
    cat = cat.slice(0, -(par.length + 1));
  }
  if (BASE_CATEGORIES.has(cat)) return "";
  // "base-gold", "base-preferred-black": a rung OF the base print.
  if (BASE_CATEGORIES.has(cat.split("-")[0])) return "";
  return cat;
}

/**
 * CF-ONE-CARD-ONE-ADDRESS-WHICHEVER-COLUMN-SAID-SO (2026-09-13, reconciling
 * #2106 and #2114).
 *
 * TWO ACQUISITION LANES SPELL THE SAME FACT IN TWO PLACES, and until this
 * function existed they reached two different addresses for one card class:
 *
 *   per-ROW      the `category` column names the subset, one file per product
 *                (tcdb's World Cup, checklistinsider's big Rookies & Stars)
 *   per-FILE     the MANIFEST declares `subset`, one file per subset
 *                (cardboardconnection #2114: 197 subset-declaring files across
 *                 6 products, and #2106's Rookies & Stars autograph subsets,
 *                 which went further and gave each file its own `setKey`)
 *
 * They are the SAME CLAIM -- "these rows belong to a named subset of this
 * product" -- so they must derive the SAME key. A subset stated in a manifest
 * is not a weaker claim than one stated in a column, and a card's address must
 * not depend on which scraper happened to fetch it.
 *
 * THE CANONICAL FORM IS R30'S KEY, NOT THE `:sub-` SEGMENT. Drew ruled it
 * (R30, 2026-09-13): a same-numbered subset is its own card SET KEY, and
 * #2106 already shipped it that way -- `panini-rookies-and-stars-rookies-
 * signatures` is a normalizeSetKey FIXED POINT today, registered in src. The
 * `:sub-` segment from the 2026-09-04 ruling stays where it belongs: it
 * resolves a clash the CATALOG discovers between two stored rows, which is a
 * different question from what a checklist asserts up front.
 *
 * WHY `:sub-` CANNOT BE THE CANONICAL FORM HERE, measured on #2114's staged
 * files 2026-09-13:
 *
 *   1. IT IS REACTIVE. The branch is `if (known && knownClaim && knownClaim
 *      !== productClaim)` -- it fires only when a row is ALREADY STORED at the
 *      plain id claiming a different subset. Into an empty cell the first
 *      file's rows land PLAIN; only a later file's rows get a segment. The
 *      address a card ends up at therefore depends on FILE ORDER.
 *   2. IT NEVER RUNS IN REPORT MODE. `if (!APPLY) { written++; return; }`
 *      precedes it, so a dry run cannot see any of this.
 *   3. IT IS ASYMMETRIC BY CONSTRUCTION. The incumbent is re-minted and MOVED
 *      and the plain id vacated -- a repair for two rows, not an addressing
 *      scheme for 197 files and 68,329 rows.
 *   4. TWO ADDRESSES FOR ONE CARD CLASS. Great Significance #1 would be
 *      `…:nba-hoops:1:base:auto:sub-great-significance` from #2114 and
 *      `…:nba-hoops-great-significance:1:base:auto` from the #2106 form. One
 *      card, two ids, two pools.
 *
 * Measured on `acq-2026-09-13-cbc`, plain ids per product cell:
 *
 *     nba-hoops 2022             10,111 rows ->  9,703 ids   200 contested
 *     panini-prizm-draft-picks    9,591 rows ->  7,748 ids   835 contested
 *     panini-spectra             11,766 rows -> 11,033 ids   485 contested
 *     panini-donruss             10,715 rows -> 10,420 ids   124 contested
 *     nba-hoops 2023             10,166 rows ->  9,739 ids   159 contested
 *     (the four Upper Deck / Topps Chrome Platinum files: zero contested)
 *
 * 1,803 contested ids, and in NOT ONE of them does an unclaimed row take part
 * -- every contested address is claimed by two or more NAMED subsets. That is
 * the R30 shape exactly, so the R30 key is what they get.
 */
function subsetSlugFor({ category, parallel, subsetName }) {
  // The row's own column first: it is the more specific statement, and a file
  // that carries both is naming a subset WITHIN the file's subset.
  const fromCategory = categorySubsetSlug(category, parallel);
  if (fromCategory) return fromCategory;
  // Then the manifest's declaration, folded through the SAME structural-
  // heading vocabulary -- a manifest that says `subset: "Base Set"` claims
  // nothing, exactly as a category of "base" does (CF-BASE-SET-IS-NOT-A-SUBSET).
  const declared = slugifyKey(subsetName);
  if (!declared || BASE_CATEGORIES.has(declared)) return "";
  return declared;
}

/**
 * The card set key a row belongs on, given the set of subsets this file has
 * MEASURED to be same-numbered. `separate` empty -- the default, and the shape
 * of every file that does not clash -- returns the product key for every row,
 * which is byte-for-byte what the ingest did before this module existed.
 *
 * -> { setKey, subsetSlug, isInsertSet }
 */
function setKeyForRow({ productSetKey, category, parallel, subsetName, separate, foldRungs }) {
  const product = String(productSetKey || "").trim();
  let subsetSlug = subsetSlugFor({ category, parallel, subsetName });
  let rungParallel = null;
  // CF-A-COLOUR-RUNG-IS-NEVER-A-CARD-SET-KEY: a subset the cell MEASURED to be
  // a colour rung of another subset folds onto its root, and the colour moves
  // to the parallel axis. Only ever one hop -- the fold is computed against the
  // roster, so a rung's root is by construction a real subset, never a rung.
  if (subsetSlug && foldRungs && foldRungs.has(subsetSlug)) {
    const fold = foldRungs.get(subsetSlug);
    rungParallel = fold.parallel;
    subsetSlug = fold.root;
  }
  if (!subsetSlug) return { setKey: product, subsetSlug: "", isInsertSet: false, rungParallel };
  if (separate && !separate.has(subsetSlug)) {
    return { setKey: product, subsetSlug, isInsertSet: false, rungParallel };
  }
  return { setKey: product + "-" + subsetSlug, subsetSlug, isInsertSet: true, rungParallel };
}

/** The parallel a row carries once rung folding is applied: the row's own
 *  column when it states one, else the colour the fold moved off the key.
 *  The row's own column WINS -- a file that states both is naming a rung of a
 *  rung, and the column is the more specific statement. */
function parallelForRow({ category, parallel, subsetName, foldRungs }) {
  const own = String(parallel || "").trim();
  if (own) return own;
  const slug = subsetSlugFor({ category, parallel, subsetName });
  if (slug && foldRungs && foldRungs.has(slug)) return foldRungs.get(slug).parallel;
  return own;
}

/**
 * CF-THE-RUN-COUNTS-DOCUMENTS-NOT-CALLS.
 *
 * Group staged rows by the id they would be written to. `computeId` is the
 * CALLER'S slug function, so the guard measures the exact addresses the run
 * would use -- a guard computing its own approximation of the id is a guard
 * that can disagree with the write it is guarding.
 *
 * A ROW THE SLUG GENERATOR REFUSES IS NOT A COLLISION. computeHobbyIqCardId
 * THROWS on an identity it cannot derive -- "unnumbered card has no player to
 * identify it" is the measured case, the three NNO Checklist rows of 1999-00
 * Skybox Premium. The ingest's own per-row try/catch already counts those as
 * `failed`; the guard must reach the same verdict rather than take the whole
 * file down with it, or a guard added to stop silent overwrites becomes a new
 * way for a good file to die.
 *
 * -> { ids, collisions: [{ id, rows: [row, ...] }], unslugable }
 */
function idCollisions(rows, computeId) {
  const byId = new Map();
  let unslugable = 0;
  for (const r of rows) {
    let id = null;
    try { id = computeId(r); } catch { id = null; }
    if (!id) { unslugable++; continue; }
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(r);
  }
  const collisions = [];
  for (const [id, group] of byId) {
    if (group.length > 1) collisions.push({ id, rows: group });
  }
  collisions.sort((a, b) => b.rows.length - a.rows.length || a.id.localeCompare(b.id));
  return { ids: byId.size, collisions, unslugable };
}

/**
 * PASS 1 -- WHICH SUBSETS ARE SAME-NUMBERED, measured on the file's own rows.
 *
 * A subset needs its own card set key exactly when it collides on the product
 * key with a DIFFERENT subset (base included). Two rows of the SAME subset
 * colliding is not this defect: the checklist itself printed one number twice
 * (1989 Pro Set #47 "William Perry/" and "Ron Morris", 1989 Score #316 ERR and
 * COR), and a set key cannot separate those -- pass 2 refuses them, which is
 * the honest answer.
 *
 * Returns the set of subset SLUGS to separate.
 */
function subsetsToSeparate(rows, productSetKey, computeId, foldRungs) {
  // EVERY ROW ON THE PRODUCT KEY. This pass asks "what does the OLD behaviour
  // collide on?", so it must use the old behaviour's address -- the product
  // key for every row, category discarded. Routing it through setKeyForRow
  // with no `separate` gave each named insert its own key here and so measured
  // a world in which nothing collides: the guard answered "separate nothing"
  // for the very file it exists to catch.
  //
  // The PARALLEL a rung fold moves onto the row is part of the old behaviour's
  // address too: two rungs of one subset differ only by it, so measuring them
  // with a blank parallel would report a clash the fold has already resolved
  // and demand a key for a colour.
  const { collisions } = idCollisions(rows, (r) => computeId({
    ...r,
    setKey: productSetKey,
    parallel: parallelForRow({ category: r.category, parallel: r.parallel, subsetName: r.subsetName, foldRungs }),
  }));
  const separate = new Set();
  for (const c of collisions) {
    const slugs = new Set(c.rows.map((r) => {
      const slug = subsetSlugFor({ category: r.category, parallel: r.parallel, subsetName: r.subsetName });
      // A rung answers as its ROOT: the colour is on the parallel axis now, so
      // the subset that takes part in the clash is the root subset.
      return slug && foldRungs && foldRungs.has(slug) ? foldRungs.get(slug).root : slug;
    }));
    // Two or more DIFFERENT subsets (the empty slug is base, and counts as one
    // of them) sharing one address: every named one gets its own key.
    if (slugs.size < 2) continue;
    for (const s of slugs) if (s) separate.add(s);
  }
  return separate;
}

/**
 * Every DISTINCT insert-set key a file would need under `separate`, each with
 * the evidence for it: the categories that named it and how many rows ride on
 * it. This is the list a refusal prints, and it is the list someone registers.
 */
function insertSetKeysOf(rows, productSetKey, separate, foldRungs) {
  const byKey = new Map();
  for (const r of rows) {
    const { setKey, subsetSlug, isInsertSet } = setKeyForRow({
      productSetKey, category: r.category, parallel: r.parallel, subsetName: r.subsetName, separate, foldRungs,
    });
    if (!isInsertSet) continue;
    if (!byKey.has(setKey)) {
      byKey.set(setKey, { setKey, subsetSlug, rows: 0, categories: new Set(), examples: [] });
    }
    const g = byKey.get(setKey);
    g.rows++;
    g.categories.add(String(r.category || ""));
    if (g.examples.length < 3) g.examples.push(`#${r.cardNumber} ${r.player}`);
  }
  return [...byKey.values()]
    .map((g) => ({ ...g, categories: [...g.categories].sort() }))
    .sort((a, b) => b.rows - a.rows || a.setKey.localeCompare(b.setKey));
}

/**
 * Which of a file's proposed keys are NOT normalizeSetKey fixed points.
 *
 * `normalize` is INJECTED rather than required, because this module must load
 * without dist/ (the tests and the census read it directly) while the ingest
 * hands it the real service. A caller that passes nothing gets every key back
 * as unverified, which REFUSES -- never "assume fine".
 */
function unregisteredKeys(keys, normalize) {
  const out = [];
  for (const k of keys) {
    if (typeof normalize !== "function") { out.push({ ...k, resolvesTo: null }); continue; }
    let resolved = null;
    try { resolved = normalize(k.setKey); } catch { resolved = null; }
    if (resolved !== k.setKey) out.push({ ...k, resolvesTo: resolved });
  }
  return out;
}

/**
 * CF-THE-CLASH-IS-A-FACT-ABOUT-THE-PRODUCT-NOT-THE-FILE (2026-09-13,
 * reconciling #2114).
 *
 * A per-FILE measurement cannot see a clash between two FILES, and that is
 * exactly the shape cardboardconnection ships: one file per subset, 197 of
 * them across 6 products. Each file is internally distinct, so a per-file
 * guard passes all 207 and reports 68,329 rows on 67,789 ids -- while the
 * PRODUCT cells underneath hold 1,803 contested addresses:
 *
 *     nba-hoops 2022             10,111 rows ->  9,703 ids   200 contested
 *     panini-prizm-draft-picks    9,591 rows ->  7,748 ids   835 contested
 *     panini-spectra             11,766 rows -> 11,033 ids   485 contested
 *     panini-donruss             10,715 rows -> 10,420 ids   124 contested
 *     nba-hoops 2023             10,166 rows ->  9,739 ids   159 contested
 *
 * Great Significance #1 (Joe Ingles), Hoops Art Signatures #1 (Paolo
 * Banchero), Hoops Ink #1 (Cade Cunningham) and Hot Signatures Hyper Gold #1
 * (Luka Doncic) all compute `hiq:basketball:2022:nba-hoops:1:base:auto`.
 *
 * So the unit of MEASUREMENT is the (sport, year, setKey) CELL across the whole
 * directory. The unit of REFUSAL stays the FILE -- that is what a resume marker
 * is written for -- but the question it answers is asked of the product.
 *
 * `rowsByCell` is a Map of cell key -> rows, built once by the caller before
 * the file loop. Returns a Map of the same keys -> the `separate` Set.
 */
function separationByCell(rowsByCell, computeId, foldByCell) {
  const out = new Map();
  for (const [cell, entry] of rowsByCell) {
    out.set(cell, subsetsToSeparate(entry.rows, entry.productSetKey, computeId, foldByCell && foldByCell.get(cell)));
  }
  return out;
}

/**
 * CF-A-COLOUR-RUNG-IS-NEVER-A-CARD-SET-KEY (R30 corollary, Drew 2026-09-13).
 *
 * THE DEFECT THIS ENDS, measured on `acq-2026-09-13-cbc` after #2112 landed:
 * of the 170 keys the refusal named, 110 WERE COLOUR RUNGS, not card sets.
 *
 *     panini-prizm-draft-picks-college-penmanship-prizms-gold
 *     panini-prizm-draft-picks-college-penmanship-prizms-black
 *     panini-spectra-aspiring-patch-autographs-neon-splatter
 *     nba-hoops-hot-signatures-hyper-gold
 *
 * Registering those would split ONE POOL PER COLOUR -- `one card, one row, one
 * pool` failing on a different axis from the collision #2112 fixed, and the
 * ruling is explicit: a named parallel is a distinct CARD, not a distinct SET,
 * so a colour rides the PARALLEL axis.
 *
 * WHY THE EXISTING STRIP COULD NOT SEE IT. `categorySubsetSlug` strips a
 * parallel off a category's tail only when the ROW'S OWN `parallel` column
 * states it. cardboardconnection ships ONE FILE PER RUNG with the colour folded
 * into the manifest's `subset` string and the parallel column LEFT BLANK --
 * 166 of its 197 subset-declaring files have `distinctParallels: 0`:
 *
 *     category,cardNumber,parallel,isAuto,printRun,player
 *     auto-college-penmanship-prizms-gold,1,,true,10,Paolo Banchero
 *     auto-college-penmanship,1,,true,,Paolo Banchero
 *
 * Same card, same player; the second is the base auto and the first its Gold
 * /10 rung. Nothing in the row says "Gold" is a parallel, so the colour
 * survived into the key.
 *
 * THE RULE IS A MEASUREMENT, NOT A LEXICON, and that is the whole point. A
 * word list would fold "Gold Standard", "Black Gold" and "Red Zone" -- real
 * products whose NAMES end in a colour word -- into a sibling that does not
 * exist. A suffixed subset is a RUNG only when all three hold:
 *
 *   (a) a ROOT subset exists in the SAME (sport, year, product) cell, whose
 *       slug is a prefix of this one at a segment boundary;
 *   (b) the two ROSTERS AGREE -- every shared card number maps to the SAME
 *       player, with ZERO disagreements. A rung reprints its root's roster;
 *       a distinct set does not;
 *   (c) the rung actually SHARES numbers with its root (an all-absent overlap
 *       proves nothing and is left alone).
 *
 * Otherwise the suffixed subset STAYS A KEY CANDIDATE and is reported, which is
 * how the four measured-distinct cbc subsets keep their own keys: Hot
 * Signatures Rookies (98 different players), Art Signatures Horizontal and
 * Vertical (disjoint numbers) -- the source publishes them as separate
 * checklists with their own rosters, so under R30 they are card sets.
 *
 * THE COLOUR SPELLING IS THE SOURCE'S OWN. The parallel this returns is the
 * tail the SOURCE wrote, un-slugged for display ("Prizms Gold", "Neon
 * Splatter"), never a name this module invents -- `no synthetic parallels`.
 *
 * Measured over the whole directory with this folding in place:
 *
 *     68,329 rows -> 68,243 distinct ids   (1,803 contested -> 68)
 *     all 68 residual groups are the SAME player: duplicate source rows,
 *     not identity conflicts
 *
 * -> Map of rungSlug -> { root, parallel, rows, same, absent }
 */
function rungFoldingFor(rows) {
  // Every subset slug this cell states, with its (number -> player) roster.
  const rosters = new Map();
  for (const r of rows) {
    const slug = subsetSlugFor({ category: r.category, parallel: r.parallel, subsetName: r.subsetName });
    if (!slug) continue;
    if (!rosters.has(slug)) rosters.set(slug, new Map());
    rosters.get(slug).set(String(r.cardNumber), String(r.player || ""));
  }
  // CF-THE-SIBLINGS-NAME-THE-SET-EVEN-WITH-NO-BASE-TIER (Drew 2026-09-13).
  //
  // A root need not be a FILE. Spectra publishes fourteen "Dual Patch
  // Autographs <colour>" files and NO uncoloured tier, so guard (a) found no
  // root and six colours survived as keys. But every one of the fourteen
  // filenames STATES the set name -- the source simply prints no uncoloured
  // print run. Reading the shared name is not inventing a root; refusing to
  // read it is what split one card set fourteen ways.
  //
  // The evidence required is the same evidence a root file gives: >= 2 sibling
  // colour slugs sharing a name prefix at a segment boundary, whose ROSTERS
  // AGREE with each other -- same number -> same player, zero disagreements.
  // Two files that merely start alike prove nothing; two files that print the
  // same players at the same numbers are two printings of one checklist.
  //
  // NO BASE ROW IS MINTED. The derived root is an ADDRESS for the colours to
  // share, never a row: blank stays unknown and nothing is written as Base
  // (feedback: blank means unknown, never "Base"). Its roster is assembled from
  // the siblings only so the fold below can measure against it.
  //
  // The longest shared prefix wins, so "Dual Patch Autographs Neon Pink" and
  // "... Neon Purple" establish "dual-patch-autographs" (their agreeing name)
  // rather than "dual-patch-autographs-neon", which no file names alone.
  const derivedRoots = new Set();
  {
    const stated = new Set(rosters.keys());
    const candidates = new Map(); // prefix -> [slug, ...]
    for (const slug of stated) {
      const segs = slug.split("-");
      // Only a slug with NO stated root of its own needs one derived. When the
      // source publishes "College Penmanship" beside "College Penmanship Prizms
      // Gold", the set is already named and deriving "college" from the shared
      // first segment would root a real card set on a fragment of its own name.
      if (segs.some((_, n) => n > 0 && stated.has(segs.slice(0, n).join("-")))) continue;
      // Every proper prefix at a segment boundary.
      for (let n = 1; n < segs.length; n++) {
        const pre = segs.slice(0, n).join("-");
        if (stated.has(pre)) continue; // a real file already roots this
        if (!candidates.has(pre)) candidates.set(pre, []);
        candidates.get(pre).push(slug);
      }
    }
    // WIDEST FIRST, THEN LONGEST. The name to derive is the one the MOST
    // siblings agree on: with fourteen "Dual Patch Autographs <colour>" files,
    // twelve share `dual-patch-autographs` while only two share
    // `dual-patch-autographs-neon`, and the set is the former. Ordering by
    // length alone over-fits a subgroup and derives a name NO FILE STATES --
    // measured on a Neon Pink + Neon Purple pair, which alone would mint
    // "Dual Patch Autographs Neon" and read the colours as "Pink" / "Purple".
    //
    // Once a prefix is established the slugs under it are SPOKEN FOR, so a
    // narrower or shorter name cannot re-root them.
    const claimed = new Set();
    const byWidth = [...candidates.keys()].sort((a, b) =>
      candidates.get(b).length - candidates.get(a).length || b.length - a.length);
    for (const pre of byWidth) {
      const sibs = candidates.get(pre).filter((x) => !claimed.has(x));
      if (sibs.length < 2) continue;
      // The siblings must AGREE with one another, pairwise against the first.
      const merged = new Map();
      let differ = 0, agreed = 0;
      for (const sib of sibs) {
        for (const [num, player] of rosters.get(sib)) {
          const held = merged.get(num);
          if (held === undefined) merged.set(num, player);
          else if (held === player) agreed++;
          else differ++;
        }
      }
      // One disagreement means these are not printings of one checklist.
      if (differ > 0 || agreed === 0) continue;
      // CF-A-SHARED-TAIL-IS-PART-OF-THE-NAME. The siblings must differ AFTER
      // the shared prefix, or the tail belongs to the set's NAME, not to a
      // rung. Measured: all 19 Donruss subsets are spelled "<Name> Autographs",
      // so a prefix rule alone derived `dominators` -- a set the source never
      // names -- and made "Autographs" a parallel. Autograph status is `isAuto`
      // and was never a parallel; the source states "Dominators Autographs" and
      // that IS the card set.
      //
      // Drew's ruling turns on the siblings naming ONE set and differing only
      // by colour ("Dual Patch Autographs Gold" vs "... Meta"). When every
      // sibling carries the SAME tail there is no colour to move and nothing to
      // derive.
      const tails = new Set(sibs.map((x) => x.slice(pre.length + 1)));
      if (tails.size < 2) continue;
      rosters.set(pre, merged);
      derivedRoots.add(pre);
      for (const sib of sibs) claimed.add(sib);
      // The derived root is itself spoken for: a shorter prefix must not adopt
      // it, which is what would put the set under a fragment of its own name.
      claimed.add(pre);
    }
  }

  const slugs = [...rosters.keys()];
  const folding = new Map();
  for (const slug of slugs) {
    // (a) The LONGEST other slug that is a segment-boundary prefix of this one.
    // Longest, so "…-prizms-red-shimmer" is tested against "…-prizms-red"
    // before "…" -- the nearest root is the one that can explain it.
    let root = null;
    for (const c of slugs) {
      if (c !== slug && slug.startsWith(c + "-") && (!root || c.length > root.length)) root = c;
    }
    if (!root) continue;
    // (b) + (c) The rosters must AGREE, over a non-empty shared span.
    const rootRoster = rosters.get(root), rungRoster = rosters.get(slug);
    let same = 0, differ = 0, absent = 0;
    for (const [num, player] of rungRoster) {
      const rootPlayer = rootRoster.get(num);
      if (rootPlayer === undefined) absent++;
      else if (rootPlayer === player) same++;
      else differ++;
    }
    // ONE disagreement is enough to refuse: a rung reprints its root's roster,
    // and a single number naming a different player means these are two sets.
    if (differ > 0 || same === 0) continue;
    // CF-AUTOGRAPH-IS-NOT-A-PARALLEL. `isAuto` already separates a signed card
    // from its unsigned twin, and it is part of the id -- so a tail that only
    // says "signed" names no rung and must never become a parallel (feedback:
    // the isAuto boundary is not text).
    //
    // Measured on acq-2026-09-13-cbc: Donruss publishes "Dominators" (40 cards,
    // unsigned) AND "Dominators Autographs" (22 cards, signed, /10). They share
    // numbers and players, so the roster test passes -- but the second is not a
    // colour rung of the first, it is the product's autograph subset, and the
    // source names it "Dominators Autographs". Folding it produced the key
    // `panini-donruss-dominators` with parallel "Autographs" for all 19 Donruss
    // subsets: a parallel that is not one, on a key the source never names.
    //
    // The ids stayed distinct (isAuto is in the slug), so this was a NAMING
    // defect rather than a collision -- which is exactly why it needs stating:
    // a wrong name on a right address is still a wrong row.
    const tail = slug.slice(root.length + 1);
    if (/^(?:autographs?|signatures?|signed|auto)$/.test(tail)) continue;
    folding.set(slug, {
      root,
      // The source's own spelling of the tail, un-slugged for display only.
      parallel: slug.slice(root.length + 1).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      rows: rungRoster.size, same, absent,
    });
  }
  // CF-A-RUNG-OF-A-RUNG-IS-A-SIBLING-COLOUR. The nearest prefix is not always
  // the real card set: "Prizms Blue Ice" picks "Prizms Blue" and "Prizms Red
  // Shimmer" picks "Prizms Red", but Blue Ice is a SIBLING COLOUR of Blue, not
  // a rung of it -- both are rungs of the base subset. A root that is ITSELF
  // folded is therefore not a card set, and following the chain to its end is
  // what puts every colour of one subset on ONE key.
  //
  // Measured on acq-2026-09-13-cbc: without this, 13 of the 54 surviving keys
  // were colour rungs whose root happened to be another colour rung.
  //
  // The PARALLEL keeps the source's own full spelling relative to the ULTIMATE
  // root ("Prizms Blue Ice", never "Ice"), because that is what the source
  // wrote and the rung is a rung OF THE BASE SUBSET.
  for (const [slug, fold] of folding) {
    let root = fold.root;
    // The chain is finite: each hop is strictly shorter than the last.
    const seen = new Set([slug]);
    while (folding.has(root) && !seen.has(root)) { seen.add(root); root = folding.get(root).root; }
    if (root === fold.root) continue;
    fold.root = root;
    fold.parallel = slug.slice(root.length + 1).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return folding;
}

/** Per-cell rung folding, built once by the caller alongside separationByCell.
 *  A rung is a fact about the PRODUCT -- the root can live in another file --
 *  so the cell is the unit here for the same reason it is there. */
function rungFoldingByCell(rowsByCell) {
  const out = new Map();
  for (const [cell, entry] of rowsByCell) out.set(cell, rungFoldingFor(entry.rows));
  return out;
}

/**
 * THE WHOLE DECISION FOR ONE FILE, in one call, so the ingest and the tests
 * and any future census all reach the same verdict from the same code.
 *
 * `separate` may be supplied by the caller -- the CELL-WIDE separation
 * measured across every file of the product (see separationByCell). When it is
 * absent the file measures itself, which is right for a directory of
 * one-file-per-product and is what the tests exercise directly.
 *
 * `computeId({ ...row, setKey })` is the caller's slug function.
 * `normalize` is normalizeSetKey, or absent (then every derived key is
 * unverified and the file refuses).
 *
 * -> { verdict: "pass" | "refuse", reason, separate, keys, unregistered,
 *      ids, collisions, rows }
 */
function planFile({ rows, productSetKey, computeId, normalize, separate: given, foldRungs: givenFold }) {
  // CF-A-COLOUR-RUNG-IS-NEVER-A-CARD-SET-KEY. Measured cell-wide by the caller
  // (rungFoldingByCell) where a root can live in another file; a file that
  // measures itself is right for one-file-per-product and is what the tests
  // exercise directly, exactly as `separate` works.
  const foldRungs = givenFold || rungFoldingFor(rows);
  const separate = given || subsetsToSeparate(rows, productSetKey, computeId, foldRungs);
  const keys = insertSetKeysOf(rows, productSetKey, separate, foldRungs);
  const unregistered = unregisteredKeys(keys, normalize);
  const finalId = (r) => computeId({
    ...r,
    // The colour a fold moved off the key rides the parallel axis, so the id
    // this measures is the id the write will take.
    parallel: parallelForRow({ category: r.category, parallel: r.parallel, subsetName: r.subsetName, foldRungs }),
    setKey: setKeyForRow({ productSetKey, category: r.category, parallel: r.parallel, subsetName: r.subsetName, separate, foldRungs }).setKey,
  });
  const { ids, collisions, unslugable } = idCollisions(rows, finalId);
  // ORDER IS LOAD-BEARING: an unregistered key is reported even when the
  // separation it would perform already removes every collision, because
  // writing to a key that folds elsewhere is the worse outcome of the two.
  if (unregistered.length) {
    return { verdict: "refuse", reason: "unregistered-set-keys", separate, foldRungs, keys, unregistered, ids, collisions, unslugable, rows: rows.length };
  }
  if (collisions.length) {
    return { verdict: "refuse", reason: "id-collisions", separate, foldRungs, keys, unregistered, ids, collisions, unslugable, rows: rows.length };
  }
  return { verdict: "pass", reason: null, separate, foldRungs, keys, unregistered, ids, collisions, unslugable, rows: rows.length };
}

/**
 * The subset's name for DISPLAY, joined to the parent product's setName.
 *
 * The manifest's `subset` is a person's transcription of the checklist's own
 * heading ("Great Significance", "The Legends Series Autographs") and is used
 * verbatim when present; only a category slug has to be un-slugged, and that
 * is a reconstruction, not the source's words. Display only -- the identity is
 * the key, which both paths already agree on.
 */
function subsetDisplayName(row) {
  const declared = String((row && row.subsetName) || "").trim();
  if (declared) return declared;
  return String((row && row.category) || "")
    .replace(/^(?:insert|auto|subset|relic|parallel)-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** One colliding group, as the refusal prints it: the id, then every row's
 *  category and player, because the CATEGORIES are what say whether the clash
 *  is an unregistered insert set or a genuine checklist duplicate. */
function formatCollision(c) {
  const lines = [`    ${c.id}   ${c.rows.length} rows`];
  for (const r of c.rows.slice(0, 12)) {
    lines.push(`        [${r.category || "-"}] #${r.cardNumber}${r.parallel ? ` (${r.parallel})` : ""}  ${r.player}`);
  }
  if (c.rows.length > 12) lines.push(`        ... and ${c.rows.length - 12} more`);
  return lines.join("\n");
}

module.exports = {
  slugifyKey,
  BASE_CATEGORIES,
  CATEGORY_PREFIXES,
  categorySubsetSlug,
  subsetSlugFor,
  setKeyForRow,
  parallelForRow,
  rungFoldingFor,
  rungFoldingByCell,
  subsetsToSeparate,
  insertSetKeysOf,
  unregisteredKeys,
  idCollisions,
  planFile,
  separationByCell,
  subsetDisplayName,
  formatCollision,
};
