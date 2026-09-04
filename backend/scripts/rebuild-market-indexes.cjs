#!/usr/bin/env node
/**
 * CF-MARKET-INDEXES rebuild (C-1 / H-11, 2026-09-03).
 *
 * Recomputes the stored 180-day series under the UNIFIED method:
 * persisted carry-forward, per-epoch basket selection with no lookahead,
 * and the usedWeight floor. This exists because the stored series is not
 * internally comparable today - nightly points were computed one way
 * (14-day carry seed, level published at any usedWeight) and backfilled
 * points another (accumulated carry, basket picked at the END date).
 *
 * REPORT-FIRST. The default run WRITES NOTHING: it reads the stored
 * series, recomputes what the unified method would produce, and prints a
 * per-sport before/after for the last 30 days. Writing requires an
 * explicit --apply, and the run refuses a whole-scope write without one.
 *
 * Runbook:
 *   # report only (safe, read-only)
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/rebuild-market-indexes.cjs
 *
 *   # after reading the report
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/rebuild-market-indexes.cjs --apply
 *
 * THE PURGE (Drew's ruling, 2026-09-03)
 * -------------------------------------
 * Nine basket documents were minted into prod on 2026-09-03 between
 * 14:12Z and 14:36Z by rebuild runs whose "report-only" mode was not
 * write-free (the defect #1675 fixed). Drew ruled they are to be
 * DELETED, and every quarter's basket recreated from that quarter's own
 * history under the unified method.
 *
 * WHICH DOCS, AND HOW WE KNOW
 * ---------------------------
 * A date alone is not a marker: it says when a doc was written, never
 * what wrote it. Two stronger markers are used, and a doc must satisfy
 * BOTH to be purged:
 *
 *   1. UNREFERENCED. No stored index point cites the basket's epoch for
 *      that sport. A basket the published series was actually computed
 *      against is load-bearing whatever its age; one that no point cites
 *      is, by definition, a basket nothing was ever valued against.
 *      Measured 2026-09-03: all 879 stored points carry epoch 2026-Q3,
 *      so the nine Q1/Q2 baskets are cited by nothing.
 *
 *   2. NOT APPLY-STAMPED. `builtBy: "apply"` is stamped by the only path
 *      that legitimately writes a basket. It did not exist when the nine
 *      landed, so they cannot carry it. A stamped basket is never purged.
 *
 * The stray window is a REPORT field, not the selector — it is printed
 * so the operator can see the nine line up with the incident, and a doc
 * outside it that meets both markers is still listed (as an unreferenced
 * basket) rather than silently kept.
 *
 * A basket the CURRENT run is about to rebuild anyway is safe to delete:
 * apply mode purges first, then rebuilds every sport's every epoch from
 * that epoch's own trailing window, with no lookahead.
 *
 * Flags / env:
 *   --apply          Persist: purge the strays, then recompute the
 *                    series. Without it: read-only, and the run proves
 *                    it wrote nothing.
 *   BACKFILL_APPLY=true  Same as --apply. This is how the backfill
 *                    runner gates the lane (script=rebuild-market-indexes).
 *   --as-of=DATE     Target day, YYYY-MM-DD (default: today UTC).
 *   --sports=a,b     Restrict to these sports (default: all five).
 *                    SPORTS=a,b from the runner does the same.
 *   --compare-days=N Days of before/after to print (default 30).
 *   REPORT_OUT       Where to write the JSON report (the runner uploads
 *                    it as an artifact).
 *
 * Thresholds are RULED, not assumed (Drew, 2026-09-03):
 *   MIN_USED_WEIGHT 0.50, MIN_BASKET_SIZE 25.
 *
 * Exit codes:
 *   0  report produced (and, with --apply, purged + written)
 *   1  bad flags / no COSMOS_CONNECTION_STRING / nothing computed
 *   2  a write was attempted in report mode, or the purge did not
 *      reconcile (intended != deleted + skipped)
 */

const path = require("path");
const fs = require("fs");

const SPORTS = ["baseball", "basketball", "football", "hockey", "pokemon"];

/**
 * The incident window, in epoch SECONDS (Cosmos `_ts` is seconds).
 * 2026-09-03 14:00:00Z .. 14:45:00Z — the nine strays landed between
 * 14:12:57Z and 14:35:59Z, and the window is padded either side.
 *
 * This is REPORTING, not selection: a doc is purged on the two markers
 * (unreferenced + unstamped), and this field only says whether it falls
 * in the known incident. See THE PURGE in the header.
 */
