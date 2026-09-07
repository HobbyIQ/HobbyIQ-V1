/**
 * sport-contamination.cjs -- THE CROSS-SPORT PROBE. Pure: no I/O, no Cosmos,
 * no clock. Counts in, verdict out, so the retire lane, the queue-hygiene
 * report and the tests all decide the SAME way and a unit test can drive the
 * rule directly (the split-identity.cjs / withheld-acquisition-cells.cjs
 * precedent: a classification rule in a lib is pinned; the same rule inline
 * is not).
 *
 * CF-A-ROW-IN-THE-WRONG-SPORT-IS-NOT-A-MISSING-CHECKLIST (2026-09-07).
 *
 * -- THE DEFECT ------------------------------------------------------------
 *
 * The 2026-09-07 auto-seed census measured 32,044 card_catalog rows from
 * `ingest-auto-seed` / `ingest-auto-seed-graded` carrying a sport with ZERO
 * checklist backing in their product-year:
 *
 *     5,945  basketball -> baseball        3,905  hockey     -> baseball
 *     5,452  football   -> baseball        2,871  non-sport  -> baseball
 *     5,249  soccer     -> baseball        1,145  FOOTBALL on 1948-1955 bowman
 *
 * These rows ARE minted from sales -- self-derived -- so the retire lane
 * reaches every one of them (`ingest-auto-seed` leads SD_SOURCES). But the
 * lane runs SPORT=<one sport> and looks for a checklist twin within
 * (sport, year, setKey). A row whose SPORT ITSELF is wrong is compared against
 * the checklists of the WRONG sport, where by construction no twin exists. It
 * falls to lane (b), `identityUnverified`, and lands on THE ACQUISITION QUEUE
 * -- a work list of checklists to go and buy.
 *
 * So 1,145 rows ask for 1948-1955 Bowman FOOTBALL checklists. Those products
 * are baseball; the checklist cannot exist, and no publisher will ever serve
 * that cell. The acquisition queue must only carry (sport, year, setKey) cells
 * that a source CAN serve (CF-A-CATCH-ALL-KEY-IS-NOT-A-PRODUCT, Drew
 * 2026-09-05, makes the same argument for `draft`/`flagship`: "needs a source"
 * means *we know the product and no source serves it*, and a human reading a
 * bad entry goes looking for a product that does not exist).
 *
 * -- THE RULE, AND WHY IT IS THE PRODUCT THAT DECIDES -----------------------
 *
 * Ruling 6 (cross-sport inserts, 2026-09-06): THE PRODUCT'S SPORT IS THE
 * CARD'S SPORT. `bowman` is baseball-only by the Bowman setKey taxonomy
 * ruling; a sale whose title carried another sport's word does not make the
 * 1952 Bowman it minted a football card.
 *
 * So the probe asks ONE question of the PRODUCT, not of the row:
 *
 *   for this (year, setKey), which sports hold STRICT CHECKLIST rows?
 *
 *   the asking sport is among them   -> not contaminated. The lane's own
 *                                       in-sport twin comparison is correct
 *                                       and this module says nothing.
 *   exactly ONE other sport holds it -> CONTAMINATED. That sport is the row's
 *                                       true sport.
 *   several other sports hold it     -> AMBIGUOUS. A genuinely cross-sport
 *                                       product (`score`, `donruss-elite`)
 *                                       cannot arbitrate, and guessing which
 *                                       of three sports a row belongs to is
 *                                       exactly the "guessed address" #1929
 *                                       removed from the ingest.
 *   no sport holds it at all         -> not contaminated. This is the honest
 *                                       acquisition case the lane already
 *                                       handles: the product is real and we
 *                                       have not bought its checklist yet.
 *
 * ABSENCE OF CHECKLIST COVERAGE IS NOT ABSENCE OF THE PRODUCT. That is
 * setSportAuthority.cjs's founding lesson -- its first version read "we have
 * no 2024 Donruss BASEBALL checklist" as "2024 Donruss is not a baseball
 * product" and moved 1.24M comps the wrong way. This module never fires on an
 * empty product-year for exactly that reason: the fourth branch above is the
 * one that keeps the acquisition queue doing its real job.
 *
 * WHY NO DOMINANCE RATIO. setSportAuthority weighs sport against sport because
 * it adjudicates a COMP whose slug is evidence. Here the asking sport has ZERO
 * checklist rows -- there is nothing to weigh. The question is presence, not
 * plurality, and a threshold would only add a knob that turns a fact into a
 * judgement call.
 *
 * MIN_CHECKLIST_ROWS guards the other direction: one stray checklist row in
 * football does not make a baseball product football's. Absolute, not a ratio,
 * for setSportAuthority's reason -- a ratio over a single-sport sample is
 * always 1.0.
 */
