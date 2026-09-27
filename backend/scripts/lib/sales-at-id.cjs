/**
 * sales-at-id.cjs -- the ONE way a retire lane asks "are there sold_comps
 * rows at this identity?"
 *
 * CF-A-CROSS-PARTITION-QUERY-IS-NOT-THE-WHOLE-POOL (2026-09-26). A real
 * sold_comps document was found, reproducibly, by a point read and by a
 * partition-scoped query (FeedOptions.partitionKey = the identity) while a
 * bare cross-partition `WHERE c.hobbyiqCardId = @id` returned ZERO rows for
 * the same id -- indexingMode consistent, /* included. A 320-doc sample
 * measured the miss rate at 0.6%, every miss carrying a null
 * `hobbyiqCardId`: rare, but real, and a retire gate that trusts the
 * cross-partition form alone can license a delete out from under a live
 * sale.
 *
 * The document that exposed it:
 *   id       ebay-user-purchase::147344007201-10082410797719
 *   cardId  === hobbyiqCardId === hiq:baseball:2026:bowman:cpa-vf:black-white-red-ink:auto
 *
 * sold_comps is partitioned on /cardId, so a sale whose cardId equals the
 * identity being retired lives in exactly the partition named by that
 * identity -- `partitionKey: id` reaches it even when the cross-partition
 * predicate misses it. Neither form is redundant: the cross-partition query
 * catches a sale that was RE-POINTED (hobbyiqCardId rewritten, cardId still
 * the sale's original address) but never re-partitioned; the partition-
 * scoped query catches a sale living in the right partition that the
 * cross-partition index missed. A retire is licensed only when BOTH read
 * zero.
 *
 * Never COUNT/GROUP BY, never maxItemCount: -1 -- doctrine on every lane
 * that touches sold_comps (see relocate-catalog-rows-by-list.cjs,
 * rewrite-parallel-names.cjs). This pages ids client-side with
 * maxItemCount: 500 and maxDegreeOfParallelism: -1, draining every page
 * `hasMoreResults()` reports, including an empty page in the middle of a
 * result set -- fetchNext() can return zero resources with more pages still
 * to come, and stopping on an empty page rather than on `hasMoreResults()`
 * going false is exactly how a drain loop under-counts.
 */
"use strict";

const CROSS_PARTITION_QUERY = "SELECT c.id FROM c WHERE c.hobbyiqCardId = @id OR c.cardId = @id";
const PARTITION_SCOPED_QUERY = "SELECT c.id FROM c WHERE c.hobbyiqCardId = @id OR c.cardId = @id";

/**
 * Pages one query to completion and returns the distinct set of ids it
 * found. Draining is driven by `hasMoreResults()`, not by page emptiness --
 * an empty page does not mean the iterator is done.
 */
async function drainIds(iterator, retry) {
  const ids = new Set();
  while (iterator.hasMoreResults()) {
    const { resources } = await retry(() => iterator.fetchNext());
    for (const r of resources ?? []) {
      if (r && r.id != null) ids.add(String(r.id));
    }
  }
  return ids;
}

/**
 * CF-AN-ID-IS-UNIQUE-ONLY-WITHIN-A-PARTITION (2026-09-27, incident: run
 * 36353646453 / #2454 repoint-sales-by-list). sold_comps ids
 * (`${source}::${externalId}`) are unique only WITHIN a partition -- this
 * file's own header, and repoint-sales-by-list.cjs's, both say so. Two
 * DIFFERENT Cosmos documents (different `cardId`, i.e. different partitions)
 * can legally carry the identical `id` string: a vendor-keyed sale still
 * resident at its raw source cardId (or a malformed legacy slug) whose
 * `hobbyiqCardId` was already rewritten to `fromId`, sitting alongside its
 * own already-moved twin.
 *
 * `drainSalesIdsAtId` used to collapse its result into a `Map` keyed by `id`
 * ALONE (`byId.set(String(r.id), ...)`, and the same shape again in the
 * xp/pk union) -- so when both of those documents matched the dual
 * predicate, the SECOND one written into the Map silently overwrote the
 * first: one whole physical document vanished from the result before any
 * caller ever saw it. repoint-sales-by-list.cjs iterates exactly the rows
 * this function returns and moves nothing it was never handed, so the
 * discarded twin was never read, never deleted, and never counted --
 * `duplicatesLeft` stayed empty and the run's own banner reported clean.
 *
 * The fix: dedupe on the REAL Cosmos identity, `(id, cardId)` together, not
 * `id` alone. Two documents that share an `id` but differ in `cardId` are
 * two rows and both survive into the result; only a genuine repeat of the
 * exact same (id, cardId) pair -- the xp and pk forms both finding the same
 * physical document -- collapses to one entry, which is the union this
 * function has always promised.
 */