const STRAY_WINDOW_START_TS = Math.floor(Date.parse("2026-09-03T14:00:00Z") / 1000);
const STRAY_WINDOW_END_TS = Math.floor(Date.parse("2026-09-03T14:45:00Z") / 1000);

/** Read a boolean env var the way the backfill runner sets it. */
function envTrue(name) {
  return String(process.env[name] ?? "").trim().toLowerCase() === "true";
}

async function main() {
  const args = process.argv.slice(2);
  // The backfill runner execs this generically with no CLI args and
  // gates every lane on BACKFILL_APPLY, so the env var is a first-class
  // way to ask for the write — not a fallback.
  const apply = args.includes("--apply") || envTrue("BACKFILL_APPLY");
  const asOfArg = flag(args, "--as-of");
  // The runner passes SPORTS; the CLI flag wins when both are present.
  const envSports = String(process.env.SPORTS ?? "").trim();
  const sportsArg = flag(args, "--sports") ?? (envSports === "" ? undefined : envSports);
  const compareDays = Number(flag(args, "--compare-days") ?? 30);

  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  if (asOfArg && !/^\d{4}-\d{2}-\d{2}$/.test(asOfArg)) {
    console.error(`--as-of must be YYYY-MM-DD, got "${asOfArg}"`);
    process.exit(1);
  }
  if (!Number.isFinite(compareDays) || compareDays < 1 || compareDays > 180) {
    console.error("--compare-days must be 1..180");
    process.exit(1);
  }

  const distRoot = path.resolve(__dirname, "..", "dist");
  if (!fs.existsSync(path.join(distRoot, "services"))) {
    console.error("backend/dist not found - run `npm run build` first");
    process.exit(1);
  }
  const svc = require(path.join(distRoot, "services", "insights", "marketIndex.service.js"));
  const compute = require(
    path.join(distRoot, "services", "insights", "marketIndexCompute.service.js"),
  );
  // CF-EVERY-WRITE-JOB-RECONCILES: this script has always reconciled its
  // DELETES against their own intended lists, and verified the result by
  // reading prod back. What it never did was reconcile the POINTS it
  // upserts, and it did so under a private accounting rule the fleet-wide
  // net cannot read — so `tests/everyWriteJobReconciles.test.ts` scored it
  // as a writer that can finish green having written nothing, which was
  // fair: nothing in the run tied `intended` to `written` for the rebuild
  // itself. Same equation, stated in the shared vocabulary.
  const { reportWrites } = require(
    path.join(distRoot, "services", "ops", "writeReconciliation.js"),
  );

  const sports = sportsArg
    ? sportsArg.split(",").map((s) => s.trim()).filter(Boolean)
    : SPORTS;
  // A sport this script does not know is a TYPO, not an empty scope. Left
  // unchecked it would scope the purge to nothing, rebuild nothing, and
  // print a clean banner — the shape of a run that silently did nothing
  // (CF-SCOPE-FORMATS-ARE-PER-SCRIPT: the banner must prove the binding).
  const unknown = sports.filter((sp) => !SPORTS.includes(sp));
  if (unknown.length > 0) {
    console.error(
      `unknown sport(s): ${unknown.join(", ")} - known: ${SPORTS.join(", ")}`,
    );
    process.exit(1);
  }
  const asOf = asOfArg ?? svc.isoDay(new Date());
  const from = svc.addDays(asOf, -(compareDays - 1));

  // The banner states the scope and the mode before anything runs, so a
  // log makes plain whether this run could write.
  console.log(JSON.stringify({
    event: "market_index_rebuild_start",
    mode: apply ? "APPLY (writes)" : "REPORT-ONLY (no writes)",
    applyVia: apply
      ? (args.includes("--apply") ? "--apply" : "BACKFILL_APPLY=true")
      : null,
    sports,
    asOf,
    compareWindow: `${from}..${asOf}`,
    // Both RULED by Drew 2026-09-03 - quoted from the service so the
    // banner cannot drift from the constants the run actually uses.
    ruledMinUsedWeight: svc.MIN_USED_WEIGHT,
    ruledMinBasketSize: svc.MIN_BASKET_SIZE,
  }));

  const series = await svc.getSeriesContainer();
  if (!series) {
    console.error("no series container - check COSMOS_CONNECTION_STRING");
    process.exit(1);
  }

  // ---- BEFORE: what is stored right now -------------------------------
  const before = {};
  for (const sport of sports) {
    before[sport] = await readStored(series, sport, from, asOf);
  }

  // ---- PURGE: the stray baskets (Drew's ruling, 2026-09-03) ------------
  // Identified in BOTH modes, deleted only under --apply. The report is
  // the thing an operator reads before authorising the delete, so it has
  // to name every doc precisely: id, sport, epoch, _ts and the marker
  // that condemned it.
  const allBaskets = await readAllBaskets(series);
  const referenced = await readReferencedEpochs(series);
  const { strays, kept } = identifyStrays(allBaskets, referenced, sports);

  console.log(JSON.stringify({
    event: "market_index_purge_plan",
    mode: apply ? "APPLY (deletes)" : "REPORT-ONLY (lists)",
    basketsStored: allBaskets.length,
    referencedEpochs: [...referenced].sort(),
    intended: strays.length,
    strays,
    kept,
  }));

  let purge = { deleted: [], skipped: [] };
  if (apply && strays.length > 0) {
    purge = await purgeStrays(series, strays);
  }

  // RECONCILE: intended = deleted + skipped. A purge that cannot account
  // for every doc it named is a purge that did something else, so the run
  // fails rather than proceeding to rebuild on top of it.
  //
  // The identity is asserted for an APPLY only. A report intends N and
  // deletes none BY DESIGN, so scoring it against deleted+skipped would
  // print `reconciled:false` on every correct read-only run - an alarm
  // that fires when nothing is wrong is an alarm nobody reads.
  const reconciled = apply
    ? strays.length === purge.deleted.length + purge.skipped.length
    : purge.deleted.length === 0 && purge.skipped.length === 0;
  console.log(JSON.stringify({
    event: "market_index_purge_reconcile",
    mode: apply ? "APPLY" : "REPORT-ONLY",
    intended: strays.length,
    deleted: purge.deleted.length,
    skipped: purge.skipped.length,
    reconciled,
    reconciles: apply
      ? "intended == deleted + skipped"
      : "report-only: deleted == 0 and skipped == 0",
    deletedIds: purge.deleted,
    skippedIds: purge.skipped,
    note: apply
      ? "strays deleted; baskets are recreated per epoch by the rebuild below"
      : "no deletes performed - re-run with --apply (or BACKFILL_APPLY=true) to purge",
  }));
  // A report that somehow deleted something is the exact defect this
  // whole PR exists to close, so it fails the run rather than warning.
  if (!apply && !reconciled) {
    console.error(JSON.stringify({
      event: "market_index_purge_deleted_in_report_mode",
      deleted: purge.deleted,
      skipped: purge.skipped,
    }));
    process.exit(2);
  }
  if (apply && !reconciled) {
    console.error(JSON.stringify({
      event: "market_index_purge_did_not_reconcile",
      intended: strays.length,
      deleted: purge.deleted.length,
      skipped: purge.skipped.length,
    }));
    process.exit(2);
  }

  // ---- PRE-SPAN POINTS: the day the walk can no longer reach ----------
  // The recompute owns `[seriesFrom .. asOf]` and upserts every id in it.
  // A point OLDER than seriesFrom is one the walk will never touch again
  // - it was written by a run whose span started a day earlier - so it
  // sits in storage forever at whatever the old method computed.
  //
  // On 2026-09-03 that was exactly four docs (`point::<sport>::2026-03-07`
  // for baseball, basketball, football and pokemon), pre-C-1, published,
  // with no usedWeight at all. verifyByRead reads across the whole
  // container, so those four alone hold verifyOk false no matter how
  // clean the walk is.
  //
  // Deleted, not rewritten: there is nothing to rewrite them TO. They are
  // outside the series the UI renders and outside the span this run
  // computes; the correct state for that id is absent.
  const seriesFrom = svc.addDays(asOf, -(svc.SERIES_DAYS - 1));
  const prePoints = await readPointsBefore(series, sports, seriesFrom);
  let prePurge = { deleted: [], skipped: [] };
  if (apply) {
    prePurge = await purgeStrays(series, prePoints);
  }
  const preReconciled = apply
    ? prePoints.length === prePurge.deleted.length + prePurge.skipped.length
    : prePurge.deleted.length === 0 && prePurge.skipped.length === 0;
  console.log(JSON.stringify({
    event: "market_index_pre_span_points",
    mode: apply ? "APPLY (deletes)" : "REPORT-ONLY (lists)",
    seriesFrom,
    intended: prePoints.length,
    deleted: prePurge.deleted.length,
    skipped: prePurge.skipped.length,
    reconciled: preReconciled,
    ids: prePoints.map((p) => p.id),
    note: "points dated before the recompute span - the walk can never upsert them",
  }));
  if (!preReconciled) {
    console.error(JSON.stringify({
      event: "market_index_pre_span_purge_did_not_reconcile",
      intended: prePoints.length,
      deleted: prePurge.deleted.length,
      skipped: prePurge.skipped.length,
    }));
    process.exit(2);
  }

  // ---- AFTER: what the unified method produces ------------------------
  // Report mode never writes. It does not merely refrain from calling
  // upsert: it drives the recompute through a container FACADE whose
  // every write method throws, so a write that slipped back in would
  // fail the run loudly rather than land in prod. Pinned in
  // tests/marketIndexDryRunWriteFree.test.ts.
  const after = {};
  if (apply) {
    const results = await compute.runMarketIndexJob({ rebuild: true, asOf, sports });
    for (const r of results) {
      after[r.sport] = {
        latestLevel: r.latestLevel,
        pointsWritten: r.pointsWritten,
        pointsWithheld: r.pointsWithheld,
        latestUsedWeight: r.latestUsedWeight,
        epochsUsed: r.epochsUsed,
      };
    }
    // RECONCILE THE REBUILD ITSELF. A recompute OWNS every id in its span:
    // `SERIES_DAYS` days per sport, and each day upserts exactly one point
    // doc. `pointsWritten` counts the days that published a LEVEL;
    // `pointsWithheld` counts the days that did not — the usedWeight floor
    // fired, or the epoch had no basket — and since #1686 / #1687 those
    // days upsert a LEVELLESS doc rather than skipping the write and
    // leaving a stale doc standing. Both are writes.
    //
    // So `written` here is both counters: the reconciliation asks whether
    // the docs the run owns actually landed, and every day's doc did.
    // Withheld days are reported alongside — they are the number that says
    // how much of the span published a level — but they are not `skipped`
    // in the shared vocabulary, because nothing was skipped. Counting them
    // as skipped would have reconciled by the same arithmetic while
    // claiming the run declined writes it in fact performed, which is the
    // class of untrue banner this whole net exists to catch.
    const spanDays = svc.SERIES_DAYS;
    const totalWritten = results.reduce((n, r) => n + (r.pointsWritten ?? 0), 0);
    const totalWithheld = results.reduce((n, r) => n + (r.pointsWithheld ?? 0), 0);
    console.log(JSON.stringify({
      event: "market_index_rebuild_points_reconcile",
      spanDays,
      sports: results.length,
      pointsPublished: totalWritten,
      pointsWithheld: totalWithheld,
      note: "a withheld day still upserts a levelless doc - both counters are writes",
    }));
    reportWrites({
      job: "rebuild-market-indexes",
      intended: spanDays * results.length,
      written: totalWritten + totalWithheld,
      skipped: 0,
      failed: 0,
    });
    // Re-read so the report quotes what actually landed.
    for (const sport of sports) {
      after[sport] = {
        ...(after[sport] ?? {}),
        stored: await readStored(series, sport, from, asOf),
      };
    }
  } else {
    const guard = readOnlyContainer(series);
    for (const sport of sports) {
      after[sport] = await dryRun(svc, compute, guard, sport, asOf, from);
    }
    // The guard counts what a write WOULD have been. Zero is the claim
    // the banner makes; anything else is a bug, and the run says so.
    if (guard.__writes.length > 0) {
      console.error(JSON.stringify({
        event: "market_index_rebuild_write_in_report_mode",
        attempted: guard.__writes,
      }));
      process.exit(2);
    }
  }

  // ---- REPORT ---------------------------------------------------------
  for (const sport of sports) {
    const b = before[sport];
    const a = after[sport];
    console.log(JSON.stringify({
      event: "market_index_rebuild_sport",
      sport,
      before: {
        latestLevel: b.latestLevel,
        points: b.count,
        freshMembersLatest: b.freshMembers,
        basketSize: b.basketSize,
      },
      after: apply
        ? {
            latestLevel: a.stored ? a.stored.latestLevel : null,
            points: a.stored ? a.stored.count : null,
            pointsWithheld: a.pointsWithheld ?? null,
            latestUsedWeight: a.latestUsedWeight ?? null,
          }
        : {
            latestLevel: a.latestLevel,
            points: a.published,
            pointsWithheld: a.withheld,
            latestUsedWeight: a.latestUsedWeight,
            wouldWithholdLatest: a.wouldWithholdLatest,
            carriedLevel: a.carriedLevel ?? null,
          },
    }));
  }

  // ---- BASKETS RECREATED, per sport / epoch ---------------------------
  // Named after the rebuild so the banner shows what the run left behind
  // rather than what it found. Every quarter's basket is selected from
  // that quarter's own trailing window (no lookahead) by ensureBasket.
  const basketsAfter = await readAllBaskets(series);
  const recreated = {};
  for (const b of basketsAfter) {
    if (!sports.includes(b.sport)) continue;
    recreated[b.sport] = recreated[b.sport] ?? {};
    recreated[b.sport][b.epoch] = {
      members: b.memberCount,
      builtBy: b.builtBy ?? null,
      baseDate: b.baseDate,
    };
  }
  console.log(JSON.stringify({
    event: "market_index_baskets_recreated",
    mode: apply ? "APPLY" : "REPORT-ONLY",
    perSportEpoch: recreated,
    note: apply
      ? "each epoch selected from its OWN trailing window - no lookahead"
      : "unchanged - report mode recreated nothing",
  }));

  // ---- VERIFY BY READ -------------------------------------------------
  // The run's own return values are not evidence. These numbers come back
  // out of Cosmos after the writes landed.
  const verify = await verifyByRead(series, sports, svc.MIN_BASKET_SIZE, svc.MIN_USED_WEIGHT);
  console.log(JSON.stringify({
    event: "market_index_rebuild_verify",
    mode: apply ? "APPLY" : "REPORT-ONLY",
    ...verify,
  }));

  console.log(JSON.stringify({
    event: "market_index_rebuild_done",
    mode: apply ? "APPLY" : "REPORT-ONLY",
    sports: sports.length,
    straysIntended: strays.length,
    straysDeleted: purge.deleted.length,
    straysSkipped: purge.skipped.length,
    verifyOk: verify.ok,
    note: apply
      ? "strays purged, baskets recreated per epoch, series recomputed under the unified method"
      : "no writes performed - re-run with --apply (or BACKFILL_APPLY=true) to purge and persist",
  }));

  // The report is uploaded as a runner artifact: a banner that scrolled
  // out of a log cannot be quoted, and this run's whole job is to be read
  // before the apply is authorised.
  const reportOut = process.env.REPORT_OUT;
  if (reportOut) {
    try {
      fs.mkdirSync(path.dirname(reportOut), { recursive: true });
      fs.writeFileSync(
        reportOut,
        JSON.stringify(
          {
            mode: apply ? "APPLY" : "REPORT-ONLY",
            asOf,
            sports,
            strays,
            kept,
            purge,
            before,
            after,
            basketsRecreated: recreated,
            verify,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify({ event: "market_index_report_written", path: reportOut }));
    } catch (err) {
      console.error(`could not write REPORT_OUT: ${err && err.message ? err.message : String(err)}`);
    }
  }

  // A verify failure is loud. In apply mode it is a failed run: the whole
  // point of the rebuild is that these three properties hold afterwards.
  if (apply && !verify.ok) {
    console.error(JSON.stringify({
      event: "market_index_rebuild_verify_failed",
      undersizedBaskets: verify.undersizedBaskets,
      publishedPointsBelowFloorCount: verify.publishedPointsBelowFloorCount,
      remainingStrays: verify.remainingStrays,
    }));
    process.exit(2);
  }
}

/**
 * Every stored basket doc, newest marker fields included.
 *
 * Read across ALL sports rather than the dispatched subset: a stray in a
 * sport this run was not asked to rebuild is still a stray, and the
 * report says so. Only the purge itself is scoped (see identifyStrays).
 */
async function readAllBaskets(series) {
  const iter = series.items.query({
    query: `SELECT c.id, c.cardId, c.sport, c.epoch, c.baseDate, c.computedAt,
                   c.builtBy, c._ts, ARRAY_LENGTH(c.members) AS memberCount
            FROM c
            WHERE c.docType = 'market_index_basket'`,
  });
  const rows = [];
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (resources) rows.push(...resources);
  }
  return rows;
}

/**
 * The (sport, epoch) pairs any stored point actually cites.
 *
 * This is marker 1, and it is the strong one. A basket that no published
 * point was computed against is load-bearing for nothing; deleting it
 * cannot change a level the UI renders, because no level was ever
 * derived from it. A basket that IS cited is never purged here however
 * old it looks — the rebuild overwrites it in place instead.
 */
async function readReferencedEpochs(series) {
  const iter = series.items.query({
    query: `SELECT c.sport, c.epoch
            FROM c
            WHERE c.docType = 'market_index_point'
            GROUP BY c.sport, c.epoch`,
  });
  const refs = new Set();
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    for (const r of resources ?? []) refs.add(`${r.sport}::${r.epoch}`);
  }
  return refs;
}

