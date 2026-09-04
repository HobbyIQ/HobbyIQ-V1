/**
 * CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE (Drew ruling,
 * 2026-09-04) -- the rematch's half of the rule.
 *
 * Mirrors backend/src/services/catalog/subsetIdentity.ts, for the same reason
 * lib/split-identity.cjs exists: this module is pure and must not require
 * dist/, so the census, the classifier and the invariant auditor can all
 * decide identically without a build step. The pin
 * (backend/tests/subsetIdentity.test.ts) drives BOTH copies over the same
 * table, so a change to one that is not made to the other goes red.
 *
 * THE RULE
 *
 *   A sale title that NAMES one of the clashing subsets derives that subset's
 *   id. A title that does not name one derives the PLAIN id and is classified
 *   UNDERIVABLE-for-subset -- report-only, never moved, never guessed.
 *
 * WHY THE REFUSAL IS THE POINT. #1741 measured the market's own answer for the
 * motivating case: all three sold_comps rows carrying "Johnson Reprints" spell
 * the card #2 or #7, and the rest of the pool does not name a subset at all.
 * Most sales genuinely cannot be assigned. Picking the bigger subset would
 * file a card into a pool it may not belong to -- the exact harm the ruling
 * exists to prevent -- so an unassigned row stays where it is and is reported.
 */

const UNDERIVABLE_FOR_SUBSET = "UNDERIVABLE-for-subset";

/** Lowercase, punctuation to single spaces. Digits survive, so "Series 1" and
 *  "Series 2" stay different subsets. */
function foldSubsetText(raw) {
  return String(raw === null || raw === undefined ? "" : raw)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Whole-phrase, word-boundary match in the folded form. Deliberately not a
 *  token overlap or a fuzzy score: subset names like "Base Set" and "Promos"
 *  share tokens with half the corpus, and a partial match would assign cards
 *  by coincidence. */
function titleNamesSubset(title, subset) {
  const t = foldSubsetText(title);
  const s = foldSubsetText(subset);
  if (!t || !s) return false;
  return (" " + t + " ").indexOf(" " + s + " ") !== -1;
}

/**
 * Resolve a title against the subsets sharing one clashing rung.
 * `candidates` are the catalog's own subsetNames for that rung -- the clash is
 * a fact about one product, so it is never a vocabulary this module carries.
 *
 * -> { outcome: "named" | "unnamed" | "ambiguous", subsetName, matched }
 */
function resolveSubsetFromTitle(title, candidates) {
  const seen = new Set();
  const clean = [];
  for (const c of candidates || []) {
    const s = String(c === null || c === undefined ? "" : c).trim();
    // Blank means unknown. An unknown subset is never a candidate, and never
    // the answer when nothing else matches.
    if (!s) continue;
    const k = foldSubsetText(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    clean.push(s);
  }
  const matched = clean.filter((c) => titleNamesSubset(title, c));
  if (matched.length === 1) return { outcome: "named", subsetName: matched[0], matched };
  if (matched.length > 1) return { outcome: "ambiguous", subsetName: null, matched };
  return { outcome: "unnamed", subsetName: null, matched };
}

/**
 * The classifier's entry point. `clashSubsets` is what the catalog says lives
 * at this row's rung: empty (the overwhelming majority of rows) means there is
 * no clash and this rule has NOTHING to say -- `applies` is false and the
 * caller's normal classification stands untouched.
 *
 * With two or more, the rule engages:
 *   named      -> the title settles it; `subsetName` is the answer.
 *   otherwise  -> UNDERIVABLE-for-subset, writable: false.
 */
function subsetVerdict(title, clashSubsets) {
  const distinct = [];
  const seen = new Set();
  for (const c of clashSubsets || []) {
    const s = String(c === null || c === undefined ? "" : c).trim();
    if (!s) continue;
    const k = foldSubsetText(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    distinct.push(s);
  }
  if (distinct.length < 2) {
    return { applies: false, klass: null, subsetName: null, reasons: [], writable: null };
  }
  const m = resolveSubsetFromTitle(title, distinct);
  if (m.outcome === "named") {
    return {
      applies: true, klass: null, subsetName: m.subsetName, writable: null,
      reasons: ["subset-named-by-title:" + foldSubsetText(m.subsetName).replace(/ /g, "-")],
    };
  }
  return {
    applies: true, klass: UNDERIVABLE_FOR_SUBSET, subsetName: null, writable: false,
    reasons: [
      "subset-" + m.outcome + ":" + distinct.length + "-candidates",
      ...(m.outcome === "ambiguous" ? ["subset-ambiguous-matches:" + m.matched.length] : []),
    ],
  };
}

/**
 * THE RUNG KEY -- the whole identity MINUS the subset, in one canonical
 * spelling so a catalog row and a sold_comps row land on the same key.
 *
 * It has to live here, and be used by BOTH sides, because the two sources
 * spell the parallel differently: card_catalog stores `parallelSlug`
 * ("refractor") while a sold_comps row stores the vendor's `parallel`
 * ("Refractor"). A caller that built its key from whichever field it happened
 * to have would miss every clash -- silently, and looking perfectly healthy,
 * which is the failure mode this whole ruling exists to end.
 *
 * printRun is part of the key because it is part of the identity: a /25 and an
 * unnumbered card of the same rung are different cards and cannot clash.
 */
function rungKey(o) {
  const num = String((o && o.cardNumber) || "").trim().toUpperCase();
  // The parallel in EITHER spelling, folded to one. Blank parallel is "base"
  // exactly as the slug generator reads it.
  const parRaw = (o && (o.parallelSlug || o.parallel)) || "";
  const par = foldSubsetText(parRaw).replace(/ /g, "-") || "base";
  const auto = (o && o.isAuto) === true ? 1 : 0;
  const run = o && o.printRun !== null && o.printRun !== undefined && o.printRun !== "" ? String(o.printRun) : "";
  return num + "|" + par + "|" + auto + "|" + run;
}

module.exports = {
  UNDERIVABLE_FOR_SUBSET,
  foldSubsetText,
  titleNamesSubset,
  resolveSubsetFromTitle,
  subsetVerdict,
  rungKey,
};
