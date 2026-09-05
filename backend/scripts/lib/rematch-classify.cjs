/**
 * rematch-classify.cjs -- the GREAT REMATCH classifier. Pure: no I/O, no
 * Cosmos, no clock. Everything the census decides about ONE row lives here so
 * a unit test can drive it directly and the fleet script is only paging + I/O.
 *
 * CF-A-REMATCH-IS-A-DIFF-BEFORE-IT-IS-A-WRITE (GREAT REMATCH, Drew 2026-09-01).
 * The pool holds 16,336,293 rows keyed by parsers of many vintages. The census
 * re-derives each row's identity from its OWN title and stored raw fields
 * through today's parser + catalog-first matcher, and diffs the result against
 * the key the row actually carries. It writes nothing. The apply pass acts on
 * exactly ONE of the four classes, and re-checks the class at write time.
 *
 * THE FOUR CLASSES
 *
 *   AGREE        the re-derived identity IS the stored key. Nothing to do, and
 *                the overwhelming majority by design.
 *   IMPROVE      the re-derived identity is STRICTLY MORE SPECIFIC than the
 *                stored one AND checklist-backed. This is the only class that
 *                may ever be written, and only under the gates below.
 *   CONFLICT     the re-derived identity is DIFFERENT but not more specific --
 *                a different card, a different product, a lateral move, or a
 *                demotion. REPORT ONLY FOREVER. These go to Drew.
 *   UNDERIVABLE  the title yields no identity that passes the slug guard. The
 *                row is left exactly as it is. Absent beats wrong.
 *
 * WHY "STRICTLY MORE SPECIFIC" IS NOT "DIFFERENT"
 *
 * The only-improve doctrine (a re-key happens only when the new identity is
 * strictly more specific and checklist-backed; ties and regressions never
 * write) is what keeps a rematch from being a churn. Specificity here is not a
 * string comparison and not a confidence score -- it is a per-axis test:
 *
 *   - every axis the STORED key names, the derived key must name IDENTICALLY.
 *     A stored `refractor` that re-derives to `base` is a DEMOTION, not an
 *     improvement, however confident the parser is.
 *   - at least one axis the stored key leaves BLANK or generic, the derived
 *     key must fill. Blank means unknown -- filling an unknown is the whole
 *     point; overwriting a known is the thing we refuse.
 *
 * `base` and a missing print run are the two generic values that count as
 * "blank" for this test, because that is exactly what the pool's older writers
 * emitted when they could not read the title. `Base` as a CHECKLIST-DEFINED
 * parallel is a different thing and is protected by the checklist-backed gate:
 * a derived parallel is only allowed to displace a stored `base` when the
 * checklist actually lists that parallel for that card.
 *
 * CHECKLIST-BACKED IS NOT OPTIONAL
 *
 * A match proves nothing unless checklist-backed -- match rate is
 * self-confirming, so "the matcher matched it" is not evidence. The caller
 * supplies a `checklistBacked` verdict per derived identity (a catalog row
 * whose source is a checklist ingest, not a vendor row). Without it the class
 * is CONFLICT, never IMPROVE, no matter how much more specific the derivation.
 *
 * PROVENANCE IS A SEPARATE AXIS FROM CLASS
 *
 * A row can be IMPROVE-shaped and still be untouchable. Provenance tier is
 * computed independently and REPORT-ONLY rows never write, so the guard cannot
 * be bypassed by a classification that happens to look clean:
 *
 *   PROTECTED  source ebay-user-purchase / ebay-user-sale / ebay-account /
 *              manual-user-entry (a real person's own transaction), any row
 *              carrying a Drew ruling or a hand/D31 relocation marker, and any
 *              row flagged verifiedByUser. 160 user-sourced rows, 53 D19
 *              relocations and 800 verified rows measured 2026-09-01.
 *   AUTO       everything else -- the vendor ingests (cardhedge, tca-ebay,
 *              cardsight) that make up 16.3M of the pool.
 *
 * GRADE IS PART OF THE IDENTITY, NOT A SEPARATE FIELD
 *
 * Grade lives in the row's fields AND in the child slug (`...:psa-9`). A
 * re-derivation must carry the stored grade forward: a title that states no
 * grade does not make a stored PSA 9 row raw. Dropping the grade child is a
 * demotion and classifies CONFLICT.
 *
 * THE ONE CONFLICT SUBCLASS THAT MAY WRITE: BASE-EVICTION
 *
 * CF-A-SLUG-IS-NOT-EVIDENCE-AGAINST-THE-ROW (Drew 2026-09-02). CONFLICT is
 * report-only as a CLASS, and stays so. But one shape inside it is not two
 * rival readings of a card at all -- it is a row that was FILED on a parallel
 * slug that nothing about the row itself supports:
 *
 *   the row sits on a slug carrying a finish child   (`...:refractor:...`)
 *   its OWN stored parallel field says Base or blank (it names no parallel)
 *   its TITLE names no finish either                 (nothing to read one from)
 *   and a checklist-backed BASE destination exists   (the card is real)
 *
 * Three independent fields, and they agree: the row is a base card wearing a
 * parallel's slug. The slug is the ONLY thing claiming a finish, and a slug is
 * an artifact of whichever writer keyed the row -- it is not evidence about
 * the card. The demotion rule exists to stop a terse title flattening a
 * KNOWN parallel; here nothing is known to flatten.
 *
 * WHY THIS IS NOT THE GONZALEZ DEMOTION IT LOOKS LIKE
 *
 * The two shapes are one field apart, and that field decides:
 *
 *   DEMOTION (CONFLICT forever)  stored.parallel = "Refractor" -- the row's own
 *                                field NAMES the parallel. A terse title never
 *                                displaces it. This is the existing pin.
 *   BASE-EVICTION (may write)    stored.parallel = "Base"/blank -- the row's own
 *                                field names NOTHING. Only the slug disagrees.
 *
 * So `parallel` must be blank/generic on the STORED side for the subclass to
 * apply, and that is asserted, not assumed: a stored parallel that names a real
 * finish takes the row out of the subclass no matter what the slug says.
 *
 * THE RESIDUAL RISK IS NAMED, AND IT IS THE AUDIT'S JOB
 *
 * A seller who lists a genuine refractor and omits the word produces exactly
 * this shape, and no field on the row can tell that apart from a mis-filing.
 * The subclass does not pretend otherwise. It is authorized for AUDITED
 * auto-apply on the same trust ladder as IMPROVE -- a per-shard 500-row audit
 * plus rematch-canary-check before that shard's apply -- and the audit is what
 * catches the seller who omitted the word. Protected tier is exempt as always.
 */
"use strict";

const path = require("path");
const SPLIT = require(path.join(__dirname, "split-identity.cjs"));
const SUBSET = require(path.join(__dirname, "subset-identity.cjs"));
const VOCAB = require(path.join(__dirname, "rematch-finish-vocab.cjs"));

// ── the classes ────────────────────────────────────────────────────────────
const AGREE = "AGREE", IMPROVE = "IMPROVE", CONFLICT = "CONFLICT", UNDERIVABLE = "UNDERIVABLE";
// CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE (Drew, 2026-09-04).
// A row sitting on a PLAIN id whose rung the catalog says is shared by two or
// more subsets, and whose title names none of them. Report-only forever: there
// is no more-specific reading to write, only a question for Drew.
const UNDERIVABLE_FOR_SUBSET = SUBSET.UNDERIVABLE_FOR_SUBSET;
const PROTECTED = "PROTECTED", AUTO = "AUTO";
/** The one CONFLICT subclass authorized for audited auto-apply (Drew 2026-09-02). */
const BASE_EVICTION = "BASE-EVICTION";
/**
 * NOT A CLASSIFICATION -- AN APPLY SCOPE (2026-09-04).
 *
 * REVERT-EVICTION never comes back from `classifyRow`; no row is ever "of" it.
 * It is the name of a PASS the apply can be scoped to, and it lives beside the
 * two real classes because the `scope` input is the one place a dispatcher
 * says what a run is allowed to do, and a run that undoes writes has to be
 * asked for by name exactly as a run that makes them does.
 *
 * Kept OUT of APPLY_CLASSES on purpose: `applyKindOf` and `writableUnderScope`
 * decide whether a CLASSIFIED row may be written, and a revert has no
 * classified row -- it has a marker and a recorded origin slug. Mixing it into
 * that machinery would let a scope=revert-eviction dispatch arm the ordinary
 * write path, which is the one thing this name must never do.
 */
const REVERT_EVICTION = "REVERT-EVICTION";
/** REPORT-ONLY subclass (Drew 2026-09-03). A pool holding rows whose titles
 *  name DIFFERENT members of one colour family -- Green vs Green Refractor vs
 *  Green Wave. Never writable; see FINISH_FAMILY_COLLISION below. */
const FINISH_FAMILY_COLLISION = "FINISH-FAMILY-COLLISION";

/** Sources that are a real person's own record of their own transaction.
 *  These are never re-keyed by a fleet, only by Drew. */
const PROTECTED_SOURCES = new Set(["ebay-user-purchase", "ebay-user-sale", "ebay-account", "manual-user-entry"]);

/** Markers a row carries when a human or a D31/D19 relocation placed it. */
const PROTECTED_MARKER_FIELDS = ["drewRuling", "handRelocated", "d31Relocated", "handRelocatedAt", "provenance"];
/** Text in a relocation reason that means a human or a ruling decided it. */
const PROTECTED_REASON_RE = /drew|ruling|hand-relocated|hand relocated|d31|d19/i;

const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const isBlank = (v) => v === null || v === undefined || str(v) === "";

/**
 * The provenance tier of one stored row. Computed from the row alone so a
 * misclassification cannot make a protected row writable.
 *
 * Returns { tier, reasons } -- reasons are for the banner's breakdown, never
 * for control flow beyond `tier === PROTECTED`.
 */
function provenanceTier(row) {
  const reasons = [];
  const source = lower(row?.source);
  if (PROTECTED_SOURCES.has(source)) reasons.push(`source:${source}`);
  // The ruling protects `drew-ruling*` as a SOURCE, not only as a relocation
  // reason. No such source exists in the pool today, so this is a guard
  // against the day one is minted -- an exact-match set would silently let a
  // fleet re-key a row whose own source names a Drew ruling.
  else if (source && PROTECTED_REASON_RE.test(source)) reasons.push(`source-marker:${source}`);
  if (row?.verifiedByUser === true) reasons.push("verifiedByUser");
  for (const f of PROTECTED_MARKER_FIELDS) if (!isBlank(row?.[f])) reasons.push(`marker:${f}`);
  const reason = str(row?.rekeyedReason) || str(row?.relocatedReason);
  if (reason && PROTECTED_REASON_RE.test(reason)) reasons.push("relocation-reason");
  return { tier: reasons.length ? PROTECTED : AUTO, reasons };
}

// ── identity axes ──────────────────────────────────────────────────────────

/** The axes an identity is compared on. Order is the banner's order. */
const AXES = ["sport", "cardYear", "setKey", "cardNumber", "parallel", "isAuto", "printRun", "grade"];

/**
 * The axes a BASE-EVICTION is DEFINED to move. An eviction takes one row off a
 * parallel slug that nothing about the row supports and files it on the
 * checklist-backed base slug -- so the finish axes are the ones expected to
 * differ, and they are the ONLY ones a write may cross.
 *
 * The other six -- sport, cardYear, setKey, cardNumber, isAuto, grade -- name
 * WHICH CARD this is. A derivation that disagrees on any of them is not a
 * mis-filing, it is a rival reading, and the destination slug is built from
 * that derived identity. `grade` is in this list and not in the movable one on
 * purpose: a PSA 9 stored row re-derived as raw is a demotion, and a demotion
 * is a conflict about the card whichever direction it runs (see the
 * grade-monotonicity ruling -- observe the inversion, never act on it).
 */
const EVICTION_MOVABLE_AXES = new Set(["parallel"]);

/**
 * A STORED PRINT RUN IS EVIDENCE, AND IT IS DISQUALIFYING (audit finding 2).
 *
 * `printRun` used to be in EVICTION_MOVABLE_AXES, and the apply path backed
 * that up with a bare `delete keep.printRun` -- so an eviction did not merely
 * move a row, it destroyed a stored field on the way. The audit found a /1 in
 * the sample (Immaculate Pujols) and Carroll /499 among them.
 *
 * A base card is not serial-numbered. A row that STORES a print run is a row
 * whose own field says "limited parallel", and that is a fourth independent
 * field disagreeing with the eviction -- exactly the kind of evidence the
 * subclass was built to require, pointing the other way. So a stored print run
 * now takes the row OUT of the subclass rather than being erased by it, and
 * `printRun` leaves the movable set: nothing an eviction does may touch it.
 *
 * The Gonzalez shape is unaffected and this is the field that separates them:
 * that row's printRun FIELD is blank while its SLUG carries num-499. Blank
 * means unknown, and an unknown is what an eviction is allowed to leave alone.
 */
