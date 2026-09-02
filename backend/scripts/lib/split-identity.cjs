/**
 * split-identity.cjs -- the SPLIT-IDENTITY predicate. Pure: no I/O, no Cosmos,
 * no clock. One row in, one classification out, so the census fleet, the
 * rematch classifier and the invariant auditor all decide the SAME way and a
 * unit test can drive the rule directly.
 *
 * CF-A-SPLIT-ROW-POLLUTES-TWO-POOLS (Drew, 2026-09-02: "we need to go back and
 * check ALL this way").
 *
 * A sold_comps row carries TWO identity fields. `cardId` is the partition key
 * the row was written under; `hobbyiqCardId` is the canonical slug. The exact
 * pool reader (services/compiq/exactPoolReader.ts) matches on EITHER:
 *
 *     WHERE (c.cardId = @cid OR c.hobbyiqCardId = @hiq ...)
 *
 * so when the two fields name DIFFERENT cards, that one row is read into BOTH
 * cards' pools. It prices two cards, and it is invisible to every per-pool
 * audit because each pool looks internally consistent -- the row is a correct
 * member of the pool it was asked for, every time it is asked. That is why
 * this is a per-ROW check and not a per-pool one: audit-identity-splits.cjs
 * finds one card spread over several pools, and cannot see this at all.
 *
 * MOST DISAGREEMENT IS THE DESIGNED SHAPE, NOT DAMAGE (#1650)
 *
 * The first sweep counted 399 disagreeing rows in the touched set and read all
 * of them as damage. 327 were not. A vendor ingest partitions its rows under
 * the VENDOR's own product id and carries our slug beside it -- cardId is a
 * CardHedge bubble id, hobbyiqCardId is the hiq slug. The fields disagree by
 * CONSTRUCTION. A control read on cards entirely outside the touched set
 * settled it: 1242 of 1242 cardhedge rows on two untouched cards are
 * partitioned exactly that way. Relocating them would have mis-repaired the
 * whole CardHedge pool.
 *
 * So the exemption predicate is LOAD-BEARING. Without it a corpus sweep
 * returns millions of "findings" that are the ingest working as designed, the
 * real damage drowns, and the census is worse than not running. The mutation
 * check in tests/splitIdentityCensus.test.ts proves it: drop the exemption and
 * the control shape must turn the census red.
 *
 * THE VENDOR SHAPES ARE ENUMERATED FROM THE DATA, NOT INVENTED
 *
 * Measured against the live pool 2026-09-02 (16,428,857 rows; 9,000 non-hiq
 * cardIds sampled across cardhedge / cardsight / tca-ebay):
 *
 *   4,988  bubble id      `1778542173652x303328120692600800`
 *                         13 digits, literal `x`, 15-21 digits. Bubble.io's
 *                         object id -- the CardHedge and Cardsight backing
 *                         store. This is the overwhelming majority.
 *     828  backstop form  `backstop:eric hartman|2026|cpa-eha|1st bowman`
 *                         Cardsight's composite fallback key.
 *     252  namespaced     `cardsight:<uuid>::<uuid>` and the bare `<uuid>::<uuid>`
 *                         pair, both seen on cardsight and ebay-user-purchase.
 *
 * A shape is exempt because it is NOT AN hiq SLUG AT ALL. That is the actual
 * rule and it is why the predicate generalises: a cardId that cannot name a
 * card in our namespace is a foreign key, and a foreign key beside our slug is
 * a partition, not a contradiction. The enumerated shapes above are recognised
 * BY NAME so the banner can report them and so an unrecognised foreign shape
 * is reported as UNKNOWN-VENDOR rather than silently exempted -- a new ingest
 * whose ids we have never seen is something Drew should be told about, not
 * something the census should quietly absorb.
 *
 * WHAT IS LEFT IS THE DAMAGE CLASS
 *
 * When BOTH sides are hiq: slugs and they differ, no ingest designed that. One
 * of the two is wrong and the row is being read into a card it is not. Sampled
 * 2026-09-02 across four sources, 3,864 such rows in a 12,000-row sample --
 * far more than the 72 the touched set contained, which is the whole reason
 * Drew asked for the corpus sweep. They sub-bucket by which slug segment
 * disagrees, because the segment names the kind of damage:
 *
 *   printRun 1,597   parallel 1,238   setKey 1,179
 *   cardNumber 262   sport 230        auto 93
 *
 * `sport` disagreements are the loudest: `hiq:baseball:...` beside
 * `hiq:wrestling:...` for one sale, and `baseball` beside `soccer` on Panini
 * Prizm. Those are two different cards by any reading.
 */
