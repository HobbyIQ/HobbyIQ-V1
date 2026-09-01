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
 */
"use strict";

// ── the classes ────────────────────────────────────────────────────────────
const AGREE = "AGREE", IMPROVE = "IMPROVE", CONFLICT = "CONFLICT", UNDERIVABLE = "UNDERIVABLE";
const PROTECTED = "PROTECTED", AUTO = "AUTO";

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
function classifyRow({ row, stored, derived, checklistBacked = false, derivationReasons = [] }) {
  const prov = provenanceTier(row);
  const base = { tier: prov.tier, provenanceReasons: prov.reasons };

  if (!derived) {
    return { ...base, klass: UNDERIVABLE, axes: { same: [], filled: [], dropped: [], changed: [] }, reasons: derivationReasons.length ? derivationReasons : ["no-derived-identity"], writable: false };
  }

  const axes = diffAxes(stored, derived);
  const reasons = [];

  if (!axes.filled.length && !axes.dropped.length && !axes.changed.length) {
    return { ...base, klass: AGREE, axes, reasons: [], writable: false };
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
    return { ...base, klass: CONFLICT, axes, reasons, writable: false };
  }

  // Strictly more specific: nothing dropped, nothing changed, something filled.
  // Now the second gate -- a match proves nothing unless checklist-backed.
  if (!checklistBacked) {
    reasons.push(`filled:${axes.filled.join(",")}`, "not-checklist-backed");
    return { ...base, klass: CONFLICT, axes, reasons, writable: false };
  }

  reasons.push(`filled:${axes.filled.join(",")}`);
  // PROTECTED rows are report-only forever, even when IMPROVE-shaped. The
  // class still says IMPROVE (that is what the census measured); `writable`
  // is what the apply pass reads, and it is false.
  return { ...base, klass: IMPROVE, axes, reasons, writable: prov.tier === AUTO };
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
  AGREE, IMPROVE, CONFLICT, UNDERIVABLE, PROTECTED, AUTO,
  PROTECTED_SOURCES, PROTECTED_MARKER_FIELDS, AXES, GENERIC_PARALLELS,
  provenanceTier, gradeToken, axisValue, axisIsBlank, diffAxes, classifyRow,
  defectAxes, renderIdentity,
};
