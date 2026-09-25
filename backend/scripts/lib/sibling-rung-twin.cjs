/**
 * CF-A-SIBLING-KEY-IS-STILL-THE-SAME-RUNG (Drew, 2026-09-25).
 *
 * ingest-checklist-csv-to-catalog.cjs and its planner (planStagedDirectory)
 * dedupe on EXACT id only. The planner has no Cosmos access, so it cannot see
 * that a staged row's (year, cardNumber, parallel slug, isAuto, printRun)
 * already exists under a SIBLING setKey of the SAME product family --
 * `bowman` vs `bowman-chrome`, `topps` vs `topps-series-1` -- because that key
 * comes from a checklist that already ran, filed at its own registered
 * address. The exact-id check at the intended slug reports "0 collisions" and
 * the row lands, and the pool the card already has splits into two: 150 lava
 * rows (09-21), 1,410 draft-sapphire rows (09-21), 658 RA- rows caught only in
 * manual review (09-22).
 *
 * THE CHECK. Same sport+year+cardNumber (a filtered query, never COUNT/
 * GROUP BY, so the caller can page every match and print real examples), same
 * parallel slug + isAuto + printRun, a DIFFERENT setKey, and the existing row
 * is checklist authority. That last condition is deliberate: a derived twin
 * under a sibling key is not evidence of anything -- it is the same class of
 * self-confirming row catalogAuthority already refuses to let outrank a
 * checklist -- so only a checklist-grade sibling counts as a real twin.
 *
 * `c.parallel` is human-form, mixed case ("Silver Prizm", not "silver-
 * prizm"), so the comparison folds BOTH sides through the same slug function
 * the write path already uses (`slugify`) rather than comparing raw strings.
 *
 * CF-A-SHARED-NUMBER-IS-NOT-A-SHARED-CARD (review finding, 2026-09-25 PR
 * #2422). The predicate above matched on cardNumber + parallel slug + isAuto
 * + printRun alone and never looked at WHO the card is. Two different
 * products routinely share a numbering scheme with different rosters -- 2020
 * Topps Series 1 #1 and 2020 Topps Chrome #1 are different players -- and
 * that pair would have read as a "twin" and skipped a genuinely distinct
 * card. `namesAgree` (lib/name-agreement.cjs) is now REQUIRED: a sibling-key
 * match is only a twin when the two rows' playerName also agree by that same
 * pair-level check (first-listed name on a multi-name card, subset-tag strip,
 * Jr./Sr. presence-vs-presence). A real disagreement -- including a genuine
 * Jr./Sr. split -- keeps the rows apart exactly as it does everywhere else
 * `namesAgree` is wired in.
 *
 * Pure query-shape + pure classification live here, with the Cosmos call
 * itself injected as `queryPage`, so a test can drive this with a fake page
 * source and never touch a network -- the same separation
 * lib/insert-set-key.cjs and lib/subset-identity.cjs use for their own pure
 * halves.
 */
const { namesAgree } = require("./name-agreement.cjs");

/** The SQL this check runs. Exposed so a test can assert the shape without
 *  a live container, and so every caller runs the identical predicate. */
function siblingRungTwinQuery({ sport, year, cardNumber }) {
  return {
    query: `SELECT c.id, c.setKey, c.parallel, c.isAuto, c.printRun, c.source, c.playerName
            FROM c
            WHERE c.sport = @sport AND (c.year = @year OR c.cardYear = @year)
              AND c.cardNumber = @cardNumber`,
    parameters: [
      { name: "@sport", value: sport },
      { name: "@cardNumber", value: String(cardNumber).toUpperCase() },
      { name: "@year", value: Number(year) },
    ],
  };
}

/**
 * Does `row` (an existing catalog document from the query above) name the
 * same rung as the staged row, under a DIFFERENT setKey, at checklist
 * authority? Pure: no I/O, so the branch is unit-testable with plain objects.
 */