"use strict";

// ── the classes ────────────────────────────────────────────────────────────
/** The two fields agree (or only one is present). Nothing to see. */
const COHERENT = "COHERENT";
/** cardId is a known vendor product id, hobbyiqCardId is our slug. BY DESIGN. */
const VENDOR_DESIGN = "VENDOR-DESIGN";
/** cardId is foreign but its shape is not one we have enumerated. Reported. */
const UNKNOWN_VENDOR = "UNKNOWN-VENDOR";
/** BOTH sides are hiq: slugs and they name different cards. THE DAMAGE. */
const HIQ_SPLIT = "HIQ-SPLIT";
/** One or both sides are empty, null, or junk that is neither slug nor vendor id. */
const MALFORMED = "MALFORMED";

/**
 * The vendor id shapes, enumerated from the live pool (counts in the header).
 * Order matters only for which NAME a row reports; every entry means the same
 * verdict. Each carries the example it was derived from so a future reader can
 * re-measure rather than guess.
 */
const VENDOR_SHAPES = [
  {
    name: "bubble-id",
    // 13-digit epoch-ms, literal x, 15-21 digit counter. Anchored both ends:
    // an unanchored test would read a bubble id embedded in a longer junk
    // string as a clean vendor key.
    re: /^\d{13}x\d{15,21}$/,
    example: "1778542173652x303328120692600800",
    note: "Bubble.io object id — the CardHedge / Cardsight backing store",
  },
  {
    name: "backstop",
    re: /^backstop:.+/,
    example: "backstop:eric hartman|2026|cpa-eha|1st bowman",
    note: "Cardsight composite fallback key",
  },
  {
    name: "cardsight-uuid-pair",
    re: /^cardsight:[0-9a-f-]{36}::[0-9a-f-]{36}$/i,
    example: "cardsight:befe9bcc-…::334908f4-…",
    note: "Cardsight namespaced account::product pair",
  },
  {
    name: "uuid-pair",
    re: /^[0-9a-f-]{36}::[0-9a-f-]{36}$/i,
    example: "befe9bcc-…::f11498f6-…",
    note: "the same pair without the namespace prefix",
  },
  {
    name: "ch-prefixed",
    // ch-daily:: / ch-comp:: are sourceExternalId shapes today (see
    // audit-pool-identity.cjs), not cardId shapes. Enumerated anyway: the
    // fan-out that keys a comp row by its CH export id is one config change
    // away, and an unrecognised CH key would otherwise report as damage.
    re: /^ch-(daily|comp)::/,
    example: "ch-daily::12345",
    note: "CardHedge export/comps key, should it ever reach cardId",
  },
];

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isHiq = (v) => str(v).startsWith("hiq:");

/** The vendor shape this id matches, or null. */
function vendorShapeOf(id) {
  const s = str(id);
  if (!s || isHiq(s)) return null;
  for (const shape of VENDOR_SHAPES) if (shape.re.test(s)) return shape.name;
  return null;
}

/** The slug segments, in the order hiq slugs encode them. */
const SEGMENTS = ["sport", "cardYear", "setKey", "cardNumber", "parallel", "auto", "printRun", "grade"];

