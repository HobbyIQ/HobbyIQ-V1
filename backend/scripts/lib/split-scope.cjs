/**
 * split-scope.cjs -- the `split` census scope (report-only), #2137 follow-on.
 *
 * DREW'S RULING, 2026-09-13: "report first, rule later" on split-identity
 * repair. The census (rematch-sold-comps.cjs, lib/split-identity.cjs) already
 * flags every HIQ-SPLIT row -- a stored `cardId` and `hobbyiqCardId` that name
 * two DIFFERENT hiq: cards, so the exact pool reader (which ORs the two
 * fields) reads one sale into both pools. What it does not do is say what
 * should happen to any of them, and that is deliberate: one card, one row,
 * one pool means a repoint moves a row to the CHECKLIST-BACKED side, and only
 * when the listing TITLE actually names that destination's differing
 * segment(s) -- never by the identity field alone (memory:
 * project_split_identity_pool_rows -- PARK lists, never repoint by
 * hobbyiqCardId alone).
 *
 * THIS MODULE ANSWERS ONE QUESTION PER HIQ-SPLIT ROW: given the row's two
 * slugs and its title, would a (future, human-gated) repair MOVE the row to
 * one side, or PARK it (leave it exactly as split, reported)? It is pure --
 * no I/O, no Cosmos, no clock -- exactly like split-identity.cjs beside it, so
 * the census, a unit test and a future apply-gate driver all decide the same
 * way from the same three facts.
 *
 * split-move  = exactly ONE side is checklist-backed AND the title names that
 *               side's differing segment(s) (the product name for a setKey
 *               split, the print-run token for printRun, the parallel words
 *               for parallel, the literal number for cardNumber, the sport
 *               word for sport).
 * split-park  = neither side is checklist-backed, or BOTH are, the title
 *               does not name the destination, or the title names MORE than
 *               the destination does (R55). Every one of those is a reason to
 *               leave the row where it is and report it -- picking a side
 *               without title evidence is exactly the guess PARK lists exist
 *               to refuse.
 *
 * R55 -- THE TITLE MAY NOT NAME MORE THAN THE DESTINATION (Drew, 2026-09-15).
 *
 * The move rule above asks only whether the title names what the destination
 * HAS. It never asked whether the title names something the destination LACKS,
 * and on the slot-3 census that is a live defect: the destination identity
 * says `Base` while the title states a parallel or an insert.
 *
 *   "Jahmyr Gibbs 2024 Prestige Heroes Holo Foil #3"
 *        -> football:2024:panini-prestige:3:Base:no-auto
 *   "2025-26 SP Authentic Acetate Retro Future Watch ... #226 SSP"
 *        -> hockey:2025:sp-authentic:226:Base:no-auto
 *   "Nikita Zadorov Retro 2025-26 O-Pee-Chee #351"
 *        -> hockey:2025:o-pee-chee:351:Base:no-auto
 *
 * Each is a real card the destination slug does not name: Heroes is an insert,
 * Acetate Retro Future Watch SSP is a distinct card, Retro is its own O-Pee-Chee
 * printing. Moving the sale onto the plain Base slug files it on a card it is
 * not -- worse than leaving it split, because the split is at least visible.
 * So the judge parks with `split-scope-parks:title-names-more-than-destination`
 * and the row becomes insert/R38 work rather than a repoint.
 *
 * A FILL IS STILL A MOVE. The ruling is about the title naming MORE than the
 * destination, not about a destination that is gaining something. When the
 * stated rung IS the destination's own parallel -- "Press Proof Silver /100"
 * onto `...:113:Press Proof Silver:no-auto:/100` -- nothing is unaccounted
 * for and the move stands, as do printRun fills.
 *
 * CHECKLIST-BACKEDNESS, OFFLINE. There is no Cosmos read available to this
 * module (nor to the fleet's own MODE=census pass, which is deliberately
 * catalog-read-light on the hot path). What is used instead is an INFERENCE
 * from the identity's own shape: a side is treated as checklist-backed when
 * its setKey is a registered product spelling (a `normalizeSetKey` FIXED
 * POINT -- the same standard `isProductSetKey`/`DISTINCT_PRODUCT_SETKEYS`
 * apply elsewhere in this rematch) and its card number is well-formed. This
 * is a PROXY, stated plainly: a real apply-gate run measures checklist
 * backing exactly, against card_catalog, the same way `checklistBacked()`
 * does for every other class in rematch-sold-comps.cjs. The `isRegisteredSetKey`
 * hook below exists so that exact measurement can be substituted without
 * touching the move/park logic -- the caller with a live catalog need only
 * pass its own predicate.
 */