function storedPrintRunNamesALimitedParallel(stored) {
  const v = stored?.printRun;
  if (v === null || v === undefined || v === "") return false;
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

/** A parallel that means "the writer could not read one". `base` is what every
 *  older writer emitted for an unreadable title, so it is treated as blank for
 *  the specificity test -- and only the checklist may displace it. */
const GENERIC_PARALLELS = new Set(["", "base", "[base]", "none", "unknown"]);

/**
 * A setKey that means "the writer could not read one" (Drew, 2026-09-03).
 *
 * THE OTHER DIRECTION OF THE COLLAPSE RULING. Drew ruled that specialized ->
 * flagship is forbidden; the REVERSE -- a stored setKey that names no product
 * at all, re-derived into the specific product the TITLE names -- is strictly
 * more specific and belongs in IMPROVE, not CONFLICT.
 *
 * Two values mean "unknown", and the census names both:
 *
 *   `unknown`  the explicit one. 4.2M UNDERIVABLE rows carry
 *              `setkey-unknown-unsupported`; where the derivation DOES resolve
 *              a product, the row diffs `unknown -> upper-deck` and read as a
 *              lateral CHANGE -- a rival reading of the card -- when it is in
 *              fact the first reading of the card. ~36,479 rows measured on
 *              that pair alone.
 *
 *   `bowman`   the OLD DEFAULT, and this is the subtle one. Before
 *              CF-CROSS-PRODUCT-MIS-SLUG-FIX, backfills that could not extract
 *              a setKey wrote the literal string "bowman", which landed
 *              Panini/Topps/Upper Deck rows in the Bowman namespace. The
 *              census reports 121,620 rows under
 *              `setkey-bowman-default-unsupported` -- that reason is exactly
 *              the marker that says "this `bowman` was never read off the
 *              card". So a `bowman -> upper-deck` diff on such a row is a fill,
 *              not a change: ~67,398 rows measured.
 *
 * THE MARKER IS REQUIRED, AND THAT IS THE WHOLE SAFETY ARGUMENT. `bowman` is
 * also a REAL product with millions of legitimate rows, and treating every
 * stored `bowman` as blank would hand the fleet a licence to re-key genuine
 * Bowman sales onto whatever a noisy title happened to say -- the exact damage
 * the default caused in the first place, running the other way. So this set is
 * consulted ONLY for `unknown`; a stored `bowman` counts as blank only when the
 * row itself carries the defaulted marker (see `storedSetKeyIsBlank`).
 */
const GENERIC_SETKEYS = new Set(["", "unknown", "none", "unspecified", "base-set"]);

/** The census reason that marks a stored `bowman` as the old unread default
 *  rather than a product read off the card. */
const BOWMAN_DEFAULT_MARKER = /setkey-bowman-default-unsupported/i;
const BOWMAN_DEFAULT_SETKEY = "bowman";

/**
 * THE PSEUDO-NUMBER IS A CARD NUMBER SHAPE THAT NAMES NO NUMBER
 * (CF-UNPARSED-IS-NOT-UNNUMBERED, Drew 2026-09-04).
 *
 * `player-<name>` occupies the cardNumber segment of 89,138 pool rows. It was
 * minted for genuinely unnumbered cards -- T206, Magic Alpha, Signature Series
 * -- where the player IS the identifier, and for those it is a real answer.
 *
 * But the deriver treated an UNPARSED cardNumber as an unnumbered one, so it
 * also minted the shape for rows whose number was simply not read. A 1987
 * Topps Traded Tiffany Maddux sale whose own title states `#70T` sits at
 * `...:player-todd-worrell:...` -- a number the title spells out, discarded,
 * and replaced with a player the vendor mis-attributed.
 *
 * For the specificity test the shape is therefore blank ON THE STORED SIDE AND
 * CONDITIONALLY: a re-derivation that reads a real number out of the title
 * FILLS an axis the stored key never named, which is IMPROVE. That is the
 * whole point of this PR.
 *
 * THE CONDITION IS NOT OPTIONAL AND IT IS THE SAFETY ARGUMENT.
 *
 * Blanking `player-` unconditionally would hand the fleet a licence to re-key
 * every genuinely unnumbered card onto whatever number a noisy title happened
 * to carry -- a cert (#3538117020), a print run (#788/1000), a lot range. Those
 * rows are correct today and there is no number to recover. So the stored side
 * counts as blank only when the caller says the TITLE ITSELF STATES THE NUMBER
 * (`opts.titleStatesNumber`), which is a fact about the row and not about the
 * derivation's confidence. Without it the diff stays `changed:cardNumber`, and
 * `changed` is CONFLICT, report-only, exactly as today.
 *
 * The DERIVED side is never blanked this way. A derivation that produces
 * `player-…` produced the pseudo-number deliberately, and a numbered stored key
 * re-deriving to it is a DEMOTION -- the demotion rule already refuses that,
 * and blanking the derived side would have converted it into a fill.
 */
const PSEUDO_NUMBER_RE = /^player-/;
function isPseudoCardNumber(v) {
  return PSEUDO_NUMBER_RE.test(lower(v).replace(/\s+/g, ""));
}

/**
 * A CORRUPTED PLAYER NAME IS NOT A LESS-GOOD NAME, IT IS NOT A NAME
 * (CF-A-PLAYER-SEGMENT-IS-A-PERSON, Drew 2026-09-04).
 *
 * hobbyIqCardId.service.ts argues the pseudo-number is "SAFE BECAUSE THE NAMES
 * ARE CLEAN", and it checked that claim the only way it could at the time: it
 * looked for names that COLLIDE under slugify, found 20 case/punctuation groups
 * out of 3,997, and folded them. What it never asked was whether each name was
 * A PERSON. The census in data/gap-reports/2026-09-04-player-field-corruption-
 * census.json asks that question and answers it: 29,654 of 115,535 rows (25.7%)
 * carry a player field with a parallel, a product, a truncation or a set code
 * inside it --
 *
 *     player-kawhi-leonard-tie-dye     a finish inside the name
 *     player-mega-box-elly-de          a product inside it, and cut mid-name
 *     player-pokemon-swsh-fa-mew       a set code, and not a person at all
 *
 * So the premise the shape rests on is false for a quarter of the population,
 * and those rows are keyed to people who do not exist. That splits the real
 * player's pool and prices a card against sales of nothing.
 *
 * THE SAME CONDITIONAL SHAPE AS THE PSEUDO-NUMBER ABOVE, FOR THE SAME REASON.
 *
 * A corrupted stored player counts as BLANK on the STORED SIDE ONLY, and only
 * when the caller supplies the fact `storedPlayerCorrupted` -- computed by the
 * census from the checklist corpus, never from the derivation's confidence. A
 * re-derivation that produces a clean name then FILLS an axis the stored key
 * never really named, which is IMPROVE rather than `changed`.
 *
 * AND THE CHECKLIST GATE IS NOT OPTIONAL. Even blanked, the IMPROVE only
 * proceeds when the derived identity is CHECKLIST-BACKED for the same
 * (year, setKey, cardNumber) -- the ordinary `checklistBacked` gate every
 * IMPROVE passes. A corrupted name whose replacement is not checklist-backed is
 * REPORT-ONLY: we know the stored name is wrong, and knowing that is not the
 * same as knowing the right one. Absent beats wrong on both sides of the swap.
 */
/**
 * CF-A-CATALOG-TITLE-NAMES-NO-PLAYER (2026-09-05).
 *
 * The vendor's PRODUCT-catalog title names a card by product and never by
 * person: "<year> <product...> <Sport> #<number> <variant>". The bare sport
 * token immediately before the card number is the tell -- a person selling a
 * card writes the player's name there, and the vendor's template never does.
 *
 * Mirrors titleNamesNoPlayer() in src/services/compiq/playerSegmentIsAPerson.ts,
 * which is the deriver's copy of this same fact. Duplicated rather than
 * imported for the reason the finish-vocabulary mirror gives: nothing under
 * src/ may depend on scripts/, and this module is a .cjs under scripts/.
 * playerSegmentCatalogTitle.test.ts pins the deriver's side against a 60-title
 * prod corpus; this side is pinned by rematchClassifyCatalogTitle.test.ts.
 */
const CATALOG_TITLE_RE =
  /\b(?:baseball|basketball|football|hockey|soccer|wrestling|racing|golf|tennis|boxing|mma|multi-?sport|non-?sport)\s+#/i;
function titleNamesNoPlayer(title) {
  return CATALOG_TITLE_RE.test(str(title));
}

function isCorruptedPlayerName(v, setKey = null, title = null) {
  const s = lower(v).trim();
  if (!s) return false;
  // CF-A-CATALOG-TITLE-NAMES-NO-PLAYER. The title this pseudo-number was
  // derived from names NO person, so whatever sits in the name slot came out of
  // the product name. This is the fact that covers the population the setKey
  // test cannot see: these rows' stored setKey is the FLAGSHIP (`topps`), not
  // the specialized product (`topps-rub-offs`), so the name's words are not in
  // it -- but the TITLE still says plainly that no person was ever named.
  //
  // Measured read-only on prod 2026-09-05 over a 30,000-row sample: of 829
  // catalog-shaped rows, the setKey test reaches 115 and `titleStatesNumber`
  // reaches 228; this reaches all 829, and 31 players stop sharing
  // `player-rub-offs`.
  if (titleNamesNoPlayer(title)) return true;
  // Ends on a name particle -> the name was cut ("Elly De").
  if (/\s(de|la|del|van|von|mc|mac|dos|das|di|da)$/.test(s)) return true;
  // Carries a franchise/layout token that is never part of a person's name.
  if (/\b(pokemon|swsh|vmax|vstar|full art|reverse holo)\b/.test(s)) return true;
  // CF-A-CATALOG-TITLE-NAMES-NO-PLAYER (2026-09-05). The name IS the product.
  //
  // parseCardQuery derived the player subtractively from a vendor CATALOG title
  // ("1966 Topps Rub-Offs Baseball #NNO Base") that names no person at all, so
  // the residue was a fragment of the PRODUCT NAME and got promoted into one.
  // Neither existing test sees it: "Rub Offs" ends on no particle and carries no
  // franchise token, so these rows classified `changed:cardNumber` = CONFLICT =
  // report-only, and the collapse stood.
  //
  // Measured read-only against prod on 2026-09-05: 31 distinct players share
  // `hiq:baseball:1966:topps:player-rub-offs:base:no-auto` and 24 share
  // `player-stand-up` -- one pool pricing many different cards.
  //
  // THE EVIDENCE IS THE setKey, NOT A WORD LIST. A person's name does not
  // reproduce the words of the product they are printed on. When every token of
  // the "name" also appears in this row's own setKey, the name is the product
  // and this is the defect. That is a comparison between two fields of the SAME
  // row -- it needs no vocabulary, and it cannot grow stale as the hobby does.
  //
  // Requires the caller to supply the setKey; without it this test is skipped
  // and the two older tests decide, exactly as before.
  const key = lower(setKey).trim();
  if (key) {
    const keyWords = new Set(key.split(/[-\s]+/).filter((w) => w.length >= 3));
    const nameWords = s.split(/[-\s]+/).filter((w) => w.length >= 3);
    // Every substantial word of the name is a word of the product's own key.
    // A one-word overlap is a coincidence ("Chase Utley" on topps-chase); the
    // test is that NOTHING in the name is from outside the product.
    if (nameWords.length > 0 && keyWords.size > 0
      && nameWords.every((w) => keyWords.has(w))) return true;
  }
  return false;
}

/**
 * Does the TITLE state a card number? The same `#N` / `No. N` reading the
 * deriver uses (extractCardNumberFromTitle in soldCompsStore), narrowed to the
 * PREFIXED form only.
 *
 * The coded form (`BCP-102` with no `#`) is DELIBERATELY excluded. This
 * predicate exists to unblock a re-key off a pseudo-number, and the coded
 * pattern matches grader labels, cert prefixes and set abbreviations that are
 * not card numbers at all -- on a genuinely unnumbered card that false positive
 * is the whole damage. A `#` is a boundary a seller typed on purpose.
 *
 * Certs and print runs are excluded by shape: a number of 5+ digits is a cert,
 * and `#788/1000` is a serial. Both appear in the unnumbered population's
 * titles and neither is a card number.
 */
const TITLE_NUMBER_RE = /(?:#|\bno\.\s*)([a-z]{0,4}-?\d{1,4}[a-z]?-?[a-z0-9]{0,6})/i;
function titleStatesCardNumber(title) {
  const t = str(title);
  if (!t) return false;
  const m = t.match(TITLE_NUMBER_RE);
  if (!m) return false;
  const tok = m[1];
  // A serial (`#788/1000`) is a print run, not a card number.
  const at = t.indexOf(m[0]);
  if (at >= 0 && /^\s*\//.test(t.slice(at + m[0].length))) return false;
  // A long run of digits is a cert number.
  const digits = tok.replace(/\D/g, "");
  if (digits.length >= 5) return false;
  return digits.length > 0;
}

/**
 * Is the STORED setKey the "unknown" one, for the specificity test?
 *
 * `derivationReasons` is the census`s own signal, not a guess about the row.
 * A stored `bowman` is blank ONLY when the derivation reported the defaulted
 * marker for this row; every other `bowman` is the product Bowman and is
 * compared as a real answer.
 */
function storedSetKeyIsBlank(stored, derivationReasons = []) {
  const v = lower(stored?.setKey);
  if (GENERIC_SETKEYS.has(v)) return true;
  if (v !== BOWMAN_DEFAULT_SETKEY) return false;
  return (derivationReasons ?? []).some((r) => BOWMAN_DEFAULT_MARKER.test(String(r)));
}

/** Grade as one comparable token. Raw is a real answer ("RAW"), not a missing
 *  one, so a stored raw row and a derived raw row AGREE on this axis. */
function gradeToken(id) {
  const c = str(id?.gradeCompany).toUpperCase();
  const v = id?.gradeValue;
  if (!c && (v === null || v === undefined || v === "")) return "RAW";
  return `${c || "RAW"}|${v === null || v === undefined || v === "" ? 0 : v}`;
}

/** One axis' comparable value. Everything is normalised to a lowercase string
 *  so "Refractor" and "refractor" are the same answer, never a defect. */
function axisValue(id, axis) {
  if (!id) return "";
  switch (axis) {
    case "sport": return lower(id.sport);
    case "cardYear": return id.cardYear === null || id.cardYear === undefined || id.cardYear === "" ? "" : String(Number(id.cardYear));
    case "setKey": return lower(id.setKey);
    case "cardNumber": return lower(id.cardNumber).replace(/\s+/g, "");
    case "parallel": return lower(id.parallel).replace(/\s+/g, " ");
    case "isAuto": return id.isAuto === true ? "auto" : id.isAuto === false ? "no-auto" : "";
    case "printRun": return id.printRun === null || id.printRun === undefined || id.printRun === "" ? "" : String(Number(id.printRun));
    case "grade": return gradeToken(id);
    default: return "";
  }
}

/** Is this axis' value the "unknown" one? Blank everywhere; additionally the
 *  generic parallels and the generic setKeys, and RAW is NOT blank -- raw is
 *  an answer.
 *
 *  The DEFAULTED `bowman` is deliberately NOT here: deciding it needs the
 *  row's derivation reasons, which this function does not see, and a blanket
 *  rule would blank every genuine Bowman row. `diffAxes` takes the marker as
 *  an argument and applies it to the STORED side only. */
function axisIsBlank(axis, value) {
  if (value === "") return true;
  if (axis === "parallel") return GENERIC_PARALLELS.has(value);
  if (axis === "setKey") return GENERIC_SETKEYS.has(value);
  return false;
}

// ── BASE-EVICTION: the finish vocabulary and its three evidence fields ─────

/**
 * THE FINISH VOCABULARY NOW COMES FROM THE CHECKLIST CORPUS.
 *
 * CF-THE-VOCABULARY-IS-THE-CHECKLIST (audit gate, 2026-09-03). What used to
 * live here was a closed ~90-word hand list, and it is the single mechanism
 * that failed all 32 shards of the census audit: 52% of the sampled
 * BASE-EVICTION lines (200/385) named a REAL parallel the list omitted --
 * Tiffany, Desert Shield, Rapture, Press Proof, Members Only, International,
 * Embossed, Mahogany, Retro-Future. Slot 29 was 30/30 wrong (1990 Bowman
 * Tiffany); slot 28 was folding 1991 Topps Desert Shield into base. Each of
 * those evictions moves a genuine parallel INTO a base pool: one card, two
 * rows, a split pool, a wrong FMV -- the exact defect the rematch exists to
 * end, arriving from the other direction.
 *
 * lib/rematch-finish-vocab.cjs now derives the vocabulary from
 * data/checklist-parallel-names.json -- 36,729 checklist-sourced parallel
 * spellings over 576 (sport, year, setKey) products -- and matches it PER
 * (year, setKey), which is also what finally resolves the product-word problem
 * the old header named and declined to fix: "chrome" is the set's own name on
 * `topps-heritage-chrome` and a finish anywhere else, and the setKey decides
 * which. A small hand list covers the spellings the corpus lacks (its Beckett
 * floor is 2020, so every vintage parallel is outside it).
 *
 * The DIRECTION of the test is unchanged and load-bearing: this is a
 * DISQUALIFYING test. A true answer takes a row out of the subclass and leaves
 * it exactly where it sits, so a false positive costs an eviction we could
 * have made while a false negative writes a parallel row onto a base slug. The
 * corpus makes the test broader in precisely the direction that was hurting.
 *
 * Re-exported below under their old names so every existing caller and test
 * keeps working.
 */
const FINISH_TOKENS = VOCAB.CORE_FINISH_TOKENS;
const FINISH_PHRASES = VOCAB.HAND_PHRASES;
const FINISH_COLOR_TOKENS = VOCAB.FINISH_COLOR_TOKENS;

/**
 * Does this title name a finish, read against THIS card's product?
 *
 * `ctx` carries `{ year, setKey }` from the DERIVED identity -- that is what
 * decides which product's checklist applies. Callers that pass nothing get the
 * global union, which is broader and therefore safe.
 */
function titleNamesFinish(title, ctx = {}) {
  return VOCAB.titleNamesFinish(title, ctx);
}

/** Does the title state a print run? `#/N`, `/N` and `N/N` all count -- the
 *  `#/N` spelling was the audit's finding 3 and used to be missed. */
function titleStatesSerial(title) {
  return VOCAB.titleStatesSerial(title);
}

/**
 * The finish child a slug carries, or null. A hiq slug is
 * `hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N][:grade]`, so the
 * parallel is the 6th colon-segment. Reading the POSITION rather than
 * scanning for a finish word anywhere is what keeps a set name from being
 * mistaken for a parallel: `hiq:baseball:2024:topps-chrome:150:base:no-auto`
 * carries "chrome" in its SET, and that row is on a base slug, not a parallel.
 */
function slugParallelSegment(slug) {
  const parts = String(slug ?? "").split(":");
  if (parts.length < 7 || parts[0] !== "hiq") return null;
  const seg = parts[5];
  return seg ? seg : null;
}

/** Is this slug's parallel segment a real parallel (not base/blank)? */
function slugNamesParallel(slug) {
  const seg = slugParallelSegment(slug);
  if (!seg) return false;
  return !GENERIC_PARALLELS.has(lower(seg));
}

/**
 * Does the title spell out, in full, the parallel phrase the STORED SLUG
 * already claims? Returns the matched phrase or null.
 *
 * CF-A-SLUG-AND-ITS-TITLE-CAN-AGREE (2026-09-04). The base-eviction guard's
 * finish test is a VOCABULARY test, and the corpus behind it is built from
 * the checklists we happen to hold. When a product's parallel names are not
 * in it -- Topps Cosmic Chrome's Planetary Pursuit (Mercury / Earth / Venus),
 * 2025 Score's Signatures -- a genuine parallel sale reads as a base sale and
 * is evicted onto the base pool, splitting the very pool the rematch exists
 * to unify.
 *
 * No vocabulary is consulted here. The slug is treated as the claim and the
 * title as the witness: when the witness repeats the claim word for word,
 * the two AGREE and no eviction is available, whatever the corpus knows.
 *
 * Every significant word (3+ chars, and never the generic 'base') of the slug
 * parallel must be present in the title. Requiring ALL of them keeps
 * 'base-refractor' from disqualifying on 'base' alone, and keeps a lone
 * shared colour word from vetoing a real eviction.
 *
 * Pure -- a test drives it with two strings.
 */
function titleEchoesSlugParallel(title, slugParallel) {
  const seg = lower(str(slugParallel));
  if (!seg || GENERIC_PARALLELS.has(seg)) return null;
  const words = seg.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && w !== "base");
  if (!words.length) return null;
  // Team phrases are stripped from the witness here for the same reason they
  // are in `storedParallelStatedInTitle` -- see TEAM_NAME_PHRASES. This half
  // is superseded by G6 on the live path but is exported and pinned, and a
  // predicate that answers differently from its own generalisation is a trap
  // for the next reader.
  const hay = new Set(titleWithoutTeamNames(title).split(/[^a-z0-9]+/).filter(Boolean));
  return words.every((w) => hay.has(w)) ? seg : null;
}

/**
 * G6 -- THE STORED IDENTITY'S OWN PARALLEL, STATED IN THE TITLE, IS A REFUSAL.
 *
 * CF-A-SLUG-AND-ITS-TITLE-CAN-AGREE, generalised past the slug (2026-09-04).
 *
 * #1711 shipped the slug half of this: read the parallel out of the stored
 * slug's 6th segment and refuse the eviction when the title spells it out.
 * That caught all 12 DAMAGED rows the halted wave wrote. It has two gaps, and
 * this guard closes both without moving what those 12 measure.
 *
 * GAP 1 -- THE SLUG IS NOT THE ONLY PLACE THE STORED IDENTITY KEEPS ITS
 * PARALLEL. `stored.parallel` is a field of its own, and the two disagree in
 * both directions in the live pool: a row can carry `parallel: "Red Wave"`
 * under a slug whose segment says `base`, and a malformed slug can carry a
 * segment that is not a parallel at all. Reading BOTH and taking the union of
 * the claims means the guard defends a row whichever half of its identity
 * still remembers the parallel. Inside BASE-EVICTION the stored field is
 * usually blank -- guard 2 requires it -- so this half is a belt for the
 * subclass and load-bearing for any other caller.
 *
 * GAP 2 -- A MALFORMED SLUG PUTS THE WRONG WORD IN THE PARALLEL SEGMENT.
 * 62 of the 1,456 rows the wave wrote came off `hiq:ant::hiq:football:2025:...`
 * -- a double-prefixed slug. Every segment shifts by two, so the parallel
 * position reads the YEAR ("2025", "2024", "2008") and a title that of course
 * contains its own year echoes it perfectly. Left alone that is 62 spurious
 * refusals standing in front of 62 rows whose real inner parallel is `base` --
 * measured, all 62 -- so they are genuine base-to-base re-keys and the slug,
 * not the identity, is what is wrong with them. `slugIsWellFormed` refuses to
 * read a parallel by POSITION out of a slug whose positions do not mean what
 * the shape says, and the malformed shape is reported as its own census
 * subclass instead of being silently absorbed here.
 *
 * WHY THE RULE STAYS "EVERY SIGNIFICANT WORD", NOT "ANY TOKEN"
 *
 * Measured over all 1,456 marker-carrying rows in the live pool, 2026-09-04:
 *
 *   every-word (this guard)   12 refusals -- exactly the 12 DAMAGED rows,
 *                             mercury x5, signatures x5, earth, venus
 *   any-token                 23 refusals -- those 12, plus 11 rows whose slug
 *                             says `rookie-autographs-black` or `rookies-
 *                             autographs` and whose title says "Rookie"
 *
 * "Rookie" in a title is a player descriptor and `rookie-autographs` is an
 * autograph SUBSET, not a finish; those 11 are genuine base sales an any-token
 * rule would strand on parallel slugs forever. A disqualifying-only guard is
 * cheap to make broad, and that is exactly why breadth has to be earned here:
 * the direction that costs us evictions is the direction nothing complains
 * about. Every word it is, and the 12 are the proof that it is enough.
 *
 * THE PRODUCT-NAME EXCLUSION IS KEPT. A token that is one of the product's own
 * setKey words names the SET on this card, never a finish -- `chrome` on
 * `topps-cosmic-chrome`, `prizm` on `panini-prizm`. Those are dropped before
 * the every-word test, so a slug parallel made only of product words matches
 * nothing at all, which is the right answer: it never named a finish.
 *
 * Hyphen-insensitive and case-insensitive on both sides. The slug spells a
 * parallel `pink-refractor`, the title spells it "Pink Refractor", and both
 * reduce to the same two words.
 *
 * DISQUALIFYING ONLY. It can keep a row exactly where it sits and it can never
 * mint a parallel: a false positive costs one eviction, a false negative
 * splits a pool. Pure -- a test drives it with strings.
 */

/** Is this slug well-formed enough to read a parallel out of BY POSITION?
 *  Exactly one `hiq:` prefix, and at least the seven segments the shape
 *  defines. A double-prefixed slug is malformed and yields nothing. */
function slugIsWellFormed(slug) {
  const s = str(slug);
  if (!s.startsWith("hiq:")) return false;
  // `hiq:ant::hiq:football:2025:...` -- two prefixes, every segment shifted.
  if ((s.match(/hiq:/g) || []).length !== 1) return false;
  return s.split(":").length >= 7;
}

/**
 * The significant finish words the STORED IDENTITY claims, from both places it
 * keeps them: the slug's parallel segment and the `parallel` field. Generic
 * parallels contribute nothing, the product's own words are dropped, and words
 * under 3 characters are noise.
 *
 * Returns a list of { from, phrase, words } -- `from` names which half of the
 * identity the claim came out of, so a refusal can say so.
 */
function parallelTokensOfStoredIdentity({ storedSlug, stored, setKey }) {
  const claims = [];
  const slug = str(storedSlug);
  if (slugIsWellFormed(slug)) {
    const seg = slugParallelSegment(slug);
    if (seg && !GENERIC_PARALLELS.has(lower(seg))) claims.push({ from: "slug", phrase: lower(seg) });
  }
  const field = lower(str(stored?.parallel));
  if (field && !GENERIC_PARALLELS.has(field)) claims.push({ from: "field", phrase: field });
  const out = [];
  for (const c of claims) {
    const words = c.phrase
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && w !== "base" && !VOCAB.isProductWord(w, setKey));
    if (words.length) out.push({ ...c, words });
  }
  return out;
}

/**
 * SLUG-SHAPE DEFECTS -- TWO REPORT-ONLY CENSUS SUBCLASSES (2026-09-04).
 *
 * Both were found while auditing the 1,456 rows the halted base-eviction wave
 * wrote. Neither is a reason to write anything, and that is the finding: each
 * is a shape the census could not previously NAME, so it had no count and no
 * way to be argued about. They are counted and reported, never acted on.
 *
 * 1. MALFORMED-DOUBLE-PREFIX-SLUG -- 62 of the 1,456.
 *
 *    `hiq:ant::hiq:baseball:2023:bowman-chrome:39:base:no-auto`. Some writer
 *    prefixed an already-complete hiq slug with `hiq:ant:` and an empty
 *    segment. Every position after that shifts by two, so anything reading the
 *    slug BY POSITION -- which is how the parallel, the setKey and the sport
 *    are all read -- gets the wrong field: position 5 is the parallel by the
 *    shape's definition, and on these it holds the YEAR.
 *
 *    Measured: all 62 have `base` in their REAL (inner) parallel position, so
 *    the evictions those rows received were base-to-base and did not damage an
 *    identity. What is wrong with them is the KEY, not the reading -- which is
 *    exactly why this is reported rather than repaired here. Rewriting a
 *    row's cardId is a relocation with a destination, and the destination
 *    question ("is the inner slug right, or is the whole key a mis-mint?")
 *    is not one a classifier answers.
 *
 * 2. NUM-SLUG-WITHOUT-STORED-PRINTRUN -- 244 of the 1,456.
 *
 *    The slug carries `:num-###` -- the shape's optional print-run segment --
 *    while the row's own `printRun` field is null. The two halves of the
 *    identity disagree about whether the card is serial-numbered at all.
 *
 *    Deliberately NOT a refusal. `storedPrintRunNamesALimitedParallel` already
 *    vetoes an eviction when the row STORES a print run, and that guard is
 *    about the field precisely because a field is the row's own hand while a
 *    slug segment is whichever writer keyed it. Promoting this to a veto would
 *    re-block the 244, and nothing has been measured that says the slug is
 *    the truthful half. So: a count, a name, and a sample for Drew.
 *
 * Pure, and independent of every class. A row can carry either shape in any
 * class, so these are tallied ALONGSIDE the class counts, never inside them.
 */
const SLUG_SHAPE_DEFECTS = {
  DOUBLE_PREFIX: "malformed-double-prefix-slug",
  NUM_WITHOUT_PRINTRUN: "num-slug-without-stored-printrun",
};

/**
 * The slug-shape defects ONE row carries, as a list of names. Empty for a
 * well-formed row, which is the overwhelming majority.
 *
 * `slug` is the row's stored cardId; `stored` supplies the printRun FIELD the
 * second defect compares the segment against.
 */
function slugShapeDefects({ slug, stored }) {
  const out = [];
  const s = str(slug);
  if (!s) return out;
  if (s.startsWith("hiq:") && (s.match(/hiq:/g) || []).length > 1) out.push(SLUG_SHAPE_DEFECTS.DOUBLE_PREFIX);
  if (/:num-\d+/.test(s)) {
    const pr = stored?.printRun;
    if (pr === null || pr === undefined || pr === "") out.push(SLUG_SHAPE_DEFECTS.NUM_WITHOUT_PRINTRUN);
  }
  return out;
}

/**
 * G6. Does the title state, in full, a parallel the stored identity claims?
 * Returns { phrase, from } or null.
 *
 * Independent of the finish vocabulary by construction: the stored identity is
 * the claim and the title is the witness, and when the witness repeats the
 * claim the two agree. A parallel the checklist corpus has never heard of --
 * Topps Cosmic Chrome's Planetary Pursuit Mercury, 2025 Score's Signatures --
 * still defends itself.
 */
/**
 * A TEAM NAME IS NOT A PARALLEL, AND G6 READS THE TITLE AS A BAG OF WORDS.
 *
 * CF-A-TEAM-NAME-IS-NOT-A-FINISH, at G6 (measured on the live pool after the
 * base-eviction apply, 2026-09-04).
 *
 * G6 asks whether the title repeats the stored parallel word for word. On a
 * MULTI-word parallel that is self-evidently safe -- "pink refractor" appears
 * in a title only when the seller named the parallel. On a ONE-word COLOUR
 * parallel it is not, because the colour words are also the words baseball
 * teams are named with:
 *
 *   slug ...:red:...   "Jon Papelbon 2006 Bowman #76 Boston RED SOX"
 *   slug ...:blue:...  "Vladimir Guerrero Jr. 2025 Bowman #27 BLUE JAYS"
 *   slug ...:white:... "... #12 Chicago WHITE SOX ..."
 *   slug ...:green:... "... GREEN BAY Packers ..."
 *
 * In each the title's ONLY occurrence of the colour is the team, the seller
 * named no finish at all, and the row is exactly the base-in-refractor sale
 * the eviction exists to move. G6 refused all of them -- the over-broad
 * direction this guard's own test file warns about, which "silently halts the
 * program rather than announcing itself".
 *
 * THE PRECEDENT IS ALREADY IN THE TREE, TWICE. `titleNearMissesFinish` was
 * narrowed for precisely this shape ("Diamondbacks" read as a typo of the
 * finish word "diamond", refusing a genuine eviction), and the census script
 * strips the same phrases before tokenizing. This is the third site and the
 * only one that still had the hole.
 *
 * WHY PHRASE-STRIPPING AND NOT A COLOUR BLOCKLIST. Dropping the colour word
 * outright would break the honest case -- a genuine "2025 Bowman Chrome Blue
 * Refractor /150 Blue Jays" must still defend itself. So the TEAM PHRASES are
 * removed from the witness and the colour is then looked for in what remains:
 * a title that names the colour anywhere outside the team name still refuses,
 * and a title whose only colour is the team no longer does.
 *
 * Directionally this is the narrowing that costs refusals and admits
 * evictions, so it is the direction that CAN do damage -- which is why it is
 * confined to the team PHRASES (never a bare colour) and pinned both ways.
 */
const TEAM_NAME_PHRASES = [
  /\bred\s+sox\b/g, /\bwhite\s+sox\b/g, /\bblue\s+jays\b/g,
  /\bblue\s+jackets\b/g, /\bred\s+wings\b/g, /\bred\s+raiders\b/g,
  /\bcincinnati\s+reds\b/g, /\bthe\s+reds\b/g,
  /\bgreen\s+bay\b/g, /\bbowling\s+green\b/g,
  /\bblackhawks\b/g, /\bredskins\b/g, /\bredbirds\b/g, /\bbrowns\b/g,
  /\bgolden\s+(?:state|knights|bears|gophers|hurricanes|eagles|flashes)\b/g,
  /\bgold\s+glove\b/g, /\bsilver\s+slugger\b/g,
  /\borange\s+bowl\b/g, /\bsyracuse\s+orange\b/g,
];

/** The title with the team phrases removed, for G6's witness only. */
function titleWithoutTeamNames(title) {
  let t = lower(str(title));
  for (const re of TEAM_NAME_PHRASES) t = t.replace(re, " ");
  return t;
}

/**
 * A PLAYER'S NAME IS NOT A FINISH -- CF-A-TEAM-NAME-IS-NOT-A-FINISH, read on
 * the OTHER half of the title (2026-09-04).
 *
 * THE DAMAGE. The finish vocabulary is harvested from the checklist corpus,
 * and real parallels really are called Max, King, Royal, Rose, Ruby and Jade.
 * They are also the words people are named with. Measured on the live pool:
 *
 *   "2025 Topps Chrome Max Fried #142 Atlanta Braves"      -> names a finish
 *   "1986 Topps Pete Rose #1 Cincinnati Reds"              -> names a finish
 *   "2013 Topps King Felix Hernandez #100 Mariners"        -> names a finish
 *
 * In each the title's ONLY occurrence of the finish word is the player's own
 * name, the seller named no parallel at all, and the row is exactly the
 * base-in-refractor sale the eviction exists to move. Guard 3 refuses all of
 * them, and the base sale stays in the refractor pool -- one card, two pools.
 *
 * THE SHAPE IS THE TEAM-NAME FIX, TURNED ON THE OTHER NOUN, AND DELIBERATELY
 * SO. A team is suppressed by PHRASE because `TEAM_NAME_PHRASES` can enumerate
 * the thirty phrases teams are called. Players cannot be enumerated -- there
 * are hundreds of thousands of them -- so the suppression is driven by THIS
 * ROW'S OWN IDENTITY: only the words of the name attached to THIS card are
 * suppressed, and only in THIS row's witness.
 *
 * ONLY THE WORDS OF THAT NAME. "2025 Topps Chrome Max Fried #142 Gold" still
 * names Gold: `gold` is not a word of "Max Fried", so it survives into the
 * witness and the guard refuses exactly as it does today. That is the whole
 * safety argument, and it is the property the pins hold in both directions.
 *
 * WHICH NAME, AND WHY THE POOL'S OWN FIELD IS NOT ENOUGH ON ITS OWN
 *
 * The CHECKLIST's `playerName` for (year, setKey, cardNumber) is the name,
 * supplied by the caller as `checklistPlayerName` because only a catalog read
 * can see it and this module is pure. The row's own stored `playerName` is the
 * fallback -- and it is a fallback that has to be CHECKED, because 25.7% of
 * the player fields in the pool are corrupted (CF-A-PLAYER-SEGMENT-IS-A-PERSON,
 * #1734: 29,654 of 115,535 rows carry a parallel, a product or a set code
 * inside the name). Measured on this population, the corruption is exactly the
 * dangerous kind:
 *
 *   playerName "Pandora Alanna Smith Lynx"  -- Pandora IS the parallel
 *   playerName "Fire Ernie Banks Bb"        -- Fire is the product
 *   playerName "Zenith Caleb Williams Retail"
 *
 * Suppressing from those fields would delete a REAL finish word from the
 * witness and evict a genuine Prizm Pandora sale onto the base pool -- the
 * defect this lane exists to end, arriving through its own repair. So a stored
 * name is read only when `isCorruptedPlayerName` says it is a person, and a
 * word is suppressed only when the checklist agrees or the stored name is
 * clean. Absent beats wrong: no readable name means no suppression and the
 * guard answers exactly as it does today.
 *
 * DIRECTION. This costs REFUSALS and admits EVICTIONS, so it is the direction
 * that can do damage -- which is why it is confined to the words of ONE name,
 * gated on that name being a person, and pinned both ways.
 */
const NAME_PARTICLES = new Set([
  "jr", "sr", "ii", "iii", "iv", "de", "la", "del", "van", "von", "da", "das",
  "dos", "di", "mc", "mac", "the",
]);

/** The suppressible words of a player name: 3+ characters, no particles.
 *  Short tokens are excluded for the reason the near-miss floor exists -- at
 *  two letters the word is an initial and matches half the vocabulary. */
function playerNameWords(playerName) {
  const out = new Set();
  for (const w of lower(str(playerName)).split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !NAME_PARTICLES.has(w)) out.add(w);
  }
  return out;
}

/**
 * The name this row's identity attaches to the card, or null when none can be
 * trusted. The checklist's name wins; a stored name is accepted only when it
 * reads as a person.
 *
 * TWO GATES ON THE STORED FIELD, AND THE SECOND IS THE ONE THAT MATTERS HERE.
 *
 * `isCorruptedPlayerName` (#1734) catches a name cut mid-particle ("Elly De")
 * and a franchise/layout token ("pokemon swsh fa mew"). It does NOT catch the
 * shape this suppression is most endangered by, because it was written for a
 * different question -- a stored name that has swallowed a PARALLEL:
 *
 *     "Pandora Alanna Smith Lynx"     Pandora IS the parallel
 *     "Fire Ernie Banks Bb"           Fire is the product
 *     "Zenith Caleb Williams Retail"
 *
 * Believing one of those would delete the parallel's own word from the witness
 * and evict a genuine Prizm Pandora sale onto the base pool -- the split this
 * lane exists to end, arriving through its own repair. So a stored name whose
 * words include a FINISH TOKEN is refused outright: we know the field is wrong,
 * and knowing that is not the same as knowing which half is the person. Absent
 * beats wrong, and the row simply keeps today's verdict.
 *
 * The gate is on the STORED field only. A checklist name is a checklist name --
 * the corpus that would flag it is built from the same checklists -- and a real
 * player genuinely called Rose or Max must still be readable, which is the
 * entire point of the fix.
 */
function storedNameCarriesAFinishWord(name) {
  for (const w of playerNameWords(name)) {
    if (titleNamesFinish(w, {})) return true;
  }
  return false;
}

function trustedPlayerName({ checklistPlayerName, storedPlayerName }) {
  const cl = str(checklistPlayerName).trim();
  if (cl) return cl;
  const sp = str(storedPlayerName).trim();
  if (sp && !isCorruptedPlayerName(sp) && !storedNameCarriesAFinishWord(sp)) return sp;
  return null;
}

/**
 * The title with THIS card's player name removed -- as a PHRASE, exactly the
 * way `titleWithoutTeamNames` removes a team.
 *
 * WHY THE PHRASE AND NOT THE WORDS (found by this PR's own pin, 2026-09-04).
 *
 * The first version of this dropped every WORD of the name wherever it
 * occurred, and the pin that caught it is the one that matters:
 *
 *     "1986 Topps Pete Rose #1 Rose Gold Parallel"   slug ...:rose-gold:...
 *
 * Word-wise suppression deletes BOTH roses -- the man AND the parallel he is
 * printed in -- and G6 then finds nothing to echo, so a genuine Rose Gold sale
 * is evicted onto the base pool. That is the over-broad direction, and it is
 * the direction that does damage.
 *
 * Removing the CONTIGUOUS RUN instead is what makes the suppression evidence
 * rather than a blocklist: "pete rose" is struck because those two words
 * appear together in that order, and the second, separate "rose" is left
 * standing for the vocabulary and G6 to read. A single-word name -- the whole
 * of `playerName` being one token -- still removes that one word, because
 * there is no run to anchor against and the alternative is to suppress nothing
 * at all for players like Ichiro.
 */
function titleWithoutPlayerName(title, playerName) {
  const words = [...playerNameWords(playerName)];
  const t = lower(str(title));
  if (!words.length) return t;
  // The name's own words, in the order the name states them, as one phrase.
  //
  // THE JOIN ADMITS THE PARTICLES BACK AS SEPARATORS. `playerNameWords` drops
  // "de", "la", "jr" -- they are not distinguishing words and must never be
  // suppressed on their own. But they DO sit between the words that are, so a
  // separator of "any run of non-alphanumerics" alone would fail to match
  // "Elly De La Cruz" in its own title and suppress nothing. Silent
  // under-delivery, not damage -- but it would quietly cost every player with a
  // particle in their name, which is a large and specific population.
  const gap = `(?:[^a-z0-9]+(?:${[...NAME_PARTICLES].map(escapeRe).join("|")})?)+`;
  const phrase = new RegExp(`\\b${words.map(escapeRe).join(gap)}\\b`, "g");
  const stripped = t.replace(phrase, " ");
  // A run was found and removed -- that is the whole suppression.
  if (stripped !== t) return stripped;
  // No contiguous run. A one-word name is still a name, so it is removed on its
  // own; a multi-word name that never appears as a run is NOT removed at all,
  // because scattered single words are not evidence that this title names this
  // person, and striking them is the word-wise behaviour this comment rejects.
  if (words.length !== 1) return t;
  return t.split(/([^a-z0-9]+)/).map((tok) => (tok === words[0] ? " " : tok)).join("");
}

/** A literal, for building the name phrase. */
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function storedParallelStatedInTitle({ title, storedSlug, stored, setKey, playerName = null }) {
  // The witness is read with team PHRASES removed, so a colour that appears
  // only inside a team name is not evidence that the seller named a finish.
  // A title naming the colour anywhere else still echoes, and a multi-word
  // parallel is unaffected by construction.
  //
  // AND WITH THE PLAYER'S OWN NAME REMOVED, for the identical reason. G6 reads
  // the title as a BAG OF WORDS, so a one-word parallel slug matches the
  // player as readily as it matched the team:
  //
  //   ...:rose:...     "1986 Topps Pete Rose #1 Cincinnati Reds"
  //   ...:max:...      "2025 Topps Chrome Max Fried #142 Braves"
  //
  // Found by this PR's own pins: guard 3 released those rows and G6 held them
  // anyway, which is the same two-guards-one-bug shape #1750 measured -- there
  // the vocabulary fired first, here G6 does. Fixing one without the other
  // releases nothing.
  //
  // `playerName` is the CALLER'S trusted name (see `trustedPlayerName`), never
  // the raw stored field: a corrupted player field carries the parallel itself,
  // and suppressing from it would delete the very word G6 exists to find.
  const hay = new Set(
    titleWithoutPlayerName(titleWithoutTeamNames(title), playerName)
      .split(/[^a-z0-9]+/).filter(Boolean));
  if (!hay.size) return null;
  for (const c of parallelTokensOfStoredIdentity({ storedSlug, stored, setKey })) {
    if (c.words.every((w) => hay.has(w))) return { phrase: c.phrase, from: c.from };
  }
  return null;
}

/**
 * The three evidence fields, quoted, for ONE row. Returns
 * { qualifies, evidence } where evidence is what the census banner and the
 * rekeyedReason both print -- the row is never evicted on a verdict alone,
 * the quoted evidence travels with it.
 *
 * `baseDestBacked` is the caller's verdict that a CHECKLIST-BACKED base
 * destination row exists for this card. Without it there is nowhere to evict
 * TO, and a row is never moved to a slug the checklist does not list.
 *
 * `checklistPlayerName` is the CHECKLIST's name for this (year, setKey,
 * cardNumber), supplied by the caller because only a catalog read can see it.
 * It is the trusted half of the player-name suppression at guard 3; the row's
 * own stored name is the checked fallback. A caller that supplies neither gets
 * today's behaviour exactly.
 */
