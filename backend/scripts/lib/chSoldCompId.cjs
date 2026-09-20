/**
 * CF-CH-DAILY-DOUBLE-WRITE (2026-09-20). ONE definition of the id a
 * CardHedge daily-sales row becomes in sold_comps, shared by every .cjs
 * writer that upserts CH rows directly (i.e. bypasses recordSoldComp's
 * own makeId()).
 *
 * The canonical shape, held by chRowToSoldComp.ts (TS, used via
 * recordSoldComp -> makeId) and bulk-import-ch-daily-to-sold-comps.cjs
 * (also via recordSoldComp):
 *
 *   sourceExternalId = `ch-daily::${price_history_id}`
 *   id               = `cardhedge::${sourceExternalId}`
 *                     = `cardhedge::ch-daily::${price_history_id}`
 *
 * backfill-sold-comps-from-ch.cjs upserts straight to the container
 * (see its own header comment for why) and had drifted onto a SYNTHETIC
 * shape keyed on (card_id, sale_date, price-in-cents) instead of CH's
 * true vendor sale id. Same sale, two ids, one partition -- a twin.
 * 35% of sampled September rows had one.
 *
 * This module holds ONLY the id-shape functions, not the whole row
 * mapping (chRowToSoldComp.ts's mapping is not duplicated here, and
 * this file must never diverge from what it produces for the same
 * price_history_id).
 */

/** Canonical sourceExternalId for a CH daily-sales row, when the row
 *  carries CH's true vendor sale id (ch_daily_sales doc id / price_history_id). */
function canonicalSourceExternalId(priceHistoryId) {
  const id = String(priceHistoryId ?? "").trim();
  if (!id) return null;
  return `ch-daily::${id}`;
}

/** Canonical sold_comps doc id built from a canonical sourceExternalId. */
function canonicalDocId(sourceExternalId) {
  return `cardhedge::${sourceExternalId}`;
}

/** LEGACY synthetic id shape -- kept ONLY for rows lacking price_history_id,
 *  and only after the twin-resident check in backfill-sold-comps-from-ch.cjs
 *  finds no resident row for the same sale. Never used when a vendor id is
 *  available. */
function syntheticSourceExternalId(cardId, saleDate, price) {
  const cents = Math.round(Number(price) * 100);
  return `ch-daily::${cardId}::${saleDate}::${cents}`;
}

/** True when a sold_comps doc id is the LEGACY SYNTHETIC shape this
 *  script used to write: `cardhedge::ch-daily::<cardId>::<soldAt>::<cents>`
 *  -- i.e. it embeds soldAt as its own "::"-delimited segment. A true
 *  `price_history_id` is a CardHedge-issued opaque token and does not
 *  contain the sale date as a delimited segment, so this distinguishes
 *  "long/synthetic, has a twin risk" ids from genuine vendor-id ids
 *  without needing to know which shape wrote any given resident row. */
function isLongSyntheticShape(id, soldAt) {
  const s = String(id ?? "");
  if (!s.startsWith("cardhedge::ch-daily::")) return false;
  if (!soldAt) return false;
  return s.includes(`::${soldAt}::`);
}

module.exports = {
  canonicalSourceExternalId,
  canonicalDocId,
  syntheticSourceExternalId,
  isLongSyntheticShape,
};