"use strict";

/** A sport must hold at least this many strict checklist rows in the
 *  product-year before it can be called that product's true sport. One stray
 *  row is a misfiling, not an attestation. Absolute, never a ratio:
 *  dominance over a single-sport sample is always 1.0 (setSportAuthority). */
const MIN_CHECKLIST_ROWS = 3;

const normSport = (s) => String(s == null ? "" : s).toLowerCase().trim();

/**
 * Classify one self-derived row's sport against its product's checklist sports.
 *
 * @param {object} a
 * @param {string} a.sport                 the sport the ROW claims (the lane's SPORT)
 * @param {Map<string,number>|object} a.checklistSportCounts
 *        sport -> count of STRICT CHECKLIST rows in this (year, setKey),
 *        ACROSS ALL SPORTS. Built by the caller from one cross-sport read.
 * @param {number} [a.minChecklistRows]
 * @returns {{contaminated: boolean, verdict: string, trueSport: string|null,
 *            candidates: string[], reason: string|null}}
 *
 * `verdict` is one of:
 *   "agree"          the asking sport holds checklist rows here -- lane proceeds
 *   "contaminated"   exactly one OTHER sport holds them -> trueSport
 *   "ambiguous"      several other sports hold them -> no address to stand behind
 *   "no-attestation" nobody holds a checklist here -> the honest acquisition case
 */
function classifySportContamination({ sport, checklistSportCounts, minChecklistRows }) {
  const min = Number.isFinite(minChecklistRows) ? minChecklistRows : MIN_CHECKLIST_ROWS;
  const asking = normSport(sport);
  const entries = checklistSportCounts instanceof Map
    ? [...checklistSportCounts.entries()]
    : Object.entries(checklistSportCounts || {});

  // BLANK IS UNKNOWN, AND UNKNOWN NEVER MATCHES (the #1923 rule). A row whose
  // sport does not read names no product to ask about, and a checklist row
  // with no sport cannot attest one.
  const attesting = entries
    .map(([s, n]) => [normSport(s), Number(n) || 0])
    .filter(([s, n]) => s && n >= min);

  if (!attesting.length) {
    return { contaminated: false, verdict: "no-attestation", trueSport: null, candidates: [], reason: null };
  }
  if (!asking) {
    // No readable asking sport: we cannot say it disagrees with anything.
    return { contaminated: false, verdict: "no-attestation", trueSport: null, candidates: [], reason: null };
  }
  if (attesting.some(([s]) => s === asking)) {
    return { contaminated: false, verdict: "agree", trueSport: null, candidates: [], reason: null };
  }

  const others = attesting.map(([s]) => s).sort();
  if (others.length === 1) {
    return {
      contaminated: true,
      verdict: "contaminated",
      trueSport: others[0],
      candidates: others,
      // The reason is completed by the caller once it knows whether a twin
      // exists under the true sport -- `sport-contaminated:twin-in-<sport>`
      // or `sport-contaminated:no-twin`.
      reason: null,
    };
  }
  return {
    contaminated: true,
    verdict: "ambiguous",
    trueSport: null,
    candidates: others,
    reason: "sport-ambiguous",
  };
}

/** The reason string a contaminated row carries once the twin question is
 *  answered. Stated here, once, so the lane and the pins cannot drift. */
function contaminationReason(verdict, { trueSport, twinFound } = {}) {
  if (verdict === "ambiguous") return "sport-ambiguous";
  if (verdict !== "contaminated") return null;
  return twinFound ? `sport-contaminated:twin-in-${normSport(trueSport)}` : "sport-contaminated:no-twin";
}

/**
 * MAY THIS CELL BE ENQUEUED FOR ACQUISITION?
 *
 * The whole point of the probe. A cell whose checklist lives under another
 * sport is not a gap -- it is a misfiling, and asking a publisher for it is
 * wasted acquisition effort against a product that does not exist.
 *
 * A contaminated row NEVER enqueues:
 *   - not for its own (wrong) sport: no source can serve `football 1952 bowman`.
 *   - not for its true sport either: by construction that cell HAS a checklist
 *     -- that is the very fact that identified the contamination -- so there
 *     is nothing to acquire.
 * An ambiguous row never enqueues: we do not know which cell to ask for, and a
 * guessed cell is a guessed address.
 */
function mayEnqueueAcquisition(verdict) {
  return verdict === "agree" || verdict === "no-attestation";
}

module.exports = {
  classifySportContamination,
  contaminationReason,
  mayEnqueueAcquisition,
  MIN_CHECKLIST_ROWS,
};
