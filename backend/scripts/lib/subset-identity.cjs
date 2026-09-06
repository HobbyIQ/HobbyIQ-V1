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
/**
 * CF-BASE-SET-IS-NOT-A-SUBSET (2026-09-06, run 34027488624), EXTENDED by
 * CF-INSERTS-IS-NOT-A-SUBSET-NAME (Drew ruling, 2026-09-06, run 34038740849).
 *
 * THE FIRST HALF. The 1957 Topps recheck read 417 checklist rows and wrote 9.
 * The other 407 were refused as "subset collisions" against incumbents whose
 * subsetName was the literal "Base Set" -- Mantle #95, Mays #10, Aaron #20,
 * every one the SAME card the checklist was bringing.
 *
 * THE SECOND HALF, and it is the same defect one heading over. #1893 found
 * eight 1998/1999 SP Authentic insert pages (Sheer Dominance, Sheer Dominance
 * Titanium, Home Run Chronicles, HRC Die Cuts, Epic Figures, Reflections,
 * 300th HR Redemption, Game Jersey 5x7) refused ENTIRELY -- read 42, wrote 0,
 * REFUSED 42 -- because their SD, HR, E and R card numbers are already
 * occupied by 56 + 130 baseballcardpedia rows carrying subsetName "Inserts".
 *
 * WHY BOTH LABELS ARE THE SAME KIND OF THING. Neither is a subset name. Both
 * are PAGE-SECTION HEADINGS that scrape-baseballcardpedia reads off the wiki
 * nav and turns into a category, and the heading text then rides along into
 * subsetName. The scraper's own classifier is where this is visible:
 *
 *     else if (/base\s*set/.test(joined)) category = "base";
 *     else if (/inserts?/.test(joined))   category = `insert-${slugify(leaf)}`;
 *
 * When a page gives each insert its own heading, `leaf` is that insert's real
 * name ("Sheer Dominance") and the subsetName is a genuine claim. When the
 * page lists cards directly under a bare "Inserts" section, `leaf` is the
 * literal word "Inserts" -- a statement that a section of the page holds
 * inserts, which is true of the section and says NOTHING about which insert
 * the card belongs to. "Base Set" asserts "this row IS the base set";
 * "Inserts" asserts "this row is one of the inserts on this page". Neither
 * names a subset, and comparing either against a checklist page that states
 * none concluded "two different cards" when both sides were saying the same
 * thing.
 *
 * THE ROWS THEMSELVES SAY SO. The 1998 SP Authentic "Inserts" population is 57
 * rows, and 13 of them are parse damage from that same undifferentiated
 * section: cardNumber "Gary" with playerName "Sheffield 5 X 7 JSY 125",
 * cardNumber "Gold" with playerName "(serial-numbered to 2000 copies)". A
 * heading that produces THAT is a section label the scraper could not resolve,
 * not a subset a checklist ever printed.
 *
 * A checklist page states NO subset, and blank means unknown. So the clash
 * test must compare the subset each side actually CLAIMS -- and a structural
 * section heading claims nothing.
 *
 * WHAT IS DELIBERATELY NOT IN THIS LIST. Only labels that name a STRUCTURAL
 * SECTION of a page: the base print, or the undifferentiated insert section.
 * A REAL named subset -- "Cards That Never Were", "Rookie Stars", "Row 2",
 * "Sheer Dominance", "Johnson Reprints" -- is a claim, still clashes against
 * unknown (#1741), and still disambiguates against another real subset (the
 * 2026-09-04 ruling). A guessed vocabulary here would silently merge two real
 * subsets onto one address, which is the exact harm #1741 was written for, so
 * the list stays small enough to read in one glance and every entry must be a
 * heading the bcp scraper can actually emit.
 */
const SECTION_HEADING_LABELS = new Set([
  // The base print of a product. `category: "base"`.
  "base",
  "base set",
  "base cards",
  "base card",
  "base set cards",
  "checklist",
  "checklist base set",
  // The undifferentiated insert section. `category: insert-${slugify(leaf)}`
  // where the leaf IS the section word, so the subsetName is the heading
  // itself rather than an insert's name. These are the scraper's sibling
  // spellings of one heading -- see the /inserts?/ branch above.
  "insert",
  "inserts",
  "insert sets",
  "insert set",
  "inserts and parallels",
]);

/**
 * Kept under its original name because it is the exported vocabulary #1878
 * pinned. The set now holds both structural families; the predicate below is
 * what callers ask.
 */
const BASE_SECTION_LABELS = SECTION_HEADING_LABELS;

/** Is this subsetName a structural PAGE-SECTION heading ("this row is in the
 *  base section" / "this row is in the inserts section") rather than a claim
 *  that the row belongs to one NAMED subset? */
function isBaseSectionLabel(subset) {
  return SECTION_HEADING_LABELS.has(foldSubsetText(subset));
}

/**
 * The subset a row actually CLAIMS, for clash purposes: its subsetName unless
 * that is a structural page-section label, in which case it claims none.
 * Returns "" for "no subset claimed".
 */
function claimedSubsetOf(subset) {
  const raw = String(subset === null || subset === undefined ? "" : subset).trim();
  if (!raw) return "";
  return isBaseSectionLabel(raw) ? "" : raw;
}

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
  BASE_SECTION_LABELS, SECTION_HEADING_LABELS, isBaseSectionLabel, claimedSubsetOf,
};
