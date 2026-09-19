#!/usr/bin/env node
/**
 * CF-THE-CATEGORY-PREFIX-IS-THE-SOURCE-SPEAKING (Drew, 2026-09-18).
 *
 * ONE reader for the `category` column of the checklist CSVs, shared by the
 * corpus builder (backend/scripts/build-parallel-vocabulary.cjs) and by the
 * ingester's category reader. Two readers of the same column that disagree is
 * two different answers to "what card is this", which is the defect class this
 * exists to end.
 *
 * -- THE DEFECT IT ANSWERS ---------------------------------------------------
 *
 * Several sources label a product's BASE ladder with `insert-` categories and
 * put the variant ONLY in the category slug:
 *
 *     insert-base-hobby,1,,,,Caleb Williams          <- parallel column BLANK
 *     insert-base-red-zone-blue,1,,,,Caleb Williams
 *     auto-base-autographs-no-huddle,1,,,,Caleb W.
 *
 * Read naively every one of those is "card 1, no parallel", so they all
 * collapse onto the same identity. Measured by the acquisition researcher on
 * 2024 panini-zenith football: 485 ids claimed by several rows, 5,338 distinct
 * ids for 6,214 rows. Treating the variant as the parallel takes it to 6,178.
 *
 * -- THE THREE RULES ---------------------------------------------------------
 *
 * (a) `insert-base` / `insert-base-<variant>` IS THE BASE CARD. The tail is
 *     the parallel, never an insert set name. `insert-base-hobby` is the Hobby
 *     printing of the base card; there is no insert set called "Base".
 *
 * (b) `auto-base-<variant>` is the same, signed. `isAuto` is true because THE
 *     SOURCE SAID SO: in these files the category prefix is the section
 *     heading the manufacturer published, and `auto-` is that heading naming
 *     the signed section. That satisfies "autos only when the source says
 *     signed" -- the attestation is the prefix itself.
 *
 *     THIS MUST NOT GENERALISE. Nothing here licenses inferring `isAuto` from
 *     a NAME ("Rookie Autographs" in a parallel string), from a card-number
 *     prefix, or from a title. Those are inferences; this is a source field.
 *     CF-ISAUTO-BOUNDARY-IS-CARDNUMBER-NOT-TEXT still holds everywhere else.
 *
 * (c) A TIER IS NOT A PARALLEL. Where the variant names a registered tier key
 *     (#2231: concourse, club-level, premier-level, field-level), it is a
 *     SEPARATE PRODUCT, not a rung: `insert-base-club-level` is the Club Level
 *     product's base card. The caller gets `tierKey` and must key the row to
 *     that product rather than filing "Club Level" as a parallel of the
 *     flagship. Returned alongside, never instead of, so a caller that does
 *     not yet handle tiers is no worse off than today.
 *
 * -- WHAT IT DELIBERATELY DOES NOT DO ----------------------------------------
 *
 * It does not invent an insert ROOT by stripping a remainder. That was tried
 * and measured: `insert-prizm-gold` + parallel "Prizm Gold" leaves `prizm`,
 * and 2025 panini-prizm football lost 73 real base rungs (Prizm Gold, Prizm
 * Blue Wave, Prizm Choice Nebula) to an invented insert set called "Prizm".
 * A root is only ever taken from a category whose tail is NOT the row's own
 * parallel text, and the caller decides what to do with it.
 *
 * PURE. No fs, no Cosmos, no corpus read -- the tier list is passed in so the
 * ingester can supply the live registry and the builder its own copy.
 */
"use strict";

/**
 * The #2231 tier keys, as the SUFFIX they appear as in a category slug.
 * Passed in by the caller in production; this is the default so a caller that
 * has no registry still gets the right answer for the four registered today.
 */
const DEFAULT_TIER_SUFFIXES = Object.freeze([
  "concourse",
  "club-level",
  "premier-level",
  "field-level",
  // `premier` alone appears in some slugs; the registered key is
  // `panini-select-premier-level`, and both spellings mean that product.
  "premier",
  // MEASURED AND REPORTED FOR ACQUISITION (2026-09-18). 2024 panini-select
  // football carries `insert-base-suite-level` at #301-400 -- a real tier,
  // holding a DISJOINT number range from concourse (1-100) and club-level
  // (201-300), which is the proof it is a separate product rather than a
  // parallel. `panini-select-suite-level` is NOT in productSetKeys yet.
  //
  // It is listed here so the helper reports `tierKey: "suite-level"` rather
  // than filing "Suite Level" as a PARALLEL of the flagship -- the wrong of
  // the two available answers. Naming a tier the registry lacks is a
  // reporting decision, not a minted key: nothing downstream may build an
  // address from it until the key is registered, and the caller sees a
  // tierKey it cannot resolve rather than a plausible-looking rung.
  "suite-level",
]);