"use strict";

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const lower = (v) => str(v).toLowerCase();

/** hiq: slug grammar, matching lib/split-identity.cjs's SEGMENTS exactly:
 *  hiq:sport:cardYear:setKey:cardNumber:parallel:auto[:printRun][:grade] */
const SEGMENTS = ["sport", "cardYear", "setKey", "cardNumber", "parallel", "auto", "printRun", "grade"];
const AXES_THIS_SCOPE_JUDGES = ["setKey", "printRun", "parallel", "cardNumber", "sport"];

const isHiq = (v) => lower(v).startsWith("hiq:");

/** A parallel that means "the writer could not read one" -- a MIRROR of
 *  GENERIC_PARALLELS in scripts/lib/rematch-classify.cjs, duplicated here only
 *  because this module is pure and must not require the classifier (which
 *  loads the corroboration rule and therefore a built dist/).
 *  `splitScopeMirrorsGenericParallels` in the test file asserts the two stay
 *  identical, so they cannot drift: add a spelling there first. */
const GENERIC_PARALLELS = new Set(["", "base", "[base]", "none", "unknown"]);

/**
 * Parse an hiq: slug into its named segments. Returns null for anything that
 * is not the hiq: shape -- callers must not guess at a vendor id's segments.
 */
function parseHiqSlug(slug) {
  const s = str(slug);
  if (!isHiq(s)) return null;
  const parts = s.split(":");
  if (parts.length < 7) return null;
  const out = {};
  // parts[0] is the literal "hiq" tag, so segment i lives at parts[i + 1].
  for (let i = 0; i < SEGMENTS.length; i++) out[SEGMENTS[i]] = parts[i + 2] !== undefined ? parts[i + 1] : (parts[i + 1] ?? null);
  // printRun/grade are OPTIONAL trailing segments (see split-identity.cjs's
  // own differingSegments comment: an absent trailing segment is read as a
  // real disagreement, never as "matches anything"), so re-derive them
  // positionally rather than assuming every slug carries all 8.
  out.sport = parts[1] ?? "";
  out.cardYear = parts[2] ?? "";
  out.setKey = lower(parts[3] ?? "");
  out.cardNumber = parts[4] ?? "";
  out.parallel = lower(parts[5] ?? "");
  out.auto = lower(parts[6] ?? "");
  out.printRun = parts[7] ?? null;
  out.grade = parts[8] ?? null;
  return out;
}

/**
 * A well-formed card number: non-empty, and not itself a placeholder the
 * census already treats as blank (see rematch-classify.cjs's GENERIC_*
 * tables -- mirrored narrowly here rather than imported, to keep this module
 * leaf-pure). A card number of "0", "" or "unknown" cannot be checklist-backed
 * whatever its setKey says.
 */
const BLANK_CARD_NUMBERS = new Set(["", "unknown", "none", "n-a", "na"]);
function cardNumberIsWellFormed(cardNumber) {
  const v = lower(cardNumber).replace(/\s+/g, "");
  if (BLANK_CARD_NUMBERS.has(v)) return false;
  return /^[a-z0-9-]+$/.test(v) && /[0-9]/.test(v);
}

