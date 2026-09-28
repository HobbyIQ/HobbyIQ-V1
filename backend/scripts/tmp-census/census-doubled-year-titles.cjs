#!/usr/bin/env node
/**
 * census-doubled-year-titles.cjs -- READ-ONLY sizing census for the
 * doubled-leading-year title defect ("2025 2025 Topps Chrome Update
 * Baseball #AC-AB Base"), found by the 2026-09-28 dedupe analysis
 * (C:/tmp/twins_dd_1430/content-differs.csv: 154/155 refused "duplicate"
 * pairs differed ONLY in this shape). The producer
 * (backfill-sold-comps-from-ch.cjs) was fixed 2026-08-24 (commit 0000f60);
 * this counts how much of the LEGACY, pre-fix damage is still resident in
 * sold_comps, broken out by sport/year, so a repair pass can be sized and
 * dispatched per cell rather than as one whole-pool sweep.
 *
 * UNCOMMITTED. Not wired into the runner. NOT RUN by the agent that wrote
 * it -- no COSMOS_CONNECTION_STRING was read, no query was issued. This
 * file exists to describe the query precisely enough that Drew (or a
 * dispatched runner script, once this is reviewed and promoted out of
 * tmp-census/) can run it deliberately.
 *
 * THE QUERY, per sport/year cell:
 *
 *   SELECT VALUE COUNT(1) FROM c
 *   WHERE c.sport = @sport
 *     AND c.cardYear = @year
 *     AND STARTSWITH(c.title, CONCAT(ToString(@year), " ", ToString(@year), " "))
 *
 * -- i.e. a title whose first two whitespace-separated tokens are BOTH the
 * card's own year, matching relocate-sold-comp.cjs's own
 * `dedupeYearPrefix` regex `^(\d{4})\s+\1[\s-]+` restricted to the case
 * where that doubled year equals cardYear (the shape the fixed producer
 * actually made -- a title where the FIRST token happens to double some
 * OTHER 4-digit number, e.g. a print run, is a different, unaddressed
 * population and deliberately excluded here).
 *
 * This is a scoped per-(sport,year) COUNT, never a cross-partition
 * aggregate over the whole container in one query -- sold_comps is
 * partitioned on /cardId, so an unscoped COUNT(1) fans out across every
 * physical partition and is the shape the "retire lane wedge" and
 * "fleet scripts measure throughput" incidents both warn against. Driving
 * this per (sport, year) cell (a manageable, enumerable axis -- distinct
 * sport/year pairs number in the low hundreds, not the pool's row count)
 * keeps each individual query's RU cost and latency bounded and lets a
 * partial run report partial, real numbers instead of timing out on one
 * giant scan.
 *
 * source=cardhedge is NOT filtered in the query above on purpose: the
 * defect's PRODUCER only ever wrote source="cardhedge" (per the CSV: all
 * 155 rows), but the census should still show whether ANY non-cardhedge
 * source independently carries the same shape (a second, unrelated
 * producer, or a repointed copy of a cardhedge row that had its `source`
 * field overwritten somewhere upstream) -- so the per-cell result should
 * be read back WITH a `c.source` GROUP BY (client-side tally over the
 * same scoped query's resources, not a second cross-partition query) so
 * a non-cardhedge hit is visible rather than silently folded into the
 * cardhedge count.
 *
 * SPORT x YEAR axis: enumerate from the known sport list (baseball,
 * basketball, football, hockey, soccer, pokemon, ...) crossed with the
 * cardYear range CardHedge actually covers (roughly 1880s-present per
 * ch_daily_sales' own "8yr" description in CLAUDE.md, but cardYear on a
 * SOLD_COMPS row can predate the ingest window for a vintage card) --
 * drive it from an actual DISTINCT (sport, cardYear) enumeration already
 * used elsewhere in this repo (e.g. the pattern audit-set-sport.cjs and
 * census-subset-clash.cjs use: read distinct cells from a maintained
 * catalog/product table, never a live cross-partition GROUP BY against
 * sold_comps itself) rather than a fresh cross-partition DISTINCT here.
 *
 * OUTPUT SHAPE (once actually run): a table of
 *   sport | year | doubledYearTitleCount | ofWhichNonCardhedge
 * plus a grand total, so the repair's dispatch (almost certainly a new
 * repair-*.cjs list lane, or a targeted extension of one of the three
 * existing repair scripts that already carry a local dedupeYear helper --
 * see lib/relocate-sold-comp.cjs's dedupeYearPrefix and its callers) can
 * be scoped exactly the way every other repair lane in this repo requires
 * (SPORTS/YEARS/SETKEYS named, never a whole-pool APPLY with all three
 * empty).
 *
 * This script intentionally does NOT construct a CosmosClient, read
 * COSMOS_CONNECTION_STRING, or issue any request. Promoting it to a real,
 * runnable census (mirroring the shape of scripts/census-unknown-setkey.cjs
 * or scripts/census-seller-name-auto.cjs) is follow-up work, not done here.
 */

throw new Error(
  "census-doubled-year-titles.cjs is a READ-ONLY QUERY DESCRIPTION, not a runnable script. " +
  "See the header comment for the exact per-(sport,year) query and axis; " +
  "no Cosmos client is constructed and nothing here has been run.",
);
