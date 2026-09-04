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
const VOCAB = require(path.join(__dirname, "rematch-finish-vocab.cjs"));

// ── the classes ────────────────────────────────────────────────────────────
const AGREE = "AGREE", IMPROVE = "IMPROVE", CONFLICT = "CONFLICT", UNDERIVABLE = "UNDERIVABLE";
const PROTECTED = "PROTECTED", AUTO = "AUTO";
/** The one CONFLICT subclass authorized for audited auto-apply (Drew 2026-09-02). */
const BASE_EVICTION = "BASE-EVICTION";
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
 *  generic parallels, and RAW is NOT blank -- raw is an answer. */
function axisIsBlank(axis, value) {
  if (value === "") return true;
  if (axis === "parallel") return GENERIC_PARALLELS.has(value);
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
 * The three evidence fields, quoted, for ONE row. Returns
 * { qualifies, evidence } where evidence is what the census banner and the
 * rekeyedReason both print -- the row is never evicted on a verdict alone,
 * the quoted evidence travels with it.
 *
 * `baseDestBacked` is the caller's verdict that a CHECKLIST-BACKED base
 * destination row exists for this card. Without it there is nowhere to evict
 * TO, and a row is never moved to a slug the checklist does not list.
 */
function baseEvictionEvidence({ row, stored, derived, storedSlug, baseDestSlug, baseDestBacked }) {
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
  if (!title) fail.push("no-title");
  else if (titleNamesFinish(title, { year: beYear, setKey: beSetKey })) fail.push("title-names-a-finish");
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
 */
function finishFamilyCollision({ row, storedSlug, stored, derived }) {
  const title = str(row?.title);
  const slug = str(storedSlug ?? row?.cardId);
  const slugParallel = slugParallelSegment(slug);
  const ev = {
    storedSlugParallel: slugParallel,
    titleQuoted: title.slice(0, 160),
    storedParallelField: stored?.parallel ?? null,
    family: null,
    titleFamilyWords: [],
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
  "bowmans-best", "bowman-sterling", "bowman-heritage", "bowman-chrome",
  "bowman-draft", "bowman-platinum", "bowman-inception", "bowman-1st-edition",
  "bowman-chrome-sapphire", "topps-chrome", "topps-chrome-black",
  "topps-heritage", "topps-heritage-chrome", "topps-allen-ginter",
  "topps-allen-ginter-chrome", "topps-fire", "topps-finest", "topps-gold-label",
  "topps-stadium-club", "topps-stadium-club-chrome", "topps-cosmic-chrome",
  "fleer-ultra", "panini-prizm", "panini-mosaic", "panini-optic",
];

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
  // 2. ITS TEST COULD NOT HAVE REFUSED ANYWAY. It asked
  //    `checklistListsParallel("Base", year, setKey)`, a TOKEN-membership test
  //    -- and `base` is a token of every product's checklist. It answered true
  //    for every product in the corpus.
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
  // Runs on ANY derived parallel, filled or not: the collapse is just as wrong
  // when the row already carried a sibling's name, and the fix at the source
  // (parseTitleIdentity's colour alternations) is a fix, not a guarantee.
  {
    const parallel = str(derived?.parallel);
    if (title && parallel && !axisIsBlank("parallel", axisValue(derived, "parallel"))) {
      const dropped = VOCAB.familyTokensDroppedByDerivation(title, parallel, setKey);
      if (dropped.length) {
        const listed = VOCAB.checklistParallelForFamily(title, year, setKey);
        refusals.push(
          `improve-title-names-a-finish-family-the-derivation-dropped:${dropped.join("+")}` +
          `@${parallel}${listed ? `|checklist-lists:${listed}` : ""}`,
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
      if (touchesNumber) refusals.push(`improve-lot-or-range-listing:${lot.reasons.join(",")}`);
    }
  }

  // GUARD 3: a setKey collapse never feeds IMPROVE.
  const collapse = derivationCollapsesProduct(stored, derived);
  if (collapse) refusals.push(`improve-setkey-collapses-distinct-product:${collapse}`);

  return refusals;
}

/**
 * Compare stored vs derived identity axis by axis.
 *   same     both name the same value (or both blank)
 *   filled   stored is blank/generic, derived names something
 *   dropped  stored names something, derived is blank/generic  -> a DEMOTION
 *   changed  both name something, and they differ              -> a CONFLICT
 */
function diffAxes(stored, derived) {
  const same = [], filled = [], dropped = [], changed = [];
  for (const axis of AXES) {
    const a = axisValue(stored, axis), b = axisValue(derived, axis);
    const aBlank = axisIsBlank(axis, a), bBlank = axisIsBlank(axis, b);
    if (a === b) { same.push(axis); continue; }
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
  // The PARSER'S own multi-card-lot verdict (`isMultiCardLot` from
  // parseTitleIdentity). Passed IN rather than imported: this module is pure
  // and must not require dist/. Two detectors, one decision -- the
  // count-anchored lot idioms live in the parser, the card-number range and
  // the pick/singles vocabulary live in rematch-finish-vocab.cjs, and GUARD 5
  // refuses on either. A caller that cannot supply it loses only the idioms
  // the parser owns; the range half still fires.
  parserSaysLot = false,
}) {
  const prov = provenanceTier(row);

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
  const base = {
    tier: prov.tier,
    provenanceReasons: prov.reasons,
    splitIdentity: split.split,
    splitClass: split.klass,
    splitSegments: split.segments,
    finishFamilyCollision: family.qualifies,
    finishFamily: family.qualifies ? family.evidence.family : null,
    finishFamilyEvidence: family.qualifies ? family.evidence : null,
  };
  const splitReasons = split.split ? [`split-identity:${split.klass}:${split.reason}`] : [];
  if (family.qualifies) splitReasons.push(`subclass:${FINISH_FAMILY_COLLISION}:${family.evidence.family}`);

  if (!derived) {
    return { ...base, klass: UNDERIVABLE, axes: { same: [], filled: [], dropped: [], changed: [] }, reasons: [...(derivationReasons.length ? derivationReasons : ["no-derived-identity"]), ...splitReasons], writable: false };
  }

  const axes = diffAxes(stored, derived);
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
  const be = baseEvictionEvidence({ row, stored, derived, storedSlug, baseDestSlug, baseDestBacked });
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
      writable: prov.tier === AUTO && contradicting.length === 0 && !family.qualifies,
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
    return { ...base, klass: AGREE, axes, reasons: [...near, ...splitReasons], writable: false };
  }

  // A demotion or a lateral change on ANY axis is a conflict, whatever else
  // improved. This is the only-improve rule stated as code: an identity that
  // contradicts the stored one on a named axis is a different reading of the
  // card, and a fleet never settles that -- Drew does.
  if (axes.dropped.length) reasons.push(`dropped:${axes.dropped.join(",")}`);
  if (axes.changed.length) reasons.push(`changed:${axes.changed.join(",")}`);
  if (axes.dropped.length || axes.changed.length) {
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
  const refusals = improveRefusals({ row, stored, derived, axes, parserSaysLot });

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
  if (family.qualifies) refusals.push("finish-family-collision:not-writable-until-ruled");

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
  const out = { classes: new Set(), ok: false, reason: "", raw: str(raw) };
  if (!v) { out.reason = "scope is empty -- an apply must name the class it writes"; return out; }
  const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
  const unknown = [];
  for (const part of parts) {
    const hit = APPLY_SCOPE_ALIASES.get(part);
    if (hit) for (const k of hit) out.classes.add(k);
    else unknown.push(part);
  }
  if (!out.classes.size) {
    out.reason = `scope ${JSON.stringify(str(raw))} names no apply class ` +
      `(expected one of: improve, base-eviction, both)`;
    return out;
  }
  if (unknown.length) {
    // A scope that is PART understood is not understood. Half a scope is how a
    // typo arms a class the dispatcher did not mean to arm.
    out.classes.clear();
    out.reason = `scope ${JSON.stringify(str(raw))} carries unrecognised token(s) ${unknown.join(",")}`;
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
  FINISH_FAMILY_COLLISION, FAMILY_COLOURS, colourFamilyOf, finishFamilyCollision,
  PROTECTED_SOURCES, PROTECTED_MARKER_FIELDS, AXES, GENERIC_PARALLELS,
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
  // The trust ladder's new gates, exported so the tests can drive each one
  // directly and the mutation check can revert them one at a time.
  EVICTION_MOVABLE_AXES, DISTINCT_PRODUCT_SETKEYS,
  storedPrintRunNamesALimitedParallel, derivationCollapsesProduct, improveRefusals,
  // The apply class scope (audit gate item 8) -- BASE-EVICTION is clean
  // corpus-wide while IMPROVE is not, so the apply is scopable to a class.
  APPLY_CLASSES, APPLY_SCOPE_ALIASES, parseApplyScope, applyKindOf, writableUnderScope,
  VOCAB,
};