/**
 * THE DEFAULT "IS THIS A REGISTERED PRODUCT" PROXY.
 *
 * Deliberately NOT the generic-setkey blank test alone (`unknown`/`""` are
 * already refused above the call site by differingSegments requiring a real
 * disagreement) -- this asks the STRONGER question, "does this look like a
 * real, specific product spelling and not a bare, undifferentiated fallback".
 * A setKey is treated as backed when:
 *   - it is not one of the generic/unknown markers, AND
 *   - it is not a single bare word with no hyphenation UNLESS that bare word
 *     is a well-known flagship spelling (topps, bowman, panini-donruss-style
 *     flagships collapse to their own single word for some sports) -- so the
 *     proxy is conservative in the direction of NOT calling a vague key
 *     "backed", because an offline over-count of `split-move` is exactly the
 *     mistake report-first exists to prevent.
 *
 * This is intentionally simple. It is a REPORT-TIME estimate, and the report
 * this module feeds says so on every axis: "the fleet run will measure this
 * exactly against card_catalog." Callers with a live catalog (a future
 * apply-gate driver) pass their own `isRegisteredSetKey` and this default is
 * never consulted.
 */
const GENERIC_SETKEYS = new Set(["", "unknown", "none", "unspecified", "base-set"]);
const KNOWN_BARE_FLAGSHIPS = new Set([
  "topps", "bowman", "panini-donruss", "panini-prizm", "panini-optic",
  "panini-mosaic", "panini-select", "panini-score", "finest", "fleer",
  "score", "upper-deck", "donruss", "leaf", "stadium-club", "pacific",
  "pinnacle", "skybox", "ultra", "hoops", "nba-hoops", "topps-chrome",
  "bowman-chrome", "topps-heritage", "panini-contenders", "contenders",
]);
function defaultIsRegisteredSetKey(setKey) {
  const k = lower(setKey);
  if (GENERIC_SETKEYS.has(k)) return false;
  if (k.includes("-")) return true; // a hyphenated, specific spelling
  return KNOWN_BARE_FLAGSHIPS.has(k);
}

/** Is this SIDE checklist-backed, under the given setKey predicate? */
function sideIsChecklistBacked(side, isRegisteredSetKey) {
  if (!side) return false;
  return isRegisteredSetKey(side.setKey) && cardNumberIsWellFormed(side.cardNumber);
}

// ── PER-AXIS "DOES THE TITLE NAME THE DESTINATION" TESTS ───────────────────
//
// Each mirrors the house style in rematch-classify.cjs (titleEchoesSlugParallel,
// titleStatesCardNumber): word-boundary, whole-significant-word matching, never
// a substring or fuzzy score, because a coincidental token match is exactly
// the false "the title said so" that would license a wrong repoint.

function titleWords(title) {
  return lower(title).normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/).filter(Boolean);
}

/** setKey -> the phrase(s) a title would use to name it. Hyphens become
 *  spaces ("donruss-elite" -> "donruss elite"); every significant word (3+
 *  chars) must appear in the title, same discipline as titleEchoesSlugParallel. */
function titleNamesSetKey(title, setKey) {
  const words = lower(setKey).split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  if (!words.length) return false;
  const hay = new Set(titleWords(title));
  return words.every((w) => hay.has(w));
}

/** parallel -> every significant word (3+ chars, never "base") in the title. */
function titleNamesParallel(title, parallel) {
  const seg = lower(parallel);
  if (!seg || seg === "base" || seg === "[base]" || seg === "none") return false;
  const words = seg.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && w !== "base");
  if (!words.length) return false;
  const hay = new Set(titleWords(title));
  return words.every((w) => hay.has(w));
}

/** printRun -> the title states the SAME serial number, in any of the
 *  `/N`, `#/N`, `N/N` spellings the corpus uses. */
function titleNamesPrintRun(title, printRun) {
  const n = String(printRun ?? "").replace(/\D/g, "");
  if (!n) return false;
  const t = str(title);
  const re = new RegExp(`(?:^|[^0-9])/\\s*0*${n}(?:[^0-9]|$)`);
  return re.test(t);
}

/** cardNumber -> the title states the literal number, `#`-prefixed (the same
 *  boundary titleStatesCardNumber uses -- a bare number anywhere in a title
 *  is not a card-number witness, a `#`-prefixed one is). */
