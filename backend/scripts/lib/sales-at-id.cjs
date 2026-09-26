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

module.exports = { salesAtId, CROSS_PARTITION_QUERY, PARTITION_SCOPED_QUERY };