/**
 * Classify every stored basket into purge / keep, with the REASON.
 *
 * A basket is purged only when BOTH markers agree:
 *   unreferenced  - no stored point cites (sport, epoch)
 *   unstamped     - no builtBy:"apply" from the path that legitimately writes
 *
 * Requiring both is what keeps this from being a date sweep. The
 * incident window is attached for the operator's benefit and is not part
 * of the test — a stray outside it is still a stray, and a legitimate
 * basket inside it is still kept.
 */
function identifyStrays(baskets, referenced, sports) {
  const scope = new Set(sports);
  const strays = [];
  const kept = [];
  for (const b of baskets) {
    const referencedByPoints = referenced.has(`${b.sport}::${b.epoch}`);
    const applyStamped = b.builtBy === "apply";
    const inStrayWindow = b._ts >= STRAY_WINDOW_START_TS && b._ts <= STRAY_WINDOW_END_TS;
    const row = {
      id: b.id,
      sport: b.sport,
      epoch: b.epoch,
      baseDate: b.baseDate,
      members: b.memberCount,
      computedAt: b.computedAt,
      ts: b._ts,
      tsIso: new Date(b._ts * 1000).toISOString(),
      marker: applyStamped
        ? "apply-stamped"
        : referencedByPoints
          ? "referenced-by-points"
          : inStrayWindow
            ? "unreferenced+unstamped+in-stray-window"
            : "unreferenced+unstamped",
      referencedByPoints,
      applyStamped,
      inStrayWindow,
    };
    if (!referencedByPoints && !applyStamped) {
      // Out of the dispatched sport scope: named in the report, never
      // deleted by a run that was not asked to touch that sport.
      if (!scope.has(b.sport)) {
        kept.push({ ...row, keptBecause: "out-of-scope-for-this-run" });
        continue;
      }
      strays.push(row);
      continue;
    }
    kept.push({
      ...row,
      keptBecause: applyStamped ? "apply-stamped" : "referenced-by-points",
    });
  }
  strays.sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : 1));
  return { strays, kept };
}