function titleNamesCardNumber(title, cardNumber) {
  const n = lower(cardNumber).replace(/\s+/g, "");
  if (!n) return false;
  const t = lower(title);
  const re = new RegExp(`#\\s*0*${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`);
  return re.test(t);
}

/** sport -> the title names the sport word or a well-known synonym/league. */
const SPORT_SYNONYMS = {
  football: ["football", "nfl", "cfb", "ncaaf"],
  basketball: ["basketball", "nba", "wnba", "ncaab"],
  baseball: ["baseball", "mlb", "milb"],
  hockey: ["hockey", "nhl"],
  soccer: ["soccer", "futbol", "fifa", "uefa", "mls"],
  wrestling: ["wrestling", "wwe", "aew"],
  golf: ["golf", "pga"],
  racing: ["racing", "nascar", "f1"],
  pokemon: ["pokemon", "pokémon"],
};
function titleNamesSport(title, sport) {
  const s = lower(sport);
  const words = new Set(titleWords(title));
  const syns = SPORT_SYNONYMS[s] ?? [s];
  return syns.some((w) => words.has(w));
}

const AXIS_TITLE_TESTS = {
  setKey: titleNamesSetKey,
  parallel: titleNamesParallel,
  printRun: titleNamesPrintRun,
  cardNumber: titleNamesCardNumber,
  sport: titleNamesSport,
};

/**
 * Does the title name the DESTINATION side's value for every differing axis
 * this scope judges? A split can carry axes this scope does not adjudicate
 * (auto, cardYear, grade -- see AXES_THIS_SCOPE_JUDGES) -- those are ignored
 * here, not treated as un-named, because the ruling names five specific
 * segments and no others.
 */
function titleNamesDestinationForAxes(title, destSide, judgedAxes) {
  const named = [];
  const unnamed = [];
  for (const axis of judgedAxes) {
    const test = AXIS_TITLE_TESTS[axis];
    const value = destSide?.[axis];
    if (test && test(title, value)) named.push(axis); else unnamed.push(axis);
  }
  return { allNamed: unnamed.length === 0, named, unnamed };
}

/**
 * Classify ONE HIQ-SPLIT row for the `split` scope.
 *
 * `row` is `{ cardId, hobbyiqCardId, title }`. `segments` is the differing-
 * segment list lib/split-identity.cjs's `classifyIdentity` already computed
 * for this row (so this module never re-derives the split itself -- it only
 * judges what to DO about one). `isRegisteredSetKey` is the injectable
 * checklist-backed predicate described above.
 *
 * Returns:
 *   { verdict: "split-move" | "split-park", judgedAxes, destination,
 *     backed: { cardId: bool, hobbyiqCardId: bool },
 *     titleNamed, titleUnnamed, reason }
 *
 * `destination` is `"cardId" | "hobbyiqCardId" | null` -- which field's side
 * the row would move TO. Null for every split-park verdict: a park has no
 * destination by definition, and a caller that read one off a park result
 * would be exactly the un-evidenced repoint the ruling refuses.
 */
