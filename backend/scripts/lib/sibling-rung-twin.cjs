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
 * Pure query-shape + pure classification live here, with the Cosmos call
 * itself injected as `queryPage`, so a test can drive this with a fake page
 * source and never touch a network -- the same separation
 * lib/insert-set-key.cjs and lib/subset-identity.cjs use for their own pure
 * halves.
 */

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
  return true;
}

/**
 * Page a Cosmos query to completion. `queryPage(query, continuation)` returns
 * `{ resources, hasMoreResults, continuation }`; this never breaks on an
 * empty page, only on `hasMoreResults === false` -- an empty page mid-result
 * set is a real shape Cosmos returns and is not "done".
 */
async function drainQuery(container, query) {
  const iter = container.items.query(query);
  const out = [];
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
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
async function findSiblingRungTwins(container, staged, { sport, year, setKey, parallelSlugOf, catalogAuthorityOf }) {
  const query = siblingRungTwinQuery({ sport, year, cardNumber: staged.cardNumber });
  const rows = await drainQuery(container, query);
  return rows.filter((row) => isSiblingRungTwin(row, staged, { setKey, parallelSlugOf, catalogAuthorityOf }));
}

module.exports = {
  siblingRungTwinQuery,
  isSiblingRungTwin,
  drainQuery,
  findSiblingRungTwins,
};