function baseEvictionEvidence({ row, stored, derived, storedSlug, baseDestSlug, baseDestBacked, checklistPlayerName = null }) {
  const title = str(row?.title);
  const slug = str(storedSlug ?? row?.cardId);
  const ev = {
    storedSlugParallel: slugParallelSegment(slug),
    titleQuoted: title.slice(0, 160),
    storedParallelField: stored?.parallel ?? null,
    // Quoted because it is now a VETO field: an eviction that ran despite a
    // stored print run would have to explain itself against this line.
    storedPrintRunField: stored?.printRun ?? null,
    baseDestSlug: baseDestSlug ?? null,
    baseDestChecklistBacked: !!baseDestBacked,
  };
  const fail = [];
  // 1. the slug claims a finish the row itself never states
  if (!slugNamesParallel(slug)) fail.push("slug-names-no-parallel");
  // 2. the row's OWN parallel field names nothing. This is the field that
  //    separates an eviction from the Gonzalez demotion, so it is checked on
  //    the STORED identity, never on the derived one.
  if (!axisIsBlank("parallel", axisValue(stored, "parallel"))) fail.push("stored-parallel-names-a-finish");
  // 3. the title names no finish either -- read against THIS card's product,
  //    so `chrome` on a Topps Heritage Chrome card is the set's own name while
  //    `Tiffany` on a 1990 Bowman is a parallel the corpus (or the hand list
  //    beneath its 2020 floor) knows about.
  const beYear = derived?.cardYear ?? stored?.cardYear ?? null;
  const beSetKey = derived?.setKey ?? stored?.setKey ?? "";
  // A TEAM NAME IS NOT THE SELLER NAMING A FINISH.
  //
  // CF-A-TEAM-NAME-IS-NOT-A-FINISH, at guard 3 (measured on the live pool
  // AFTER the base-eviction apply ran on all 32 shards, 2026-09-04).
  //
  // The finish vocabulary is the checklist corpus's, and Bowman really does
  // print a bare "Red", "Blue", "White" and "Green" parallel -- so each of
  // those is a legitimate finish TOKEN. The defect is not the word, it is the
  // OCCURRENCE: the only place the colour appears in these titles is the
  // team.
  //
  //   ...:red:...    "Jon Papelbon 2006 Bowman #76 Boston RED SOX"
  //   ...:blue:...   "Vladimir Guerrero Jr. 2025 Bowman #27 BLUE JAYS"
  //   ...:white:...  "... #12 Chicago WHITE SOX ..."
  //   ...:green:...  "... GREEN BAY Packers ..."
  //
  // Measured over 921,000 rows of the live pool: 193 of 1,501 surviving
  // base-in-refractor rows -- 12.9% -- are refused by this guard and by this
  // guard alone, on a colour that occurs ONLY inside a team name. Every one is
  // a base sale stranded on a colour slug, which is the exact split pool the
  // GREAT REMATCH exists to end.
  //
  // THE STRIP IS LOCAL TO THIS CALL SITE, DELIBERATELY. `titleNamesFinish` is
  // also consulted by the IMPROVE guards, where a FALSE answer makes the guard
  // MORE conservative -- so silencing a team name there would loosen a
  // different lane that no measurement here has cleared. Base-eviction is the
  // lane the audit gate cleared and the only one this changes.
  //
  // Phrase-stripping, never a colour blocklist: "Blue Refractor /150 Blue
  // Jays" still names a finish once the team is gone, so an honest parallel
  // keeps defending its row. Verified on the six colour-plus-team shapes --
  // none drops to false.
  // AND A PLAYER'S NAME IS NOT ONE EITHER. The same ruling, read on the other
  // noun in the title: max, king, royal, rose, ruby and jade are real parallel
  // names AND real people's names, and a title whose only occurrence of one is
  // the player is a title that names no finish. Only the words of THIS card's
  // own name are removed, and only from a name that reads as a person -- see
  // `trustedPlayerName` for why a stored field cannot be believed unchecked.
  // Composed with the team strip rather than replacing it: a title can carry
  // both a team and a player whose names are finish words.
  const bePlayerName = trustedPlayerName({
    checklistPlayerName,
    storedPlayerName: stored?.playerName ?? row?.playerName ?? null,
  });
  ev.playerNameSuppressed = bePlayerName;
  const beTitleWitness = titleWithoutPlayerName(titleWithoutTeamNames(title), bePlayerName);
  if (!title) fail.push("no-title");
  else if (titleNamesFinish(beTitleWitness, { year: beYear, setKey: beSetKey })) fail.push("title-names-a-finish");
  else {
    // 3b. A MISSPELLED FINISH WORD IS STILL A FINISH WORD, ON THE DISQUALIFYING
    //     SIDE (first audit gate, leak 3 -- 7 writable BASE-EVICTION lines).
    //
    //     "Refactor", "Refracor", "Refractpr". Each of those titles is a
    //     GENUINE refractor that our vocabulary could not read, so
    //     titleNamesFinish said false, the eviction qualified on all four
    //     fields, and the row moved onto the BASE slug -- one card, two rows,
    //     a split pool, which is precisely the defect the rematch exists to
    //     end, arriving through a typo.
    //
    //     Edit distance 1 (substitutions, insertions, deletions and adjacent
    //     transpositions) over finish words of 7+ characters. The length floor
    //     is what makes it safe: at 4 letters every 1-edit neighbourhood is
    //     full of ordinary English, at 7+ it is empty of it.
    //
    //     DISQUALIFYING ONLY, and that is a rule about this call site, not a
    //     property of the predicate: a near miss says "we cannot read this
    //     title", and the answer to an unreadable title is to leave the row
    //     exactly where it is. It never mints a parallel and it is never
    //     consulted on the IMPROVE positive path.
    const near = VOCAB.titleNearMissesFinish(title, beSetKey);
    if (near) {
      ev.titleNearMiss = near;
      fail.push(`title-near-misses-a-finish:${near.word}~${near.matched}`);
    }
  }
  // 3c. THE TITLE ECHOES THE SLUG'S OWN PARALLEL PHRASE (2026-09-04).
  //
  //      Guard 3 asks the finish VOCABULARY whether the title names a finish.
  //      The vocabulary is the checklist corpus's, and a corpus is never
  //      complete: measured on the 1,457 rows the halted base-eviction wave
  //      wrote, 12 rows were evicted whose titles state the stored slug's
  //      parallel IN FULL -- 'Planetary Pursuit Mercury' off
  //      ...:ppm-ja:mercury:no-auto ($250), 'EARTH' off ...:ppea-cs:earth,
  //      'Venus' off ...:ppv-jj:venus, and five 2025 Score 'Signatures' rows.
  //      None of mercury/earth/venus/signatures is in CORE_FINISH_TOKENS, so
  //      titleNamesFinish said false and the eviction qualified on every
  //      other field.
  //
  //      This check needs no vocabulary. The stored slug already names the
  //      parallel; if the title spells that same phrase out, the row and the
  //      slug AGREE and there is nothing to evict. It is a self-evidence
  //      test, so a parallel the corpus has never seen still defends itself.
  //
  //      DISQUALIFYING ONLY, exactly like the near-miss rule above: it can
  //      only ever keep a row where it is, and it never mints a parallel.
  //      Words of 3+ characters only, and EVERY significant word of the slug
  //      parallel must appear, so a ...:base-refractor:... slug does not
  //      disqualify on the bare word 'base' and one-word overlap is never
  //      enough on its own.
  //      G6 (2026-09-04) generalises this past the slug. The stored `parallel`
  //      FIELD is read as a second source of the same claim; the product's own
  //      setKey words are dropped, so `chrome` on topps-cosmic-chrome can never
  //      carry a match; and a MALFORMED slug -- `hiq:ant::hiq:...`, 62 of the
  //      1,456 rows -- yields no parallel at all rather than echoing the year
  //      its shifted segments left where the parallel belongs.
  const g6 = storedParallelStatedInTitle({ title, storedSlug: slug, stored, setKey: beSetKey, playerName: bePlayerName });
  if (g6) {
    ev.storedParallelStatedInTitle = g6;
    // The historical field name is kept alongside it, so a row written under
    // #1711's guard and a row written under this one read the same to every
    // caller that already looks for it.
    ev.titleEchoesSlugParallel = g6.phrase;
    // ONE REASON STRING PER REFUSAL, NAMED BY WHICH HALF OF THE IDENTITY SPOKE.
    //
    // The failure list is COMMA-JOINED into a single `not-base-eviction:...`
    // reason, so pushing two names for one finding does not give a reader two
    // matchable reasons -- it gives them one unreadable one and breaks every
    // consumer keyed to either. So the slug half keeps #1711's exact string,
    // which the audit gate, the census banner and every row already written
    // under that guard use; the FIELD half -- the case #1711 could not see at
    // all -- gets G6's own name, because a new population deserves a name a
    // census can count separately.
    fail.push(g6.from === "slug"
      ? `title-echoes-slug-parallel:${g6.phrase}`
      : `stored-parallel-stated-in-title:${g6.phrase}`);
  }
  // 3d. THE SLUG'S "PARALLEL" IS A PRODUCT NAME THE TITLE STATES (GUARD 7,
  //     2026-09-04 -- the slot-19 routing defect).
  //
  //     CF-A-TIFFANY-SALE-IS-A-TIFFANY-CARD, read onto the ROUTING rather
  //     than onto the write. The census put ~24 correct
  //     `topps -> topps-tiffany` derivations in CONFLICT/BASE-EVICTION
  //     instead of IMPROVE/SPECIALIZATION-STATED -- Clutterbuck #562,
  //     Larkin #648, Mattingly #500, Bonds #320 PSA 8 and PSA 9,
  //     Henderson #735 -- and the cause is ORDER, not any of the legs.
  //
  //     Every one of those rows is stored on a slug whose PARALLEL segment
  //     carries the product name, read live from the pool 2026-09-04:
  //
  //       hiq:baseball:1987:topps:320:tiffany:no-auto   parallel field "Base"
  //       hiq:baseball:1987:topps:562:tiffany:no-auto   parallel field "Base"
  //
  //     `classifyRow` evaluates this subclass BEFORE the axis diff decides,
  //     deliberately, so the commonest eviction shape is seen at all. But
  //     that puts it ahead of the SPECIALIZATION-STATED door, and these rows
  //     qualified on every leg: the slug names a "parallel" (tiffany), the
  //     stored parallel field says Base, and guard 3 reads the title's
  //     "Tiffany" as the DERIVED product's own setKey word and so suppresses
  //     it -- `titleNamesFinish` is asked against setKey `topps-tiffany`.
  //     So base-eviction claimed the row and returned CONFLICT before the
  //     specialization could be considered, and the census reported a
  //     title-stated, checklist-backed improvement as a conflict.
  //
  //     The row was never writable (`base-eviction-contradicted:setKey`
  //     held), so nothing was written to the wrong card -- but a correct
  //     improvement counted as a conflict is a repair nobody can find, and
  //     6,339 rows were measured eligible lane-wide.
  //
  //     THE TEST IS THE LADDER'S, SO IT NEEDS NO NEW VOCABULARY. If the
  //     slug's parallel segment spells a DECLARED CHILD of the stored key
  //     whose distinguishing words this title states, then that segment is a
  //     PRODUCT NAME misfiled into the parallel slot -- not a finish claim
  //     the row fails to support. There is nothing to evict: the right
  //     answer is to move the row onto the child product, which is exactly
  //     what SPECIALIZATION-STATED decides, under its own five legs.
  //
  //     DISQUALIFYING ONLY, like every guard above it. It refuses the
  //     eviction and lets the row fall through to the ordinary path; it
  //     never mints a specialization and it never writes. A row whose
  //     specialization legs then FAIL (no child checklist, say) lands in
  //     CONFLICT carrying its failed legs -- reported, never written.
  {
    const beStoredKey = lower(stored?.setKey);
    const slugParallel = slugParallelSegment(slug);
    if (beStoredKey && slugParallel && title) {
      const segWords = lower(slugParallel).split(/[^a-z0-9]+/).filter(Boolean);
      for (const child of SPECIALIZATION_CHILDREN_OF(beStoredKey)) {
        const words = distinguishingWords(child, beStoredKey);
        if (!words.length) continue;
        // The slug segment must BE the child's distinguishing words -- every
        // one of them, and nothing else. `:tiffany:` names topps-tiffany;
        // `:gold-refractor:` names no product and is left to the finish
        // guards above, which is where a real parallel belongs.
        if (words.length !== segWords.length) continue;
        if (!words.every((w) => segWords.includes(w))) continue;
        // ...and the TITLE must say so too, on the same evidence GUARD 6
        // uses. A slug alone is an address, not a claim about the sale.
        if (!words.every((w) => titleStatesWord(title, w))) continue;
        ev.slugParallelNamesProduct = { segment: slugParallel, child, words };
        fail.push(`slug-parallel-names-a-product-the-title-states:${words.join("+")}|names:${child}`);
        break;
      }
    }
  }
  // 4. somewhere checklist-backed to go
  if (!baseDestBacked) fail.push("no-checklist-backed-base-destination");
  // 4b. THE STORED PRINT RUN IS A FOURTH FIELD, AND IT VETOES. A base card is
  //     not serial-numbered; a row storing /499 says "limited parallel" in its
  //     own hand. Never erased, and never overridden.
  if (storedPrintRunNamesALimitedParallel(stored)) fail.push(`stored-printrun-names-a-limited-parallel:${stored.printRun}`);
  // 5. the derived reading must itself be base -- if today's parser reads a
  //    parallel off this row, this is not an eviction, it is a disagreement.
  if (derived && !axisIsBlank("parallel", axisValue(derived, "parallel"))) fail.push("derived-names-a-finish");
  return { qualifies: fail.length === 0, evidence: ev, failed: fail };
}

// ── FINISH-FAMILY-COLLISION: one colour, several parallels, one pool ───────
//
// CF-A-COLOUR-FAMILY-IS-SEVERAL-CARDS (Drew, 2026-09-03: "Green refractors and
// bases are mixed in").
//
// This is the shape BASE-EVICTION cannot see. An eviction is defined by the
// title naming NO finish; here every title names one -- they just name
// DIFFERENT ones that share a colour word. Measured on the live pool
// 2026-09-03: 122 Bowman slugs carry rows whose titles variously say "green",
// "green refractor" and "green wave", e.g.
// hiq:baseball:2025:bowman-chrome:7:green-geometric-refractor:no-auto.
//
// Green, Green Refractor, Green Shimmer, Green Wave and Green Mojo Refractor
// are five checklist rows with five price curves. Pooled together their trend
// is the trend of no real card, so the FMV the engine projects is a number
// nothing ever sold for.
//
// WHY THIS IS REPORT-ONLY, AND PERMANENTLY SO
//
// BASE-EVICTION may write because its destination is DERIVED FROM ABSENCE: the
// row names no finish, so the base row is the only card it can be, and a
// checklist-backed base destination is required before it moves. Here the
// title names a finish POSITIVELY, and choosing between "the title is right
// and the slug is wrong" and "the title is terse and the slug is right" is a
// judgement about which card a sale is -- exactly the contradiction the census
// hands to Drew rather than settling. A fleet that guessed here would move
// genuine Green Wave sales onto a Green pool as readily as the reverse.
//
// So this subclass TAGS and COUNTS. It never sets `writable`. Its product is
// the ranked list of collided slugs, which is what a repair list is built from
// once Drew rules on the family.
//
// THE VOCABULARY IS THE CHECKLIST'S, NOT THIS FILE'S (merge, 2026-09-03).
// This predicate was first written against the closed FINISH_TOKENS list and
// a hand-typed colour set. Both are gone: the colours are the corpus's own
// FINISH_COLOR_TOKENS, and "is this word a finish?" is asked of the per-card
// vocabulary, which suppresses the product's own setKey words for us. The two
// exclusions the hand-rolled version documented survive as CONSEQUENCES of
// that call rather than as separate code -- see `comparable` below.

/** The colour words a family collision is measured on. The corpus's own colour
 *  vocabulary, so a colour the checklists prove out is a family here too. */
const FAMILY_COLOURS = new Set(VOCAB.FINISH_COLOR_TOKENS);

/**
 * The colour family a parallel name belongs to, or null. "Green Wave" and
 * "Green" are both the `green` family; "Refractor" alone belongs to none
 * (it names no colour), and neither does a two-colour name like "Black &
 * White Red Ink" -- ambiguous membership is no membership, because a
 * collision must be unambiguous to be worth reporting.
 */