/**
 * Delete exactly the listed ids and nothing else.
 *
 * The list is the scope. This never re-derives what to delete from a
 * predicate at delete time: it walks the ids identifyStrays named, so
 * what the report showed is precisely what goes. A delete that 404s is
 * counted as skipped (already gone), never as a failure — but it is
 * still reconciled, so the banner cannot claim a deletion it did not do.
 */
/**
 * Every index POINT dated before `boundary`, for the scoped sports.
 *
 * Shaped like a stray ({id, sport}) so it feeds the same purgeStrays and
 * the same reconcile identity - one delete path, one accounting rule.
 */
async function readPointsBefore(series, sports, boundary) {
  const iter = series.items.query({
    query: `SELECT c.id, c.sport, c.date, c.usedWeight, c.stale, c.computedAt
            FROM c
            WHERE c.docType = 'market_index_point'
              AND c.date < @boundary`,
    parameters: [{ name: "@boundary", value: boundary }],
  });
  const rows = [];
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (resources) rows.push(...resources);
  }
  // Scoped like the basket purge: a sport this dispatch did not name is
  // not this run's to delete.
  return rows.filter((r) => sports.includes(r.sport));
}

async function purgeStrays(series, strays) {
  const deleted = [];
  const skipped = [];
  for (const st of strays) {
    try {
      await series.item(st.id, `index::${st.sport}`).delete();
      deleted.push(st.id);
    } catch (err) {
      const code = err && (err.code ?? err.statusCode);
      if (code === 404) {
        skipped.push({ id: st.id, reason: "already-absent" });
      } else {
        skipped.push({ id: st.id, reason: `delete-failed: ${err && err.message ? err.message : String(err)}` });
      }
    }
  }
  return { deleted, skipped };
}