function isSiblingRungTwin(row, staged, { setKey, parallelSlugOf, catalogAuthorityOf }) {
  if (!row || row.setKey === setKey) return false;
  if (catalogAuthorityOf(row.source) !== "checklist") return false;
  const rowParallelSlug = parallelSlugOf(row.parallel || "Base");
  const stagedParallelSlug = parallelSlugOf(staged.parallel || "Base");
  if (rowParallelSlug !== stagedParallelSlug) return false;
  if (Boolean(row.isAuto) !== Boolean(staged.isAuto === "true" || staged.isAuto === true)) return false;
  const rowPrintRun = typeof row.printRun === "number" ? row.printRun : null;
  const stagedPrintRun = staged.printRun ? Number(staged.printRun) : null;
  if (rowPrintRun !== stagedPrintRun) return false;
  // CF-A-SHARED-NUMBER-IS-NOT-A-SHARED-CARD. Same number, same rung, same
  // product family shape -- but a different player is a different card, not
  // a twin of this one. `namesAgree` is the pair-level check every other
  // different-player decision in this codebase already uses; a real
  // disagreement (including a genuine Jr./Sr. split) is never overridden.
  if (!namesAgree(row.playerName, staged.player)) return false;
  return true;
}

/**
 * Page a Cosmos query to completion. `queryPage(query, continuation)` returns
 * `{ resources, hasMoreResults, continuation }`; this never breaks on an
 * empty page, only on `hasMoreResults === false` -- an empty page mid-result
 * set is a real shape Cosmos returns and is not "done".
 *
 * `retry` wraps each `fetchNext()` call (429/throttling backoff), mirroring
 * the injected-retry convention `lib/relocate-sold-comp.cjs` and
 * `lib/catalog-none-pk.cjs` already use: it defaults to a passthrough, the
 * caller supplies its own wrapper (the ingest script's Cosmos client is
 * already configured with `retryOptions.maxRetryAttemptsOnThrottledRequests`,
 * so the SDK itself absorbs ordinary throttling; `retry` is for a caller that
 * wants to layer its own policy on top, and tests can omit it). A 429 that
 * survives every retry still throws, and the ROW-LEVEL try/catch in the
 * ingest's write loop is what turns that into `failed` -- this function never
 * swallows an error itself.
 */
async function drainQuery(container, query, retry = (fn) => fn()) {
  const iter = container.items.query(query);
  const out = [];
  while (iter.hasMoreResults()) {
    const { resources } = await retry(() => iter.fetchNext());
    if (resources && resources.length) out.push(...resources);
  }
  return out;
}

/**
 * Find every sibling-key rung twin for one staged row. Returns the first
 * matching row (for the SKIP decision) plus the full list (for the banner's
 * examples), so a caller wanting only "is there one" is not forced to
 * materialise every match, while the banner can still show up to 20.
 */
async function findSiblingRungTwins(container, staged, { sport, year, setKey, parallelSlugOf, catalogAuthorityOf, retry }) {
  const query = siblingRungTwinQuery({ sport, year, cardNumber: staged.cardNumber });
  const rows = await drainQuery(container, query, retry);
  return rows.filter((row) => isSiblingRungTwin(row, staged, { setKey, parallelSlugOf, catalogAuthorityOf }));
}

/**
 * CF-A-BURST-IS-NOT-A-BATCH (review finding, 2026-09-25 PR #2422). The
 * per-row write loop already fans out CONCURRENCY (default 48) rows at once;
 * without its own cap, the sibling-twin query rides along on all 48 as a
 * SEPARATE cross-partition query each, a burst the exact-id point read (5 RU,
 * single-partition) never created. `createSemaphore(limit)` returns
 * `run(fn)`, which queues `fn` behind at most `limit` concurrent callers --
 * a small, dependency-free counting semaphore, scoped to wrap ONLY the twin
 * query call site, never the row's other Cosmos calls.
 */
function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(
      (v) => { active--; resolve(v); next(); },
      (e) => { active--; reject(e); next(); },
    );
  };
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
    },
    get active() { return active; },
    get queued() { return queue.length; },
  };
}

module.exports = {
  siblingRungTwinQuery,
  isSiblingRungTwin,
  drainQuery,
  findSiblingRungTwins,
  createSemaphore,
};
