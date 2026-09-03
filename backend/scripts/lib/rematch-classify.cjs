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
const EVICTION_MOVABLE_AXES = new Set(["parallel", "printRun"]);

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
 * The finish/format words that name HOW a card is printed. A title containing
 * ANY of these is a title that might be naming a parallel, and that is enough
 * to take the row out of the subclass -- the test is deliberately over-broad
 * on the DISQUALIFYING side, because a false "this title names a finish" only
 * costs us an eviction we could have made, while a false negative writes.
 *
 * Grounded, not invented: every entry appears as a word in
 * data/checklist-parallel-names.json (21,090 distinct checklist-sourced
 * parallel names). Counts measured 2026-09-02 -- prizm 2,652, holo 877,
 * refractor 857, mosaic 490, patch 449, plate 387, pulsar 298, wave 292,
 * optic 260, mojo 250, laser 240, shimmer 237, foil 212, sapphire 208,
 * diamond 174, disco 137, lava 124, die-cut 110, hyper 107, pandora 93,
 * canvas 91, sparkle 86, scope 75, cracked ice 71, velocity 68, flash 56,
 * atomic 52, marble 52, aqua 51, camo 48, fireworks 42, dragon 38,
 * crystal 31, chrome 27, x-fractor 26, tiger 25, reactive 25, snakeskin 24,
 * tie-dye 22, speckle 21, superfractor 15, vapor 13, genesis 12, zebra 10,
 * pearl 8, stained glass 4. `PLURAL_PARALLEL_HEAD` in hobbyIqCardId.service
 * is the same closed-vocabulary discipline applied to slug tails.
 *
 * COLOUR WORDS ARE HERE TOO, and for the same reason: "Gold", "Orange",
 * "Blue" name parallels across every modern product even with no finish noun
 * beside them. A title saying "Gold" is a title we do not evict on.
 *
 * KNOWN AND DELIBERATE -- DO NOT "FIX" THIS CASUALLY. Several entries here are
 * PRODUCT words as well as finish words: chrome, prizm, mosaic, optic,
 * sapphire, diamond. "2024 Topps Chrome Judge #150" names a SET, not a
 * parallel, and this vocabulary disqualifies it anyway. That costs us
 * evictions we could have made -- the measured yield of ~391 rows is therefore
 * a FLOOR, not the true population -- and it costs them in the safe direction:
 * a false "this title names a finish" only leaves a row where it already sits,
 * while the opposite error writes a parallel row onto a base slug. Recovering
 * the lost yield needs a product-word/finish-word split (read the set segment
 * of the slug and drop a token from the test when it appears there), not the
 * deletion of these entries. Until that split exists, the suppression stays.
 */
const FINISH_TOKENS = [
  // finishes and formats
  "refractor", "refractors", "x-fractor", "xfractor", "fractor", "superfractor",
  "prizm", "prizms", "shimmer", "wave", "holo", "holofoil", "foil", "sparkle",
  "pulsar", "mojo", "mega", "atomic", "disco", "lava", "speckle", "canvas",
  "velocity", "hyper", "optic", "mosaic", "sapphire", "laser", "pandora",
  "flash", "aqua", "vapor", "scope", "tiger", "zebra", "snakeskin", "dragon",
  "fireworks", "diamond", "crystal", "prismatic", "reactive", "pearl", "marble",
  "camo", "genesis", "chrome", "ice", "glass", "cosmic", "nebula", "galactic",
  "logofractor", "raywave", "shock", "hyperplaid", "choice", "dazzle",
  // formats that are their own parallel families
  "plate", "plates", "die-cut", "diecut", "parallel", "variation", "ssp",
  // the numbered/limited vocabulary -- a title that says these is naming a
  // parallel even when it never says which finish
  "numbered", "serial",
];
// DELIBERATELY ABSENT, and asserted absent by the tests: `auto`, `autograph`,
// `rc`, `rookie`, `1st`, `prospect`, `base`. These describe the CARD, not how
// it is printed. Every 1st Bowman Auto title carries at least one of them --
// the very shape this subclass was authorized for -- so admitting one here
// would silently switch the whole thing off. `relic` and `patch` are absent
// for the same reason from the other direction: they name a card's CONTENT,
// and a relic card's parallel is still named separately when it has one.
/** Multi-word finish phrases, matched with flexible separators. */
const FINISH_PHRASES = [
  "cracked ice", "stained glass", "ray wave", "tie dye", "mini diamond",
  "printing plate", "short print", "gold rush", "black label",
];
/** Colour words that name a parallel on their own across modern products. */
const FINISH_COLOR_TOKENS = [
  "gold", "orange", "purple", "blue", "green", "red", "black", "pink", "yellow",
  "teal", "aqua", "bronze", "silver", "platinum", "copper", "sepia", "magenta",
  "cyan", "lime", "indigo", "violet", "rose", "amber", "onyx", "emerald",
  "ruby", "sapphire", "gunmetal", "chartreuse", "fuchsia", "neon", "atomic",
];