/**
 * Which slug segments disagree between two hiq slugs. A missing trailing
 * segment on one side counts as a disagreement on that segment -- an absent
 * print run and a `/499` are exactly the kind of split that empties a pool,
 * so treating "absent" as "matches anything" would hide the commonest form.
 */
function differingSegments(a, b) {
  const pa = str(a).split(":").slice(1);
  const pb = str(b).split(":").slice(1);
  const out = [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? "") !== (pb[i] ?? "")) out.push(SEGMENTS[i] ?? `seg${i}`);
  }
  return out;
}

/**
 * Classify ONE row's two identity fields.
 *
 * Returns { klass, vendorShape, segments, cardId, hobbyiqCardId, split }.
 * `split` is the single boolean every consumer gates on: TRUE only for a
 * genuine within-row contradiction (HIQ-SPLIT, UNKNOWN-VENDOR, MALFORMED),
 * never for the designed vendor partition. It is deliberately the ONLY thing
 * callers are meant to branch on, so a future class cannot be added in a way
 * that silently starts or stops flagging rows.
 */
function classifyIdentity(row) {
  const cardId = str(row?.cardId);
  const hobbyiqCardId = str(row?.hobbyiqCardId);
  const base = { cardId, hobbyiqCardId, vendorShape: null, segments: [] };

  // A row carrying only one identity has nothing to contradict. An absent
  // hobbyiqCardId is a COVERAGE question (auditSoldCompsHiqCoverage.cjs owns
  // it), not a coherence one, and conflating the two would let a backfill gap
  // read as pool damage.
  if (!cardId || !hobbyiqCardId) {
    return { ...base, klass: COHERENT, split: false, reason: "one-sided" };
  }
  if (cardId === hobbyiqCardId) {
    return { ...base, klass: COHERENT, split: false, reason: "identical" };
  }

  const bothHiq = isHiq(cardId) && isHiq(hobbyiqCardId);
  if (bothHiq) {
    // THE DAMAGE CLASS. No ingest writes two different slugs for one sale.
    const segments = differingSegments(cardId, hobbyiqCardId);
    return { ...base, klass: HIQ_SPLIT, segments, split: true, reason: `segments:${segments.join(",") || "none"}` };
  }

  // hobbyiqCardId must be OUR slug for the vendor-partition reading to hold.
  // A vendor id in the hobbyiqCardId field is not a partition, it is a row
  // whose canonical slug was never derived -- the fields disagree and neither
  // names a card we can read.
  if (!isHiq(hobbyiqCardId)) {
    return { ...base, klass: MALFORMED, split: true, reason: "hobbyiqCardId is not an hiq: slug" };
  }

  const shape = vendorShapeOf(cardId);
  if (shape) {
    // THE EXEMPTION. cardId is a foreign key, hobbyiqCardId is our slug: the
    // designed vendor partition (#1650). Counted, never flagged.
    return { ...base, klass: VENDOR_DESIGN, vendorShape: shape, split: false, reason: `vendor:${shape}` };
  }

  // Foreign, but a shape we have never measured. NOT silently exempted: a new
  // ingest's key shape is something to be told about. Flagged so it surfaces,
  // and reported under its own class so it is never confused with real damage.
  return { ...base, klass: UNKNOWN_VENDOR, split: true, reason: "cardId is neither an hiq: slug nor a known vendor shape" };
}

/** A one-line rendering of a row's split, for a banner sample or a violation. */
function renderSplit(c) {
  const seg = c?.segments?.length ? `  [${c.segments.join(",")}]` : "";
  return `${c?.cardId || "(empty)"}  ||  ${c?.hobbyiqCardId || "(empty)"}${seg}`;
}

module.exports = {
  COHERENT, VENDOR_DESIGN, UNKNOWN_VENDOR, HIQ_SPLIT, MALFORMED,
  VENDOR_SHAPES, SEGMENTS,
  vendorShapeOf, differingSegments, classifyIdentity, renderSplit, isHiq,
};
