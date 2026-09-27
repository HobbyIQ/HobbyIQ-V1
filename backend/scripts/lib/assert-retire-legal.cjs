/**
 * assert-retire-legal.cjs -- the ONE gate every catalog RETIRE (hard delete)
 * path must clear before it calls retireCatalogRow / container.item().delete().
 *
 * LANE-SAFETY (2026-09-27), matching #2436's gate on relocate-catalog-rows-
 * by-list.cjs's `retire` action. Doctrine, stated plainly:
 *
 *   A retire is legal only when
 *     (a) a checklist-grade twin exists at the CANONICAL id (a row whose
 *         catalogAuthorityOf(source) === "checklist" -- never a derived row,
 *         which is the ONE-CARD-ONE-ROW doctrine's own boundary: a derived
 *         row is not a twin, it is a stand-in that will itself need folding),
 *         AND
 *     (b) ZERO sales point at the id being retired, by BOTH read forms --
 *         a cross-partition `hobbyiqCardId = @id OR cardId = @id` query, and
 *         the same predicate scoped with `partitionKey: id` (lib/sales-at-id
 *         .cjs's salesAtId; see its own header for the reproduced 0.6%
 *         cross-partition-miss anomaly this closes).
 *
 * A lane that has no canonical destination at all (a junk-row purge, where
 * the row being deleted never had a twin because it was never a real card)
 * passes `requireTwin: false` and gets the sales check alone -- the twin
 * check answers "does the CARD still have a home", which is meaningless for
 * a row minted from page furniture.
 *
 * NEVER SWALLOWS. A query throw from salesAtId propagates out of this
 * function; callers get `{ ok: false, reason: "sales-check-threw", error }`
 * rather than a bare throw, so a REPORT-mode loop can log and continue
 * without every caller re-implementing the same try/catch.
 *
 * @param {{cat: {item:Function}, pool: {items:{query:Function}}}} containers
 *   `cat` is the card_catalog container (for the twin read); `pool` is
 *   sold_comps (for the dual sales check).
 * @param {{id: string, pk?: string, canonicalId?: string, requireTwin?: boolean, retry?: Function}} opts
 *   `id` is the identity being retired. `pk` is its partition key (defaults
 *   to `id` -- most catalog rows are keyed (id, id) or (id, cardId ?? id),
 *   so callers that key differently pass `pk` explicitly). `canonicalId`
 *   is the id the twin check reads (defaults to `id` -- most retires check
 *   their OWN address; a caller retiring a SOURCE row after a move to a
 *   different address passes the destination id). `requireTwin` defaults
 *   true.
 * @returns {Promise<{ok: boolean, reason: string, salesCount: number, xp?: number, pk?: number, twinAuthority?: string}>}
 */
"use strict";

const { salesAtId } = require("./sales-at-id.cjs");

async function assertRetireLegal(containers, opts) {
  const { cat, pool } = containers;
  const { id, canonicalId = id, requireTwin = true } = opts;
  const retry = opts.retry ?? ((fn) => fn());

  // (a) THE TWIN CHECK. A retire that has nowhere for the card to live is not
  // licensed: the row would vanish and the card would have no address at all.
  // A DERIVED row at the canonical id is not a twin -- doctrine: never retire
  // a checklist row in favour of a derived one. read() 404s are "no twin",
  // not an error -- that is the whole answer a missing row gives this check.
  let twinAuthority;
  if (requireTwin) {
    let twinRow = null;
    try {
      const twinPk = opts.canonicalPk ?? canonicalId;
      twinRow = (await retry(() => cat.item(canonicalId, twinPk).read())).resource ?? null;
    } catch (err) {
      if (err?.code !== 404 && err?.statusCode !== 404) {
        return { ok: false, reason: "twin-check-threw", error: err, salesCount: null };
      }
      twinRow = null;
    }
    if (!twinRow) {
      return { ok: false, reason: "no-twin-at-canonical-id", salesCount: null };
    }
    const { catalogAuthorityOf } = opts.catalogAuthorityOf
      ? { catalogAuthorityOf: opts.catalogAuthorityOf }
      : require("../../dist/services/catalog/catalogAuthority.service.js");
    twinAuthority = catalogAuthorityOf(twinRow.source);
    if (twinAuthority !== "checklist") {
      return { ok: false, reason: "twin-not-checklist-grade", twinAuthority, salesCount: null };
    }
  }

  // (b) THE DUAL SALES CHECK. Never trust one read form alone (lib/sales-at-id
  // .cjs's own header). A throw here propagates as a decided refusal, never
  // as "unknown, proceed".
  let xp, pk, total;
  try {
    const res = await salesAtId(pool, id, { retry });
    xp = res.xp; pk = res.pk; total = res.total;
  } catch (err) {
    return { ok: false, reason: "sales-check-threw", error: err, salesCount: null };
  }

  if (total > 0) {
    return { ok: false, reason: "sales-present", salesCount: total, xp, pk, twinAuthority };
  }

  return { ok: true, reason: "clear", salesCount: 0, xp, pk, twinAuthority };
}

module.exports = { assertRetireLegal };
