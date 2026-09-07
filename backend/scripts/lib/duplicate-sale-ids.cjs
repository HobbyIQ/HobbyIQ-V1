/**
 * duplicate-sale-ids.cjs -- the rule for "one sale, one document".
 *
 * CF-ONE-CARD-ONE-ROW-ONE-POOL, read at the DOCUMENT level.
 *
 * #1924/#1936 measured split-identity ROWS: one document whose `cardId` and
 * `hobbyiqCardId` name different cards. This library is about the other shape,
 * and it is strictly worse. The same sale `id` exists as TWO DOCUMENTS under
 * two different `cardId` partition keys.
 *
 * WHY THE TWO SHAPES NEED DIFFERENT MACHINERY
 *
 * `exactPoolReader` builds `WHERE ... AND (c.cardId = @cid OR c.hobbyiqCardId
 * = @hiq)`. That OR is a predicate over DOCUMENTS, so a split ROW satisfying
 * both disjuncts is still returned once -- #1924 §4 measured exactly this, and
 * `exactPoolNeverCountsARowTwice.test.ts` pins it. Two DOCUMENTS are two rows.
 * Each pool read finds exactly ONE of them, so:
 *
 *   - every per-pool audit reconciles (one row, counted once);
 *   - the reader's identity-union guard never has both halves in front of it;
 *   - `dedupeSoldComps` cannot collapse them -- it clusters within ONE array,
 *     and the two copies are never in the same array;
 *
 * and the sale is nevertheless priced into two pools. No reader-side guard can
 * see this. The defect is in the container, and so is the repair.
 *
 * CF-COLLISION-IS-NOT-A-DUPLICATE (D31). Two documents sharing an `id` under
 * two partition keys are not "a collision" to be resolved by picking a winner
 * on price similarity -- they are, by construction, THE SAME SALE: Cosmos
 * guarantees `id` uniqueness WITHIN a partition, so a repeated `id` across
 * partitions is one ingest identity written twice. That is why the canonical
 * rule below is about ADDRESS COHERENCE and never about ratio similarity.
 *
 * CF-A-RETIRE-IS-A-MARKER-NEVER-A-DELETE. The extra copy is PARKED or
 * FLAGGED, never deleted: a sale is never lost, and a marker is reversible.
 */
"use strict";
const crypto = require("crypto");

/**
 * The shard axis, and it is the ONE part of the split-identity walk that does
 * NOT transfer.
 *
 * CF-A-SHARD-AXIS-MUST-BE-GUARANTEED-AND-MEASURED. A duplicate's two documents
 * were written at DIFFERENT times -- that is the whole defect -- so they sit in
 * different `_ts` windows. Sharding the WALK by `_ts` (as the split-identity
 * census correctly does, because its unit is one row) would give a slot one
 * copy of an id and not the other: the slot would see a single document, call
 * the id unique, and report zero. The population would vanish into the shard
 * boundaries and every slot would reconcile honestly.
 *
 * So each slot walks the WHOLE `_ts` space and keeps only the ids whose hash
 * falls in its slice. Hashing is on the id alone, so every copy of an id --
 * whenever it was written and whatever partition it sits in -- is guaranteed
 * to land in the same slot.
 */
function shardOfId(id, slots) {
  if (!slots || slots <= 1) return 0;
  const h = crypto.createHash("md5").update(String(id)).digest();
  return h.readUInt32BE(0) % slots;
}

/** The sport segment of a `hiq:` slug, or a vendor tag for anything else. */
function sportOf(slug) {
  const s = String(slug ?? "");
  if (!s) return "(none)";
  if (!s.startsWith("hiq:")) return "(vendor)";
  const seg = s.split(":")[1];
  return seg || "(malformed)";
}