/**
 * VERIFY BY READ. Re-reads prod after the writes and asserts the three
 * properties the rebuild is supposed to establish. A green run is not
 * evidence; the numbers read back are.
 */
async function verifyByRead(series, sports, minBasketSize, minUsedWeight) {
  const baskets = await readAllBaskets(series);
  const referenced = await readReferencedEpochs(series);

  const perSportEpoch = {};
  const undersized = [];
  for (const b of baskets) {
    if (!sports.includes(b.sport)) continue;
    perSportEpoch[b.sport] = perSportEpoch[b.sport] ?? {};
    perSportEpoch[b.sport][b.epoch] = b.memberCount;
    if (b.memberCount < minBasketSize) {
      undersized.push({ id: b.id, members: b.memberCount });
    }
  }

  // No point may be PUBLISHED (not stale) below the ruled floor. The
  // threshold is the service constant, passed in - a verification that
  // hardcodes its own copy of a ruled number stops verifying the moment
  // the ruling moves.
  //
  // A point with NO usedWeight field predates C-1 and was never
  // floor-tested at all; `NOT IS_DEFINED` catches those too, because an
  // unmeasured point is not a passing point.
  const iter = series.items.query({
    query: `SELECT c.id, c.sport, c.date, c.usedWeight
            FROM c
            WHERE c.docType = 'market_index_point'
              AND (NOT IS_DEFINED(c.usedWeight) OR c.usedWeight < @floor)
              AND (NOT IS_DEFINED(c.stale) OR c.stale = false)`,
    parameters: [{ name: "@floor", value: minUsedWeight }],
  });
  const belowFloor = [];
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (resources) belowFloor.push(...resources);
  }

  const remainingStrays = baskets.filter(
    (b) => b.builtBy !== "apply" && !referenced.has(`${b.sport}::${b.epoch}`),
  );

  return {
    basketsPerSportEpoch: perSportEpoch,
    basketCount: baskets.length,
    undersizedBaskets: undersized,
    publishedPointsBelowFloor: belowFloor.slice(0, 20),
    publishedPointsBelowFloorCount: belowFloor.length,
    remainingStrayCount: remainingStrays.length,
    remainingStrays: remainingStrays.map((b) => b.id),
    ok:
      undersized.length === 0 &&
      belowFloor.length === 0 &&
      remainingStrays.length === 0,
  };
}