const rowKey = (r) => `${r.id}|${r.cardId ?? ""}`;

/**
 * salesAtId(container, id, opts?) -- the dual check.
 *
 * Runs (a) a cross-partition query with no partitionKey, and (b) the same
 * predicate scoped with `partitionKey: id`, both paginated and both drained
 * to their last page. Returns the union of what either form found, plus the
 * two individual counts so a caller can log "sales at id: xp=N pk=M" and so
 * a caller that wants to know WHICH form found a row still can.
 *
 * A retire is licensed only when `total === 0` (equivalently, `xp === 0 &&
 * pk === 0`) -- the caller decides what "licensed" means, this only counts.
 *
 * @param {{items:{query:Function}}} container a Cosmos container (or a test
 *   double with the same `items.query(query, feedOptions)` shape)
 * @param {string} id the hobbyiqCardId / cardId identity being checked
 * @param {{retry?:(fn:()=>unknown)=>unknown}} [opts]
 * @returns {Promise<{xp:number, pk:number, total:number, ids:string[]}>}
 */
async function salesAtId(container, id, opts = {}) {
  const retry = opts.retry ?? ((fn) => fn());

  const xpIter = container.items.query(
    { query: CROSS_PARTITION_QUERY, parameters: [{ name: "@id", value: id }] },
    { maxItemCount: 500, maxDegreeOfParallelism: -1 },
  );
  const pkIter = container.items.query(
    { query: PARTITION_SCOPED_QUERY, parameters: [{ name: "@id", value: id }] },
    { maxItemCount: 500, maxDegreeOfParallelism: -1, partitionKey: id },
  );

  const xpIds = await drainIds(xpIter, retry);
  const pkIds = await drainIds(pkIter, retry);

  const union = new Set([...xpIds, ...pkIds]);
  return { xp: xpIds.size, pk: pkIds.size, total: union.size, ids: [...union] };
}

/**
 * drainSalesIdsAtId(container, id, opts?) -- like salesAtId, but returns the
 * (id, cardId) pair for every sale found rather than just a count, for the
 * rare caller that needs to ADDRESS each sale afterward (patch it, as
 * retire-autoseed-window.cjs does) rather than merely refuse on a nonzero
 * count. Runs the SAME dual cross-partition + partition-scoped union
 * salesAtId does -- see this file's header for why neither form alone is
 * trusted -- just selecting `c.cardId` too so the result is addressable.
 *
 * @returns {Promise<{total:number, rows:{id:string, cardId:string|null}[]}>}
 */
async function drainSalesIdsAtId(container, id, opts = {}) {
  const retry = opts.retry ?? ((fn) => fn());
  const query = "SELECT c.id, c.cardId FROM c WHERE c.hobbyiqCardId = @id OR c.cardId = @id";

  const drainRows = async (iterator) => {
    // Keyed by (id, cardId) -- the REAL Cosmos document identity -- never by
    // `id` alone. See the header note above `rowKey`: an id string is unique
    // only within a partition, so two documents with different `cardId` can
    // share one, and keying on `id` alone silently drops one of them.
    const byKey = new Map();
    while (iterator.hasMoreResults()) {
      const { resources } = await retry(() => iterator.fetchNext());
      for (const r of resources ?? []) {
        if (r && r.id != null) {
          const row = { id: String(r.id), cardId: r.cardId ?? null };
          byKey.set(rowKey(row), row);
        }
      }
    }
    return byKey;
  };

  const xpIter = container.items.query(
    { query, parameters: [{ name: "@id", value: id }] },
    { maxItemCount: 500, maxDegreeOfParallelism: -1 },
  );
  const pkIter = container.items.query(
    { query, parameters: [{ name: "@id", value: id }] },
    { maxItemCount: 500, maxDegreeOfParallelism: -1, partitionKey: id },
  );

  const xpRows = await drainRows(xpIter);
  const pkRows = await drainRows(pkIter);

  const union = new Map([...xpRows, ...pkRows]);
  return { total: union.size, rows: [...union.values()] };
}

module.exports = { salesAtId, drainSalesIdsAtId, CROSS_PARTITION_QUERY, PARTITION_SCOPED_QUERY };