/**
 * Fold one scanned row into the accumulator.
 *
 * The common case -- an id seen once -- costs one small object. Only when a
 * SECOND partition appears is the full per-copy detail materialised, because
 * holding every copy of 16.9M ids is not affordable and is not needed.
 *
 * A repeat of the SAME (id, cardId) cannot happen -- Cosmos enforces id
 * uniqueness within a partition -- but the walk is paged and a page can be
 * re-fetched on a retry, so an identical (id, cardId) is folded rather than
 * counted twice. Counting a retry as a duplicate is how a census invents a
 * population.
 */
function observe(seen, id, row) {
  const pk = String(row.cardId ?? "");
  const copy = {
    cardId: pk,
    hobbyiqCardId: String(row.hobbyiqCardId ?? ""),
    source: String(row.source ?? "(none)"),
    ts: Number(row._ts) || 0,
  };
  const prev = seen.get(id);
  if (!prev) { seen.set(id, copy); return; }
  if (prev.copies) {
    if (!prev.copies.some((c) => c.cardId === pk)) prev.copies.push(copy);
    return;
  }
  if (prev.cardId === pk) return;            // same address: a re-fetched page
  seen.set(id, { copies: [prev, copy] });
}

/** Newest-first, so `copies[0]` is the newer copy everywhere below. */
function byTsDesc(copies) {
  return [...copies].sort((a, b) => b.ts - a.ts);
}

/**
 * Is this copy's own address coherent -- does the partition it sits in match
 * the slug it names?
 *
 * A vendor-partitioned row (`cardId` = a CardHedge bubble id) is coherent BY
 * DESIGN and must never be judged incoherent: #1650 established the vendor
 * partition is load-bearing, and #1924 measured it at 12.96M rows. So a
 * non-`hiq:` cardId is not evidence either way and returns null.
 */
function addressCoherent(copy) {
  const pk = String(copy.cardId ?? "");
  const hiq = String(copy.hobbyiqCardId ?? "");
  if (!pk.startsWith("hiq:")) return null;    // designed vendor partition
  if (!hiq) return null;                       // nothing to compare against
  return pk === hiq;
}

const DAY = 86400;

function summarize(dups, nowSec = Math.floor(Date.now() / 1000)) {
  const bySource = {}, bySportPair = {}, byNewerDay = {};
  let dupIds = 0, dupIds3plus = 0, dupDocs = 0, excessDocs = 0;
  let newerHiqDiffers = 0, newerHiqSame = 0, newerCoherent = 0, olderCoherent = 0;
  let writtenLast7d = 0, newestTs = 0;

  const bump = (m, k) => { m[k] = (m[k] ?? 0) + 1; };

  for (const d of dups) {
    const copies = byTsDesc(d.copies);
    dupIds++;
    if (copies.length > 2) dupIds3plus++;
    dupDocs += copies.length;
    excessDocs += copies.length - 1;

    for (const s of new Set(copies.map((c) => c.source))) bump(bySource, s);

    const [newer, older] = copies;
    const pair = [sportOf(older.cardId), sportOf(newer.cardId)].join(" -> ");
    bump(bySportPair, pair);

    if (newer.ts > newestTs) newestTs = newer.ts;
    if (nowSec - newer.ts <= 7 * DAY) writtenLast7d++;
    bump(byNewerDay, new Date(newer.ts * 1000).toISOString().slice(0, 10));

    if (newer.hobbyiqCardId !== older.hobbyiqCardId) newerHiqDiffers++; else newerHiqSame++;
    if (addressCoherent(newer) === true) newerCoherent++;
    if (addressCoherent(older) === true) olderCoherent++;
  }

  return {
    dupIds, dupIds3plus, dupDocs, excessDocs,
    bySource, bySportPair, byNewerDay,
    newerHiqDiffers, newerHiqSame, newerCoherent, olderCoherent,
    writtenLast7d, newestTs,
    newestIso: newestTs ? new Date(newestTs * 1000).toISOString() : null,
  };
}