function classifySplitScope({ cardId, hobbyiqCardId, title }, segments, opts = {}) {
  const isRegisteredSetKey = opts.isRegisteredSetKey ?? defaultIsRegisteredSetKey;
  const judgedAxes = (segments ?? []).filter((s) => AXES_THIS_SCOPE_JUDGES.includes(s));

  const a = parseHiqSlug(cardId);
  const b = parseHiqSlug(hobbyiqCardId);
  const backedA = sideIsChecklistBacked(a, isRegisteredSetKey);
  const backedB = sideIsChecklistBacked(b, isRegisteredSetKey);
  const backed = { cardId: backedA, hobbyiqCardId: backedB };

  // No judged axis at all (the split is entirely on auto/cardYear/grade) --
  // this scope has nothing to say about it. Park, reported as out-of-scope.
  if (!judgedAxes.length) {
    return {
      verdict: "split-park", judgedAxes, destination: null, backed,
      titleNamed: [], titleUnnamed: [],
      reason: "no-judged-axis:split-differs-only-on-auto-cardYear-or-grade",
    };
  }

  // Either side unparseable (should not happen for a row classifyIdentity
  // already called HIQ-SPLIT, both being hiq: slugs by definition -- guarded
  // anyway, because a caller could hand this module a row directly).
  if (!a || !b) {
    return {
      verdict: "split-park", judgedAxes, destination: null, backed,
      titleNamed: [], titleUnnamed: [],
      reason: "unparseable-slug",
    };
  }

  // BOTH backed, or NEITHER backed: no single side is the checklist's answer,
  // so there is no destination to move to. Park.
  if (backedA === backedB) {
    return {
      verdict: "split-park", judgedAxes, destination: null, backed,
      titleNamed: [], titleUnnamed: [],
      reason: backedA ? "both-sides-checklist-backed" : "neither-side-checklist-backed",
    };
  }

  const destField = backedA ? "cardId" : "hobbyiqCardId";
  const destSide = backedA ? a : b;
  const { allNamed, named, unnamed } = titleNamesDestinationForAxes(title, destSide, judgedAxes);

  if (!allNamed) {
    return {
      verdict: "split-park", judgedAxes, destination: null, backed,
      titleNamed: named, titleUnnamed: unnamed,
      reason: `title-does-not-name-destination:${unnamed.join(",")}`,
    };
  }

  // R55 -- THE TITLE MAY NOT NAME MORE THAN THE DESTINATION DOES.
  //
  // Asked LAST, so it narrows a move the rules above already approved and can
  // never create one. See the header for the ruling and its three measured
  // rows.
  //
  // THE DETECTOR IS INJECTED, NOT REIMPLEMENTED. This module is pure by
  // contract, and "does the title state a finish this identity does not
  // account for" is a question the parser already answers --
  // `parseListingIdentity(...).parallelIsUnconfirmed`, the flag
  // CF-A-STATED-PARALLEL-IS-NEVER-EVICTED-TO-BASE added for exactly this
  // shape: the title states finish evidence and the derivation could not turn
  // it into a rung. A second regex here would be a second opinion about what a
  // title says, and the two would drift. So the caller supplies the answer the
  // same way it supplies `isRegisteredSetKey`.
  //
  // ONLY WHERE THE DESTINATION SAYS `Base`. A destination that already names a
  // rung has accounted for the title's finish words -- that is the Press Proof
  // Silver case, which stays a move. `Base` is the claim that the card has no
  // parallel, and it is the only claim a stated finish can contradict.
  //
  // UNASKED IS NOT GUILTY. `titleStatesUnaccountedFinish` defaults to a
  // function returning null, and null leaves the move standing -- a caller
  // that cannot ask keeps today's behaviour rather than parking everything.
  const destParallel = lower(destSide.parallel);
  if (GENERIC_PARALLELS.has(destParallel)) {
    const statesMore = (opts.titleStatesUnaccountedFinish ?? (() => null))(title, destSide);
    if (statesMore === true) {
      return {
        verdict: "split-park", judgedAxes, destination: null, backed,
        titleNamed: named, titleUnnamed: unnamed,
        reason: "split-scope-parks:title-names-more-than-destination",
      };
    }
  }

  return {
    verdict: "split-move", judgedAxes, destination: destField, backed,
    titleNamed: named, titleUnnamed: unnamed,
    reason: `title-names-destination:${destField}:${named.join(",")}`,
  };
}

module.exports = {
  SEGMENTS, AXES_THIS_SCOPE_JUDGES, GENERIC_PARALLELS,
  parseHiqSlug, cardNumberIsWellFormed,
  defaultIsRegisteredSetKey, sideIsChecklistBacked,
  titleNamesSetKey, titleNamesParallel, titleNamesPrintRun, titleNamesCardNumber, titleNamesSport,
  titleNamesDestinationForAxes,
  classifySplitScope,
};
