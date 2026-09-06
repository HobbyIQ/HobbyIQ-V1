/**
 * card-shard-axis.cjs -- the shard unit of a MOVE lane is the CARD, never the row.
 *
 * CF-A-MOVE-LANE-SHARDS-BY-CARD-NOT-BY-ROW (2026-09-05).
 *
 * THE DEFECT. repair-bowman-product-refile shards its catalog scan with
 *
 *     shardIndex(row.id) !== SLOT -> skip
 *
 * and its scan is `STARTSWITH(c.id, 'hiq:<sport>:<year>:<setKey>:')`. A card's
 * GRADED CHILDREN live at `${parentSlug}:${tier}`, so they start with that same
 * stem and are IN the scanned population -- hashed independently of their
 * parent. Measured, 16 slots, one real card:
 *
 *     hiq:baseball:2026:bowman-chrome:cpa-jd:base:auto            -> slot 9
 *     hiq:...:cpa-jd:base:auto:psa-10                             -> slot 15
 *     hiq:...:cpa-jd:base:auto:psa-9                              -> slot 11
 *     hiq:...:cpa-jd:base:auto:bgs-9-5                            -> slot 15
 *     hiq:baseball:2026:bowman:cpa-jd:base:auto      (destination) -> slot 11
 *
 * Five slots for ONE card. That is not a partition of the work, it is four
 * concurrent writers on one identity, because `moveCatalogRow` does not touch
 * the parent alone: it copies the survivor to the destination, RE-POINTS THAT
 * ROW'S SALES, RETIRES THE GRADED CHILDREN OF THE OLD SLUG, and deletes the old
 * row -- in that order. So while slot 9 is retiring cpa-jd's children, slot 15
 * is independently reading one of those same children as a scan row of its own
 * and planning a move for it, and slot 11 is writing the very destination slug
 * that slot 9's copy step is creating. Interleavings available:
 *
 *   - slot 15 reads a child, slot 9 deletes it, slot 15's move writes it BACK
 *     at a destination -- a resurrected orphan whose parent is gone.
 *   - slot 9 and slot 11 both upsert the destination; `chooseSurvivor` runs
 *     twice against two different incumbents and the loser's fields are lost.
 *   - slot 11 deletes the old row under slot 9's feet; slot 9's own delete is
 *     tolerant, but its sales re-point already ran against a row that moved.
 *
 * None of these throws. Every slot exits 0 and reconciles honestly against the
 * rows IT saw -- the same shape as CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD,
 * where every signal a reviewer checks says success.
 *
 * THE RULE. Hash the CARD, not the row. `cardShardKey(id)` strips the grade
 * tier segment so a parent and every one of its graded children yield the SAME
 * key, and therefore the same slot. A card is then owned end-to-end by exactly
 * one slot: its parent, its children, and the sales that hang off them.
 *
 * THE DESTINATION IS NOT COVERED BY THIS, and cannot be. A refile MOVES a card
 * across products, so source and destination stems differ by construction and
 * no hash of an identity can put both in one slot. What makes that safe is that
 * the destination is not in the scanned population: the scan is stemmed to the
 * SOURCE product (`STARTSWITH(c.id, '...:bowman-chrome:')`) and the destination
 * stems elsewhere (`...:bowman:`). No slot ever scans a row another slot is
 * writing as a destination. That is also exactly why re-running is a no-op --
 * see the idempotency pin.
 *
 * WHY NOT SHARD BY (year, setKey) LIKE THE RETIRE LANE. #1799's axis is the
 * right one for a lane whose scope is a whole sport: it has thousands of
 * products to spread. These lanes are dispatched at ONE product
 * (`baseball:2026:bowman-chrome`), so a product-level hash puts 100% of the
 * work in one slot and the other fifteen exit having done nothing. The card is
 * the finest unit that is still safe.
 */

"use strict";

const crypto = require("crypto");

/**
 * A grade tier segment: `psa-10`, `bgs-9-5`, `sgc-10`, `cgc-9`, `raw`. Anchored
 * to a KNOWN grader vocabulary rather than "any trailing segment", because an
 * identity slug's own last segment is `auto` / `no-auto` / `num-50` and must
 * NOT be stripped -- stripping it would collapse a numbered sibling onto its
 * unnumbered twin and hand two DIFFERENT cards to one slot, which is merely a
 * hot slot, but would also make `cardShardKey` lie about what a card is.
 */
const GRADE_TIER_SEGMENT = /^(?:psa|bgs|sgc|cgc|hga|csg|gma|ace|tag|isa)-[0-9]+(?:-[0-9]+)?$/i;

/**
 * The shard key of a catalog row id: the CARD it belongs to.
 *
 * A graded child `${parent}:${tier}` folds onto its parent. Everything else --
 * an identity slug, a pool row id, a vendor-shaped id -- is its own key.
 *
 * @param {string} id a catalog row id (or any string)
 * @returns {string} the key to hash
 */
function cardShardKey(id) {
  const s = String(id ?? "");
  const cut = s.lastIndexOf(":");
  if (cut <= 0) return s;
  const last = s.slice(cut + 1);
  return GRADE_TIER_SEGMENT.test(last) ? s.slice(0, cut) : s;
}

/**
 * The slot that owns a card, given a row id belonging to it.
 *
 * @param {string} id    a catalog row id
 * @param {number} slots the fan-out width (>= 1)
 * @returns {number} slot index in [0, slots)
 */
function cardShardIndex(id, slots) {
  const n = Math.max(1, Number(slots) || 1);
  return parseInt(
    crypto.createHash("sha1").update(cardShardKey(id)).digest("hex").slice(0, 8),
    16,
  ) % n;
}

module.exports = { cardShardKey, cardShardIndex, GRADE_TIER_SEGMENT };