/**
 * A container facade that passes reads through and REFUSES every write.
 *
 * This is the mechanical guarantee behind "REPORT-ONLY (no writes)". The
 * report lane used to hand the real container to ensureBasket, which
 * upserts a basket doc whenever the epoch it is asked for has none
 * stored - so a report over a 180-day span crossing an unbuilt quarter
 * minted that quarter's basket from today's eligibility read. On
 * 2026-09-03 that put nine basket docs into prod from runs that
 * announced they wrote nothing.
 *
 * Attempts are recorded on `__writes` (rather than only thrown) so the
 * caller can assert ZERO and report what was attempted.
 */
function readOnlyContainer(real) {
  const writes = [];
  const refuse = (method) => (...args) => {
    const doc = args[0];
    writes.push({ method, id: doc && doc.id, docType: doc && doc.docType });
    throw new Error(
      `REPORT-ONLY run attempted ${method} on ${doc && doc.id ? doc.id : "<unknown doc>"}`,
    );
  };
  return {
    __writes: writes,
    // Reads pass straight through to the real container.
    items: {
      query: (...a) => real.items.query(...a),
      readAll: (...a) => real.items.readAll(...a),
      create: refuse("items.create"),
      upsert: refuse("items.upsert"),
    },
    item: (id, pk) => {
      const it = real.item(id, pk);
      return {
        read: (...a) => it.read(...a),
        replace: refuse("item.replace"),
        delete: refuse("item.delete"),
        patch: refuse("item.patch"),
      };
    },
  };
}