/**
 * Tiers this module names that productSetKeys does NOT yet register. A caller
 * building an address must refuse these rather than guess a key -- they are
 * an acquisition item, and this list is how the helper says so out loud.
 */
const UNREGISTERED_TIER_SUFFIXES = Object.freeze(["suite-level"]);

/** Slug -> the human spelling a parallel column would carry. */
function humanise(slug) {
  return String(slug || "")
    .split("-")
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /^(nfl|nba|mlb|nhl)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Normalise any text to a comparable slug. */
function slugify(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Read one `category` cell.
 *
 * @param {string} category      the CSV's column 0, e.g. `insert-base-hobby`
 * @param {string} parallelText  the CSV's column 2 for the SAME row; may be ""
 * @param {{tierSuffixes?: string[]}} [opts]
 * @returns {{
 *   kind: "base"|"insert"|"auto"|"unknown",
 *   parallel: string|null,   // the rung this row states, human-spelled
 *   tierKey: string|null,    // set when the variant names a registered tier
 *   isAuto: boolean,         // true ONLY when the source's own prefix says so
 *   insertRoot: string|null, // set only for a genuine insert set
 * }}
 */
function readChecklistCategory(category, parallelText, opts = {}) {
  const raw = String(category || "").trim().toLowerCase();
  const stated = String(parallelText || "").trim();
  const tiers = opts.tierSuffixes ?? DEFAULT_TIER_SUFFIXES;
  const none = { kind: "unknown", parallel: stated || null, tierKey: null, isAuto: false, insertRoot: null };
  if (!raw) return none;

  const dash = raw.indexOf("-");
  const prefix = dash < 0 ? raw : raw.slice(0, dash);
  const tail = dash < 0 ? "" : raw.slice(dash + 1);

  // --- (a) and (b): the BASE ladder, however it is labelled -----------------
  //
  // `base`, `base-<v>`, `insert-base`, `insert-base-<v>`, `auto-base`,
  // `auto-base-<v>`. The variant is the parallel; the prefix decides isAuto.
  const baseLike =
    prefix === "base" ? { variant: tail, isAuto: false }
      : (raw === "insert-base" || raw.startsWith("insert-base-"))
        ? { variant: raw.slice("insert-base".length).replace(/^-/, ""), isAuto: false }
        : (raw === "auto-base" || raw.startsWith("auto-base-"))
          ? { variant: raw.slice("auto-base".length).replace(/^-/, ""), isAuto: true }
          : null;

  if (baseLike) {
    const variant = baseLike.variant;
    // (c) A TIER IS A PRODUCT, NOT A RUNG. Longest match wins so
    // `club-level-black-and-blue-prizm-shock` resolves to `club-level` and
    // keeps the rest as the parallel.
    let tierKey = null, rungSlug = variant;
    for (const t of tiers) {
      if (variant === t || variant.startsWith(t + "-")) {
        if (!tierKey || t.length > tierKey.length) { tierKey = t; rungSlug = variant.slice(t.length).replace(/^-/, ""); }
      }
    }
    // THE ROW'S OWN PARALLEL TEXT WINS WHEN IT HAS ONE. Photogenic writes the
    // colour in BOTH places (`insert-base-black` + "Black"); Zenith writes it
    // only in the category. Preferring the stated text is what makes the two
    // shapes converge on one answer -- which is rule (c) of the dedupe: the
    // same card+parallel described twice becomes ONE row, not a refusal.
    const parallel = stated || (rungSlug ? humanise(rungSlug) : null);
    const tierSlug = tierKey ? slugify(tierKey) : null;
    return {
      kind: baseLike.isAuto ? "auto" : "base",
      parallel,
      tierKey: tierSlug,
      // A tier the registry does not carry. The caller must REFUSE to build
      // an address from it rather than guess a key -- see
      // UNREGISTERED_TIER_SUFFIXES.
      tierIsRegistered: tierSlug ? !UNREGISTERED_TIER_SUFFIXES.includes(tierSlug) : null,
      isAuto: baseLike.isAuto,
      insertRoot: null,
    };
  }

  // --- a genuine insert set -------------------------------------------------
  if (prefix === "insert") {
    // The root is the category tail. It is NOT derived by stripping the row's
    // parallel text out of it -- see the header for the measurement that
    // killed that idea. A caller wanting children keyed to this root matches
    // on the root itself.
    return { kind: "insert", parallel: stated || null, tierKey: null, isAuto: false, insertRoot: tail || null };
  }

  // --- a signed insert / subset --------------------------------------------
  if (prefix === "auto") {
    return { kind: "auto", parallel: stated || null, tierKey: null, isAuto: true, insertRoot: tail || null };
  }

  return none;
}

/**
 * The identity-bearing fields a row contributes, for a caller building ids.
 * Convenience over `readChecklistCategory`, so the ingester and the builder
 * cannot drift on how the answer is applied either.
 */
function identityFieldsFromCategory(category, parallelText, opts = {}) {
  const r = readChecklistCategory(category, parallelText, opts);
  return {
    parallel: r.parallel,
    isAuto: r.isAuto,
    tierKey: r.tierKey,
    isBaseCard: r.kind === "base" || r.kind === "auto",
  };
}

/**
 * THE INSERT SETS A PRODUCT'S CATEGORY COLUMN ATTESTS, when the parallel
 * column is blank (Drew, 2026-09-18).
 *
 * Some sources put the set name ONLY in the category and leave the parallel
 * column empty on the set's own cards:
 *
 *     insert-z-marquee,1,,,,Caleb Williams          <- the set's own card
 *     insert-z-marquee-blue,1,Blue,,25,Caleb W.     <- its Blue printing
 *
 * The BARE category is the root, taken whole -- no stripping, no remainder
 * arithmetic. A child is admitted only when a SIBLING category extends the
 * root by one segment AND that sibling carries its own attested parallel
 * text on some row. Both halves matter:
 *
 *   - taking the bare category avoids the defect that killed the strip rule
 *     (`insert-prizm-gold` + "Prizm Gold" left `prizm`, and 2025
 *     panini-prizm football lost 73 real base rungs to an invented insert
 *     set called "Prizm");
 *   - requiring the sibling to carry attested parallel text is what stops a
 *     multi-word root being mistaken for root+colour. `insert-color-guard`
 *     is one set, not `color` + guard.
 *
 * MEASURED on 2024 panini-zenith football: 49 blank-parallel insert
 * categories, of which 18 are bare roots with attested children (A to Z,
 * Behind the Numbers, Chalk Talk, Color Guard, Idols, Splash, Z Marquee...).
 *
 * Takes the product's OWN rows, so it cannot reach across products.
 *
 * @param {Array<{category: string, parallel: string}>} rows one product's rows
 * @returns {Array<{root: string, children: string[]}>}
 */
function insertSetsFromCategories(rows) {
  const byCat = new Map();
  for (const r of rows ?? []) {
    const cat = String(r?.category ?? "").trim().toLowerCase();
    if (!cat) continue;
    const read = readChecklistCategory(cat, r?.parallel);
    // Base-like categories are the ladder, never an insert set.
    if (read.kind !== "insert") continue;
    if (!byCat.has(cat)) byCat.set(cat, new Set());
    const stated = String(r?.parallel ?? "").trim();
    if (stated) byCat.get(cat).add(stated);
  }
  const out = [];
  for (const [cat, pars] of byCat) {
    // A bare ROOT states no parallel of its own.
    if (pars.size) continue;
    const children = [];
    for (const [other, otherPars] of byCat) {
      if (other === cat || !other.startsWith(cat + "-")) continue;
      // ...and the sibling must ATTEST its parallel in the parallel column.
      for (const p2 of otherPars) children.push(p2);
    }
    if (!children.length) continue;
    const root = humanise(cat.slice("insert-".length));
    out.push({ root, children: [...new Set(children.map((c) => `${root} ${c}`))].sort() });
  }
  return out.sort((a, b) => a.root.localeCompare(b.root));
}

/**
 * WHEN THE PARALLEL COLUMN CANNOT TELL SIBLINGS APART, THE CATEGORY TAIL CAN
 * (Drew, 2026-09-18).
 *
 * MEASURED on 2024 panini-zenith football. One insert set, three colours, and
 * a parallel column that does not distinguish them:
 *
 *   insert-...-variation-rps-preview-blue   #10  par="Variation"  /24
 *   insert-...-variation-rps-preview-red    #10  par="Variation"  /24
 *   insert-...-variation-rps-preview-green  #10  par=""           /24
 *
 * Blue #10 and red #10 mint the IDENTICAL id (25 such collisions). The colour
 * exists only in the category tail, and the column is actively misleading --
 * it says "Variation" for two of the three and nothing for the third.
 *
 * THE RULE IS NARROW AND EVERY CLAUSE IS LOAD-BEARING. A tail is promoted to
 * the parallel only when ALL of:
 *
 *   1. two or more sibling categories share a root (same text up to the last
 *      segment), so there is something to disambiguate at all;
 *   2. the parallel column FAILS to distinguish them -- every sibling's value
 *      is identical, or blank, or a mix of one value and blank. A column that
 *      already says Blue/Red/Green needs no help and is left alone;
 *   3. each differing tail is a word this product ATTESTS as a parallel
 *      somewhere else in its own file. `blue`/`red`/`green` qualify on Zenith
 *      (254/254/100 rows); an invented word would not.
 *
 * Clause 3 is what keeps this from being the strip rule that failed: nothing
 * is inferred from the SHAPE of the tail, only from the product's own
 * vocabulary. And when any clause fails the tail is left alone and the
 * caller refuses -- absent beats wrong, and a collision the ingester refuses
 * is visible, while a guessed colour is not.
 *
 * The promoted parallel KEEPS the column's own text when it had one: "Variation
 * Blue", not "Blue" -- the column said Variation and that is still true.
 *
 * @param {Array<{category: string, parallel: string}>} rows one product's rows
 * @returns {Map<string, string>} category -> the parallel it should state
 */
function disambiguateSiblingCategories(rows) {
  const valuesByCat = new Map();
  const attested = new Set();
  for (const r of rows ?? []) {
    const cat = String(r?.category ?? "").trim().toLowerCase();
    const par = String(r?.parallel ?? "").trim();
    if (par) attested.add(slugify(par));
    if (!cat) continue;
    if (!valuesByCat.has(cat)) valuesByCat.set(cat, new Set());
    valuesByCat.get(cat).add(par);
  }

  // Group categories by their root (everything up to the final segment).
  const byRoot = new Map();
  for (const cat of valuesByCat.keys()) {
    const i = cat.lastIndexOf("-");
    if (i <= 0) continue;
    const root = cat.slice(0, i);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(cat);
  }

  const out = new Map();
  for (const [root, cats] of byRoot) {
    if (cats.length < 2) continue;                      // (1)

    // BASE-LIKE CATEGORIES ARE NOT THIS FUNCTION'S BUSINESS.
    // `readChecklistCategory` already derives their parallel from the whole
    // variant (`insert-base-red-zone-blue` -> "Red Zone Blue"), which is
    // strictly better than the last segment alone ("Blue") -- it keeps the
    // Red Zone. Answering here too would give two answers for one row, which
    // is the drift this module exists to prevent.
    if (cats.some((c) => readChecklistCategory(c, "").kind !== "insert")) continue;

    // (2) does the column already distinguish them?
    const nonBlank = new Set();
    for (const c of cats) for (const v of valuesByCat.get(c)) if (v) nonBlank.add(v);
    if (nonBlank.size > 1) continue;                    // it does -- leave alone

    // (3) every differing tail must be an attested parallel word.
    const tails = cats.map((c) => c.slice(root.length + 1));
    if (tails.some((t) => !t || !attested.has(slugify(t)))) continue;

    const stated = [...nonBlank][0] ?? "";
    for (const c of cats) {
      const tail = humanise(c.slice(root.length + 1));
      out.set(c, stated ? `${stated} ${tail}` : tail);
    }
  }
  return out;
}

module.exports = {
  readChecklistCategory,
  identityFieldsFromCategory,
  insertSetsFromCategories,
  disambiguateSiblingCategories,
  DEFAULT_TIER_SUFFIXES,
  UNREGISTERED_TIER_SUFFIXES,
  humanise,
  slugify,
};