/**
 * WHICH COPY IS CANONICAL.
 *
 * Drew's rule, and it is deliberately NOT "the newer one wins" and NOT
 * "hobbyiqCardId is canonical". #1924 §6 measured the second of those and found
 * it false as a fact about these rows -- `hobbyiqCardId` was correct 2,330
 * times, `cardId` was correct 1,203 times, and neither 395 times. A convention
 * is not evidence.
 *
 * The test is ADDRESS COHERENCE plus a CATALOG-BACKED destination:
 *
 *   canonical  the copy whose partition matches its OWN hobbyiqCardId AND
 *              whose slug resolves to a `card_catalog` row.
 *   park       both qualify, or neither does -- the extra copy is PARKED with
 *              reason `duplicate-partition-copy`, which keeps it out of every
 *              pool without asserting which card it belongs to.
 *
 * `catalogHas` is injected (a Set-like `has`) so the decision is testable
 * without Cosmos, and so the census can batch its catalog reads.
 *
 * CF-CATALOG-MATCH-IS-SELF-CONFIRMING: a copy is never promoted to canonical
 * on the strength of the sales themselves. If no checklist names either
 * address, we park -- we do not mint an identity from our own sale.
 *
 * Returns { canonical, extras, verdict, reason }. `extras` is never empty for
 * a real duplicate, and every extra is PARKED or RETIRED -- never deleted.
 */
function decideCanonical(copies, catalogHas = { has: () => false }) {
  const ordered = byTsDesc(copies);
  const scored = ordered.map((c) => ({
    copy: c,
    coherent: addressCoherent(c) === true,
    inCatalog: !!catalogHas.has(String(c.cardId ?? "")),
  }));
  const qualified = scored.filter((s) => s.coherent && s.inCatalog);

  if (qualified.length === 1) {
    const winner = qualified[0];
    return {
      canonical: winner.copy,
      extras: ordered.filter((c) => c !== winner.copy),
      verdict: "CANONICAL",
      reason: "partition matches its own hobbyiqCardId and resolves to a catalog row",
    };
  }
  return {
    canonical: null,
    extras: ordered.slice(1),         // the newest copy is left in place, unparked
    verdict: qualified.length > 1 ? "PARK-BOTH-QUALIFY" : "PARK-NEITHER-QUALIFIES",
    reason: qualified.length > 1
      ? "both copies are coherent and catalog-backed — no tell picks between them"
      : "neither copy is both coherent and catalog-backed — no evidence to promote one",
  };
}

/**
 * The list entry the relocate lane consumes.
 *
 * PARK, not RELOCATE and not delete. `relocate-pool-rows-by-list.cjs` reads
 * `parkIdentityUnverified: true` and patches `identityUnverified` in place --
 * no partition moves, no document is removed, and the row leaves every pool.
 * The `id`+`fromCardId` pair addresses ONE of the two documents, which is
 * exactly the granularity this defect needs: each copy is repaired at its own
 * address, as #1936's tranche 2 keyed uniqueness on (id, fromCardId).
 */
function parkEntry(id, copy, evidence) {
  return {
    id,
    fromCardId: copy.cardId,
    parkIdentityUnverified: true,
    evidence: `duplicate-partition-copy: ${evidence}`,
  };
}

function sampleLines(dups, cap) {
  const out = [];
  for (const d of dups.slice(0, cap)) {
    const copies = byTsDesc(d.copies);
    out.push(`${d.id}  x${copies.length}`);
    for (const c of copies) {
      out.push(`      ${new Date(c.ts * 1000).toISOString().slice(0, 10)}  ${String(c.source).padEnd(14)} ${String(c.cardId).slice(0, 56)}`);
      if (c.hobbyiqCardId && c.hobbyiqCardId !== c.cardId) out.push(`                    hiq= ${String(c.hobbyiqCardId).slice(0, 56)}`);
    }
  }
  return out;
}

module.exports = {
  shardOfId, sportOf, observe, byTsDesc, addressCoherent,
  summarize, decideCanonical, parkEntry, sampleLines,
};