/** Read the stored series for a sport over [from, asOf]. */
async function readStored(series, sport, from, asOf) {
  const iter = series.items.query({
    query: `SELECT c.date, c.level, c.freshMembers, c.basketSize, c.usedWeight, c.stale
            FROM c
            WHERE c.cardId = @pk
              AND c.docType = 'market_index_point'
              AND c.date >= @from AND c.date <= @to
            ORDER BY c.date ASC`,
    parameters: [
      { name: "@pk", value: `index::${sport}` },
      { name: "@from", value: from },
      { name: "@to", value: asOf },
    ],
  });
  const rows = [];
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    rows.push(...resources);
  }
  const last = rows[rows.length - 1];
  return {
    count: rows.length,
    latestLevel: last ? last.level : null,
    freshMembers: last ? (last.freshMembers ?? null) : null,
    basketSize: last ? (last.basketSize ?? null) : null,
    rows,
  };
}

/**
 * Recompute a sport's window WITHOUT writing. Mirrors the shipped
 * compute path (same basket, same carry, same floor) but keeps every
 * result in memory - this is the read-only lane the runbook leads with.
 */
async function dryRun(svc, compute, series, sport, asOf, reportFrom) {
  const soldComps = await svc.getSoldCompsContainer();
  if (!soldComps) return { latestLevel: null, published: 0, withheld: 0 };

  const fullFrom = svc.addDays(asOf, -(svc.SERIES_DAYS - 1));
  // persist:false — the would-be basket is computed in memory. Combined
  // with the read-only facade this is belt and braces: the option keeps
  // the write from being attempted, the facade proves none was.
  //
  // A null here means the span's FIRST epoch has too few eligible cards.
  // That is not a reason to abandon the sport: later epochs may be fine
  // (hockey's 2026-Q1 has 21 cards, its 2026-Q3 has 43). Those early days
  // are withheld and the walk picks the basket up at the next roll.
  const ensured = await compute.ensureBasket(soldComps, series, sport, fullFrom, {
    persist: false,
  });

  let basket = ensured ? ensured.basket : null;
  let epoch = basket ? basket.epoch : svc.rebalanceEpochFor(fullFrom);
  let memberIds = basket ? basket.members.map((m) => m.cardId) : [];
  let memberSet = new Set(memberIds);

  // LEAD_IN_DAYS, not VALUE_WINDOW_DAYS: the write path reads 90 days
  // before day one to seed its carry, and a report lane reading only 14
  // sees a thinner seed and predicts withholds the apply lane will not
  // make.
  const allRows = await svc.fetchSales(
    soldComps,
    sport,
    svc.addDays(fullFrom, -svc.LEAD_IN_DAYS),
    svc.addDays(asOf, 1),
  );

  const carry = await svc.loadCarryForward(series, sport);
  // MIRROR THE WRITE PATH (2026-09-03). This seeded only the FIRST
  // epoch's members while computeSeriesForSport seeds every card in the
  // lead-in, so the report lane predicted published/withheld counts the
  // apply lane would not produce - the report is worthless the moment it
  // stops modelling the thing it reports on. Unbounded here is safe:
  // the dry run persists nothing.
  const seed = svc.groupByCard(allRows.filter((r) => r.soldAt < fullFrom));
  for (const [cardId, agg] of seed) {
    if (carry.has(cardId)) continue;
    const v = agg.values[agg.values.length - 1];
    if (v > 0) carry.set(cardId, { value: v, asOf: fullFrom });
  }

  let published = 0;
  let withheld = 0;
  let latestLevel = null;
  let latestUsedWeight = null;
  let wouldWithholdLatest = false;
  // Same seed the write path uses: a withheld day carries the last level
  // actually PUBLISHED, never a level from a different computation.
  let priorLevel = await compute.lastPublishedLevel(series, sport, fullFrom);
  let carriedFrom = priorLevel;

  for (let day = fullFrom; day <= asOf; day = svc.addDays(day, 1)) {
    const dayEpoch = svc.rebalanceEpochFor(day);
    if (dayEpoch !== epoch) {
      const rolled = await compute.ensureBasket(soldComps, series, sport, day, {
        persist: false,
      });
      if (rolled) {
        basket = rolled.basket;
        epoch = basket.epoch;
        memberIds = basket.members.map((m) => m.cardId);
        memberSet = new Set(memberIds);
      } else {
        // Too few eligible cards for a basket this epoch - withhold the
        // whole epoch rather than value it against the previous one.
        basket = null;
        epoch = dayEpoch;
        memberIds = [];
        memberSet = new Set();
      }
    }
    if (!basket) {
      if (day >= reportFrom) withheld++;
      wouldWithholdLatest = true;
      latestUsedWeight = null;
      if (priorLevel != null) latestLevel = priorLevel;
      continue;
    }
    const windowFrom = svc.addDays(day, -svc.VALUE_WINDOW_DAYS);
    const windowTo = svc.addDays(day, 1);
    const inWindow = svc.groupByCard(
      allRows.filter(
        (r) => r.soldAt >= windowFrom && r.soldAt < windowTo && memberSet.has(r.cardId),
      ),
    );
    const { values } = svc.valueMembersOnDayDated(memberIds, inWindow, carry, day);
    const decision = svc.decidePoint(basket.members, values);

    const inReportWindow = day >= reportFrom;
    if (decision.publish) {
      priorLevel = Math.round(decision.level * 100) / 100;
      if (inReportWindow) published++;
      latestLevel = priorLevel;
      latestUsedWeight = Math.round(decision.usedWeight * 10000) / 10000;
      wouldWithholdLatest = false;
    } else {
      if (inReportWindow) withheld++;
      latestUsedWeight = Math.round(decision.usedWeight * 10000) / 10000;
      wouldWithholdLatest = true;
      if (priorLevel != null) latestLevel = priorLevel;
    }
  }

  return {
    latestLevel,
    published,
    withheld,
    latestUsedWeight,
    wouldWithholdLatest,
    // What the tile would show on the newest day if it is withheld: the
    // last published level, carried and labelled. Null means the tile
    // goes empty because nothing was ever published to carry.
    carriedLevel: wouldWithholdLatest ? latestLevel : null,
    seededCarryFrom: carriedFrom,
  };
}

function flag(args, name) {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