const FINISH_WORD_SET = new Set([...FINISH_TOKENS, ...FINISH_COLOR_TOKENS]);
/** Split a title into comparable words. `/` and `#` are boundaries, so a
 *  print-run "/499" never glues itself to the word beside it. */
const titleWords = (t) => lower(t).split(/[^a-z0-9-]+/).filter(Boolean);

/**
 * Does this title name a finish? Word-exact against the closed vocabulary,
 * plus the multi-word phrases with flexible separators.
 *
 * Word-EXACT matters: a substring test would read "Goldschmidt" as "gold" and
 * "Refractory" as "refractor", and a player's surname is not a parallel. The
 * hyphenated entries ("x-fractor", "die-cut") are checked both as one word and
 * as the un-hyphenated join, because titles spell them either way.
 */
function titleNamesFinish(title) {
  const t = lower(title);
  if (!t) return false;

  // A SERIAL NUMBER IS A PARALLEL NAMED IN DIGITS.
  //
  // Measured on the live pool 2026-09-02: of the six qualifying examples the
  // corpus probe surfaced, THREE carried a serial number in the title and no
  // finish word -- "... Cole Young #PA-CY /50", "... Prized Pros. /250",
  // "... JARLIN SUSANA 59/149 PSA 1". A base card is not serial-numbered, so a
  // title stating a print run is a title telling us the card is from a limited
  // parallel whose NAME the seller happened to omit. That is precisely the
  // residual risk the ruling names, and it is cheap to catch here rather than
  // leave to the audit.
  //
  // Matched as `/N` or `N/N` with the slash a real boundary, so a grade
  // ("PSA 10") and a card number ("#140") are untouched. The DENOMINATOR is
  // excluded when it looks like a year (19xx/20xx): "sold 8/2026" is a date,
  // and no print run is 2,026 -- runs are 1/1, /5, /25, /50, /99, /150, /250,
  // /499, /999. Being over-broad is otherwise SAFE here (a false "this names a
  // finish" only costs an eviction we could have made, never a wrong write),
  // so this is the one exclusion worth carving and no more.
  const YEARISH = /^(19|20)\d{2}$/;
  const numbered = t.match(/(?:^|[\s(\[#])(\d{1,5})\s*\/\s*(\d{1,5})(?=$|[\s)\],.])/);
  if (numbered && !YEARISH.test(numbered[2])) return true;
  const bare = t.match(/(?:^|[\s(\[])\/\s*(\d{1,5})(?=$|[\s)\],.])/);
  if (bare && !YEARISH.test(bare[1])) return true;

  for (const p of FINISH_PHRASES) {
    if (new RegExp(`\\b${p.split(" ").join("[\\s-]+")}\\b`).test(t)) return true;
  }
  const words = titleWords(t);
  for (const w of words) {
    if (finishWord(w)) return true;
    // A HYPHENATED COMPOUND IS ITS PARTS. "OPTIC-FLEX" tokenises whole and
    // would never match bare "optic" -- and that row was in the probe's own
    // qualifying sample, one hyphen away from being written to a base slug.
    // Splitting is safe in this direction: a compound containing a finish word
    // is a compound naming a finish.
    if (w.includes("-") && w.split("-").some((part) => part && finishWord(part))) return true;
  }
  return false;
}

/** One word against the closed vocabulary, allowing a checklist's plural
 *  ("Refractors" heads a section; the parallel one card carries is singular). */
function finishWord(w) {
  if (FINISH_WORD_SET.has(w)) return true;
  return w.endsWith("s") && FINISH_WORD_SET.has(w.slice(0, -1));
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
  // 3. the title names no finish either
  if (!title) fail.push("no-title");
  else if (titleNamesFinish(title)) fail.push("title-names-a-finish");
  // 4. somewhere checklist-backed to go
  if (!baseDestBacked) fail.push("no-checklist-backed-base-destination");
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

/** The colour words a family collision is measured on -- the same bare-colour
 *  vocabulary the writer-side guard uses (titleOutranksVendorTag.ts), so the
 *  census counts exactly the shape the writer now refuses to create. */
const FAMILY_COLOURS = new Set([
  "gold", "blue", "green", "orange", "red", "purple", "black", "silver",
  "pink", "yellow", "aqua", "sapphire", "bronze", "teal", "copper",
]);

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
function finishFamilyCollision({ row, storedSlug, stored }) {
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
  const words = titleWords(title);
  if (!words.includes(family)) return { qualifies: false, evidence: ev };

  // ...and it must name a finish word BESIDE the colour that the slug's
  // parallel does not carry (or vice versa). A title saying exactly what the
  // slug says is agreement, and agreement is not a collision.
  //
  // TWO WORDS ARE EXCLUDED FROM THE COMPARISON, both learned from real rows:
  //
  // 1. PRODUCT WORDS THE SLUG'S OWN SET SEGMENT CARRIES. "2025 Bowman CHROME
  //    Green Wave" names the PRODUCT in the title and the slug says
  //    `bowman-chrome`; counting "chrome" as a finish the slug's parallel
  //    lacks would report every Bowman Chrome row as collided. The same
  //    suppression FINISH_TOKENS documents for the eviction vocabulary,
  //    applied where the set segment can actually be read.
  // 2. WORDS OUTSIDE THE FINISH VOCABULARY ENTIRELY, on the SLUG side --
  //    "geometric" in `green-geometric-refractor` is a real parallel word we
  //    do not carry in FINISH_TOKENS, and treating our own vocabulary gap as
  //    the title "dropping" a word would flag agreement as collision. Only
  //    words we can actually adjudicate are compared, in both directions.
  const setWords = new Set(String(slug.split(":")[3] ?? "").split(/[^a-z0-9]+/).filter(Boolean));
  const comparable = (w) => w !== family && finishWord(w) && !setWords.has(w);
  const slugWords = new Set(slugParallel.split(/[^a-z0-9]+/).filter(Boolean));
  const titleFinishWords = words.filter(comparable);
  ev.titleFamilyWords = titleFinishWords;
  const titleAddsOrDrops =
    titleFinishWords.some((w) => !slugWords.has(w)) ||
    [...slugWords].some((w) => comparable(w) && !words.includes(w));
  return { qualifies: titleAddsOrDrops, evidence: ev };
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
  const family = finishFamilyCollision({ row, storedSlug, stored });
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
    return { ...base, klass: AGREE, axes, reasons: splitReasons, writable: false };
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

  reasons.push(`filled:${axes.filled.join(",")}`, ...splitReasons);
  // A FLAGGED FAMILY COLLISION IS NEVER WRITTEN, INCLUDING AS AN IMPROVE.
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
  // The class stays IMPROVE -- that is what the census measured, and hiding the
  // shape would lose the count -- and `writable` is what the apply pass reads.
  if (family.qualifies) reasons.push("finish-family-collision:not-writable-until-ruled");
  return { ...base, klass: IMPROVE, axes, reasons, writable: prov.tier === AUTO && !family.qualifies };
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
  titleNamesFinish, slugParallelSegment, slugNamesParallel, baseEvictionEvidence,
};