function colourFamilyOf(parallelName) {
  const words = lower(parallelName).split(/[^a-z0-9]+/).filter(Boolean);
  const hits = [...new Set(words.filter((w) => FAMILY_COLOURS.has(w)))];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Does this row's TITLE name a finish in the same colour family as its SLUG,
 * but not the same parallel? That is the collision: both agree the card is
 * green, and they disagree about which green card it is.
 *
 * Returns { qualifies, evidence }. The evidence quotes both sides, because a
 * subclass that only reported a verdict would be unactionable -- Drew rules on
 * the family by reading the titles.
 *
 * A VENDOR-KEYED ROW STILL HAS AN ADDRESS -- IT IS JUST THE OTHER FIELD.
 *
 * CF-A-GOLD-SHIMMER-IS-NOT-A-GOLD (Drew, 2026-09-05). Every caller passes
 * `storedSlug: row.cardId`, and on a CardHedge row `cardId` is the vendor's
 * bubble id (`1778541264103x262828165280045280`), not an `hiq:` slug. So
 * `slugParallelSegment` returned null, the predicate returned `qualifies:
 * false` at its first branch, and the ENTIRE vendor-keyed population was
 * invisible to this census -- 59% of a 5,000-row 2015+ sample, measured
 * read-only on the live pool 2026-09-05.
 *
 * That is precisely where the damage hides. The row that prompted this ruling
 * is Drew's Marconi German: title "2026 Bowman Marconi German 1st Auto CPA-MG
 * Gold Shimmer /50 - Raw", stored `parallel` "Gold", and
 * `hobbyiqCardId` ...:cpa-mg:gold-refractor:auto:num-50 -- a Gold Shimmer sale
 * addressed to the Gold Refractor pool. Asked with `cardId` the predicate says
 * nothing; asked with `hobbyiqCardId` it says `family: "gold"`,
 * `titleFamilyWords: ["shimmer"]`. Same row, same detector, one field apart.
 *
 * So the ADDRESS this predicate reads is the row's `hiq:` slug wherever the
 * row has one: `cardId` when that is a slug, else `hobbyiqCardId`. The pool
 * reader ORs the two fields, so both are addresses the sale actually prices
 * under, and reading the one that carries a parallel segment is reading the
 * claim this predicate exists to compare against the title.
 *
 * THIS CANNOT MAKE A ROW WRITABLE. `finishFamilyCollision` is report-only and
 * permanently so (see the block comment above): it sets a tag and a count,
 * never `writable`. Widening what it can SEE widens the census, not the fleet.
 * Measured on the same sample: flagged rows 394 -> 922, all report-only.
 */
function finishFamilyCollision({ row, storedSlug, stored, derived }) {
  const title = str(row?.title);
  // The row's own `hiq:` address, whichever field carries it. `storedSlug`
  // (always `row.cardId` at every call site) wins when it IS a slug, so an
  // hiq-keyed row is read exactly as it was before this widening.
  // `slugParallelSegment` itself is the `hiq:`-shape test, so the fallback is
  // taken only when the explicit key yields no parallel segment AND the
  // hobbyiqCardId does -- never on a malformed value of either.
  const explicit = str(storedSlug ?? row?.cardId);
  const fallback = str(row?.hobbyiqCardId);
  const slug = slugParallelSegment(explicit) ? explicit
    : (slugParallelSegment(fallback) ? fallback : explicit);
  const slugParallel = slugParallelSegment(slug);
  const ev = {
    storedSlugParallel: slugParallel,
    titleQuoted: title.slice(0, 160),
    storedParallelField: stored?.parallel ?? null,
    family: null,
    titleFamilyWords: [],
    // WHICH address was read. A vendor-keyed row is reported against its
    // `hobbyiqCardId`, and the report has to say so -- a collision quoted
    // against an address the reader cannot find on `cardId` would look like a
    // defect in the census rather than the shape of the row.
    addressField: slug === explicit ? "cardId" : "hobbyiqCardId",
    addressSlug: slug || null,
  };
  if (!slugParallel || !slugNamesParallel(slug)) return { qualifies: false, evidence: ev };
  const family = colourFamilyOf(slugParallel.replace(/-/g, " "));
  if (!family) return { qualifies: false, evidence: ev };
  ev.family = family;

  // The title must name the SAME colour -- otherwise this is an ordinary
  // disagreement about the card, not a family collision.
  const words = VOCAB.titleWords(title);
  if (!words.includes(family)) return { qualifies: false, evidence: ev };

  // ...and it must name a finish word BESIDE the colour that the slug's
  // parallel does not carry (or vice versa). A title saying exactly what the
  // slug says is agreement, and agreement is not a collision.
  //
  // `isFinishToken` is asked PER CARD, and that one call is what excludes the
  // two word classes the closed-list version had to exclude by hand:
  //
  // 1. PRODUCT WORDS. "2025 Bowman CHROME Green Wave" names the PRODUCT in the
  //    title while the slug says `bowman-chrome`; counting "chrome" as a
  //    finish the slug's parallel lacks would report every Bowman Chrome row
  //    as collided. The vocabulary suppresses this card's own setKey words
  //    itself -- that IS the product-word fix -- so we no longer re-derive the
  //    set segment out of the slug to do it.
  // 2. WORDS OUTSIDE THE FINISH VOCABULARY ENTIRELY. "geometric" in
  //    `green-geometric-refractor` is a real parallel word the corpus may not
  //    carry, and treating our own vocabulary gap as the title "dropping" a
  //    word would flag agreement as collision. Only words the vocabulary can
  //    actually adjudicate are compared, in BOTH directions.
  const year = derived?.cardYear ?? stored?.cardYear ?? null;
  const setKey = derived?.setKey ?? stored?.setKey ?? "";
  const vocab = VOCAB.vocabularyFor(year, setKey);
  const comparable = (w) => w !== family && vocab.isFinishToken(w);
  const slugWords = new Set(slugParallel.split(/[^a-z0-9]+/).filter(Boolean));
  const titleFinishWords = words.filter(comparable);
  ev.titleFamilyWords = titleFinishWords;
  const titleAddsOrDrops =
    titleFinishWords.some((w) => !slugWords.has(w)) ||
    [...slugWords].some((w) => comparable(w) && !words.includes(w));
  return { qualifies: titleAddsOrDrops, evidence: ev };
}

// ── IMPROVE guards (audit finding 7: IMPROVE IS NOT SAFE) ──────────────────

/**
 * KNOWN DISTINCT PRODUCTS. A derived setKey that collapses one of these into
 * its parent is not a more specific reading of the card -- it is a DIFFERENT
 * card (audit finding 4).
 *
 * Measured in the census: the derivation collapses bowmans-best,
 * bowman-sterling, bowman-heritage and bowman-chrome into `bowman`;
 * allen-ginter and fire into `topps`; fleer-ultra into `ultra`;
 * stadium-club-chrome and heritage-chrome into `paper`. The
 * `contradicted:setKey` guard blocks those from BASE-EVICTION (316 rows in
 * slot 19 alone) -- but IMPROVE never looked, so a collapse that ALSO filled a
 * blank axis read as an improvement and was writable.
 *
 * bowman-vs-chrome and sapphire are DIFFERENT cards, and a product-family
 * ladder nests specialized products under a flagship without merging them. A
 * derived setKey that drops one of these words is a demotion in product space
 * even when the axis diff calls it a fill somewhere else.
 */
const DISTINCT_PRODUCT_SETKEYS = [
  // -- Bowman ---------------------------------------------------------------
  // Drew, 2026-09-03: bowmans-best, bowman-sterling and bowman-heritage are
  // each DISTINCT from bowman, and bowman is DISTINCT from bowman-chrome.
  "bowmans-best", "bowman-best-university", "bowman-sterling", "bowman-heritage",
  "bowman-chrome", "bowman-chrome-sapphire", "bowman-chrome-mega-box",
  "bowman-chrome-nscc", "bowman-chrome-draft",
  "bowman-draft", "bowman-draft-sapphire", "bowman-draft-picks-and-prospects",
  "bowman-draft-1st-edition", "bowman-platinum", "bowman-inception",
  "bowman-1st-edition", "bowman-paper",
  // -- Topps ----------------------------------------------------------------
  "topps-chrome", "topps-chrome-platinum", "topps-chrome-black",
  "topps-chrome-sapphire", "topps-chrome-update-series",
  "topps-chrome-update-sapphire", "topps-update-series", "topps-update-sapphire",
  "topps-heritage", "topps-heritage-chrome", "topps-allen-ginter",
  "topps-allen-ginter-chrome", "topps-fire", "topps-finest",
  "topps-finest-flashbacks", "topps-gold-label", "topps-stadium-club",
  "topps-stadium-club-chrome", "topps-cosmic-chrome", "topps-signature-class",
  "topps-composite", "topps-archives", "topps-museum-collection", "topps-now",
  "topps-traded", "topps-traded-tiffany", "topps-tiffany", "topps-total",
  "topps-pristine", "topps-resurgence",
  // -- Panini / Donruss -----------------------------------------------------
  // Drew, 2026-09-03: donruss-elite, donruss-studio and diamond-kings are each
  // DISTINCT from panini-donruss.
  "donruss-elite", "donruss-studio", "diamond-kings", "panini-diamond-kings",
  "donruss-optic", "panini-donruss",
  "panini-prizm", "panini-prizm-wnba", "panini-prizm-draft-picks",
  "panini-prizm-monopoly-wnba", "panini-mosaic", "panini-optic",
  "panini-select", "score-select", "panini-score",
  "panini-origins", "panini-prestige", "panini-certified",
  // NBA Hoops is spelled by its checklist (Drew 2026-09-05): `nba-hoops`
  // holds 26,355 checklistinsider rows, `panini-hoops` zero strict ones.
  // A supported key must be a normalizeSetKey fixed point, and since
  // RULED_ALIASES now folds the prefixed spelling, the ruled key is the
  // one that belongs on this list.
  "nba-hoops",
  "panini-zenith", "panini-photogenic", "panini-court-kings", "panini-recon",
  "panini-rookies-and-stars", "panini-impeccable", "panini-chronicles",
  "panini-luminance", "panini-crusade", "panini-signature-series",
  "panini-boys-of-summer", "panini-three-and-two",
  // -- Fleer / SkyBox -------------------------------------------------------
  // Drew, 2026-09-03: fleer-tradition and metal-universe are DISTINCT from
  // fleer; skybox-premium is DISTINCT from skybox.
  "fleer-tradition", "fleer-tradition-update", "metal-universe",
  "skybox-metal-universe", "marvel-metal", "fleer-ultra", "ultra", "flair",
  "skybox-premium", "skybox-molten-metal", "skybox-thunder", "circa-thunder",
  // -- Upper Deck -----------------------------------------------------------
  // Drew, 2026-09-03: upper-deck-black-diamond is DISTINCT from upper-deck.
  "upper-deck-black-diamond", "upper-deck-mvp", "sp-authentic", "sp-game-used",
  "spx", "spx-finite", "collectors-choice",
  // -- Pacific / Pinnacle / Score / Upper Deck: the products the shard-31
  //    IMPROVE audit proved were being folded into their flagship
  //    (2026-09-04). Each key below is a product a sampled sale NAMED in its
  //    title while the derivation answered the flagship, so each is a pool
  //    that was about to be merged with a different card's.
  //
  //    1995 Pacific is the exemplar and the worst of them: "Prism" alone
  //    covers TWO products -- the STANDALONE 1995 Pacific Prism set and the
  //    Crown Collection PRISMS insert -- and the Gold Crown Die-Cuts are a
  //    third. All three collapsed onto `pacific:<n>:base`, and because the
  //    inserts carry their own low numbering, #4 named the Prism Maddux, the
  //    Gold Crown Die-Cut Ripken and the base card all at once.
  "pacific-prism", "pacific-crown-collection", "pacific-crown-collection-prisms",
  "pacific-gold-crown-die-cuts",
  // 1995 Upper Deck SP is a separate product from 1995 Upper Deck, and SP
  // Championship is separate again. Jeter SP #181 is a landmark rookie; base
  // Upper Deck #181 is not the same card at any price.
  "upper-deck-sp", "upper-deck-sp-championship", "upper-deck-minor-league",
  // 1989 Score Traded uses its own #NNT numbering, exactly as Topps Traded
  // does -- the number is what separates it and it must stay separated.
  //
  // THE CATALOG'S OWN SPELLING, NOT THE SELLER'S (GUARD 7, 2026-09-04).
  // This list carried `score-traded`, which is an ALIAS: productSetKeys.ts
  // declares `S("score-rookie-and-traded", { names: [..., "score-traded"] })`,
  // so `score-rookie-and-traded` is the canonical key and a normalizeSetKey
  // FIXED POINT. Measured on the live catalog 2026-09-04:
  // `score-rookie-and-traded` holds 766 rows and `score-traded` holds ZERO.
  //
  // The drift was invisible because the alias still LOOKED like a declared
  // distinct product, so `derivationCollapsesProduct` and GUARD 6 both
  // matched on a key nothing is ever stored under, while the key rows
  // actually carry reached this list only through SPECIALIZATION_PARENTS
  // below. Both spellings are named now -- the canonical one so the guards
  // fire on the rows that exist, the alias so a row written under the old
  // spelling before the rename is still recognised rather than silently
  // becoming collapsible.
  "score-rookie-and-traded", "score-traded", "score-masters",
  // 1975 Topps Mini is a physically different card printed on the same
  // checklist; the pools price differently and always have.
  "topps-mini",
  // 1995 Pinnacle UC3 is its own product, not a Pinnacle parallel.
  "pinnacle-uc3",
  // 1995-96 Fleer Metal is a distinct product from Fleer, and from Metal
  // Universe -- the audit caught "Fleer Metal Nuts & Bolts" landing on
  // the fleer flagship. Metal Universe is already declared; bare Metal was not.
  "fleer-metal",
  // -- Leaf -----------------------------------------------------------------
  // Census-found: the /(?:^|-)leaf/ family catch-all in the regex vocabulary
  // was collapsing every one of these into `leaf` inside matchKnownProductLine.
  "leaf-metal", "leaf-limited", "leaf-certified", "leaf-certified-materials",
  "leaf-signature-series", "leaf-rookies-and-stars",
  // -- The 1990s named inserts and food issues (GATE 3 slot-31 audit,
  //    2026-09-04). A named insert shares its flagship's brand word and NOT
  //    its checklist: Upper Deck Special Edition #31 is Olajuwon while base
  //    1995-96 Upper Deck #31 is another player, and 1978 Topps Holsum is a
  //    33-card food issue against Topps's 528. Folding either way merges two
  //    different cards' pools.
  "upper-deck-special-edition", "upper-deck-jordan-collection",
  "upper-deck-milk-caps", "topps-holsum",
  // UDA is UPPER DECK AUTHENTICATED -- the company's autographed-memorabilia
  // arm, not a set in the Upper Deck checklist at all (GATE 4 slot-31,
  // 2026-09-04). It was the ONE case of the gate's five that GUARD 6 did not
  // already refuse, and the reason was vocabulary and nothing else: the guard
  // asks "is there a declared child of this key whose distinguishing word the
  // title states?", and no table declared one. The other four
  // (upper-deck-special-edition, topps-mini, topps-holsum, upper-deck-minors)
  // were already declared here or in SPECIALIZATION_PARENTS, and the guard
  // refuses them today -- measured, and pinned in
  // rematchTitleNamesProduct.test.ts.
  //
  // Declaring it is the whole fix. A UDA item is signed memorabilia whose
  // price is a different order of magnitude from a base card's, so folding it
  // onto `upper-deck:<n>` corrupts that pool in the direction the audit
  // opened on. Same shape as the milk caps above, one line up.
  "upper-deck-uda",
  // 1995 Collector's Choice Special Edition is the one product in this family
  // the catalog ALREADY backs (313 baseballcardpedia rows) and already a
  // reconciliation fixed point -- named here so GUARD 6 and
  // `derivationCollapsesProduct` fire on the rows that exist.
  "collectors-choice-special-edition",
];

/**
 * THE RULED COLLAPSE PAIRS (Drew, 2026-09-03).
 *
 * `derivationCollapsesProduct` is STRUCTURAL and stays that way -- it catches
 * shapes nobody enumerated. This table is the NAMED half: every pair Drew ruled
 * on explicitly, plus the pairs the census found, each carrying the row count
 * the Great Rematch measured across all 32 shards. It exists so a refusal can
 * name the RULING and not only the shape, and so a test can pin each pair
 * individually -- a structural guard that silently stopped matching one pair
 * would still pass a test that only exercised the structure.
 *
 * `est` is the scaled estimate from the census artifacts: sampled CONFLICT
 * lines per shard, weighted by that shard`s own `CONFLICT changed:setKey`
 * population. Total measured `changed:setKey` population across the 32 runs:
 * 2,922,114 rows.
 */
const RULED_COLLAPSE_PAIRS = Object.freeze([
  // -- ruled by Drew, >=200 sampled rows --
  { from: "topps-chrome-update-series", to: "topps-chrome", sampled: 496, est: 287655, ruled: true },
  { from: "topps-chrome-platinum", to: "topps-chrome", sampled: 974, est: 229345, ruled: true },
  { from: "topps-allen-ginter", to: "topps", sampled: 446, est: 214366, ruled: true },
  { from: "bowmans-best", to: "bowman", sampled: 622, est: 200863, ruled: true },
  { from: "donruss-elite", to: "panini-donruss", sampled: 542, est: 168392, ruled: true },
  { from: "panini-prizm-wnba", to: "panini-prizm", sampled: 226, est: 152382, ruled: true },
  { from: "bowmans-best", to: "bowman-chrome", sampled: 380, est: 105816, ruled: true },
  // -- ruled by Drew, below the 200-sample line but named in the ruling --
  { from: "panini-prizm-draft-picks", to: "panini-prizm", sampled: 196, est: 118860, ruled: true },
  { from: "bowman-draft-sapphire", to: "bowman-chrome-sapphire", sampled: 176, est: 90000, ruled: true },
  { from: "panini-score", to: "score", sampled: 132, est: 48808, ruled: true },
  { from: "skybox-premium", to: "skybox", sampled: 176, est: 30437, ruled: true },
  { from: "metal-universe", to: "fleer", sampled: 134, est: 28629, ruled: true },
  { from: "fleer-tradition", to: "fleer", sampled: 160, est: 24025, ruled: true },
  { from: "donruss-studio", to: "panini-donruss", sampled: 140, est: 23213, ruled: true },
  { from: "bowman-draft-picks-and-prospects", to: "bowman-draft", sampled: 120, est: 16855, ruled: true },
  { from: "topps-gold-label", to: "topps", sampled: 82, est: 15830, ruled: true },
  { from: "bowman-heritage", to: "bowman", sampled: 158, est: 14992, ruled: true },
  { from: "bowman-sterling", to: "bowman", sampled: 58, est: 10767, ruled: true },
  { from: "diamond-kings", to: "panini-donruss", sampled: 78, est: 8966, ruled: true },
  { from: "upper-deck-black-diamond", to: "upper-deck", sampled: 56, est: 8546, ruled: true },
  // -- census-found, not individually ruled -- same shape, same refusal --
  { from: "panini-donruss", to: "donruss-optic", sampled: 226, est: 108520, ruled: false },
  { from: "topps-chrome-black", to: "topps-chrome", sampled: 222, est: 76485, ruled: false },
  { from: "topps-signature-class", to: "topps", sampled: 120, est: 55556, ruled: false },
  { from: "topps-cosmic-chrome", to: "topps", sampled: 92, est: 36704, ruled: false },
  { from: "panini-prizm-monopoly-wnba", to: "panini-prizm", sampled: 16, est: 22122, ruled: false },
  { from: "topps-composite", to: "topps", sampled: 58, est: 19876, ruled: false },
  { from: "bowman-best-university", to: "bowman-chrome", sampled: 20, est: 16715, ruled: false },
  { from: "topps-finest-flashbacks", to: "topps-finest", sampled: 62, est: 15248, ruled: false },
  { from: "score-select", to: "panini-select", sampled: 70, est: 12561, ruled: false },
  { from: "bowman-chrome-mega-box", to: "bowman-chrome", sampled: 26, est: 12324, ruled: false },
  { from: "bowman-best-university", to: "bowman", sampled: 22, est: 12156, ruled: false },
  { from: "topps-traded", to: "topps", sampled: 74, est: 10838, ruled: false },
  { from: "topps-now", to: "topps", sampled: 48, est: 10294, ruled: false },
  { from: "spx-finite", to: "spx", sampled: 26, est: 8910, ruled: false },
  { from: "topps-total", to: "topps", sampled: 18, est: 5094, ruled: false },
  { from: "skybox-molten-metal", to: "skybox", sampled: 38, est: 5087, ruled: false },
  { from: "fleer-tradition-update", to: "fleer", sampled: 32, est: 4555, ruled: false },
  { from: "skybox-metal-universe", to: "fleer", sampled: 26, est: 3200, ruled: false },
  { from: "marvel-metal", to: "fleer", sampled: 24, est: 2900, ruled: false },
  { from: "skybox-thunder", to: "skybox", sampled: 20, est: 2400, ruled: false },
  { from: "flair", to: "fleer", sampled: 20, est: 2300, ruled: false },
  // The Leaf family catch-all. `/(?:^|-)leaf/` in the regex vocabulary
  // swallowed every specialized Leaf product inside matchKnownProductLine --
  // this is the exemplar pair the ruling itself is written around
  // ("2002 Leaf Certified Materials #62"  table: leaf-certified-materials,
  // regexes: leaf). It was named in the ruling and measured by the coverage
  // census, but never carried its own row here, so the refusal could name the
  // SHAPE and not the PAIR. `est` is the coverage census`s measured row count
  // for the KEY (14,717), the same figure the V6 table carries. `sampled` is
  // null on purpose: the coverage census counted the key, not this
  // stored -> derived direction, and a sample count nobody measured is a
  // number this table must not carry. The remaining Leaf specializations
  // (certified, limited, signature-series, rookies-and-stars, metal) are in
  // SPECIALIZED_PRODUCT_KEYS and are refused STRUCTURALLY; they get named rows
  // here when a census measures their directions.
  { from: "leaf-certified-materials", to: "leaf", sampled: null, est: 14717, ruled: true },
]);

/** The ruled pair for this stored -> derived direction, or null. */
function ruledCollapsePair(from, to) {
  const f = lower(from), t = lower(to);
  return RULED_COLLAPSE_PAIRS.find((p) => p.from === f && p.to === t) ?? null;
}

/**
 * EVERY DECLARED CHILD OF A GIVEN PARENT KEY, from the tables this module
 * already keeps -- no new vocabulary, so a product named in one place is named
 * in all of them.
 *
 * Three sources, unioned:
 *   RULED_COLLAPSE_PAIRS   every `from` whose `to` is this key. This is the
 *                          measured table: each entry carries the row count
 *                          the 32-shard census found for that direction, so a
 *                          refusal built on it can cite a number.
 *   SPECIALIZATION_PARENTS the ladder edges (topps-traded -> topps,
 *                          topps-traded-tiffany -> topps-traded, ...).
 *   DISTINCT_PRODUCT_SETKEYS
 *                          the structural half: any declared distinct product
 *                          whose key is `<parent>-<something>`. This is what
 *                          catches a child nobody has measured a pair for yet
 *                          -- `topps-mini` the day it is declared, without an
 *                          edit here.
 *
 * Memoized per parent: `improveRefusals` runs on every IMPROVE-shaped row and
 * the answer is a pure function of three frozen tables.
 */
const _childCache = new Map();
function SPECIALIZATION_CHILDREN_OF(parentKey) {
  const p = lower(parentKey);
  if (!p) return [];
  const hit = _childCache.get(p);
  if (hit) return hit;
  const out = new Set();
  for (const pair of RULED_COLLAPSE_PAIRS) if (pair.to === p) out.add(pair.from);
  for (const [child, parent] of Object.entries(SPECIALIZATION_PARENTS)) if (lower(parent) === p) out.add(lower(child));
  for (const k of DISTINCT_PRODUCT_SETKEYS) if (lower(k).startsWith(`${p}-`)) out.add(lower(k));
  // Longest first: `topps-traded-tiffany` must be TESTED before `topps-traded`,
  // so a title naming the grandchild is refused citing the grandchild.
  const list = [...out].sort((a, b) => b.length - a.length);
  _childCache.set(p, list);
  return list;
}

/**
 * Does the derived setKey COLLAPSE a known distinct product into a parent?
 *
 * The test is structural, not a lookup table of pairs: a stored setKey that is
 * a known distinct product, and a derived setKey that is a strict PREFIX of it
 * (on a `-` boundary) or that the stored key otherwise contains, is a
 * collapse. `bowman-chrome` -> `bowman` collapses; `bowman` -> `bowman-chrome`
 * does not (that direction is a genuine refinement, and the ordinary axis test
 * already treats a changed setKey as a CONFLICT anyway).
 */
function derivationCollapsesProduct(stored, derived) {
  const s = lower(stored?.setKey), d = lower(derived?.setKey);
  if (!s || !d || s === d) return null;
  // THE NAMED PAIRS ANSWER FIRST (Drew, 2026-09-03). A ruled pair is a
  // collapse whatever its shape, so the refusal can cite the ruling and the
  // measured row count rather than only the structure. `panini-donruss ->
  // donruss-optic` and `flair -> fleer` are exactly why: neither is a prefix
  // nor a segment of the other, and the third structural clause below would
  // have caught them only by accident of sharing no segment.
  const ruled = ruledCollapsePair(s, d);
  if (ruled) return `${s}->${d}`;
  if (!DISTINCT_PRODUCT_SETKEYS.includes(s)) return null;
  // a strict prefix on a segment boundary is the collapse shape:
  // `bowman-chrome` -> `bowman`, `topps-allen-ginter` -> `topps`.
  if (s.startsWith(`${d}-`)) return `${s}->${d}`;
  // The derived key is a SEGMENT of the stored one -- `fleer-ultra` -> `ultra`
  // drops the brand and keeps the tail, which is the same loss of product
  // identity as dropping the tail. Either direction of truncation collapses.
  const segs = s.split("-");
  if (segs.includes(d)) return `${s}->${d}`;
  // The derived key shares NO segment with the stored one at all:
  // `topps-stadium-club-chrome` -> `paper`. That is not a refinement of this
  // product under any reading -- it is a different product entirely.
  const dSegs = d.split("-");
  if (!segs.some((seg) => dSegs.includes(seg))) return `${s}->${d}`;
  return null;
}

/**
 * L3 -- THE SOURCES THAT PROVE A SPECIALIZATION LISTS A CARD (2026-09-04).
 *
 * WHY THIS IS AN ALLOWLIST AND NOT A REGEX OF FORBIDDEN WORDS.
 *
 * The ordinary IMPROVE gate asks "does this card exist?" and answers it with
 * `CHECKLIST_SOURCE_RE` -- /checklist|beckett|tcdb|insider|bcp|baseballcardpedia|tcgdex/.
 * That is a reasonable question to answer loosely. SPECIALIZATION-STATED asks a
 * different and much stronger one: does THIS SPECIALIZATION list THIS CARD? A
 * wrong yes there does not merely fail to improve a row, it moves a sale onto a
 * card that may never have been printed.
 *
 * The first draft of this gate was `CHECKLIST_SOURCE_RE && !DERIVED_SOURCE_RE`,
 * and measuring it against the real container is what retired it. `SELECT
 * c.source, COUNT(1) GROUP BY c.source` over card_catalog on 2026-09-04 returns
 * 100+ distinct sources, and the subtractive predicate is wrong in BOTH
 * directions on them:
 *
 *   FALSE NEGATIVES -- real scrapes the loose regex never matched at all, so
 *   subtracting from it could not rescue them:
 *     drew-google-sheet-scraped-2026-09-01   735 rows -- and it is the 1987
 *         Topps Tiffany checklist itself, the one #1615 landed to take 2,760
 *         sales out of the base pools. The census refused 1,576 1987
 *         topps-tiffany rows for "no backing" while their backing sat right
 *         there under a name the regex did not know.
 *     bccp / bccp-graded                     1.6M rows (baseballcardpedia's
 *         own short name; the long spelling matched, the short one did not)
 *     hobbymonitor-*                         790k
 *     cardboardconnection-* / cardboard-connection-*
 *     baseball-almanac, bbm-japan-official-pdf, pokemon-tcg-data-scraped
 *
 *   FALSE POSITIVES -- names that would pass a loosened regex but are not
 *   checklist evidence at all:
 *     catalog-explode-actuals-*  1.9M rows built by EXPLODING actuals, the
 *         exact shape CF-EXPLODED-SPINE retired
 *     pool, sold-comps-stub-*    rows minted FROM SALES -- the circularity
 *         this leg exists to refuse, under a different name than
 *         `sales-attested`
 *     subset-unfold-*            unfolded, not scraped
 *     cardhedge*, cardsight*     VENDOR rows; the persist-vendor-lookups
 *         doctrine is that vendors never mint catalog rows
 *     ebay-browse, ebay-user-*   listings and a user's own record
 *     undefined                  a source that says nothing
 *
 * So the leg names the sources it TRUSTS, and everything else -- including
 * every source invented after this line was written -- is refused until someone
 * adds it deliberately. That is the right default for a gate whose false yes
 * moves a sale onto a card that may not exist. `rematchSpecializationStated.test.ts`
 * pins each family and each exclusion by name.
 *
 * The suffixes the catalog appends (`-graded`, `-graded-graded`,
 * `-graded-attested`) and the trailing ingest date are stripped before the
 * comparison, so a new scrape of a trusted source needs no code change.
 */
const STRICT_CHECKLIST_SOURCES = Object.freeze([
  // -- the checklist aggregators ------------------------------------------
  "checklist", "checklistinsider", "checklistcenter", "checklistcenter-html",
  "beckett-checklist", "beckett-scraped", "beckett",
  "tcdb", "tcgdex", "cardboardchecklist",
  // www.sportscardchecklist.com -- a real scraped publisher with its own lane
  // (discoverSportsCardChecklistSets.cjs / fetchSportsCardChecklist.cjs), and
  // as of 2026-09-04 the source of ~50k+ rows: Tiffany 1984-1991, Fleer
  // Tiffany/Glossy, the 1990s baseball destinations (#1766), the vintage
  // FB/BK/HK cells. It was missing from this list, so the STRICT gate scored
  // its rows 0 while the LOOSE CHECKLIST_SOURCE_RE matched them -- the two
  // predicates disagreed about the same rows, which is exactly the split this
  // allowlist exists to prevent. That is half of why 1987 topps-traded-tiffany
  // read "strict-checklist 0"; the other half was the cardYear filter.
  "sportscardchecklist",
  // -- the encyclopaedias and card-by-card references ----------------------
  "baseballcardpedia", "baseballcardpedia-ladders", "bccp",
  "cardboardconnection", "cardboard-connection",
  "baseball-almanac", "hobbymonitor",
  "bbm-japan-official-pdf", "pokemon-tcg-data",
  // -- Drew's own hand-verified checklist sheets --------------------------
  // The 1987 Topps Tiffany 792 came from here (#1615). A human transcribing a
  // printed checklist is a scrape with the best possible provenance, and the
  // ruling rows are Drew deciding a card by name.
  "drew-google-sheet", "cardpedia-drew-ruling",
]);

/** The catalog's per-ingest suffixes and date stamps, stripped so a trusted
 *  source stays trusted across re-scrapes without a code change. */
function normalizeCatalogSource(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  // The per-ingest suffixes, stripped repeatedly (the catalog really does
  // carry `-graded-graded` and `-graded-attested`). `scraped` is stripped as
  // one of them because it names the INGEST VERB, not the source: the same
  // publisher appears as both `tcdb-2026-08-12` and
  // `tcgdex-scraped-2026-08-16`, and an allowlist that had to carry both
  // spellings of every name would eventually miss one.
  const strip = (x) => x.replace(/-(graded|attested|unnumbered|scraped)$/, "");
  for (;;) { const next = strip(s); if (next === s) break; s = next; }
  // a trailing ISO-ish date stamp: -2026-08-27, -2026-08-27T..., -20260827
  s = s.replace(/-\d{4}-\d{2}-\d{2}(t[\d:.+-]*)?$/, "").replace(/-\d{8}$/, "");
  // and the suffixes again, in case the date sat between them
  for (;;) { const next = strip(s); if (next === s) break; s = next; }
  return s;
}

/**
 * A PUBLISHER'S LANE IS STILL THAT PUBLISHER (Drew's ruling, 2026-09-04).
 *
 * `tcgdex-ja-2026-09-04` is the SAME publisher as `tcgdex` -- scrape-tcgdex-ja.cjs
 * reads the identical free JSON API (MIT, the permitted one), and the `-ja`
 * token names WHICH CORPUS of that API was walked, not a different source of
 * evidence. It normalised to `tcgdex-ja`, which is not in the allowlist, so
 * 12,851 rows scored STRICT 0 while the LOOSE `catalogAuthorityOf` called every
 * one of them `checklist` -- the two predicates disagreeing about the same rows,
 * which is precisely the split this allowlist exists to prevent.
 *
 * WHY A NAMED LIST AND NOT A GENERAL "STRIP THE LAST SEGMENT" RULE. Measured
 * read-only over all 172 distinct card_catalog sources on 2026-09-04, exactly
 * five normalized keys are a suffix of a strict publisher, and they are NOT the
 * same case:
 *
 *   tcgdex-ja               12,851  the tcgdex JSON API, ja corpus     -> STRICT
 *   tcdb-scrape              6,158  tcdb's own scrape lane; the sibling
 *                                   `tcdb-scraped-*` ALREADY normalises to
 *                                   `tcdb` and is strict, so refusing this
 *                                   spelling is the same self-disagreement  -> STRICT
 *   bccp-product-structure   3,075  a VENDOR product classification.
 *                                   catalogAuthority.service.ts already sends
 *                                   every `-product-structure` to VENDOR by
 *                                   name; consume SALES not PRODUCT fields  -> refuse
 *   checklist-batch-fill       265  a legacy FILL lane, not a transcription;
 *                                   nukeCatalogFragmentation ranks it BELOW
 *                                   cardsight                              -> refuse
 *   baseballcardpedia-manual     3  a hand-edit lane of unproven provenance,
 *                                   3 rows, never audited                  -> refuse
 *
 * So a generic rule would promote a vendor's product classification into the
 * gate whose false yes moves a sale onto a card that may never have been
 * printed. The lanes are named, and every lane invented later is refused until
 * someone adds it deliberately -- the same default the publisher list itself
 * has. Pinned BOTH directions in rematchStrictSourceAndPlayerName.test.ts: a
 * lane suffix never flips a KNOWN publisher's strictness, and an unknown
 * publisher stays non-strict no matter what lane it claims.
 */
const STRICT_PUBLISHER_LANES = Object.freeze([
  "tcgdex-ja",
  "tcdb-scrape",
]);

/** L3. Is this catalog row's source a REAL SCRAPED CHECKLIST -- one that can
 *  prove a specialization lists a card? Every source not named above is
 *  refused, including every source invented later. Absent beats wrong. */
function isStrictChecklistSource(raw) {
  const s = normalizeCatalogSource(raw);
  if (s === "") return false;
  if (STRICT_CHECKLIST_SOURCES.includes(s)) return true;
  // A named lane of a named publisher. The lane must resolve to a publisher
  // that is ALREADY strict on its own -- so this can never admit a source the
  // list does not already trust, only a corpus of one it does.
  if (STRICT_PUBLISHER_LANES.includes(s)) {
    const publisher = s.slice(0, s.lastIndexOf("-"));
    return STRICT_CHECKLIST_SOURCES.includes(publisher);
  }
  return false;
}

// ── SPECIALIZATION-STATED: the IMPROVE subclass that repairs a stated ──────
//    product the old parser could not read.  (Drew's Maddux, 2026-09-04)
//
// CF-A-TIFFANY-SALE-IS-A-TIFFANY-CARD, applied to the rematch.
//
// THE DAMAGE. Drew's 1987 Topps Traded Tiffany Greg Maddux #70T (PSA 10)
// published $148.32 against a $910-$1,560 market. Nothing was wrong with the
// pricing: 23 Tiffany PSA 10 sales sat in the FLAGSHIP pool
// `hiq:baseball:1987:topps:70t:base:no-auto` beside ~121 non-Tiffany Traded
// PSA 10 sales at ~$150, and FMV projects the next sale of the pool it is
// given. One pool cannot serve two cards.
//
// The cause was a parser defect, fixed in #1715: `inferSetKeyFromTitle` had no
// rule for "traded" or "tiffany", so every such title fell past the ~30
// `topps <product>` rules to the bare `/topps/` catch-all. `normalizeSetKey`
// had ruled on all three keys since 2026-08-04 and productSetKeys.ts carries
// them with their parent ladder -- only the TITLE parser disagreed.
//
// WHY THE REMATCH COULD NOT REPAIR THEM. #1715 changed DERIVATION ONLY, and
// said so: "the census classifies these rows CONFLICT (changed:setKey), which
// its auto-apply lane will not write. That gate needs a separate ruling."
// Measured on the Maddux pool: 341 of 365 rows return CONFLICT
// writable:false on `changed:setKey`. The rule that refuses them is the
// only-improve doctrine stated as code -- a changed axis is a rival reading of
// the card, and a fleet never settles a rival reading.
//
// WHY THIS ONE IS NOT A RIVAL READING. `changed:setKey` is the right default
// because a setKey move is usually two parsers disagreeing about which product
// a title names. This shape is different in a way that can be TESTED, not
// asserted:
//
//   the stored key is an ANCESTOR of the derived key on the product-family
//   ladder, and the title states, in full, every word that distinguishes the
//   child from that ancestor.
//
// A title that says "Topps Traded Tiffany" and a row filed under `topps` are
// not two readings of one card. They are one reading and one FAILURE to read.
// The row's own title carries the evidence; nothing is inferred, guessed or
// widened. This is the ladder pointing the OTHER WAY from
// `derivationCollapsesProduct` -- that guard refuses `topps-tiffany` ->
// `topps` because a specialization is never the flagship; this subclass admits
// `topps` -> `topps-tiffany` when the title says Tiffany, because the flagship
// was never the specialization either. The two are the same ruling read in
// both directions, which is why they share the ladder and not a word list.
//
// THE FIVE LEGS. All five must hold; any one failing leaves the row CONFLICT
// exactly as today, and the failing leg is NAMED so the census can count it.
//
//   L1  LADDER      the stored key is a strict ANCESTOR of the derived key in
//                   productSetKeys.ts (`topps` -> `topps-traded` ->
//                   `topps-traded-tiffany`; `topps` -> `topps-tiffany`).
//                   Ancestry, not string prefix: a prefix test would admit
//                   `topps-t` -> `topps-tiffany` and would be a different,
//                   weaker claim than the one Drew ruled.
//   L2  STATED      the title states EVERY word that distinguishes the derived
//                   key from the stored one. Derived `topps-traded-tiffany`
//                   minus stored `topps` = {traded, tiffany}, and the title
//                   must contain BOTH as whole words. This is the leg that
//                   makes the subclass EVIDENCE rather than inference, and it
//                   is the leg the mutation pin drops.
//   L3  BACKED      the DERIVED identity (year, setKey, cardNumber, parallel)
//                   is checklist-backed in card_catalog by a REAL SCRAPED
//                   SOURCE. `derived-from-base-checklist-*`, `auto-seed-*` and
//                   sales-attested rows are NOT backing: the first mints a
//                   specialization's rows by copying the flagship's, so citing
//                   one as evidence would be citing a row that exists only
//                   because someone already assumed the thing being proven.
//                   See `checklistBackedStrict` in the runner.
//   L4  IDENTITY    cardNumber, grade and isAuto are UNCHANGED -- and so is
//                   every other axis except `setKey`. Those axes say WHICH
//                   CARD and WHICH SLAB. A derivation moving one of them is
//                   disagreeing about identity, not reading a product word the
//                   old parser dropped, and a fleet never settles that.
//   L5  NOT-FLAGSHIP the stored flagship's OWN checklist does not list this
//                   cardNumber. A genuine flagship card that merely mentions
//                   the word is not eligible -- 1987 Topps #70 exists, and a
//                   title reading "1987 Topps #70 ... traded to the Cubs" must
//                   never be re-keyed off a real card's pool. Supplied by the
//                   runner as `storedFlagshipListsCardNumber`; a caller that
//                   cannot answer supplies `null` and the row is REFUSED,
//                   because absent beats wrong.
//
//                   THE SAME-NUMBER PARALLEL-SET EXCEPTION (Drew ruled it,
//                   2026-09-04). Measured 2026-09-04: 1987 topps lists #70 and
//                   #320 but NOT #70T, so the Traded Tiffany rows pass L5 on
//                   the number alone -- while `topps-tiffany` and
//                   `bowman-tiffany` reprint the flagship's card list ON THE
//                   SAME NUMBERS, so every one of their rows failed L5 by
//                   construction: 6,113 rows, 7,076 topps -> topps-tiffany and
//                   794 bowman -> bowman-tiffany by key pair.
//
//                   #1725 shipped that as a refusal and counted the population
//                   so Drew could rule on it. He had already ruled: eed10b9b,
//                   "a Tiffany sale is a Tiffany card", moved 2,760 rows out
//                   of the base pools on exactly this reasoning. Where a
//                   specialization reprints its parent card-for-card at the
//                   parent's numbers, the number is shared BY DESIGN -- L5's
//                   answer is not merely yes, it is uninformative -- and the
//                   title is the only thing that can separate the two cards.
//                   So it is sufficient.
//
//                   `SAME_NUMBER_PARALLEL_SETS` (productSetKeys.ts, mirrored
//                   below) declares those pairs, and L5 skips the
//                   flagship-lists test for them ALONE. EVERY OTHER FAMILY
//                   KEEPS L5 STRICT -- `topps -> topps-traded` is separated by
//                   the number and stays separated, and `o-pee-chee` is a
//                   different product with its own numbering, not a parallel
//                   set. And nothing else is relaxed: L3 still demands the
//                   CHILD'S OWN checklist row from a real scraped source, so
//                   1987's 735 hand-verified `topps-tiffany` rows become
//                   eligible while the years whose Tiffany catalog rows are
//                   synthetic `derived-from-base-checklist-*` stay PENDING a
//                   checklist. The title says which product; the checklist
//                   says the card was printed. Both, or neither.
//
// G1-G6 STILL APPLY. The subclass rides the IMPROVE arm and is evaluated
// ALONGSIDE `improveRefusals`, the family-collision refusal, the
// derivation-defect refusals and the provenance tier -- every one of which can
// still refuse it. It widens WHICH ROWS REACH the IMPROVE gate; it does not
// weaken the gate.
//
// APPLY PLUMBING: none. `applyKindOf` returns IMPROVE for these rows because
// their `klass` IS IMPROVE, so `scope=improve` arms them and the existing
// canary gate covers them. No new workflow input, no new apply class.
// ─────────────────────────────────────────────────────────────────────────────
// SELLER-NAME-AUTO -- A SHOP NAME IS NOT A SIGNATURE (measured 2026-09-04)
//
// THE DEFECT. The pool-side title parser bounded `auto` on both sides but
// `autograph` on NEITHER:
//
//     /\bauto\b|autograph|hard[-\s]signed/i
//
// so the letters a-u-t-o-g-r-a-p-h anywhere inside a longer word read as an
// autograph. eBay sellers append their shop name to the title, and one shop is
// enormous:
//
//   "Vladimir Guerrero Jr. 2025 Bowman #27 Blue Jays MLB READ FREE SHIP AutographDen"
//
// 102,621 of 271,664 scanned sold_comps rows carry isAuto=true on this defect,
// 102,482 of them from the single phrase "autographden", across ~40 years:
// 1991 panini-donruss 1,869; 1983 fleer 1,804; 2024 panini-donruss 1,645; 2019
// bowman 1,644; 1982 fleer 1,499. Base cards priced as autographs, and every
// real autograph pool diluted with base sales -- BOTH pools wrong.
//
// THE PARSER IS FIXED (parseTitleIdentity.service.ts). That stops NEW rows.
// It does not move the 102k already stored, and it CANNOT, because the runner
// computes `isAuto` as `parsed.isAuto || row.isAuto === true` -- the stored
// flag is OR'd in, so a fixed parser still re-derives `auto` on these rows and
// they classify AGREE forever. This subclass is what moves them.
//
// THE RULE, BOUNDED EXACTLY LIKE SPECIALIZATION-STATED. A stored isAuto=true
// row whose ONLY autograph witness is a seller token, and whose CHECKLIST ROW
// for (year, setKey, cardNumber) is a NON-AUTO card, classifies IMPROVE onto
// the base identity. Five legs, all of which must hold; any one failing leaves
// the row exactly where it is today, and the failing leg is NAMED so the
// census can count it.
//
//   S1  SELLER-ONLY   the stored title's ONLY autograph witness is a known
//                     seller/shop token. Strip the shop name and ask again: if
//                     something else still states an autograph ("Bowman Chrome
//                     Prospect Autographs ... AutographDen"), this is a real
//                     auto the shop happened to sell, and the row STAYS.
//   S2  STORED-AUTO   the row is actually stored isAuto=true. This subclass
//                     repairs a wrong flag; it never sets one.
//   S3  BACKED        the CHECKLIST row for (year, setKey, cardNumber) exists,
//                     from a REAL SCRAPED SOURCE (the same named allowlist L3
//                     uses -- `isStrictChecklistSource`), and says the card is
//                     NOT an autograph. This is the leg that makes the
//                     subclass EVIDENCE rather than inference, and it is the
//                     leg the mutation pin drops. A row with NO checklist
//                     stays CONFLICT: absent beats wrong, exactly as L5.
//   S4  NUMBER        the cardNumber is not itself an auto-subset number
//                     (CPA-, BCPA-, BDA-, ...). CF-ISAUTO-BOUNDARY-IS-
//                     CARDNUMBER is the ruling this whole area runs on: the
//                     card number is SUFFICIENT evidence of an autograph and
//                     it outranks the title in both directions. If the number
//                     says auto, no title reading may take the flag off.
//   S5  IDENTITY      every axis EXCEPT isAuto is unchanged -- grade, parallel,
//                     cardNumber, setKey, year, sport, printRun. `isAuto` is
//                     the one axis this subclass exists to move; a derivation
//                     moving any other is disagreeing about identity, not
//                     reading a shop name the old parser mistook for a
//                     signature, and a fleet never settles that.
//
// WHY `autographics` IS NOT A SELLER TOKEN. It looks exactly like one and is
// not: it is Skybox's autograph INSERT SET (1996-97 Skybox Premium
// Autographics, 2004-05 Skybox Autographics, 2006 Flair Showcase
// Autographics), 190 rows in the corpus. Naming it a shop would strip the flag
// off real autographs. The seller list is DERIVED FROM THE CORPUS -- over
// 61,793 titles carrying the letters, `autographden` is the one seller token
// that appears -- never invented, because a speculative list of store suffixes
// is vocabulary the data does not support.
//
// G1-G6 STILL APPLY, exactly as for SPECIALIZATION-STATED: the subclass rides
// the IMPROVE arm and is evaluated ALONGSIDE `allImproveRefusals` and the
// provenance tier, every one of which can still refuse it. It widens WHICH
// ROWS REACH the IMPROVE gate; it does not weaken the gate.
const SELLER_NAME_AUTO = "SELLER-NAME-AUTO";

/**
 * THE AUTOGRAPH WITNESS, MIRRORED.
 *
 * `parseTitleIdentity.service.ts` is the authority and stays that way. This
 * module is pure .cjs by contract -- no dist/, no TypeScript, so a unit test
 * can drive the classifier without a build -- so the witness shape is mirrored
 * here and `sellerNameAutoRepair.test.ts` pins the mirror against the compiled
 * export, character for character. A mirror nothing compares is a second
 * source of truth; a mirror a test compares is a cache. #1753 is the precedent
 * and the reason: the Fleer ladder shipped in the authority and never reached
 * the mirror, so the gate it armed could not be read by the classifier that
 * production actually runs.
 */
const AUTO_WITNESS_RE = /\bauto\b|\bautograph(?:ed|s)?\b|\bautographics\b|hard[-\s]signed/i;

/** The seller/shop tokens, mirrored from `SELLER_SHOP_TOKEN_RE`. Corpus-
 *  derived, and `autographics` is deliberately absent -- it is a real Skybox
 *  insert set, not a store. */
const SELLER_SHOP_TOKEN_RE = /\bautographden\b/i;

/** THE DEFECTIVE SHAPE, KEPT ON PURPOSE. `autograph` unbounded -- the exact
 *  regex that minted the 102,621 stored rows. It is what "this row's flag came
 *  from a shop name" MEANS, so the repair has to be able to state it. Without
 *  it the predicate is unanswerable: under the FIXED witness `AutographDen` is
 *  already not a witness, so "strip the shop and the witness disappears" is
 *  false for every row and the subclass would never fire on the population it
 *  exists to repair. */
const LEGACY_AUTO_WITNESS_RE = /\bauto\b|autograph|hard[-\s]signed/i;

/** S1. True when the title's ONLY autograph witness is a seller/shop token --
 *  i.e. the OLD detector called this an autograph, and the only reason it did
 *  is the shop name. Strip the shop and ask the old question again: if nothing
 *  is left that the legacy reader would have called an autograph, the shop
 *  name was the whole case.
 *
 *  Asked against the LEGACY shape deliberately. The fixed witness is the right
 *  question for a NEW title; for a STORED row the right question is "what did
 *  the reader that wrote this flag see?", and that reader is the defective
 *  one. */
function autographWitnessIsSellerNameOnly(title) {
  const t = str(title);
  if (!t || !SELLER_SHOP_TOKEN_RE.test(t)) return false;
  const withoutShop = t.replace(new RegExp(SELLER_SHOP_TOKEN_RE.source, "gi"), " ");
  return LEGACY_AUTO_WITNESS_RE.test(t) && !LEGACY_AUTO_WITNESS_RE.test(withoutShop);
}

/**
 * The five legs. `checklistSaysNotAuto` is the caller's read of the CHECKLIST
 * row for this (year, setKey, cardNumber) -- a catalog read, so the runner
 * supplies it and this module stays pure:
 *
 *   true   a checklist row from a real scraped source exists and is NOT an auto
 *   false  a checklist row exists and IS an auto -- the seller sold a real one
 *   null   no checklist row, or no strictly-sourced one. UNANSWERED, which is
 *          a refusal: absent beats wrong.
 */
function sellerNameAutoEvidence({
  row, stored, derived, axes,
  checklistSaysNotAuto = null,
  autoByCardNumber = false,
}) {
  const failed = [];
  const title = str(row?.title);

  // S1 -- the shop name is the whole case.
  const sellerOnly = autographWitnessIsSellerNameOnly(title);
  if (!sellerOnly) failed.push("autograph-witness-is-not-seller-only");

  // S2 -- the row really does carry the wrong flag.
  if (stored?.isAuto !== true) failed.push("stored-is-not-auto");

  // S3 -- the checklist decides, and it must say NOT an auto.
  if (checklistSaysNotAuto === null) failed.push("checklist-unknown");
  else if (checklistSaysNotAuto === false) failed.push("checklist-says-auto");

  // S4 -- the cardNumber outranks every title reading, in BOTH directions.
  if (autoByCardNumber) failed.push("cardnumber-is-auto-subset");

  // S5 -- nothing but isAuto may move.
  const moved = [...(axes?.changed ?? []), ...(axes?.dropped ?? [])].filter((a) => a !== "isAuto");
  if (moved.length) failed.push(`identity-axis-moved:${moved.join(",")}`);

  return {
    qualifies: failed.length === 0,
    failed,
    evidence: {
      sellerWitnessOnly: sellerOnly,
      storedIsAuto: stored?.isAuto === true,
      checklistSaysNotAuto,
      autoByCardNumber,
    },
  };
}

const SPECIALIZATION_STATED = "SPECIALIZATION-STATED";

/**
 * THE PRODUCT-FAMILY LADDER, MIRRORED.
 *
 * `productSetKeys.ts` is the authority and stays that way. This module is pure
 * .cjs by contract -- no dist/, no TypeScript, so a unit test can drive the
 * classifier without a build -- so the parent edges this subclass needs are
 * mirrored here, and `rematchSpecializationStated.test.ts` pins the mirror
 * against `productAncestry()` edge by edge. A mirror nothing compares is a
 * second source of truth; a mirror a test compares is a cache.
 *
 * Only the edges REACHABLE BY THIS SUBCLASS are mirrored -- a specialization
 * whose distinguishing words a title can state. Adding an edge here does not
 * make a row writable on its own: L2 through L5 still have to hold.
 */
const SPECIALIZATION_PARENTS = Object.freeze({
  // -- Topps: the products #1715's parser learned to read ------------------
  "topps-traded": "topps",
  "topps-traded-tiffany": "topps-traded",
  "topps-tiffany": "topps",
  // -- Bowman: `bowman-tiffany` is a normalizeSetKey fixed point and a ruled
  //    DISTINCT key (setkey-reconciliation.json: 453 catalog rows, 1989-1991,
  //    "product-family collapse -- `bowman` is an ancestor of
  //    `bowman-tiffany`") but productSetKeys.ts carries NO entry for it, so
  //    `productAncestry` returns ["bowman-tiffany"] alone and L1 would fail.
  //    The edge is mirrored here and the test asserts EXACTLY this exception,
  //    so the day the table gains the entry the pin says so rather than
  //    silently agreeing.
  "bowman-tiffany": "bowman",
  // -- Fleer: the coated reprints #1748 minted checklists for (5,357 cards).
  //    Unlike `bowman-tiffany` these ARE productSetKeys.ts entries with the
  //    immediate parents named here, so they are mirrored, not excepted.
  "fleer-tiffany": "fleer",
  "fleer-glossy": "fleer",
  "fleer-update-tiffany": "fleer-update",
  "fleer-update-glossy": "fleer-update",
  "fleer-tradition-tiffany": "fleer-tradition",
  // -- The 1990s baseball products the IMPROVE gate audit of #1758 found the
  //    rematch could not place. All are productSetKeys.ts entries whose
  //    immediate `parent` is named here, so they are mirrored, not excepted.
  //
  //    DELIBERATELY ABSENT FROM SAME_NUMBER_PARALLEL_SETS BELOW, unlike every
  //    Tiffany above: a coated reprint carries the paper card's number, and
  //    these do not. Score Rookie & Traded numbers `1T-110T` where flagship
  //    Score numbers `1-893`; SP, SP Championship, Upper Deck Minors, Pacific
  //    Prism and Crown Collection each run their own 1-N. The number still
  //    carries information here, so L5's strict test must keep asking -- which
  //    is exactly the `topps -> topps-traded` reasoning the note above states.
  "sp": "upper-deck",
  "sp-championship": "upper-deck",
  "upper-deck-minors": "upper-deck",
  // -- Black Diamond (R3, 2026-09-04). The same shape as `sp` directly above,
  //    and it was the one Upper Deck child the ladder could not see: the key
  //    is ALREADY a declared DISTINCT product (DISTINCT_PRODUCT_SETKEYS), a
  //    ruled collapse pair (`upper-deck-black-diamond -> upper-deck`, 8,546
  //    est rows) and a productSetKeys.ts entry whose `parent` is `upper-deck`
  //    — every table but this one. `specializationAncestry` reads ONLY the
  //    mirror, so the ladder returned [] and L1 failed on rows every other
  //    table agrees about.
  //
  //    Measured read-only on prod 2026-09-04: 12 sold_comps rows for 1999
  //    #D24 (Ken Griffey Jr.), every one stored at
  //    `hiq:baseball:1999:upper-deck:d24:base:no-auto` while their own titles
  //    say "1999 Upper Deck Black Diamond" / "1999 UD Black Diamond
  //    Dominance". normalizeSetKey already reads all of those spellings as
  //    `upper-deck-black-diamond`; only the stored slug is stale.
  //
  //    NOT in SAME_NUMBER_PARALLEL_SETS, deliberately, for the reason the note
  //    above gives for `sp`: Black Diamond runs its own D-prefixed numbering
  //    (#D24) against the flagship's plain 1-N, so the number still carries
  //    information and L5 must keep asking whether the flagship lists it.
  "upper-deck-black-diamond": "upper-deck",
  "score-rookie-and-traded": "score",
  "pacific-prism": "pacific",
  "pacific-crown-collection": "pacific",
  "pacific-gold-crown-die-cuts": "pacific",
});

/** The keys whose ladder edge this module mirrors from productSetKeys.ts --
 *  everything above except the documented `bowman-tiffany` exception. */
const LADDER_MIRRORED_KEYS = Object.freeze(
  Object.keys(SPECIALIZATION_PARENTS).filter((k) => k !== "bowman-tiffany"),
);

/**
 * SAME-NUMBER PARALLEL SETS, MIRRORED from productSetKeys.ts.
 * (CF-A-TIFFANY-SALE-IS-A-TIFFANY-CARD read onto L5 -- Drew, 2026-09-04.)
 *
 * A Tiffany/Glossy-style set is the flagship's checklist REPRINTED card for
 * card ON THE SAME NUMBERS. For those families L5's question -- "does the
 * stored flagship's own checklist list this cardNumber?" -- is always YES and
 * always uninformative: the number is shared BY DESIGN, so it cannot separate
 * the two cards and only the title can. Refusing on that answer refused the
 * whole family by construction: 6,113 rows measured 2026-09-04, 7,076
 * topps -> topps-tiffany and 794 bowman -> bowman-tiffany by key pair.
 *
 * Drew ruled it already (eed10b9b, "a Tiffany sale is a Tiffany card", 2,760
 * rows out of the base pools): a sale whose title says Tiffany belongs to the
 * Tiffany product. Where the number is uninformative the title IS the
 * evidence -- and it is sufficient only because L3 still demands the CHILD'S
 * OWN checklist row from a real scraped source. That is what keeps the
 * synthetic `derived-from-base-checklist-*` rows (all 453 `bowman-tiffany`
 * catalog rows carry exactly that source) from qualifying, and it is why this
 * widening moves 1987's 735 hand-verified Tiffany rows and leaves the rest
 * PENDING a checklist rather than writing them on a name.
 *
 * ONLY THE DECLARED PAIRS SKIP L5. Every other family keeps the strict test:
 * `topps -> topps-traded` is separated by the number (#70T is not #70) and
 * must stay separated, and `o-pee-chee` is a different product with its own
 * numbering, not a parallel set, so its number still carries information.
 *
 * The mirror is a cache, not a second source of truth --
 * `rematchSpecializationStated.test.ts` pins every entry against
 * `isSameNumberParallelSet` in productSetKeys.ts, pair by pair, and pins that
 * neither table has an entry the other lacks.
 */
const SAME_NUMBER_PARALLEL_SETS = Object.freeze([
  Object.freeze({ setKey: "topps-tiffany", parent: "topps" }),
  Object.freeze({ setKey: "topps-traded-tiffany", parent: "topps-traded" }),
  Object.freeze({ setKey: "bowman-tiffany", parent: "bowman" }),
  // The Fleer coated reprints (#1748): the Tiffany/Glossy card carries the
  // paper card's number, so the number cannot tell them apart and only the
  // title can. 1996 Fleer Tiffany lists #1-600 and so does 1996 Fleer.
  Object.freeze({ setKey: "fleer-tiffany", parent: "fleer" }),
  Object.freeze({ setKey: "fleer-glossy", parent: "fleer" }),
  Object.freeze({ setKey: "fleer-update-tiffany", parent: "fleer-update" }),
  Object.freeze({ setKey: "fleer-update-glossy", parent: "fleer-update" }),
  Object.freeze({ setKey: "fleer-tradition-tiffany", parent: "fleer-tradition" }),
]);

/** Does `derivedKey` reprint `storedKey`'s checklist on `storedKey`'s own card
 *  numbers? Only then may L5 stop asking whether the flagship lists the
 *  number -- because for these families the answer is yes by construction. */
function isSameNumberParallelSet(derivedKey, storedKey) {
  const d = lower(derivedKey), s = lower(storedKey);
  if (!d || !s) return false;
  return SAME_NUMBER_PARALLEL_SETS.some((e) => e.setKey === d && e.parent === s);
}

/** Every ancestor of `setKey` under the mirrored ladder, nearest first. */
function specializationAncestry(setKey) {
  const out = [];
  let cur = lower(setKey);
  const seen = new Set([cur]);
  for (;;) {
    const parent = SPECIALIZATION_PARENTS[cur];
    if (!parent || seen.has(parent)) break;
    out.push(parent);
    seen.add(parent);
    cur = parent;
  }
  return out;
}

/** L1. Is `derived` a strict descendant of `stored` on the ladder? */
function isSpecializationOf(derivedKey, storedKey) {
  const d = lower(derivedKey), s = lower(storedKey);
  if (!d || !s || d === s) return false;
  return specializationAncestry(d).includes(s);
}

/**
 * L2. The words that distinguish the derived key from the stored one, each of
 * which the title must state.
 *
 * Computed from the SEGMENTS, not from a hand list: `topps-traded-tiffany`
 * minus `topps` is {traded, tiffany}, and `topps-traded-tiffany` minus
 * `topps-traded` is {tiffany}. A hand list would need editing for every new
 * edge and would silently under-demand on the one it forgot.
 */
function distinguishingWords(derivedKey, storedKey) {
  const d = lower(derivedKey).split("-").filter(Boolean);
  const s = new Set(lower(storedKey).split("-").filter(Boolean));
  return d.filter((w) => !s.has(w));
}

/** Does the title state this word, whole, case-insensitively?
 *
 *  AN APOSTROPHE IS SPELLING, NOT IDENTITY (GUARD 7, 2026-09-04).
 *
 *  A setKey segment cannot carry punctuation, so `bowmans-best` is how the
 *  catalog spells a product every seller writes "Bowman's Best". The word
 *  this function is asked about is therefore `bowmans`, and `\bbowmans\b`
 *  never matches "Bowman's" -- the apostrophe IS a word boundary, so the
 *  regex sees "bowman" then "s" and stops.
 *
 *  The cost was measured on the slot-19 census. GUARD 6 refuses an IMPROVE
 *  when a declared CHILD of the derived key has EVERY distinguishing word
 *  stated in the title; for `bowmans-best` those words are ["bowmans",
 *  "best"], "best" matched, "bowmans" did not, so the guard stood down and
 *  a whole product family collapsed into its flagship unexamined:
 *
 *    "2022 Bowman's Best Baseball #20 Base"        -> bowman:20:base
 *    "2022 Bowman's Best #B22-SK Blue Refractor"   -> bowman-chrome:B22:...
 *
 *  Bowman's Best is a DISTINCT_PRODUCT_SETKEYS entry and a ruled distinct
 *  key (est. 200,863 rows); folding its sales into `bowman` splits no pool,
 *  it merges two products' pools, which corrupts both FMVs.
 *
 *  So a title's apostrophes and the U+2019 curly form are treated as absent
 *  when they sit INSIDE a word. Deliberately a normalization of the TITLE
 *  and not a looser word regex: stripping the mark makes "Bowman's" read as
 *  "Bowmans" and match, while every other boundary the `\b` anchors still
 *  holds, so "Bowmans Best" and "Bowman Best" keep answering exactly as they
 *  do today and no new word can start matching mid-token. */
function titleStatesWord(title, word) {
  if (!word) return false;
  const w = String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${w}\\b`, "i");
  const t = String(title ?? "");
  if (re.test(t)) return true;
  // Only an apostrophe BETWEEN two letters is spelling; a leading or trailing
  // quote mark is punctuation around the word and its boundary must stand.
  const unapostrophed = t.replace(/(?<=\p{L})['’](?=\p{L})/gu, "");
  return unapostrophed !== t && re.test(unapostrophed);
}

/**
 * The SPECIALIZATION-STATED evidence for one row. Returns
 * `{ qualifies, failed, evidence }` in the same shape as the eviction
 * evidence, so the census can count a near miss BY THE LEG IT FAILED.
 *
 * `failed` is the AUDIT PRODUCT. A subclass that only said yes or no would
 * leave the census unable to answer "how many rows are one checklist away",
 * which is exactly the question the 1984-1991 Topps Traded Tiffany checklist
 * is being staged to answer.
 */
function specializationStatedEvidence({
  row, stored, derived, axes,
  derivedBacked = false,
  storedFlagshipListsCardNumber = null,
}) {
  const failed = [];
  const title = str(row?.title);
  const storedKey = lower(stored?.setKey), derivedKey = lower(derived?.setKey);

  // L1 -- the ladder, and only the ladder.
  const ladder = isSpecializationOf(derivedKey, storedKey);
  if (!ladder) failed.push("not-a-ladder-specialization");

  // L2 -- every distinguishing word, stated in the title. Only meaningful
  // once the ladder holds; on a non-ladder pair the segment difference is not
  // a specialization's words and naming it would be a misleading count.
  const words = ladder ? distinguishingWords(derivedKey, storedKey) : [];
  const unstated = words.filter((w) => !titleStatesWord(title, w));
  if (ladder && !words.length) failed.push("no-distinguishing-words");
  else if (unstated.length) failed.push(`title-does-not-state:${unstated.join("+")}`);

  // L3 -- the DERIVED identity is checklist-backed by a real scraped source.
  if (!derivedBacked) failed.push("derived-not-checklist-backed");

  // L4 -- the axes that say WHICH CARD are unchanged. `setKey` is the one axis
  // this subclass exists to move; every other changed or dropped axis is the
  // derivation disagreeing about identity.
  const moved = [...(axes?.changed ?? []), ...(axes?.dropped ?? [])].filter((a) => a !== "setKey");
  if (moved.length) failed.push(`identity-axis-moved:${moved.join(",")}`);

  // L5 -- the stored flagship's own checklist must NOT list this number.
  // `null` means the caller could not answer, and an unanswered gate is a
  // refusal: absent beats wrong.
  //
  // UNLESS the pair is a DECLARED SAME-NUMBER PARALLEL SET, in which case the
  // question is not merely answered YES, it is MEANINGLESS: a Tiffany set
  // reprints the flagship's checklist on the flagship's own numbers, so the
  // number is shared by design and cannot separate the two cards. Asking it
  // there refuses the family by construction -- which is the 6,113 rows Drew
  // ruled on 2026-09-04. The declaration is the ONLY thing that turns L5 off,
  // it lives in productSetKeys.ts, and every undeclared family keeps the
  // strict test. What still has to hold for a declared pair is L3: the CHILD'S
  // own checklist row, from a real scraped source. The title says which
  // product; the checklist says the card was printed. Both, or neither.
  const sameNumberParallel = ladder && isSameNumberParallelSet(derivedKey, storedKey);
  if (!sameNumberParallel) {
    if (storedFlagshipListsCardNumber === null) failed.push("flagship-coverage-unknown");
    else if (storedFlagshipListsCardNumber === true) failed.push("flagship-checklist-lists-this-card");
  }

  return {
    qualifies: failed.length === 0,
    failed,
    evidence: {
      storedSetKey: storedKey, derivedSetKey: derivedKey,
      distinguishingWords: words, unstatedWords: unstated,
      derivedBacked, storedFlagshipListsCardNumber,
      sameNumberParallelSet: sameNumberParallel,
    },
  };
}

/**
 * The three IMPROVE guards the audit demanded. Returns a list of refusals;
 * empty means the IMPROVE may proceed to the tier gate.
 *
 * CF-IMPROVE-IS-NOT-SAFE (audit gate, 2026-09-03). The IMPROVE class was
 * treated as the safe one and shipped without a title check of its own. The
 * audit found it minting parallels out of PRODUCT words over titles that say
 * "Base" -- "2024 Topps Heritage Chrome #399 Base" deriving parallel=Chrome,
 * "Topps Chrome Black #191 Base" deriving Black Refractor -- and filling print
 * runs onto Base rows from unrecognized qualifiers, minting numbered base
 * cards the checklist never listed ("Tie-Dye Prizm #/25" -> Base:/25,
 * "Disco /75" -> Base:/75).
 */

/**
 * IS THIS FINISH WITNESS STRONG ENOUGH TO REFUSE A WRITE?
 *
 * CF-A-COLOUR-IS-NOT-A-FINISH-CLAIM (GATE 3 slot-31 audit, 2026-09-04). The
 * per-card vocabulary answers "could this word name a parallel of some
 * product?", which is the right question for `titleNamesFinish` and TOO WIDE
 * to refuse a write on. Measured over the 374 evidence rows of run
 * 33915911825, refusing on ANY witness refuses 222 of them -- the witnesses
 * include `astros`, `hof`, `two`, `championship`, `leaders` and `larry`,
 * because a product with no corpus slice falls through to the 1,465-word
 * global token set, where a team name that is somebody's parallel colour
 * elsewhere reads as a finish here.
 *
 * NARROWING TO THE ADJUDICATED CORE cuts that to 33 and is still wrong, and
 * the residue is the interesting part -- every remaining false positive is a
 * BARE COLOUR standing for a person or a team:
 *
 *   "1978 Topps #20 Pete Rose"                 witness `rose`   (8 rows)
 *   "1995 Bowman Nomar Garciaparra #249 Red Sox"  witness `red`
 *   "Roberto Alomar 1995 Bowman #368 Blue Jays"   witness `blue`
 *
 * Refusing those would cost eight genuine improvements on one of the most
 * traded vintage cards there is, and a FALSE refusal is a repair nobody can
 * find -- the same cost GUARD 6's singular/plural note weighs.
 *
 * SO THE WITNESS MUST NAME A FINISH, NOT MERELY A COLOUR. A colour qualifies
 * only in company: "Silver Foil" and "Gold Signature" are finishes, "Rose" and
 * "Blue" are a man and a bird. This is the same ruling GUARD 6 makes one
 * screen up ("A COLOUR IS NOT A PRODUCT NAME") applied to the finish axis, and
 * it is why `signature` had to enter the vocabulary as the PHRASE "gold
 * signature" rather than as a token.
 *
 * Measured with this rule on the same 374 rows: 15 refusals, and every one of
 * them is a real product or a real parallel -- 11 Pacific Prism, 3 Topps Mini
 * (both of which GUARD 6 independently refuses, so this guard is not carrying
 * them alone), plus the Silver Foil and Gold Signature rows that no other
 * guard sees. Zero false positives.
 */
const FINISH_NOUNS = new Set(
  [...VOCAB.CORE_FINISH_TOKENS, ...VOCAB.FINISH_FAMILY_TOKENS, ...VOCAB.HAND_SPELLINGS]
    .map((w) => lower(w)),
);
function finishWitnessIsNamed(witness) {
  const parts = lower(witness).split(/[\s-]+/).filter(Boolean);
  if (!parts.length) return false;
  // Every word must be vocabulary this module recognises -- a phrase carrying
  // an unrecognised word is a corpus artifact, not a finish name...
  if (!parts.every((p) => FINISH_NOUNS.has(p) || FAMILY_COLOURS.has(p))) {
    // ...unless the WHOLE phrase is a hand-listed one, which is a measured
    // claim about a real parallel and outranks the token test that could not
    // see it ("gold signature": `signature` is a corpus stopword by design).
    return VOCAB.HAND_PHRASES.includes(lower(witness));
  }
  // ...and at least one of them must be a FINISH, not just a colour.
  return parts.some((p) => FINISH_NOUNS.has(p));
}

/**
 * NON-CARD FORMATS -- the things sold in the hobby that are NOT cards
 * (GATE 3 slot-31 audit, Drew 2026-09-04: "a Pog is not a card").
 *
 * A milk cap, a pog, a disc, a coin, a pin and a sticker are collectibles a
 * card brand printed and a card seller lists, and the derivation reads the
 * brand and the `#N` off them exactly as it reads a card's:
 *
 *   "1995 UD Upper Deck Michael Jordan PSA 9 #1 Milk Cap"  -> upper-deck:1
 *   "Michael Jordan 1995 UD Upper Deck #9 Milk Caps Pog"   -> upper-deck:9
 *
 * `upper-deck:1` is a CARD -- a different player's card -- and a pog's price
 * in that pool is a number the card never sold for. The format is not a
 * parallel of the card and not a lesser reading of it; it is a different
 * object that happens to carry a number.
 *
 * THE RULE IS NEVER MINT, NOT NEVER MENTION. The refusal is on the WRITE, and
 * only when the destination key is not itself the non-card product. That
 * matters because several non-card formats ARE declared products with their
 * own catalog rows -- `topps-coins` (49 rows), `king-b-discs` (301),
 * `sportflics-superstar-discs` (20), `topps-stickers` (2,070), measured
 * 2026-09-04 -- and a row ALREADY correctly filed on one of those is right
 * where it is. Refusing it would be the mirror of the defect: a guard that
 * cannot tell "this pog belongs on the pog product" from "this pog belongs on
 * the card" would drive both to the same place.
 *
 * So the destination is asked first. If the key the write would land on
 * already NAMES the format -- its segments contain the matched word -- the
 * guard stands down and the ordinary gates decide. Otherwise the write is
 * refused and the row stays exactly where it is, reported to Drew, which is
 * what "never mint" means here: the classifier does not create the pog product
 * and does not move the row onto it. A checklist for these formats is a
 * separate acquisition, and until one exists the honest answer is absence.
 *
 * DELIBERATELY NOT `-cards`-suffixed formats. "Trading Card Game", "card" and
 * "insert" are card words and are absent from this list; every entry here is
 * an object you cannot put in a nine-pocket page.
 */
const NON_CARD_FORMAT_RE = /\b(?:milk[\s-]?caps?|pogs?|slammers?|discs?|coins?|pins?|stickers?|decals?|tattoos?|magnets?|bottle[\s-]?caps?)\b/i;

/** The non-card format word this title states, or null. */
function nonCardFormatNamed(title) {
  const m = NON_CARD_FORMAT_RE.exec(String(title ?? ""));
  return m ? lower(m[0]).replace(/[\s-]+/g, "-") : null;
}

/** Does `setKey` itself name this format? A key whose segments carry the
 *  format's own word IS the format's product, and a row there is filed
 *  correctly. Compared on the SINGULAR stem in both directions, the same
 *  spelling-not-identity rule GUARD 6 uses: `topps-coins` names "coin". */
function setKeyNamesFormat(setKey, format) {
  if (!setKey || !format) return false;
  const segs = new Set(lower(setKey).split("-").filter(Boolean));
  const stem = (w) => (w.endsWith("s") ? w.slice(0, -1) : w);
  // "milk-caps" arrives hyphenated; every one of its words must be present.
  const words = format.split("-").filter(Boolean);
  return words.every((w) => segs.has(w) || segs.has(stem(w)) || segs.has(`${stem(w)}s`));
}

function improveRefusals({ row, stored, derived, axes, parserSaysLot = false }) {
  const refusals = [];
  const title = str(row?.title);
  const year = derived?.cardYear ?? stored?.cardYear ?? null;
  const setKey = derived?.setKey ?? stored?.setKey ?? "";

  // GUARD 1: never mint a parallel out of a PRODUCT word over a title that
  // says Base or names no finish at all.
  //
  // The parallel axis only matters here when the derivation FILLED it -- a
  // parallel the stored row already named is not this shape.
  if (axes.filled.includes("parallel")) {
    const parallel = str(derived?.parallel);
    const pTokens = VOCAB.nameTokens(parallel);
    const fromProductWord = pTokens.length > 0 && pTokens.every((t) => VOCAB.isProductWord(t, setKey));
    const titleSaysBase = /\bbase\b/i.test(title);
    const titleNamesAFinish = title ? titleNamesFinish(title, { year, setKey }) : false;
    if (fromProductWord && (titleSaysBase || !titleNamesAFinish)) {
      refusals.push(`improve-parallel-from-product-word:${parallel}@${setKey}`);
    }
    // A derived parallel the product's own checklist does not list is not
    // checklist-backed AS A PARALLEL, whatever the destination row's source
    // says. The corpus is the same evidence the destination gate reads.
    else if (!titleNamesAFinish && titleSaysBase) {
      refusals.push(`improve-parallel-over-explicit-base:${parallel}`);
    }
  }

  // GUARD 2: never fill a print run onto a Base/blank parallel unless the
  // product's checklist actually defines a numbered base AT THAT PRINT RUN.
  //
  // CF-NUMBERED-BASE-IS-CHECKLIST-DEFINED (Drew's ruling). A numbered base
  // card exists only where the product's checklist says so. "Tie-Dye Prizm
  // #/25" is a Tie-Dye Prizm numbered to 25, not a base card numbered to 25 --
  // and the parser that could not read "Tie-Dye Prizm" as a parallel is
  // exactly the parser whose print run should not be trusted onto a base row.
  //
  // TWO DEFECTS FIXED HERE, AND THEY WERE STACKED (second audit gate, leak 7
  // -- 13 lines minted a numbered base the checklist never listed).
  //
  // 1. THE CHECKLIST BRANCH WAS UNREACHABLE. The two branches used to run
  //    finish-word-first, and `titleNamesFinish` opens with
  //    `if (titleStatesSerial(t)) return true` -- a title stating a print run
  //    names a finish BY DEFINITION in that predicate. So on every path where
  //    `serial !== null`, `namesAFinish` was also true, the first branch always
  //    won, and the numbered-base refusal never fired at all.
  //
  // 2. ITS TEST COULD NOT HAVE ANSWERED THE QUESTION EITHER WAY. It asked
  //    `checklistListsParallel("Base", year, setKey)`, a TOKEN-membership
  //    test -- and `base` is a CORPUS STOPWORD, so `nameTokens("base")` is the
  //    EMPTY list and that function's own `if (!toks.length) return false`
  //    fires. It answered FALSE for every product in the corpus (measured: all
  //    576), not true, as the first write-up of this leak claimed.
  //
  //    THAT CORRECTION CHANGES WHAT THIS SWAP IS. `!false` is true, so the old
  //    predicate ALSO refused every numbered base -- it simply refused for the
  //    wrong reason (an empty token list) rather than the ruled one (no
  //    checklist defines one). So replacing it is a HARDENING, not the fix:
  //    the defect that actually made these 13 lines writable was defect 1, the
  //    unreachable branch. What the swap buys is that the guard now asks the
  //    question the ruling states, and can therefore ADMIT a numbered base the
  //    day a checklist lists one -- which the old predicate could never do.
  //
  //    Because both predicates answer false everywhere on the committed
  //    corpus, a mutation reverting this one is invisible to it. The pin that
  //    catches it supplies a fixture corpus whose Base row carries a print run
  //    (tests/rematchAuditGateLeaks.test.ts, "a checklist that DOES define a
  //    numbered base"), where the two disagree and the revert goes red.
  //
  // The ruling is a claim about a CARD, and a card is a (name, print run)
  // pair, so the question is asked that way: does this product's checklist
  // list a Base row carrying THIS run? `checklistDefinesNumberedBase` reads
  // the corpus's own printRun field to answer it. Measured on the committed
  // corpus: 36,699 parallel rows, 27,009 with a print run, and ZERO whose name
  // is bare "Base" -- so today the guard refuses every numbered base, which is
  // the ruling applied. A future checklist that lists one is admitted without
  // a code change.
  //
  // The checklist test is asked FIRST because it is the stronger claim. When
  // the checklist DOES define the numbered base, the older question -- "did
  // the title also name a finish the derivation dropped?" -- is the right
  // follow-up, and it is kept below, now reachable.
  if (axes.filled.includes("printRun")) {
    const destParallel = axisValue(derived, "parallel");
    if (axisIsBlank("parallel", destParallel)) {
      const serial = VOCAB.serialFromTitle(title);
      const namesAFinish = title ? titleNamesFinish(title, { year, setKey }) : false;
      if (serial !== null && !VOCAB.checklistDefinesNumberedBase(year, setKey, serial)) {
        refusals.push(`improve-numbered-base-not-checklist-defined:/${serial}`);
      } else if (serial !== null && namesAFinish) {
        // The run belongs to the parallel the title names and the derivation
        // could not read, not to the base card that shares its number.
        refusals.push(`improve-printrun-onto-base-with-unrecognized-qualifier:/${serial}`);
      }
    }
  }

  // GUARD 4: THE DERIVED PARALLEL MUST CARRY EVERY FINISH FAMILY THE TITLE
  // NAMES (first audit gate, leak 1 -- 22 writable IMPROVE lines).
  //
  // CF-A-NAMED-PARALLEL-IS-A-DISTINCT-CARD. GUARD 1 above refuses a parallel
  // built ENTIRELY of product words; nothing compared the derived parallel
  // against the finish family the TITLE names. So a derivation that read
  // "BLACK WAVE /10" and answered "Black Refractor" passed every gate: the
  // parallel is not a product word, the title does not say Base, the title
  // DOES name a finish, and the destination is checklist-backed -- because
  // 2025 topps-chrome football lists Black Refractor too. It lists Black WAVE
  // Refractor as well. Those are two cards.
  //
  // Every leak of this shape is a SIBLING, not a demotion:
  //   "BLACK WAVE /10"           -> Black Refractor
  //   "Pink Wave"                -> Pink Refractor
  //   "Yellow Vapor /75"         -> Yellow Refractor   (2023 bowman-chrome has
  //                                                     NO plain Yellow Refractor)
  //   "Aqua Equinox"             -> Aqua Refractor
  //   "Black Etch SSP"           -> Black Refractor
  //   "Etched In Glass Variation"-> Image Variation     (both listed separately)
  //   "Shimmer Refractors"       -> Refractor
  //   "Fuchsia Wave"             -> Fuchsia Refractor
  //   "Black Ray Wave"           -> Black Refractor
  //
  // The axis diff cannot see it: `parallel` moved from blank to a real name,
  // which is a FILL, which is an improvement by every test the classifier had.
  // The evidence that it is not is in the title, and it is one word.
  //
  // THE RULE, stated as the audit stated it: if the title names a finish-family
  // token the derived parallel LACKS, the write is refused. And when the
  // product's own checklist lists the title's exact family, the refusal NAMES
  // the row the write should have gone to -- a census is a diff before a write,
  // and a refusal that says "and here is the right answer" is what a repair
  // list is built from.
  //
  // Runs on ANY derived parallel, INCLUDING Base and blank. This is the
  // audit-gate residual: the guard shipped gated on
  // `!axisIsBlank("parallel", ...)`, which excludes exactly the answers "",
  // "base", "[base]", "none" and "unknown" -- so a derivation that read
  // "Purple Laser Refractor" or "Electric Etch" and answered BASE escaped the
  // guard entirely, while the same derivation answering the WRONG SIBLING was
  // caught. The comment claimed it ran on any derived parallel; it did not.
  //
  // THE BLANK ANSWER IS THE WORSE COLLAPSE. It drops the family AND the
  // colour, and the row it leaves behind is a numbered base -- the shape leak
  // 7 is about. It is also the answer that lets a cardNumber fill through:
  // GUARD 2 refuses only the printRun, so the same row's NUMBER still moved
  // onto the base slug. Running here refuses the whole IMPROVE, which is the
  // right scope -- a derivation that could not read the parallel has not
  // earned a write on any axis of this row.
  //
  // `familyTokensDroppedByDerivation` needs no change to carry it:
  // `parallelFinishFamilyTokens("")` is empty, so every family the title names
  // is dropped, which is the true answer. The blank is passed as "" rather
  // than the literal "Base" so a checklist parallel legitimately NAMED "Base
  // <family>" cannot be read as carrying that family.
  {
    const parallel = str(derived?.parallel);
    const derivedIsBlank = axisIsBlank("parallel", axisValue(derived, "parallel"));
    // The derivation must have PRODUCED an identity for this guard to have an
    // opinion: no identity at all is UNDERIVABLE, a different class. A blank
    // parallel VALUE on a real identity is the shape this now covers.
    if (title && derived) {
      const dropped = VOCAB.familyTokensDroppedByDerivation(title, derivedIsBlank ? "" : parallel, setKey);
      if (dropped.length) {
        const listed = VOCAB.checklistParallelForFamily(title, year, setKey);
        const shown = derivedIsBlank ? (parallel || "(blank)") : parallel;
        refusals.push(
          `improve-title-names-a-finish-family-the-derivation-dropped:${dropped.join("+")}` +
          `@${shown}${listed ? `|checklist-lists:${listed}` : ""}`,
        );
      }
    }
  }

  // GUARD 5: A LOT OR A RANGE LISTING NEVER MINTS A CARD NUMBER
  // (audit gates 1 and 2, leaks 2 and 6 -- 23 + 117 writable IMPROVE lines).
  //
  // CF-A-LOT-IS-NOT-A-CARD. A title selling many cards states no single card's
  // number, and the derivation read the FIRST number of a range as if it did:
  //
  //   "Complete Set #1-726"                 -> cardNumber 1
  //   "#1-150 Pick Your Cards"              -> cardNumber 1
  //   "Singles #1-251"                      -> cardNumber 1
  //   "#8-40 Insert"                        -> cardNumber 8
  //   "Lot 110 different #1-125"            -> cardNumber 1
  //   "Complete Set of 792 Cards ... #414"  -> cardNumber 692
  //   "LOT OF THREE (3)"
  //
  // Filing a lot's price on card #1 puts a whole box's price into one card's
  // pool, and the FMV that pool projects is a number that card never sold for.
  // The first number of a range is not even the most-represented card in the
  // sale -- it is an artifact of how the seller wrote the span.
  //
  // The refusal is on the cardNumber FILL specifically, because that is the
  // axis a lot title corrupts. The other axes a lot title fills (year, setKey,
  // sport) are read off product words and are as right as any other title's --
  // but a row whose cardNumber came from a range is not improvable at all
  // while the range is what named it, so the refusal is unconditional once the
  // title is a lot and the derivation filled or changed the number.
  //
  // The row is ALSO reported as an excludedFromFmv candidate: a multi-card
  // sale in a single card's pool is wrong wherever it sits, and refusing to
  // MOVE it does not make it right where it is. That is Drew's call, so the
  // classifier flags and the census counts -- it never sets the field.
  {
    const lot = VOCAB.isLotOrRangeListing(title, parserSaysLot === true);
    if (lot.lot) {
      const touchesNumber = axes.filled.includes("cardNumber") || axes.changed.includes("cardNumber");
      // A LOT WHOSE NUMBER WAS ALREADY WRONG IS STILL A LOT (shard-31 audit,
      // 2026-09-04). The `touchesNumber` condition assumed the derivation is
      // what puts a lot's price on a single card's number -- but when the
      // stored row ALREADY carries the range's first number, the re-derivation
      // fills only `setKey` and this guard stood down, so the row was writable
      // and the improvement filed a whole set's price into one card's pool:
      //
      //   "1995-96 Flair Hardwood Leaders Complete Set #1-27 Michael Jordan"
      //       stored unknown:1 -> flair:1   filled:setKey, number untouched
      //
      // Refusing only the number was the narrower reading of
      // CF-A-LOT-IS-NOT-A-CARD than the rule states. A multi-card sale does
      // not belong in ANY single card's pool, so no axis of it is improvable
      // while the title is a lot -- the same conclusion GUARD 6 reaches for a
      // row whose product cannot be read. The row stays reported (and still
      // flagged as an excludedFromFmv candidate, which is Drew's call), it is
      // simply never written.
      if (touchesNumber || axes.filled.includes("setKey") || axes.changed.includes("setKey")) {
        refusals.push(`improve-lot-or-range-listing:${lot.reasons.join(",")}`);
      }
    }
  }

  // GUARD 6: THE TITLE NAMES A PRODUCT THE DERIVED setKey DOES NOT CARRY.
  //
  // CF-A-BLANK-STORED-KEY-IS-NOT-A-LICENCE-TO-GUESS-THE-FLAGSHIP
  // (shard-31 IMPROVE audit, 2026-09-04 -- 105 of 287 sampled evidence rows
  // were WRONG, a 36.6% error rate on the one class that writes).
  //
  // WHY GUARD 3 COULD NOT SEE THESE. `derivationCollapsesProduct` compares the
  // STORED key against the DERIVED one, and it opens with
  // `if (!s || !d || s === d) return null`. Every row in the audit had a stored
  // key of "", "unknown" or "base-set" -- the blank shapes -- so the guard
  // returned null on its first line and the collapse it exists to refuse went
  // through unexamined. GENERIC_SETKEYS is precisely the set of stored values
  // that make Guard 3 blind, and it is also precisely the set that makes a row
  // IMPROVE-shaped in the first place (`filled:setKey` was 5,184 of the 5,208
  // IMPROVE rows on slot 31). The class that writes was therefore UNGUARDED ON
  // ITS DOMINANT SHAPE: the guard covered the case that cannot arise and
  // skipped the case that always does.
  //
  // THE EVIDENCE, by product family, from the committed shard-31 census log:
  //
  //   "1995 Pacific Prism Greg Maddux #4"        -> pacific:4:base
  //   "1995 Pacific Crown Collection Prisms #102" -> pacific:102:base
  //       1995 Pacific Prism is a STANDALONE 108-card set; Crown Collection
  //       Prisms is an INSERT of a different product. Neither is the 1995
  //       Pacific (Crown Collection) base set. 49 rows.
  //   "1995 Upper Deck SP Derek Jeter #181"      -> upper-deck:181:base
  //       1995 SP is its own product and #181 is a landmark rookie; the base
  //       1995 Upper Deck #181 is a different, far cheaper card. Folding the
  //       two pools together corrupts BOTH FMVs, in opposite directions.
  //   "1975 Topps Mini #616"                     -> topps:616:base
  //   "1989 Score Traded #100T"                  -> score:1:base
  //   "1995-96 Fleer Metal Nuts & Bolts #212"    -> fleer:212:base
  //   "1995 Pinnacle UC3 #73"                    -> pinnacle:73:base
  //
  // And on slot 19 (y=1987), the same shape reaches Drew's own holding:
  //   "1987 Topps Traded - Greg Maddux #70T Tiffany (RC)"
  //       -> topps-traded:70T:base -- the Tiffany DROPPED, against
  //       CF-A-TIFFANY-SALE-IS-A-TIFFANY-CARD. 7 sampled rows of this shape.
  //
  // THE RULE. A specialization is a (parent, distinguishing words) pair, and
  // both halves are already declared in this module -- RULED_COLLAPSE_PAIRS
  // and SPECIALIZATION_PARENTS name the children, `distinguishingWords` says
  // which words separate a child from its parent, and `titleStatesWord` asks
  // whether the title states one. So the guard asks a question with no new
  // vocabulary at all: IS THERE A DECLARED CHILD OF THE DERIVED KEY WHOSE
  // DISTINGUISHING WORD THIS TITLE STATES? If yes, the derivation answered the
  // PARENT to a title that names the CHILD, and the write is refused.
  //
  // IT REFUSES, IT DOES NOT REDIRECT. Naming the child it should have been is
  // the census's job and the refusal carries that name, but this arm never
  // moves the row there: the child's own checklist backing is what
  // SPECIALIZATION-STATED demands before a row may land on a specialization,
  // and that leg is not in evidence here. A row this guard refuses stays
  // CONFLICT/UNDERIVABLE -- reported to Drew, never written -- which is the
  // stated goal: the IMPROVE arm must never move a row onto a WRONG product,
  // and a row it cannot place RIGHT stays where it is.
  //
  // IT IS DELIBERATELY ONE-DIRECTIONAL. Only a DERIVED key that is a declared
  // PARENT is examined. A derivation that already answered the child
  // (`topps-traded-tiffany`) states the words itself and is not this shape, so
  // the Tiffany rows that SPECIALIZATION-STATED legitimately promotes are
  // untouched -- verified read-only on slot 19: 281 SPECIALIZATION-STATED
  // sample rows, and this guard refuses only the 7 that DROP the word.
  //
  // IT RUNS ON THE STORED KEY TOO, NOT ONLY THE DERIVED ONE -- THE FILL ARM
  // (GATE 3 slot-31 audit, 2026-09-04). Nine of the twelve wrong rows in that
  // audit changed NOTHING BUT `cardNumber`, because the stored setKey ALREADY
  // equalled the flagship and the re-derivation agreed with it:
  //
  //   "1995-96 Upper Deck Special Edition #31 Hakeem Olajuwon"
  //       upper-deck:?  ->  upper-deck:31      filled:cardNumber only
  //   "1995 UD Upper Deck Michael Jordan PSA 9 #1 Milk Cap"
  //       upper-deck:?  ->  upper-deck:1       filled:cardNumber only
  //   "1978 Topps Holsum #32 Ken Houston"
  //       topps:?       ->  topps:32           filled:cardNumber only
  //
  // Reading only `derived.setKey` was not wrong, it was HALF THE QUESTION. The
  // guard's rule is "the title names a child of this key and the derivation
  // answered the parent", and a derivation that answers the parent because the
  // STORED row already said the parent is the same collapse -- it simply
  // arrives with the setKey axis standing still. Filing Upper Deck Special
  // Edition #31 onto `upper-deck:31` puts Olajuwon's price in another player's
  // pool whether the key MOVED there or was already there.
  //
  // So the guard asks its question of BOTH keys, and refuses on either. The
  // union is deliberate rather than a switch on which axis moved: a rule that
  // depended on the axis diff would have to be re-derived every time a new
  // axis becomes fillable, and this one does not care WHICH field the write
  // touches -- a row whose product cannot be read has not earned a write on
  // any axis of it, the same conclusion GUARD 5 reaches for a lot.
  {
    const keys = [...new Set([lower(derived?.setKey), lower(stored?.setKey)].filter(Boolean))];
    if (keys.length && title) {
      const derivedSegs = new Set(lower(derived?.setKey).split("-").filter(Boolean));
      const children = [...new Set(keys.flatMap((k) => SPECIALIZATION_CHILDREN_OF(k).map((c) => `${k}\u0000${c}`)))];
      for (const pair of children) {
        const [parentKey, child] = pair.split("\u0000");
        // IT STAYS ONE-DIRECTIONAL, AND THE UNION IS WHY THAT NEEDED SAYING
        // OUT LOUD (GATE 3 slot-31, 2026-09-04). The guard refuses a
        // derivation that answered the PARENT to a title naming the CHILD. A
        // derivation that already CARRIES the child's words states them itself
        // and is the SPECIALIZATION-STATED promotion this classifier exists to
        // make -- "1987 Topps Traded Tiffany #70T", stored `topps`, derived
        // `topps-traded-tiffany`.
        //
        // Reading the STORED key as well as the derived one put that promotion
        // in range for the first time: `topps` names `topps-tiffany` AND
        // `topps-traded` as children, the title states both words, and the
        // guard refused the very rows Drew ruled on (eed10b9b, 2,760 rows out
        // of the base pools). Its own suite caught it -- 15 reds, four files.
        //
        // THE TEST IS THE WORDS, NOT THE LADDER, and two weaker drafts prove
        // why. `child === derived.setKey` still refused the Maddux row: the
        // offending child was `topps-tiffany` while the derivation answered
        // `topps-traded-tiffany`. And the ladder cannot rescue it either --
        // `specializationAncestry("topps-traded-tiffany")` is
        // ["topps-traded", "topps"], so the two keys are SIBLINGS, not
        // ancestor and descendant, and `isSpecializationOf` answers false.
        //
        // What is actually true of that row is that the derived key ALREADY
        // SPELLS every word the refusal is about to complain was dropped:
        // `tiffany` is right there in `topps-traded-tiffany`. A word the
        // derivation carries is a word the derivation did not drop, whichever
        // key surfaced the child -- which is the guard's own rule, stated
        // about the answer rather than about the ladder that reached it.
        const words = distinguishingWords(child, parentKey);
        if (words.length && words.every((w) => derivedSegs.has(w))) continue;
        // EVERY distinguishing word must be stated. A child whose name adds
        // two words ("crown-collection") is not named by a title that states
        // only one of them, and a one-word test would refuse half the pool on
        // an accident of vocabulary.
        if (!words.length) continue;
        // A COLOUR IS NOT A PRODUCT NAME. `topps-chrome-black` is a real
        // distinct product, but "black" is also a FINISH COLOUR, and
        // "2025 Topps Chrome Black Refractor /10" names the Black Refractor
        // PARALLEL of topps-chrome -- not the Topps Chrome Black product.
        // Reading it as the product refused a control the audit gate pins as
        // writable, which is the false positive this clause exists to stop.
        //
        // THE TEST IS COLOUR, NOT FINISH, AND THE DIFFERENCE IS MEASURED.
        // The first draft skipped any child whose words were all FINISH_TOKENS
        // or FINISH_COLOR_TOKENS, and that was too wide: `mini` and `tiffany`
        // are both in the finish vocabulary (each names a parallel on some
        // product), so the exclusion silently switched the guard off for
        // `topps-mini` and `topps-traded-tiffany` -- two of the very products
        // this audit was opened to protect. Its own pins caught it.
        //
        // A bare COLOUR is the only word that cannot name a product on its
        // own: "Black Refractor" is the Black parallel of topps-chrome, never
        // the Topps Chrome Black product. Words like `tiffany` and `mini` DO
        // name products, so they stay in scope here. Where the word really is
        // a colour, the question "did the derivation drop a finish the title
        // names?" belongs to GUARD 4 and is asked there against the parallel
        // axis -- so nothing goes unguarded by skipping it here.
        if (words.every((w) => FAMILY_COLOURS.has(w))) continue;
        // Singular/plural is spelling, not identity, AND IT CUTS BOTH WAYS.
        // The sampled titles say "Gold Crown Die-Cut" against a key ending
        // `-die-cuts`, and "Pacific Prisms" against the key `pacific-prism`.
        // A one-directional test caught the first and missed the second: 14 of
        // the audit's Pacific rows say "Prisms" and the key is singular.
        //
        // So the word matches if the title states it, its bare singular, or
        // its simple plural. It is deliberately only the trailing -s in either
        // direction: anything looser (stemming, edit distance) would start
        // matching words that are not the product, and a FALSE refusal here
        // costs a real improvement -- which is why the controls in
        // rematchTitleNamesProduct.test.ts are pinned beside every fixture.
        const statesWord = (w) =>
          titleStatesWord(title, w)
          || (w.endsWith("s") && titleStatesWord(title, w.slice(0, -1)))
          || (!w.endsWith("s") && titleStatesWord(title, `${w}s`));
        if (words.every(statesWord)) {
          refusals.push(`improve-title-names-a-product-the-derivation-dropped:${words.join("+")}@${parentKey}|title-names:${child}`);
          break;
        }
      }
    }
  }

  // GUARD 8: A NON-CARD FORMAT NEVER LANDS ON A CARD.
  //
  // CF-A-POG-IS-NOT-A-CARD (Drew, GATE 3 slot-31 audit, 2026-09-04). Three of
  // that audit's twelve wrong rows were milk caps -- a 1990s promotional disc
  // Upper Deck printed with Jordan on it -- filed onto `upper-deck:1`,
  // `upper-deck:5` and `upper-deck:9`, which are three other players' base
  // cards. The derivation is not misreading anything: the title really does
  // say "1995 UD Upper Deck" and really does say "#9". The object it names is
  // simply not a card, so no card's pool is the right home for its price.
  //
  // See NON_CARD_FORMAT_RE above for the vocabulary and for why the
  // destination is asked first -- `topps-coins` and `king-b-discs` are real
  // products with real catalog rows, and a row already sitting on one of them
  // is filed correctly and must not be refused.
  //
  // THE REFUSAL IS ON EVERY AXIS, not only the number. A pog's YEAR and BRAND
  // are as right as any card's, but a row whose price does not belong in this
  // pool is not improved by making its address more precise -- the same
  // reasoning GUARD 5 applies to a lot. The row is reported and left alone.
  {
    const format = title ? nonCardFormatNamed(title) : null;
    if (format) {
      // The key the write would land on. `derived` when the derivation moved
      // it, the stored key when the write only sharpens another axis -- the
      // same both-keys reading GUARD 6's fill arm uses, and for the same
      // reason: a fill onto a standing key is still a write into that pool.
      const dest = [lower(derived?.setKey), lower(stored?.setKey)].filter(Boolean);
      const landsOnTheFormat = dest.some((k) => setKeyNamesFormat(k, format));
      if (!landsOnTheFormat) {
        refusals.push(`improve-non-card-format:${format}@${dest[0] || "(none)"}`);
      }
    }
  }

  // GUARD 9: A TITLE THAT STATES A FINISH NEVER LANDS ON THE BASE POOL.
  //
  // CF-A-STATED-PARALLEL-IS-NOT-BASE (GATE 3 slot-31 audit, 2026-09-04 -- the
  // last two of the twelve wrong rows).
  //
  //   "1995 Bowman *Silver Foil* HIDEO NOMO #238"
  //       base-set:238:Base  ->  bowman:238:BASE
  //   "1995 Collectors Choice - NOLAN RYAN - GOLD Signature #46"
  //       unknown:46:Base    ->  collectors-choice:46:BASE
  //
  // while the CONTROL in the same evidence, one row apart, is right:
  //
  //   "1995 BOWMAN GOLD FOIL FOIL #254 JOHNNY DAMON"
  //       base-set:254:Gold Foil -> bowman:254:Gold Foil
  //
  // WHY THE EXISTING GUARDS ALL STOOD DOWN, measured on these three rows:
  //
  //   GUARD 1 and GUARD 2 open with `axes.filled.includes("parallel")` and
  //     `axes.filled.includes("printRun")`. Neither axis was FILLED here --
  //     the stored parallel was already the string "Base" and the derivation
  //     answered "Base" too, so the axis never moved and both guards were
  //     unreachable. They are written for the derivation that INVENTS a
  //     parallel, and this is the derivation that LOSES one.
  //
  //   GUARD 4 asks `familyTokensDroppedByDerivation`, and its vocabulary is
  //     FINISH_FAMILY_TOKENS -- wave, vapor, etch, shimmer, mojo, prism: the
  //     words that turn "<Colour> Refractor" into a different sibling. That
  //     list deliberately excludes bare colours AND the base finishes, and
  //     "foil" and "signature" are in NEITHER it nor the colour list. Measured:
  //     `familyTokensDroppedByDerivation("...Silver Foil...", "", "bowman")`
  //     returns [] -- the empty list, meaning "nothing dropped" -- so GUARD 4
  //     had no opinion at all. It is not a bug in GUARD 4: a foil is not a
  //     family sibling of a refractor, it is a finish in its own right.
  //
  // So the gap is exactly this: `titleNamesFinish` answers TRUE for all three
  // titles (verified), the vocabulary KNOWS "Silver Foil" and "Gold Signature"
  // are finishes, and nothing was asking it on this shape. The Gold Foil
  // control passes not because a guard cleared it but because its parallel is
  // NOT Base -- and that is precisely the test to write.
  //
  // THE RULE: if the title names a finish and the destination parallel is
  // Base or blank, the write is refused. It is a claim about the DESTINATION,
  // not about which axis moved, so it catches the fill arm and the standing
  // arm alike -- the same lesson GUARD 6's fill arm records.
  //
  // IT IS NOT A DUPLICATE OF GUARD 1. Guard 1 refuses a parallel MINTED from a
  // product word over a Base title -- the derivation claiming too much. This
  // refuses a Base destination under a title that STATES a finish -- the
  // derivation claiming too little. Opposite directions, and the audit found
  // both.
  //
  // WHY IT DOES NOT REFUSE HALF THE POOL. `titleNamesFinish` is the per-card
  // corpus vocabulary, which suppresses the product's OWN setKey words, so
  // "1995 Bowman #254" does not read `bowman` as a finish and a plain base
  // sale is untouched. The control that proves the boundary is pinned beside
  // the fixtures: a bare "1989 Bowman #126 Bo Jackson Rookie" stays writable.
  {
    const destParallel = axisValue(derived, "parallel");
    const storedParallel = axisValue(stored, "parallel");
    // BOTH ends must be Base/blank. A row whose STORED parallel already names
    // the finish is not this shape -- that is the Gold Foil control, and the
    // question there is whether the derivation KEPT it, which GUARD 4 owns.
    if (title && derived
      && axisIsBlank("parallel", destParallel)
      && axisIsBlank("parallel", storedParallel)) {
      // A SERIAL ALONE IS NOT A FINISH NAME. `titleNamesFinish` opens with
      // `if (titleStatesSerial(t)) return true`, so a plain base card listed
      // "#/999" answers true on its print run alone and would be refused for
      // naming no finish at all. GUARD 2 already owns the print-run question
      // on a Base destination, so this guard asks `titleFinishWitness` --
      // the same walk minus that first line, returning the WORD or null.
      const witness = VOCAB.titleFinishWitness(title, { year, setKey });
      if (witness && finishWitnessIsNamed(witness)) {
        refusals.push(`improve-title-states-a-finish-over-a-base-destination:${witness}@${setKey}`);
      }
    }
  }

  // GUARD 3: a setKey collapse never feeds IMPROVE.
  const collapse = derivationCollapsesProduct(stored, derived);
  if (collapse) refusals.push(`improve-setkey-collapses-distinct-product:${collapse}`);

  return refusals;
}

/**
 * EVERY REFUSAL THAT CAN STOP AN IMPROVE, IN ONE ARRAY, FROM ONE PLACE.
 *
 * Two arms now reach the IMPROVE gate -- the ordinary filled-only path, and
 * the SPECIALIZATION-STATED subclass -- and they must be gated IDENTICALLY. A
 * subclass that widened which rows reach the gate AND quietly skipped one of
 * the gate's refusals would not be a subclass, it would be a bypass.
 *
 * It is one function rather than two copies of three lines for a reason the
 * test suite states directly: `rematchDerivationDefects.test.ts` reverts each
 * push below by SOURCE STRING and asserts there is EXACTLY ONE site to revert.
 * A second copy would pass that assertion's sibling and leave one arm
 * unguarded -- which is precisely the mutation nobody would notice.
 *
 * The three sources, in the order a reader should think about them:
 *
 *   G1-G5  `improveRefusals` -- the audit-gate guards. IMPROVE was the class
 *          treated as safe and shipped without a title check of its own.
 *
 *   FINISH-FAMILY COLLISION -- a row whose colour family is collided and
 *          UNRULED. Filling a blank axis is only an improvement when the
 *          destination is settled; inside a collided family it is picking a
 *          side of the open question. It joins this array rather than sitting
 *          beside it because the audit gate READS this array: a refusal that
 *          is not in it is a refusal the census cannot report and the canary
 *          cannot count.
 *
 *   DERIVATION DEFECTS -- IMPROVE is the class that writes, so a bad reading
 *          arriving here is the one that costs something. The V3
 *          genericization shape is the live danger: `Prism Refractor` ->
 *          `Refractor` over a row whose printRun the derivation also filled
 *          diffs as filled-only -- strictly more specific by the axis test --
 *          and would have been written, pooling a distinct card into its
 *          family.
 */
function allImproveRefusals({ row, stored, derived, axes, parserSaysLot, family, derivationRefused = [] }) {
  const refusals = improveRefusals({ row, stored, derived, axes, parserSaysLot });
  if (family.qualifies) refusals.push("finish-family-collision:not-writable-until-ruled");
  refusals.push(...derivationRefused);
  return refusals;
}

// ── DERIVATION DEFECTS: five guards that refuse a bad reading by name ──────
//
// CF-A-DERIVATION-DEFECT-IS-NOT-A-RULING (Drew, 2026-09-03). The 32-shard
// census returned 4,453,642 CONFLICT rows, and an aggregation over them found
// that the largest populations are not two rival readings of a card at all --
// they are the DERIVATION failing to read what is plainly written, and the
// census dutifully reporting that failure as a disagreement Drew has to
// settle. A conflict that exists only because our own parser dropped a word is
// noise in the one report that is supposed to be signal.
//
// Each guard below is DISQUALIFYING in the same direction as the eviction
// evidence: it takes a derived reading OUT of contention and names why. The
// class stays CONFLICT (the census must keep counting the shape), `writable`
// goes false, and the reason string is what lets the population be filtered
// out of Drew's queue and counted as a parser bug instead of a ruling.
//
// A guard never invents an identity. It refuses one. Absent beats wrong.

/** A parallel name reduced to comparable words. `-`, `&`, `/` and case all
 *  vary freely between a checklist spelling and a seller's title, and none of
 *  them changes which card is meant. */
const nameKey = (s) => lower(s).replace(/[^a-z0-9]+/g, " ").trim();

/** The singular form of a checklist plural. A checklist heads its section in
 *  the plural ("Gold Refractors") while the card carries the singular, so the
 *  two spellings are ONE name -- see checklistListsParallel, same rule. */
const singularWord = (w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const nameKeyLoose = (s) => nameKey(s).split(/\s+/).filter(Boolean).map(singularWord).join(" ");

/**
 * D1 -- THE TITLE STILL CONTAINS THE STORED COLOUR WORD.
 *
 * 1,374,029 rows: the stored row names a real finish (Gold, Blue, Red Wave,
 * Coral Foil, Gray Back, Purple Scope, Team Color, Pristine Purple), the
 * derivation says Base, and in 98.5% of the sampled cases THE TITLE STILL
 * CONTAINS THE STORED COLOUR WORD. 94.5% are terse CardHedge titles of the
 * shape "2025 Panini Prizm Football #99 Red Wave", where the finish is the
 * only thing after the card number.
 *
 * The cause is in extractParallel: a closed hand-rolled ladder of enumerated
 * colour+pattern pairs (Blue Wave, Gold Shimmer, Orange Lava...). A bare
 * colour, or a colour paired with a pattern word nobody enumerated, matches no
 * rule and falls all the way through to `return "Base"`. The finish reader is
 * failing to read a finish the OLD writer read off the same string -- and the
 * checklist corpus, 36,729 spellings over 576 products, knows every one of
 * these names already.
 *
 * So this is never a demotion for Drew to rule on. A derived `Base` that would
 * displace a stored named finish WHOSE OWN WORDS THE TITLE CONTAINS is refused
 * outright: the title agrees with the stored row, and only our reader dissents.
 *
 * THE TEST IS ON THE STORED NAME'S WORDS, NOT ON THE VOCABULARY. Asking "does
 * the title name a finish?" would fire on any title with a colour anywhere in
 * it. The question here is narrower, and that is the whole point: does the
 * title contain THE STORED PARALLEL -- as a phrase, or as every one of its
 * distinguishing words? "Red Wave" against "...#99 Red Wave" yes; "Red Wave"
 * against "...#99 Blue Refractor" no, and that one IS a real conflict which
 * still reaches Drew.
 */
function titleNamesStoredFinish(title, storedParallel) {
  const p = nameKeyLoose(storedParallel);
  if (!p) return false;
  if (GENERIC_PARALLELS.has(nameKey(storedParallel))) return false;
  const t = ` ${nameKeyLoose(title)} `;
  // the whole phrase, in order -- "Red Wave", "Gray Back", "Pristine Purple"
  if (t.includes(` ${p} `)) return true;
  // ...or every distinguishing word of it, in any order. Sellers reorder
  // ("Bowman Blue ... True" for "True Blue"), and a stored name may carry a
  // word the title spells elsewhere. Stopwords and 1-2 letter fragments are
  // dropped so a match on "of" or "the" can never carry a name by itself.
  const words = p.split(/\s+/).filter((w) => w.length >= 3 && !VOCAB.CORPUS_STOPWORDS.has(w));
  if (!words.length) return false;
  return words.every((w) => t.includes(` ${w} `));
}

/**
 * D7 -- isAuto's BOUNDARY IS cardNumber, NEVER TITLE TEXT.
 *
 * 33,283 rows, 100% of them no-auto -> auto, every one driven by a title word
 * (Auto / Autograph / Signatures). This runs against a PINNED ruling
 * (CF-ISAUTO-BOUNDARY-IS-CARDNUMBER: text on the card_set is HARMFUL), and the
 * population above is exactly why the ruling exists:
 *
 *   "1953 Bowman ... PSA AUTHENTIC AUTO"
 *
 * is a CUT SIGNATURE mounted with a base card. The card is the base card; the
 * autograph is not part of its identity, and no 1953 Bowman autograph subset
 * exists to file it against. Flipping the flag on the word moves a real base
 * sale into an auto pool that has no cards in it.
 *
 * A card is an auto because its CARD NUMBER says so -- the checklist's
 * autograph subset carries a fixed prefix (CPA-, BCPA-, BDA-, ...). That is
 * the boundary, and parseListingIdentity already reads it
 * (isCardNumberAutoSubset). What must never happen is the other half of that
 * same line -- extractIsAuto(t), a title-word reader -- flipping a stored
 * no-auto row on the strength of the word alone.
 *
 * So a derived isAuto=true over a stored isAuto=false is refused UNLESS the
 * derived cardNumber is itself an auto-subset number.
 */
function isAutoFlipIsTitleOnly({ stored, derived, autoByCardNumber }) {
  if (stored?.isAuto === true) return false;      // not a flip
  if (derived?.isAuto !== true) return false;     // not a flip
  return !autoByCardNumber;                       // the cardNumber does not back it
}

/**
 * D8 -- A GRADE IS A GRADER TOKEN PLUS A NUMERAL. NOTHING ELSE.
 *
 * 58,241 rows where a RAW CONDITION ADJECTIVE was read as a numeric grade:
 *
 *   "VG-VGEX"            -> PSA 10   (no grader, no numeral at all)
 *   "VG-EX"              -> PSA 8    (same)
 *   "PSA GRADED EX-MT 6" -> PSA 9    (grader present, but the WRONG numeral)
 *
 * The first two are ungraded vintage cards described in the raw-condition
 * vocabulary every vintage seller uses. Reading "VG" as a grade files a raw
 * card into a PSA 10 pool -- the most expensive pool in the product -- and the
 * sale it contributes is a raw sale. The third is genuinely graded, and even
 * there the reader took the first digit it could find rather than the one
 * ADJACENT TO THE GRADE PHRASE: "EX-MT 6" is PSA 6, not PSA 9.
 *
 * The rule is the one the doctrine already states: a grade derives ONLY from
 * an explicit grader token (PSA/BGS/SGC/CGC/...) followed by a numeral, and
 * the numeral is the one that follows the grade PHRASE. An adjective on its
 * own -- VG, EX, NM, EX-MT, VG-EX, GEM MINT with no grader -- never produces a
 * grade. Absent beats wrong: an unread grade leaves the stored one alone, and
 * a raw card stays raw.
 */
const GRADER_RE = /\b(PSA|BGS|BVG|SGC|CGC|CSG|HGA|TAG|ISA|GMA|KSA)\b/i;
/** Raw-condition adjectives. Present WITHOUT a grader token these are a seller
 *  describing an ungraded card, and they are not grades. */
const RAW_CONDITION_RE = /\b(?:VG-?VGEX|VG-?EX|EX-?MT|NM-?MT|GD-?VG|P-?FR|VG|EX|NM|GD|FR|PR|GEM\s*MINT|MINT|NEAR\s*MINT|EXCELLENT|VERY\s*GOOD|GOOD|POOR|FAIR)\b/i;

/**
 * Read a grade the way the doctrine says: a grader token, then the numeral
 * that follows IT -- skipping over any condition adjective sitting between,
 * which is what "PSA GRADED EX-MT 6" is. Returns null when the title states no
 * grade, which is a real answer meaning "leave the stored one alone".
 */
function gradeFromTitleStrict(title) {
  const t = String(title ?? "");
  const g = t.match(GRADER_RE);
  if (!g) return null;
  // The numeral belongs to the grade phrase, so read FORWARD from the grader
  // token only -- a digit earlier in the title is a year, a card number or a
  // print run, never this card's grade.
  const after = t.slice(g.index + g[0].length);
  // Allow the words a slab label actually carries between the grader and the
  // number ("GRADED", "AUTHENTIC", "MINT", "EX-MT"), then the numeral. This is
  // what turns "PSA GRADED EX-MT 6" into 6 rather than into the first digit
  // anywhere in the string.
  const m = after.match(/^[\s.:-]*(?:(?:GRADED|GRADE|AUTH(?:ENTIC)?|CARD|GEM|MINT|NEAR|MT|PRISTINE|BLACK|LABEL|[A-Z]{2}(?:-[A-Z]{2})?)[\s.:-]*){0,4}(10(?:\.0)?|[1-9](?:\.5|\.0)?)(?!\d)/i);
  if (!m) return null;
  return { gradeCompany: g[1].toUpperCase(), gradeValue: Number(m[1]) };
}

/** A grade rendered for a REASON STRING. `gradeToken` joins on `|`, which is
 *  also the separator the verdict fixtures join on -- a reason carrying a raw
 *  token would shift every field after it and read as an axis that moved.
 *  Same information, one space instead. */
const gradeLabel = (id) => gradeToken(id).replace("|", " ");

/**
 * The derived grade is a CONDITION-ADJECTIVE ARTIFACT when the derivation
 * claims a grade the strict reader cannot find, on a title carrying a raw
 * condition adjective or no grader token at all. That is D8 exactly.
 */
function derivedGradeIsAdjectiveArtifact({ row, stored, derived }) {
  const title = str(row?.title);
  if (!title) return null;
  if (gradeToken(derived) === "RAW") return null;      // nothing claimed
  // THE DERIVATION CARRIES THE STORED GRADE FORWARD, AND THAT IS NOT A READING.
  //
  // deriveIdentity takes the stored grade whenever the title is silent -- "a
  // title that states no grade does not make a stored PSA 9 row raw". So a
  // derived grade EQUAL to the stored one was never read off the title at all
  // and there is nothing here to refuse: the row agrees with itself. Without
  // this line the guard fires on AGREE rows whose titles simply do not repeat
  // the slab ("1953 Topps Baseball #54 Base", stored PSA 5), which is a
  // refusal attached to a row where nothing disagrees.
  //
  // What remains after it is the real D8 population: a grade the DERIVATION
  // introduced or changed, on a title that cannot support it.
  if (gradeToken(derived) === gradeToken(stored)) return null;
  const strict = gradeFromTitleStrict(title);
  // The strict reader agrees with the derivation -- not an artifact.
  if (strict && `${strict.gradeCompany}|${strict.gradeValue}` === gradeToken(derived)) return null;
  if (!strict) {
    // No readable grade at all. A title with no grader token, or one whose
    // only grade-ish content is a condition adjective, produced this grade out
    // of the adjective.
    if (!GRADER_RE.test(title)) return `grade-from-title-without-grader:${gradeLabel(derived)}`;
    if (RAW_CONDITION_RE.test(title)) return `grade-from-condition-adjective:${gradeLabel(derived)}`;
    return `grade-not-readable-from-title:${gradeLabel(derived)}`;
  }
  // A grade IS readable and the derivation read a different one -- the wrong
  // numeral ("PSA GRADED EX-MT 6" -> PSA 9). Name both sides.
  return `grade-numeral-not-adjacent-to-grader:derived=${gradeLabel(derived)},title=${strict.gradeCompany} ${strict.gradeValue}`;
}

/**
 * D6 -- CARD NUMBER: CASE IS NOT A DIFFERENCE, A PREFIX IS A DIFFERENT CARD.
 *
 * 171,125 rows on `changed:cardNumber`, and they are two populations with
 * opposite meanings:
 *
 *   43% CASE-ONLY         `bb-ve` vs `BB-VE`. The SAME card, and reporting it
 *                         as a conflict splits one pool in two over letter
 *                         case. `axisValue` already lowercases, so these do
 *                         not reach the diff at all -- but the CANONICAL
 *                         casing still has to be decided, and the checklist's
 *                         is the one that wins. That is a normalization lane
 *                         under IMPROVE, not a conflict.
 *   18% PREFIX TRUNCATION `1975-6` -> `1975`, `T91-74` -> `T91`, `92-36` ->
 *                         `92`. These are DIFFERENT CARDS being merged: the
 *                         derivation read the year (or the set prefix) as the
 *                         whole number and dropped the rest. Filing #1975-6
 *                         onto #1975 pools two cards into one.
 *
 * The truncation is a parser defect with a recognisable shape -- the derived
 * value is a strict PREFIX of the stored one on a separator boundary -- so it
 * is refused by name rather than handed to Drew as a rival reading.
 */
function cardNumberIsTruncation(stored, derived) {
  const s = lower(stored?.cardNumber).replace(/\s+/g, "");
  const d = lower(derived?.cardNumber).replace(/\s+/g, "");
  if (!s || !d || s === d) return null;
  if (!s.startsWith(d)) return null;
  // A strict prefix, and what follows it in the stored value begins with a
  // separator -- `1975-6` after `1975`, `t91-74` after `t91`. Without the
  // boundary test `12` would "truncate" `123`, which is a different shape (a
  // differently-read number, not a dropped suffix) and stays a conflict.
  const rest = s.slice(d.length);
  if (!/^[-_/. ]/.test(rest)) return null;
  return `${s}<-${d}`;
}

/**
 * CF-THE-CHECKLIST-SPELLS-THE-NUMBER (Drew, 2026-09-04) -- the CJS mirror of
 * `normalizePokemonCardNumber` (src/services/catalog/pokemonCardNumber.ts).
 *
 * THE STORED SHAPE THIS RECOGNISES. Every English Pokemon row written before
 * the fix carries a card number minted by concatenating POS and TOTAL, because
 * the title said "094/159" and `slugify` stripped the slash:
 *
 *     stored `094159`   derived `094`     one card, one pool
 *     stored `94159`    derived `094`     the SAME card, spelled short
 *
 * Without this rule the fix makes things WORSE, not better: `diffAxes` reads
 * `094159` vs `094` as `changed:cardNumber`, the row classifies CONFLICT, and
 * the rematch leaves the pool split exactly where it is. The classifier has to
 * know that the stored number is the derived one with the SET TOTAL glued on.
 *
 * THE TEST IS RECONSTRUCTION, NOT PREFIXING. `094159` starts with `094`, but so
 * does `0941` -- and a bare prefix test would fold a genuinely different card
 * onto this one. The stored value must be EXACTLY position-then-total, where
 * the position reduces to the derived number and the total is a plausible set
 * size. Both halves must be accounted for; a leftover digit refuses.
 *
 * Returns the witness string for the census, or null when the shape does not
 * hold. Pokemon only -- no other vertical writes POS/TOTAL, and applying this
 * to a Bowman `bd152` would be the truncation defect D6 already refuses.
 */
function pokemonNumberIsPositionOverTotal(stored, derived, sport) {
  if (lower(sport) !== "pokemon") return null;
  const sN = lower(stored?.cardNumber).replace(/[^0-9]/g, "");
  const dRaw = lower(derived?.cardNumber);
  const dN = dRaw.replace(/[^0-9]/g, "");
  // Only bare positions. A suffixed number (tg01, gg69, sv107) is never a
  // position over a total and must keep its spelling verbatim.
  if (!sN || !dN || !/^[0-9]+$/.test(dRaw)) return null;
  if (sN === dN) return null;
  if (sN.length <= dN.length) return null;
  const dVal = Number(dN);
  if (!Number.isFinite(dVal) || dVal <= 0) return null;
  // Try every split of the stored digits: the head must be the derived
  // position (by VALUE, so `94` and `094` both reconstruct), and the tail must
  // be a credible set total.
  for (let cut = 1; cut < sN.length; cut++) {
    const head = sN.slice(0, cut), tail = sN.slice(cut);
    if (Number(head) !== dVal) continue;
    const total = Number(tail);
    // A set total is a REAL PUBLISHED SIZE, and the floor matters as much as
    // the ceiling. Without it `0941` reconstructs as `094/1` -- a one-card set
    // -- and a genuinely different card folds onto this one. (Caught by the
    // prefix-test mutation pin, which is why that pin is there.) The smallest
    // real Pokemon set is in the dozens; 10 is a floor no published set is
    // under. 400 is the same ceiling the TCG number reader uses, and a
    // leading-zero total (`0159`) never occurs.
    if (!Number.isFinite(total) || total < 10 || total > 400) continue;
    if (tail.startsWith("0")) continue;
    return `${sN}=${head}/${tail}`;
  }
  return null;
}

/**
 * Is the difference ONLY the checklist's zero-padding? `94` vs `094` is one
 * card in two hands, and the checklist's spelling is the canonical one
 * (CF-CARDNUMBER-VERBATIM-FROM-THE-CHECKLIST). Bare positions only, so a
 * suffixed number is never folded.
 */
function pokemonNumberDiffersOnlyByPadding(stored, derived, sport) {
  if (lower(sport) !== "pokemon") return false;
  const s = lower(stored?.cardNumber).trim(), d = lower(derived?.cardNumber).trim();
  if (!s || !d || s === d) return false;
  if (!/^[0-9]+$/.test(s) || !/^[0-9]+$/.test(d)) return false;
  return Number(s) === Number(d);
}

/** Is the cardNumber difference CASE-ONLY? The same card; the checklist's
 *  casing is canonical and a normalization lane may adopt it under IMPROVE. */
function cardNumberDiffersOnlyByCase(stored, derived) {
  const s = str(stored?.cardNumber).replace(/\s+/g, "");
  const d = str(derived?.cardNumber).replace(/\s+/g, "");
  if (!s || !d) return false;
  return s !== d && s.toLowerCase() === d.toLowerCase();
}

/**
 * V3 -- GENERICIZATION IS A LOSS, NOT A NORMALIZATION.
 *
 * ~285k rows where the derived parallel is a strict SUBSTRING of the stored
 * named one:
 *
 *   Prism Refractor -> Refractor        Atomic Refractor -> Refractor
 *   X-Fractor       -> Refractor        Silver Sparkle   -> Refractor
 *   Mini-Diamond    -> Refractor        Logofractor      -> Refractor
 *   Encased         -> Refractor
 *
 * Every one of those is a distinct card with its own checklist row and its own
 * price curve (the Red Ink ruling: a named parallel is a distinct card). The
 * derivation is not normalizing a spelling, it is throwing the specific half
 * of the name away and landing on the family. Pooling an Atomic Refractor with
 * a plain Refractor is one card, two rows, a split pool, a wrong FMV.
 *
 * The EXEMPTION is the case that genuinely IS a spelling: casing and plural.
 * `Superfractor`/`SuperFractor` and `Refractors`/`Refractor` are one name in
 * two hands, and normalizing those is right. The test is therefore on the
 * LOOSE key (case-folded, punctuation-folded, de-pluralised): equal loose keys
 * are a normalization and pass; a strict word-subset under the loose key is a
 * genericization and is refused.
 */
function parallelIsGenericization(stored, derived) {
  const s = nameKeyLoose(stored?.parallel);
  const d = nameKeyLoose(derived?.parallel);
  if (!s || !d) return null;
  if (GENERIC_PARALLELS.has(nameKey(stored?.parallel))) return null;  // D1's shape, not this one
  if (GENERIC_PARALLELS.has(nameKey(derived?.parallel))) return null; // ditto
  if (s === d) return null;                       // case/plural alias -- NORMALIZES
  // The derived name's words are a strict SUBSET of the stored name's, i.e.
  // the derivation dropped a word and kept the family. Word-wise rather than
  // character-wise, so "fractor" inside "Superfractor" is not a substring hit.
  const sw = s.split(/\s+/).filter(Boolean), dw = d.split(/\s+/).filter(Boolean);
  if (dw.length >= sw.length) return null;
  const sset = new Set(sw);
  if (!dw.every((w) => sset.has(w))) return null;
  return `${str(derived?.parallel)}<-${str(stored?.parallel)}`;
}

/**
 * Every derivation-defect refusal for one row, in one place.
 *
 * Returns a list of reason strings. A non-empty list means the derivation is
 * not trustworthy ON THE AXIS NAMED, so the row must never be written from it,
 * and the census can subtract this population from the conflicts Drew reads.
 *
 * `autoByCardNumber` is the caller's verdict that the derived cardNumber is
 * itself an autograph-subset number -- the one thing that legitimately makes a
 * row an auto (see D7).
 */
function derivationRefusals({ row, stored, derived, autoByCardNumber = false }) {
  const out = [];
  if (!derived) return out;
  const title = str(row?.title);

  // D1: a derived Base must NEVER displace a stored named finish whose own
  // words the title contains.
  const sp = axisValue(stored, "parallel"), dp = axisValue(derived, "parallel");
  if (!axisIsBlank("parallel", sp) && axisIsBlank("parallel", dp)
      && titleNamesStoredFinish(title, stored?.parallel)) {
    out.push(`title-names-stored-finish:${str(stored?.parallel)}`);
  }

  // V3: a derived parallel that is a strict word-subset of the stored one.
  const generic = parallelIsGenericization(stored, derived);
  if (generic) out.push(`parallel-genericization:${generic}`);

  // D7: a title-only auto flip.
  if (isAutoFlipIsTitleOnly({ stored, derived, autoByCardNumber })) {
    out.push("isauto-flip-from-title-only");
  }

  // D8: a grade read off a condition adjective, or off the wrong numeral.
  const gradeArtifact = derivedGradeIsAdjectiveArtifact({ row, stored, derived });
  if (gradeArtifact) out.push(gradeArtifact);

  // CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04). A derivation that
  // produces the PSEUDO-number is never an improvement over a stored real
  // number: `70t` -> `player-greg-maddux` is the defect running backwards, and
  // it would arrive here as `changed:cardNumber` (already CONFLICT) or, on a
  // row whose stored number is blank, as a FILL that reaches IMPROVE. Refused
  // by name on both paths so the census can count it.
  if (isPseudoCardNumber(derived?.cardNumber) && !isPseudoCardNumber(stored?.cardNumber)) {
    out.push(`derived-cardnumber-is-pseudo-number:${lower(derived?.cardNumber)}`);
  }

  // D6: a derived cardNumber that is a strict prefix of the stored one.
  const trunc = cardNumberIsTruncation(stored, derived);
  if (trunc) out.push(`cardnumber-truncation:${trunc}`);

  return out;
}

/**
 * Compare stored vs derived identity axis by axis.
 *   same     both name the same value (or both blank)
 *   filled   stored is blank/generic, derived names something
 *   dropped  stored names something, derived is blank/generic  -> a DEMOTION
 *   changed  both name something, and they differ              -> a CONFLICT
 */
function diffAxes(stored, derived, opts = {}) {
  const same = [], filled = [], dropped = [], changed = [];
  // CF-A-DEFAULTED-SETKEY-IS-BLANK (Drew, 2026-09-03). The stored side only:
  // a row whose `bowman` carries the defaulted marker never read a product off
  // the card, so a derivation that names one FILLS the axis rather than
  // changing it. The DERIVED side is never blanked this way -- a derivation
  // that produces `bowman` produced an answer.
  const storedBlankSetKey = opts.storedSetKeyBlank === true;
  // CF-UNPARSED-IS-NOT-UNNUMBERED. Same shape as the defaulted setKey above,
  // and for the same reason: a stored `player-<name>` cardNumber on a row whose
  // TITLE states a number never read a number off the card, so a derivation
  // that reads one FILLS the axis rather than changing it. Gated on the
  // caller's title fact -- never on the derivation -- and applied to the STORED
  // side only.
  // CF-A-PLAYER-SEGMENT-IS-A-PERSON. The player reaches identity ONLY through
  // the cardNumber segment, as `player-<name>` -- so a corrupted NAME is a
  // corrupted cardNumber VALUE on exactly these rows, and it blanks the same
  // axis for the same reason. Two independent facts, either of which makes the
  // stored pseudo-number not-an-answer:
  //
  //   titleStatesNumber        the row was never unnumbered (#1728)
  //   storedPlayerCorrupted    the name in the pseudo-number is not a person
  //
  // Both are facts about the ROW supplied by the caller, never verdicts about
  // the derivation, and both are STORED-side only. The derived side is never
  // blanked: a derivation that produces `player-…` produced it deliberately.
  // CF-A-CATALOG-TITLE-NAMES-NO-PLAYER passes two more evidences alongside the
  // decoded name: the STORED setKey, which is the one minted alongside this
  // pseudo-number, and the row's own TITLE, which is what the name was derived
  // FROM. The title is what reaches the rows whose stored key is the flagship
  // (`topps`) rather than the specialized product (`topps-rub-offs`); the
  // setKey alone cannot see those, and they are 489 of the 829 measured.
  const storedBlankCardNumber = isPseudoCardNumber(stored?.cardNumber)
    && (opts.titleStatesNumber === true
      || opts.storedPlayerCorrupted === true
      || isCorruptedPlayerName(String(stored?.cardNumber ?? "").replace(/^player-/i, "").replace(/-/g, " "), stored?.setKey ?? null, opts.title ?? null));
  // CF-THE-CHECKLIST-SPELLS-THE-NUMBER (Drew, 2026-09-04). The stored Pokemon
  // card number is not a RIVAL READING of the number -- it is the same number
  // misspelled by a derivation we have since fixed. `094159` is `094` with the
  // SET TOTAL glued on; `94` is `094` with the checklist's padding dropped.
  // Neither is an answer about WHICH CARD this is that could contradict the
  // derivation, so the stored side is BLANK on this axis and the derivation
  // FILLS it -- which is the ordinary IMPROVE path, subject to every refusal
  // that path already applies.
  //
  // NOT `same`. Marking it same would classify the row AGREE, and AGREE means
  // "nothing to do": the row would keep its `:094159:` address and the split
  // pool this fix exists to close would never be rewritten. The whole unlock
  // is that these rows become WRITABLE.
  //
  // Gated on the row's own sport, and on BARE positions only -- a suffixed
  // number (tg01, gg69) never folds, and no other vertical writes POS/TOTAL.
  // Falling back to either identity's own `sport` keeps the pure function
  // callable from a pin without a separate option.
  const sportForNumber = str(opts.sport ?? derived?.sport ?? stored?.sport);
  const pokemonNumberFold = pokemonNumberIsPositionOverTotal(stored, derived, sportForNumber)
    || (pokemonNumberDiffersOnlyByPadding(stored, derived, sportForNumber)
      ? `padding:${lower(stored?.cardNumber)}->${lower(derived?.cardNumber)}`
      : null);
  for (const axis of AXES) {
    const a = axisValue(stored, axis), b = axisValue(derived, axis);
    const aBlank = (axis === "setKey" && storedBlankSetKey)
      || (axis === "cardNumber" && storedBlankCardNumber)
      || axisIsBlank(axis, a);
    const bBlank = axisIsBlank(axis, b);
    if (a === b) { same.push(axis); continue; }
    if (axis === "cardNumber" && pokemonNumberFold) { filled.push(axis); continue; }
    if (aBlank && !bBlank) { filled.push(axis); continue; }
    if (!aBlank && bBlank) { dropped.push(axis); continue; }
    changed.push(axis);
  }
  return { same, filled, dropped, changed };
}

/**
 * Classify ONE row.
 *
 * `stored`   the identity the row carries today (from its own fields).
 * `derived`  the identity today's parser + matcher produce, or null when the
 *            derivation failed the slug guard.
 * `opts.checklistBacked`  did the derived identity land on a CHECKLIST-backed
 *            catalog row? Anything else is not evidence.
 * `opts.derivationReasons` why the derivation produced nothing (UNDERIVABLE).
 * `opts.clashSubsets`  every subsetName the CATALOG holds at this row's rung.
 *            Two or more means the product numbers this card under more than
 *            one subset, and the identity needs a `:sub-` segment the row does
 *            not have. Empty or one -- the state of virtually every row -- and
 *            the subset rule says nothing at all. Supplied by the caller
 *            because only a catalog read can see it; never inferred here.
 * `row`      the stored document, for the provenance tier.
 *
 * Returns { klass, tier, axes, reasons, writable }.
 * `writable` is the ONLY thing the apply pass may act on, and it is the
 * conjunction of every gate -- so a future edit that loosens one class cannot
 * silently make a protected row writable.
 */
function classifyRow({
  row, stored, derived, checklistBacked = false, derivationReasons = [],
  storedSlug = null, baseDestSlug = null, baseDestBacked = false,
  // CF-A-PLAYER-NAME-IS-NOT-A-FINISH (2026-09-04). The CHECKLIST's name for
  // this (year, setKey, cardNumber) -- a catalog read, so the caller supplies
  // it and this module stays pure. Read ONLY by base-eviction's guard 3, to
  // suppress the words of this card's own player name from the finish witness.
  // Defaults null, so a caller that cannot answer gets today's behaviour and
  // the row's own stored name is used only when it reads as a person.
  checklistPlayerName = null,
  clashSubsets = [],
  // The PARSER'S own multi-card-lot verdict (`isMultiCardLot` from
  // parseTitleIdentity). Passed IN rather than imported: this module is pure
  // and must not require dist/. Two detectors, one decision -- the
  // count-anchored lot idioms live in the parser, the card-number range and
  // the pick/singles vocabulary live in rematch-finish-vocab.cjs, and GUARD 5
  // refuses on either. A caller that cannot supply it loses only the idioms
  // the parser owns; the range half still fires.
  parserSaysLot = false,
  // #1691's derivation-defect input, kept alongside this PR's. The two guards
  // are independent and both run.
  autoByCardNumber = false,
  // SPECIALIZATION-STATED (2026-09-04). Two facts the classifier cannot read
  // for itself, because both are catalog reads and this module is pure.
  //
  //   derivedBackedStrict  is the DERIVED slug backed by a REAL SCRAPED
  //                        checklist source? Deliberately NOT `checklistBacked`
  //                        above: that predicate accepts
  //                        `derived-from-base-checklist-*`, which mints a
  //                        specialization's catalog rows by copying the
  //                        flagship's. Citing one of those as proof that the
  //                        specialization lists this card would be citing a row
  //                        that exists only because the thing being proven was
  //                        already assumed. Defaults FALSE, so a caller that
  //                        does not supply it gets no subclass at all.
  //   storedFlagshipListsCardNumber
  //                        does the STORED flagship's own checklist list this
  //                        cardNumber? `null` means unanswered, and unanswered
  //                        is a refusal -- absent beats wrong.
  derivedBackedStrict = false,
  storedFlagshipListsCardNumber = null,
  // CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04). Does the row's OWN TITLE
  // state a card number? A fact about the row, supplied by the caller (the
  // census reads it with the same `#N` rule the deriver uses), never a verdict
  // about the derivation. It is the ONE thing that lets a stored
  // `player-<name>` pseudo-number count as blank, so a re-derivation onto a
  // real number classifies IMPROVE instead of `changed:cardNumber`. Absent it,
  // a genuinely unnumbered T206 row is compared as the real answer it is.
  titleStatesNumber = false,
  // SELLER-NAME-AUTO (2026-09-04). The CHECKLIST's verdict on whether this
  // (year, setKey, cardNumber) is an autograph card -- a catalog read, so the
  // caller supplies it and this module stays pure.
  //
  //   true   a strictly-sourced checklist row exists and says NOT an auto
  //   false  a strictly-sourced checklist row exists and says IT IS an auto
  //   null   unanswered (no row, or none from a real scraped source), which is
  //          a REFUSAL -- absent beats wrong, exactly like L5's coverage gate.
  //
  // Defaults null, so a caller that does not supply it gets no subclass at all
  // and today's behaviour is unchanged.
  checklistSaysNotAuto = null,
}) {
  const prov = provenanceTier(row);
  // THE SLUG-SHAPE DEFECTS ARE COMPUTED FOR EVERY ROW AND CHANGE NOTHING.
  // Report-only census subclasses: a count and a name, never a refusal and
  // never a write. See SLUG_SHAPE_DEFECTS above for why each one stops there.
  const slugShape = slugShapeDefects({ slug: storedSlug ?? row?.cardId, stored });

  // THE DERIVATION-DEFECT REFUSALS ARE COMPUTED ONCE, BEFORE ANY CLASS.
  //
  // CF-A-DERIVATION-DEFECT-IS-NOT-A-RULING. These five guards say the
  // DERIVATION is untrustworthy on a named axis -- so they must be visible
  // to every return path that could act on it, exactly like the provenance
  // tier. Computing them inside one branch would let another branch write
  // from the same bad reading.
  //
  // They never change the CLASS. A refused row is still the shape the census
  // measured, and hiding it would lose the count the fix is judged by; what
  // they change is `writable`, and the reason string is what lets this
  // population be subtracted from the conflicts Drew reads.
  const derivationRefused = derivationRefusals({ row, stored, derived, autoByCardNumber });

  // THE SPLIT-IDENTITY SIGNAL IS ORTHOGONAL TO THE DERIVATION CLASS.
  //
  // CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS (Drew, 2026-09-02: "we need to go back
  // and check ALL this way"). Every class above compares the row's identity
  // against TODAY'S DERIVATION. This one compares the row against ITSELF: a
  // sold_comps row carries `cardId` and `hobbyiqCardId`, the exact pool reader
  // ORs them, and a row whose two fields name different cards is read into
  // BOTH pools. That is true whatever the derivation says -- an AGREE row can
  // be split (its stored fields match the title perfectly while its two
  // ADDRESSES disagree), and so can an UNDERIVABLE one (a title we cannot read
  // says nothing about the two keys already on the row).
  //
  // So the flag is computed from the row alone, folded into every return path,
  // and never gated on `klass`. Hanging it off CONFLICT would have missed the
  // AGREE-shaped majority -- the same trap the BASE-EVICTION subclass had to
  // be evaluated early to avoid.
  //
  // It does NOT make a row writable, and it does not need to: the apply path
  // lands BOTH identity fields, so a repair driven by any writable class
  // already heals the split as a side effect. What the flag buys is that the
  // census OUTPUT names the row, so an audited apply is known to be repairing
  // both halves rather than silently relying on it.
  //
  // The vendor-design exemption is load-bearing here exactly as it is in the
  // census: a CardHedge row keyed by a bubble id with our slug beside it is
  // the designed partition, and flagging 13.5M of those would drown the real
  // damage. lib/split-identity.cjs owns that predicate for all three consumers.
  const split = SPLIT.classifyIdentity(row);
  // The finish-family collision is computed from the row alone and folded into
  // EVERY return path, for the same reason the split flag is: the commonest
  // collided row diffs as AGREE (its fields and its title say "Green Wave"
  // while its ADDRESS says green-geometric-refractor), and hanging the flag
  // off CONFLICT would miss exactly the rows the census exists to surface.
  // It is a report tag: it never appears in `writable`.
  //
  // `derived` is passed for the VOCABULARY only -- (year, setKey) select the
  // per-card finish words, and the predicate falls back to `stored` when the
  // derivation is absent, which is why it can still run on the UNDERIVABLE
  // path below.
  const family = finishFamilyCollision({ row, storedSlug, stored, derived });
  // CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE. Computed BEFORE the
  // class returns, because a clashing rung the title does not settle is
  // UNDERIVABLE-for-subset whatever the eight axes say -- a row can agree on
  // every field it has and still be one of two cards sharing that address. A
  // title that DOES name the subset is not this class: the derivation is
  // sound, so it falls through to the normal classification, carrying its
  // reason so a report can show which subset the seller named.
  const subset = SUBSET.subsetVerdict(row && row.title, clashSubsets);
  const base = {
    tier: prov.tier,
    provenanceReasons: prov.reasons,
    derivationRefusals: derivationRefused,
    splitIdentity: split.split,
    splitClass: split.klass,
    splitSegments: split.segments,
    finishFamilyCollision: family.qualifies,
    finishFamily: family.qualifies ? family.evidence.family : null,
    finishFamilyEvidence: family.qualifies ? family.evidence : null,
    // Report-only, on EVERY return path: a row carries its slug's shape
    // defects whatever class it lands in, and a count that only appeared for
    // some classes would be a count of the classes, not of the defect.
    slugShapeDefects: slugShape,
    // Same discipline for the subset clash: reported whatever class the row
    // lands in, so the count is of the defect and not of the classes.
    subsetClash: subset.applies,
    subsetCandidates: subset.applies ? clashSubsets.length : 0,
    subsetNamedByTitle: subset.subsetName,
  };
  const splitReasons = split.split ? [`split-identity:${split.klass}:${split.reason}`] : [];
  // Carried alongside the split reasons for the same reason: every return
  // path prints them, so a refusal is never silent.
  splitReasons.push(...derivationRefused.map((r) => `derivation-refused:${r}`));
  if (family.qualifies) splitReasons.push(`subclass:${FINISH_FAMILY_COLLISION}:${family.evidence.family}`);
  splitReasons.push(...subset.reasons);

  // THE SUBSET REFUSAL OUTRANKS THE CLASS. The row's address is shared by two
  // cards and its title does not say which one it is, so no class that could
  // move it is honest -- not AGREE (it agrees with an ambiguous address), and
  // not IMPROVE (there is nothing more specific to write). Report it and stop.
  if (subset.applies && subset.klass === UNDERIVABLE_FOR_SUBSET) {
    return {
      ...base, klass: UNDERIVABLE_FOR_SUBSET,
      axes: { same: [], filled: [], dropped: [], changed: [] },
      reasons: [...splitReasons], writable: false,
    };
  }

  if (!derived) {
    return { ...base, klass: UNDERIVABLE, axes: { same: [], filled: [], dropped: [], changed: [] }, reasons: [...(derivationReasons.length ? derivationReasons : ["no-derived-identity"]), ...splitReasons], writable: false };
  }

  const storedSetKeyBlank = storedSetKeyIsBlank(stored, derivationReasons);
  const axes = diffAxes(stored, derived, {
    storedSetKeyBlank, titleStatesNumber,
    // CF-THE-CHECKLIST-SPELLS-THE-NUMBER: the vertical gates the Pokemon
    // card-number fold. The ROW's sport, never the derivation's guess.
    sport: str(row?.sport ?? derived?.sport ?? stored?.sport),
    // CF-A-CATALOG-TITLE-NAMES-NO-PLAYER: the row's OWN title is the evidence
    // that its `player-<name>` segment was built out of the product name. A
    // fact about the row, like titleStatesNumber beside it.
    title: str(row?.title),
  });
  const reasons = [];

  // THE SLUG IS A NINTH AXIS, AND IT IS NOT IN `AXES`.
  //
  // The eight axes compare the row's FIELDS against the derived reading. A
  // base-eviction row is one where those eight agree perfectly -- fields and
  // title both say "base auto" -- and the disagreement is with the row's own
  // ADDRESS. Measured on the Gonzalez shape: a row whose printRun field is
  // blank diffs as AGREE on all eight while sitting on `:refractor:num-499`.
  //
  // So the subclass is evaluated BEFORE the axis diff decides, or the commonest
  // form of the defect is classified "nothing to do" and never seen again. Its
  // sibling form -- the same row that also copied the slug's /499 into its
  // printRun field -- would reach CONFLICT via dropped:printRun, and both must
  // land in the same subclass or the census reports one defect as two.
  const be = baseEvictionEvidence({ row, stored, derived, storedSlug, baseDestSlug, baseDestBacked, checklistPlayerName });
  if (be.qualifies) {
    reasons.push("subclass:BASE-EVICTION");
    if (axes.dropped.length) reasons.push(`dropped:${axes.dropped.join(",")}`);
    if (axes.changed.length) reasons.push(`changed:${axes.changed.join(",")}`);
    // THE SUBCLASS MOVES A ROW'S ADDRESS, NOT ITS IDENTITY.
    //
    // Evaluating the subclass before the axis diff (above) is what lets the
    // commonest shape be SEEN -- but seeing is not writing. An eviction is
    // defined as moving one row off a parallel slug it does not support, and
    // the only axes that may legitimately move under it are the ones that
    // describe the finish: `parallel` and `printRun`. Any OTHER axis that
    // dropped or changed is today's parser disagreeing with the row about
    // WHICH CARD THIS IS -- a different cardNumber, a different setKey or
    // year, a different sport, an auto flag flipped, or a grade demotion
    // (PSA 9 -> raw). The destination slug is built from the DERIVED
    // identity, so writing under any of those would file the row against a
    // card it was never proven to be, using an eviction's authority to do it.
    // A fleet never settles a contradiction about identity -- Drew does. The
    // subclass TAG stays (the census must still count the shape), the
    // contradicting axis is named in the reasons, and `writable` is false.
    const contradicting = [...axes.changed, ...axes.dropped]
      .filter((a) => !EVICTION_MOVABLE_AXES.has(a));
    if (contradicting.length) reasons.push(`base-eviction-contradicted:${contradicting.join(",")}`);
    return {
      ...base,
      // The class is CONFLICT even when the eight axes AGREE: the row and its
      // address contradict each other, and that is a conflict about the card's
      // identity whatever the fields say among themselves. Reporting it as
      // AGREE would put a written row in the one class that means "untouched".
      klass: CONFLICT, subclass: BASE_EVICTION, axes, reasons: [...reasons, ...splitReasons],
      evidence: be.evidence,
      // The SAME tier gate as IMPROVE, AND the axis gate. A protected row is
      // report-only forever, subclass or no subclass -- see the mutation
      // check; so is a row whose identity axes contradict the derivation.
      // ...and never while the row's colour family is collided and unruled
      // (see the IMPROVE path below for the case that surfaced this).
      // A derivation refused on any axis cannot authorize a write, and an
      // eviction is a write. D1 is the shape that matters here: a title that
      // names the stored finish is a title that names A finish, so the
      // eviction evidence should already have failed -- this is the belt to
      // that braces, and it is what a mutation check reverts.
      writable: prov.tier === AUTO && contradicting.length === 0 && !family.qualifies && derivationRefused.length === 0,
    };
  }

  if (!axes.filled.length && !axes.dropped.length && !axes.changed.length) {
    // AGREE carries the split flag too, and this is the case that matters
    // most: the row's fields and the derivation agree completely while its two
    // ADDRESSES name different cards. Nothing else in the census would ever
    // look at this row again.
    //
    // A NEAR-MISS EVICTION IS NAMED HERE, NOT SWALLOWED (audit gate,
    // 2026-09-03). The eight axes agree, so a row that sits on a parallel slug
    // and was REFUSED an eviction lands in AGREE -- which means "nothing to
    // do" and prints no reason at all. That is how a Tiffany row looked
    // identical to a row that was never a candidate, and it is exactly the
    // population an auditor has to be able to count: the guard's yield is only
    // visible if the refusal is recorded. Tagged only when the row was a real
    // candidate (its slug names a parallel), so the other 16.3M rows stay
    // silent.
    const near = be.failed.length && !be.failed.includes("slug-names-no-parallel")
      ? [`not-base-eviction:${be.failed.join(",")}`] : [];

    // SELLER-NAME-AUTO: THE ROW THAT AGREES WITH ITS OWN DEFECT.
    //
    // These rows land HERE, in AGREE, and that is the whole problem. The
    // runner computes `isAuto` as `parsed.isAuto || row.isAuto === true`, so
    // the stored wrong flag is OR'd into the derivation: a FIXED parser still
    // re-derives `auto` on a base card whose title ends "... AutographDen",
    // the eight axes agree, and the row reports "nothing to do" forever. The
    // 102,621-row population cannot be reached from the CONFLICT arm, because
    // it never gets there.
    //
    // So the subclass is evaluated on the AGREE path, and it is the ONLY
    // thing that may leave it. Every leg is checked in
    // `sellerNameAutoEvidence`; the derived identity written is the stored one
    // with `isAuto` FALSE -- the base identity of the very same card. Nothing
    // else moves: not the number, not the grade, not the parallel (S5).
    //
    // It takes THE ORDINARY IMPROVE GATE, through the same
    // `allImproveRefusals` the other two IMPROVE arms call, for the reason
    // #1753 spells out: two copies of a gate is one gate that silently is not
    // there. A row that fails a leg falls straight through to the AGREE return
    // it reaches today, carrying its failed legs so the census can count
    // exactly which one held it back.
    const sna = sellerNameAutoEvidence({
      row, stored, derived, axes, checklistSaysNotAuto, autoByCardNumber,
    });
    if (sna.qualifies) {
      const refusals = allImproveRefusals({ row, stored, derived, axes, parserSaysLot, family, derivationRefused });
      const snaReasons = [
        `subclass:${SELLER_NAME_AUTO}`,
        "seller-name-auto:isAuto true->false",
        "checklist-says-not-auto",
      ];
      return {
        ...base,
        klass: IMPROVE, subclass: SELLER_NAME_AUTO,
        axes: { ...axes, changed: ["isAuto"] },
        // The repair target: this card's own base identity. The stored
        // identity is already right on every other axis -- that is what S5
        // asserts -- so the write is the one flag.
        derived: { ...(derived ?? stored), isAuto: false },
        reasons: [...near, ...snaReasons, ...refusals, ...splitReasons],
        improveRefusals: refusals,
        sellerNameAutoEvidence: sna.evidence,
        writable: prov.tier === AUTO && refusals.length === 0,
      };
    }
    // A NEAR MISS IS NAMED, NOT SWALLOWED -- but only for rows that were real
    // candidates. Gating on S1 keeps the other ~16M AGREE rows silent instead
    // of each carrying a reason that says only "this title has no shop name",
    // which is a count of the corpus and not of the defect.
    const snaNear = sna.failed.includes("autograph-witness-is-not-seller-only")
      ? [] : [`not-seller-name-auto:${sna.failed.join(",")}`];

    return { ...base, klass: AGREE, axes, reasons: [...near, ...snaNear, ...splitReasons], writable: false };
  }

  // A demotion or a lateral change on ANY axis is a conflict, whatever else
  // improved. This is the only-improve rule stated as code: an identity that
  // contradicts the stored one on a named axis is a different reading of the
  // card, and a fleet never settles that -- Drew does.
  if (axes.dropped.length) reasons.push(`dropped:${axes.dropped.join(",")}`);
  if (axes.changed.length) reasons.push(`changed:${axes.changed.join(",")}`);
  if (axes.dropped.length || axes.changed.length) {
    // SPECIALIZATION-STATED: THE ONE `changed:setKey` THAT IS NOT A RIVAL
    // READING (Drew's Maddux, 2026-09-04).
    //
    // This is the ONLY place a changed axis may leave the CONFLICT path, and
    // it is deliberately the narrowest possible door: the stored key must be
    // an ANCESTOR of the derived one on the product-family ladder, the title
    // must STATE every word that distinguishes them, the derived identity must
    // be backed by a real scraped checklist, no axis but `setKey` may have
    // moved, and the stored flagship's own checklist must not list the card.
    // See SPECIALIZATION_STATED above for why each leg is there.
    //
    // Evaluated BEFORE the collapse refusal below on purpose. The two read the
    // same ladder in opposite directions and cannot both fire on one row --
    // `derivationCollapsesProduct` is a strict-descendant-to-ancestor test and
    // this is its inverse -- but ordering it first means the census output
    // shows a qualifying row as IMPROVE rather than as a collapse that was
    // then overturned, and a reader should not have to reconcile two verdicts.
    //
    // A row that FAILS a leg falls straight through to the CONFLICT return it
    // reaches today, carrying its failed legs in `reasons` so the census can
    // count exactly which one held it back. That count is the report the
    // staged 1984-1991 Traded Tiffany checklist is judged by.
    const spec = specializationStatedEvidence({
      row, stored, derived, axes,
      derivedBacked: derivedBackedStrict === true,
      storedFlagshipListsCardNumber,
    });
    if (spec.qualifies) {
      // The row now takes the ORDINARY IMPROVE gate, through THE SAME
      // function the ordinary arm calls. Sharing `allImproveRefusals` rather
      // than restating its three pushes is not tidiness: the mutation checks
      // in rematchDerivationDefects.test.ts revert exactly those pushes and
      // assert there is EXACTLY ONE site to revert. Two copies would leave
      // this arm silently unguarded by the pin that guards the other.
      const refusals = allImproveRefusals({ row, stored, derived, axes, parserSaysLot, family, derivationRefused });
      const specReasons = [
        `subclass:${SPECIALIZATION_STATED}`,
        `specialization:${spec.evidence.storedSetKey}->${spec.evidence.derivedSetKey}`,
        `title-states:${spec.evidence.distinguishingWords.join("+")}`,
      ];
      return {
        ...base,
        klass: IMPROVE, subclass: SPECIALIZATION_STATED, axes,
        reasons: [...reasons, ...specReasons, ...refusals, ...splitReasons],
        improveRefusals: refusals,
        specializationEvidence: spec.evidence,
        writable: prov.tier === AUTO && refusals.length === 0,
      };
    }
    // A NEAR MISS IS NAMED, NOT SWALLOWED. Only for rows that were real
    // candidates -- the ladder held -- or the other millions of `changed`
    // rows would each carry a reason that says only "this was never a
    // Tiffany row", which is a count of the corpus and not of the defect.
    if (!spec.failed.includes("not-a-ladder-specialization")) {
      reasons.push(`not-specialization-stated:${spec.failed.join(",")}`);
    }
    // A PRODUCT-FAMILY COLLAPSE IS REFUSED BY NAME (Drew, 2026-09-03).
    //
    // `changed:setKey` already lands in CONFLICT, and CONFLICT is already
    // never writable -- so the row was contained before this line existed.
    // What it was NOT was NAMEABLE: 2,922,114 rows reported as the same
    // undifferentiated `changed:setKey` defect, with the ~1.5M of them that
    // are product-family collapses indistinguishable from the genuine rival
    // readings. Drew ruled every pair below DISTINCT; a ruling that cannot be
    // counted in the census output is a ruling nobody can verify was applied.
    //
    // So the reason names the pair, says it was ruled, and carries the
    // measured row count. `writable` is untouched -- it is false on this path
    // by construction, and the mutation test pins that flipping this reason
    // off does not make one of these rows writable.
    const collapse = derivationCollapsesProduct(stored, derived);
    if (collapse) {
      const pair = ruledCollapsePair(stored?.setKey, derived?.setKey);
      reasons.push(pair
        ? `setkey-collapses-distinct-product:${collapse}:${pair.ruled ? "ruled" : "census-found"}:est-${pair.est}`
        : `setkey-collapses-distinct-product:${collapse}:structural`);
    }
    // REPORT NOISE TAG ONLY -- never changes the class or `writable`.
    // ingestGradeFromTitle reads the SET NAME "Topps Pristine" plus a 2+ digit
    // card number as PSA 10 (verified: "2024 Topps Pristine Baseball #131
    // Base" -> PSA 10; "#5" does not fire; no other set word collides). That
    // makes ~41.6k stored-RAW rows report as identity CONFLICTs that are pure
    // parser artifacts. They are already contained from writes -- a phantom
    // grade CHANGES the grade axis, and changed => CONFLICT => not writable --
    // so this only lets Drew filter the artifact out of the real conflicts.
    if (isPhantomGradeArtifact(stored, derived, axes)) reasons.push("changed:grade/phantom-set-word");
    // The subclass was already decided above and did not qualify. Diagnose only
    // the NEAR misses: every ordinary conflict fails this test trivially, and a
    // reason on all 16.3M of them tells the banner nothing -- a row whose slug
    // names no parallel was never a candidate at all.
    if (be.failed.length && !be.failed.includes("slug-names-no-parallel")) {
      reasons.push(`not-base-eviction:${be.failed.join(",")}`);
    }
    return { ...base, klass: CONFLICT, axes, reasons: [...reasons, ...splitReasons], writable: false };
  }

  // Strictly more specific: nothing dropped, nothing changed, something filled.
  // Now the second gate -- a match proves nothing unless checklist-backed.
  if (!checklistBacked) {
    reasons.push(`filled:${axes.filled.join(",")}`, "not-checklist-backed");
    return { ...base, klass: CONFLICT, axes, reasons: [...reasons, ...splitReasons], writable: false };
  }

  reasons.push(`filled:${axes.filled.join(",")}`);

  // THE IMPROVE GUARDS (audit finding 7). IMPROVE was the class treated as
  // safe, and it was minting parallels out of product words and print runs
  // onto base rows. A refusal keeps the CLASS -- the census must still count
  // the shape, and Drew must be able to read what was refused and why -- and
  // takes `writable` to false, the same way the provenance tier does.
  const refusals = allImproveRefusals({ row, stored, derived, axes, parserSaysLot, family, derivationRefused });

  // A FLAGGED FAMILY COLLISION IS A REFUSAL LIKE THE OTHER THREE.
  //
  // Found by the pin, 2026-09-03: a row with a BLANK stored parallel, a "Green
  // Wave" title and a `green-geometric-refractor` slug diffs as filled:parallel
  // -- strictly more specific, checklist-backed -- and so reached IMPROVE with
  // `writable` true. The fleet would have moved it onto the parallel its title
  // names while the family it belongs to is exactly what Drew has not yet ruled
  // on, and while its POOL still holds the other family members. Filling a
  // blank axis is only an improvement when the destination is settled; inside a
  // collided family it is picking a side of the open question.
  //
  // It joins `improveRefusals` rather than sitting beside it because the audit
  // gate reads that array: a refusal that is not IN the list is a refusal the
  // census cannot report and the canary cannot count. The class stays IMPROVE
  // -- that is what the census measured, and hiding the shape would lose the
  // count -- and `writable` is what the apply pass reads.
  // (the family-collision and derivation-defect refusals are appended inside
  //  `allImproveRefusals` -- see there for why each one belongs in this array)

  if (refusals.length) reasons.push(...refusals);
  reasons.push(...splitReasons);

  // PROTECTED rows are report-only forever, even when IMPROVE-shaped. The
  // class still says IMPROVE (that is what the census measured); `writable`
  // is what the apply pass reads, and it is false.
  return { ...base, klass: IMPROVE, axes, reasons, improveRefusals: refusals, writable: prov.tier === AUTO && refusals.length === 0 };
}

/**
 * The known parser artifact: a stored RAW row on a set whose NAME contains
 * "pristine", re-derived as a graded row purely because the set word plus a
 * 2+ digit card number reads as a grade. Detection is deliberately narrow --
 * stored must be raw, derived must be graded, and grade must be the artifact
 * shape -- so a genuine grade change is never tagged away.
 */
function isPhantomGradeArtifact(stored, derived, axes) {
  if (!axes?.changed?.includes("grade")) return false;
  if (gradeToken(stored) !== "RAW") return false;          // only a stored-raw row
  if (gradeToken(derived) === "RAW") return false;          // derived must claim a grade
  const set = `${lower(stored?.setKey)} ${lower(derived?.setKey)}`;
  return /pristine/.test(set);
}

// -- THE APPLY CLASS SCOPE (audit gate item 8) -----------------------------
//
// CF-A-CENSUS-IS-A-DIFF-BEFORE-A-WRITE, applied to the classes separately.
//
// The second audit gate measured the two writable classes and they came back
// UNEQUAL: BASE-EVICTION is clean corpus-wide (0 bad in 1,236 audited lines
// over all 16 shards -- Tiffany, Desert Shield, Rapture, Press Proof, Members
// Only, Embossed and Mahogany all resolve), while IMPROVE is dirty at 4.9%
// (298 of 6,106). Before this, `MODE=apply-improve` wrote BOTH: one verdict
// gated two populations, so the class that earned its apply could not have it
// without dragging along the class that had not.
//
// So the apply takes a CLASS SCOPE. `base-eviction` alone, `improve` alone, or
// both -- and the scope is a REFUSAL, not a filter on a report: a candidate of
// an unarmed class is never queued and never written, and the banner says
// which classes are armed before a single row is read.
//
// NO NEW WORKFLOW INPUT. GitHub caps workflow_dispatch at 25 inputs and 24 are
// used, so the scope rides the existing free-form `scope` input, which the
// backfill runner already exports as SCOPE. That input's documented default is
// "refractor" and it is INHERITED rather than chosen (its own description says
// so), which is why an unrecognised value is not silently treated as "both":
// an inherited default must not arm a write. The parse below maps the value to
// classes and reports how it read it, and the runner refuses an apply it
// cannot read.

/** The classes an apply may be scoped to. */
const APPLY_CLASSES = { IMPROVE, BASE_EVICTION };

/** Spellings of each class a dispatch may use. Deliberately generous on
 *  punctuation (base-eviction / base_eviction / baseeviction) and deliberately
 *  NOT generous on meaning: nothing here means "both" except the words that
 *  say both. */
/** The spellings that mean "undo", so `parseApplyScope` can tell an empty
 *  alias list that MEANS revert from one that means nothing. */
const REVERT_SCOPE_WORDS = new Set([
  "revert-eviction", "revert-evictions", "revert", "revert-base-eviction", "unevict",
]);

const APPLY_SCOPE_ALIASES = new Map([
  ["improve", [IMPROVE]],
  ["improves", [IMPROVE]],
  ["improve-only", [IMPROVE]],
  ["base-eviction", [BASE_EVICTION]],
  ["baseeviction", [BASE_EVICTION]],
  ["base-evictions", [BASE_EVICTION]],
  ["eviction", [BASE_EVICTION]],
  ["evictions", [BASE_EVICTION]],
  ["base-eviction-only", [BASE_EVICTION]],
  // The undo. It arms NO write class -- `parseApplyScope` reports it through
  // `revert` instead, and the runner branches to the revert pass. So a scope
  // that says revert can never also write an eviction or an improve.
  ["revert-eviction", []],
  ["revert-evictions", []],
  ["revert", []],
  ["revert-base-eviction", []],
  ["unevict", []],
  ["both", [IMPROVE, BASE_EVICTION]],
  ["all", [IMPROVE, BASE_EVICTION]],
  ["all-classes", [IMPROVE, BASE_EVICTION]],
]);

/**
 * Parse a dispatch `scope` value into the set of classes an apply may write.
 *
 * Returns { classes, ok, reason, raw }. `ok` false means the value named no
 * class the apply understands -- including the runner-wide inherited default
 * "refractor" and the empty string. The caller REFUSES on !ok rather than
 * defaulting: a scope that arms a write has to have been asked for.
 *
 * A comma list arms the union ("improve,base-eviction"), so a single dispatch
 * can still do both by naming both.
 */
function parseApplyScope(raw) {
  const v = lower(raw).replace(/[_\s]+/g, "-");
  const out = { classes: new Set(), ok: false, reason: "", raw: str(raw), revert: false };
  if (!v) { out.reason = "scope is empty -- an apply must name the class it writes"; return out; }
  const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
  const unknown = [];
  for (const part of parts) {
    const hit = APPLY_SCOPE_ALIASES.get(part);
    if (hit) { out.revert = out.revert || REVERT_SCOPE_WORDS.has(part); for (const k of hit) out.classes.add(k); }
    else unknown.push(part);
  }
  // THE UNDO IS EXCLUSIVE. A dispatch that says "revert-eviction,improve" is a
  // dispatch that means two opposite things about the same pool in one run,
  // and there is no reading of it that is safe to guess. Refused by name.
  if (out.revert && out.classes.size) {
    out.classes.clear(); out.revert = false;
    out.reason = `scope ${JSON.stringify(str(raw))} asks to REVERT and to WRITE in one run -- name one`;
    return out;
  }
  // A SCOPE THAT IS PART UNDERSTOOD IS NOT UNDERSTOOD, and that is checked
  // BEFORE the revert is armed as well as before a class is -- otherwise
  // `revert-eviction,bogus` would leave `revert` true on a refused parse and
  // a caller reading the flag without the verdict would run the undo anyway.
  if (unknown.length) {
    out.classes.clear();
    out.revert = false;
    // The message NAMES the options, because this is the branch the runner's
    // inherited default "refractor" lands in and a dispatcher reading it needs
    // to learn what the accepted scopes actually are -- including the revert,
    // which is otherwise undiscoverable.
    out.reason = `scope ${JSON.stringify(str(raw))} carries unrecognised token(s) ${unknown.join(",")} `
      + `(expected one of: improve, base-eviction, both, revert-eviction)`;
    return out;
  }
  if (out.revert) {
    out.ok = true;
    out.reason = "armed: REVERT-EVICTION (no write class -- damaged evictions are moved back)";
    return out;
  }
  if (!out.classes.size) {
    out.reason = `scope ${JSON.stringify(str(raw))} names no apply class ` +
      `(expected one of: improve, base-eviction, both, revert-eviction)`;
    return out;
  }
  out.ok = true;
  out.reason = `armed: ${[...out.classes].join(" + ")}`;
  return out;
}

/**
 * Is this classified row writable UNDER THIS SCOPE?
 *
 * The conjunction of the row's own `writable` (every gate the classifier
 * applies) and the scope. Both halves are required, and this function is the
 * ONLY place the two are combined -- so a caller cannot arm a class by reading
 * `writable` directly and forgetting the scope.
 */
function writableUnderScope(result, classes) {
  if (!result?.writable) return false;
  const kind = applyKindOf(result);
  if (!kind) return false;
  return !!classes && classes.has(kind);
}

/** Which apply class a classified row belongs to, or null. IMPROVE by class,
 *  BASE-EVICTION by subclass; nothing else is ever an apply candidate. */
function applyKindOf(result) {
  if (!result) return null;
  if (result.klass === IMPROVE) return IMPROVE;
  if (result.subclass === BASE_EVICTION) return BASE_EVICTION;
  return null;
}

/** The defect axis a row contributes to the banner's per-class breakdown.
 *  A row can move on several axes; each is counted. */
function defectAxes(result) {
  const out = [];
  for (const a of result?.axes?.filled ?? []) out.push(`filled:${a}`);
  for (const a of result?.axes?.dropped ?? []) out.push(`dropped:${a}`);
  for (const a of result?.axes?.changed ?? []) out.push(`changed:${a}`);
  return out;
}

/** A short, human-readable rendering of an identity for the evidence sample. */
function renderIdentity(id) {
  if (!id) return "(none)";
  const bits = [
    id.sport ?? "?", id.cardYear ?? "?", id.setKey ?? "?", id.cardNumber ?? "?",
    id.parallel || "base", id.isAuto === true ? "auto" : "no-auto",
  ];
  if (id.printRun !== null && id.printRun !== undefined && id.printRun !== "") bits.push(`/${id.printRun}`);
  const g = gradeToken(id);
  if (g !== "RAW") bits.push(g.replace("|", " "));
  return bits.join(":");
}

module.exports = {
  AGREE, IMPROVE, CONFLICT, UNDERIVABLE, PROTECTED, AUTO, BASE_EVICTION,
  UNDERIVABLE_FOR_SUBSET, subsetVerdict: SUBSET.subsetVerdict,
  resolveSubsetFromTitle: SUBSET.resolveSubsetFromTitle,
  titleNamesSubset: SUBSET.titleNamesSubset,
  FINISH_FAMILY_COLLISION, FAMILY_COLOURS, colourFamilyOf, finishFamilyCollision,
  // SPECIALIZATION-STATED (2026-09-04) -- the IMPROVE subclass, its mirrored
  // ladder and each of its legs, exported piece by piece so a pin can drive
  // one alone and the mutation check can revert one alone. A leg nothing can
  // call alone is a leg nothing can prove.
  // SELLER-NAME-AUTO (2026-09-04) -- the subclass, the MIRRORED witness regex
  // and each leg, exported piece by piece so a pin can drive one alone and the
  // mutation check can revert one alone. AUTO_WITNESS_RE and
  // SELLER_SHOP_TOKEN_RE are exported specifically so the mirror test can
  // compare them against the compiled authority, character for character.
  SELLER_NAME_AUTO, AUTO_WITNESS_RE, LEGACY_AUTO_WITNESS_RE, SELLER_SHOP_TOKEN_RE,
  autographWitnessIsSellerNameOnly, sellerNameAutoEvidence,
  SPECIALIZATION_STATED, SPECIALIZATION_PARENTS, LADDER_MIRRORED_KEYS,
  SAME_NUMBER_PARALLEL_SETS, isSameNumberParallelSet,
  STRICT_CHECKLIST_SOURCES, STRICT_PUBLISHER_LANES, normalizeCatalogSource, isStrictChecklistSource,
  specializationAncestry, isSpecializationOf, distinguishingWords,
  titleStatesWord, specializationStatedEvidence,
  PROTECTED_SOURCES, PROTECTED_MARKER_FIELDS, AXES, GENERIC_PARALLELS,
  GENERIC_SETKEYS, storedSetKeyIsBlank, RULED_COLLAPSE_PAIRS, ruledCollapsePair,
  // GATE 3 slot-31 (2026-09-04): GUARD 8 and GUARD 9, exported piece by piece
  // so a pin can drive one alone and the mutation check can revert one alone.
  NON_CARD_FORMAT_RE, nonCardFormatNamed, setKeyNamesFormat,
  FINISH_NOUNS, finishWitnessIsNamed,
  DISTINCT_PRODUCT_SETKEYS, SPECIALIZATION_CHILDREN_OF,
  FINISH_TOKENS, FINISH_PHRASES, FINISH_COLOR_TOKENS,
  provenanceTier, gradeToken, axisValue, axisIsBlank, diffAxes, classifyRow,
  defectAxes, renderIdentity,
  // The SPLIT-IDENTITY signal's own vocabulary, re-exported so a census banner
  // reading this module does not have to know the lib is split in two.
  SPLIT_CLASSES: {
    COHERENT: SPLIT.COHERENT, VENDOR_DESIGN: SPLIT.VENDOR_DESIGN,
    UNKNOWN_VENDOR: SPLIT.UNKNOWN_VENDOR, HIQ_SPLIT: SPLIT.HIQ_SPLIT, MALFORMED: SPLIT.MALFORMED,
  },
  classifyIdentity: SPLIT.classifyIdentity,
  titleNamesFinish, titleStatesSerial, slugParallelSegment, slugNamesParallel, baseEvictionEvidence,
  titleEchoesSlugParallel,
  // G6 -- the stored identity's own parallel, stated in the title, refuses the
  // eviction whatever the vocabulary knows. Exported piece by piece so each
  // half can be driven alone and reverted alone by the mutation check.
  slugIsWellFormed, parallelTokensOfStoredIdentity, storedParallelStatedInTitle,
  // The team-name suppression G6 reads its witness through, exported so the
  // pin can drive it alone and the mutation check can revert it alone.
  TEAM_NAME_PHRASES, titleWithoutTeamNames,
  // CF-A-PLAYER-NAME-IS-NOT-A-FINISH (2026-09-04) -- the same suppression read
  // on the other noun, exported piece by piece for the same reason: a pin must
  // be able to drive the word split, the trust gate and the strip separately,
  // and the mutation check must be able to revert exactly one of them.
  NAME_PARTICLES, playerNameWords, trustedPlayerName, titleWithoutPlayerName,
  storedNameCarriesAFinishWord,
  // The two report-only slug-shape census subclasses (2026-09-04).
  SLUG_SHAPE_DEFECTS, slugShapeDefects,
  // The derivation-defect guards (D1, D6, D7, D8, V3), exported so each pin
  // can drive one directly and the mutation check can revert them one at a
  // time -- a guard nothing can call alone is a guard nothing can prove.
  derivationRefusals, titleNamesStoredFinish, isAutoFlipIsTitleOnly,
  gradeFromTitleStrict, derivedGradeIsAdjectiveArtifact,
  cardNumberIsTruncation, cardNumberDiffersOnlyByCase, parallelIsGenericization,
  // CF-THE-CHECKLIST-SPELLS-THE-NUMBER (2026-09-04). The two Pokemon
  // card-number folds, exported so a pin can drive each alone and the mutation
  // check can revert each alone.
  pokemonNumberIsPositionOverTotal, pokemonNumberDiffersOnlyByPadding,
  // CF-UNPARSED-IS-NOT-UNNUMBERED (2026-09-04). The pseudo-number predicate and
  // the title-states-a-number fact, exported so the census can supply the fact
  // and a mutation check can revert each half alone.
  isPseudoCardNumber, titleStatesCardNumber, isCorruptedPlayerName,
  GRADER_RE, RAW_CONDITION_RE,
  // The trust ladder's new gates, exported so the tests can drive each one
  // directly and the mutation check can revert them one at a time.
  EVICTION_MOVABLE_AXES, DISTINCT_PRODUCT_SETKEYS,
  storedPrintRunNamesALimitedParallel, derivationCollapsesProduct, improveRefusals,
  allImproveRefusals,
  // The apply class scope (audit gate item 8) -- BASE-EVICTION is clean
  // corpus-wide while IMPROVE is not, so the apply is scopable to a class.
  APPLY_CLASSES, APPLY_SCOPE_ALIASES, parseApplyScope, applyKindOf, writableUnderScope,
  // The undo scope. A NAME, not a class -- see REVERT_EVICTION above.
  REVERT_EVICTION, REVERT_SCOPE_WORDS,
  VOCAB,
};
