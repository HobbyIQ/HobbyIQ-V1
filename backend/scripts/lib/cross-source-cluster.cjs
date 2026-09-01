/**
 * cross-source-cluster.cjs -- THE DISCRIMINATOR, IN ONE PLACE.
 *
 * -- WHY THIS FILE EXISTS ---------------------------------------------------
 *
 * Two dedup scripts bucket sold_comps rows by a real-world key and then decide
 * which rows in a bucket are one sale:
 *
 *   crossSourceDedupSoldComps.cjs      buckets on (player, year, number,
 *                                      parallel, auto, grade, price, minute)
 *   sold-comps-cross-source-dedup.cjs  buckets on (title-hash, price, minute)
 *
 * The BUCKET is not the ruling. It only assembles candidates; two rows in one
 * bucket are two real sales until something PROVES otherwise, and the only
 * thing that proves it is a shared `sourceExternalId` -- the eBay item id, half
 * of the doc id `{source}::{sourceExternalId}`. rev-2 of the first script
 * ignored the field entirely and collapsed two $9.99 sales in the same minute
 * with different item ids into one.
 *
 * That discriminator was then written out TWICE, once per script, along with a
 * copy of `externalIdOf` in each. Copies drift, and worse, the tests that were
 * supposed to protect it asserted over the SOURCE TEXT with regexes -- so a
 * mutant that reverted either script's whole-bucket collapse passed all 81 of
 * them. A rule tested by grep is a rule nobody has tested.
 *
 * So the rule lives here, both scripts import it, and the tests EXECUTE it.
 * `externalIdOf` is imported from collision-triage.cjs rather than re-declared:
 * the triage and the dedups must agree on what an item id is, and two
 * definitions of that cannot be kept in agreement by intention alone.
 *
 * -- WHAT IT DECIDES --------------------------------------------------------
 *
 * Given the rows of ONE bucket, `provenClustersOf` returns only the sub-groups
 * that share an item id, plus the counts of everything it REFUSED to touch --
 * because "left alone" is the answer in the overwhelming majority of buckets
 * and a script that does not print it cannot be checked.
 *
 * Nothing here writes, deletes, or picks a survivor. The survivor rule is
 * `pickSurvivor` in collision-triage.cjs, and the exclusion is always a
 * reversible `flaggedWrong` flag -- never a delete. The pool is the moat.
 */
"use strict";

const path = require("path");
const { externalIdOf, pickSurvivor } = require(path.join(__dirname, "collision-triage.cjs"));

/**
 * Bucket one candidate group by item id and keep only the PROVEN duplicates.
 *
 * @param {object[]} rows  the rows of a single bucket (any length)
 * @returns {{
 *   proven: object[][],        sub-groups of >= 2 rows sharing one item id
 *   sharedIds: string[],       the item id of each proven sub-group, in order
 *   refusedNoId: number,       rows carrying no item id at all
 *   refusedDifferentIds: number,  rows in a bucket where NOTHING was proven
 * }}
 *
 * THE REFUSAL IS THE COMMON CASE, and it is counted two different ways on
 * purpose. `refusedNoId` is per ROW and accrues even in a bucket that also
 * yields a proven cluster -- a row with no id is unprovable regardless of what
 * its neighbours turn out to be. `refusedDifferentIds` accrues only when the
 * bucket proves NOTHING, and then counts the whole bucket: identical title,
 * price and minute, every item id distinct, so every row is a separate real
 * sale. Both scripts print both, and this keeps the two arithmetics identical.
 */
function provenClustersOf(rows) {
  const list = (rows ?? []).filter(Boolean);
  const out = { proven: [], sharedIds: [], refusedNoId: 0, refusedDifferentIds: 0 };
  if (list.length < 2) return out;

  const byExternal = new Map();
  for (const r of list) {
    const ext = externalIdOf(r);
    // A row with no item id can never PROVE sameness with another. Absence of
    // evidence is not evidence of duplication, and -- critically -- two rows
    // that are BOTH missing an id must not cluster with each other on that
    // shared absence.
    if (ext === null) { out.refusedNoId++; continue; }
    const arr = byExternal.get(ext) ?? [];
    arr.push(r);
    byExternal.set(ext, arr);
  }

  for (const [ext, arr] of byExternal) {
    if (arr.length > 1) { out.proven.push(arr); out.sharedIds.push(ext); }
  }

  if (out.proven.length === 0) out.refusedDifferentIds += list.length;
  return out;
}

/**
 * One proven cluster resolved into the row that survives and the rows to flag,
 * with the already-flagged ones separated out.
 *
 * ONLY-IMPROVE. A row already carrying `flaggedWrong === true` is reported in
 * `alreadyFlagged` and never re-stamped, so a re-run cannot overwrite an
 * earlier -- possibly human -- ruling. It is also never UNflagged.
 */
function resolveCluster(rows) {
  const list = (rows ?? []).filter(Boolean);
  const survivor = pickSurvivor(list);
  const losers = list.filter((r) => r !== survivor);
  return {
    survivor,
    toFlag: losers.filter((r) => r.flaggedWrong !== true),
    alreadyFlagged: losers.filter((r) => r.flaggedWrong === true),
  };
}

module.exports = { provenClustersOf, resolveCluster, externalIdOf };
