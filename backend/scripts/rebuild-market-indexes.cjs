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
 * Flags:
 *   --apply          Persist the recomputed series. Without it: read-only.
 *   --as-of=DATE     Target day, YYYY-MM-DD (default: today UTC).
 *   --sports=a,b     Restrict to these sports (default: all five).
 *   --compare-days=N Days of before/after to print (default 30).
 *
 * No dispatch input changes: this is a script, run by hand from the
 * runbook. The nightly workflow is untouched.
 *
 * Exit codes:
 *   0  report produced (and, with --apply, points written)
 *   1  bad flags / no COSMOS_CONNECTION_STRING / nothing computed
 */

const path = require("path");
const fs = require("fs");

const SPORTS = ["baseball", "basketball", "football", "hockey", "pokemon"];

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const asOfArg = flag(args, "--as-of");
  const sportsArg = flag(args, "--sports");
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

  const sports = sportsArg
    ? sportsArg.split(",").map((s) => s.trim()).filter(Boolean)
    : SPORTS;
  const asOf = asOfArg ?? svc.isoDay(new Date());
  const from = svc.addDays(asOf, -(compareDays - 1));

  // The banner states the scope and the mode before anything runs, so a
  // log makes plain whether this run could write.
  console.log(JSON.stringify({
    event: "market_index_rebuild_start",
    mode: apply ? "APPLY (writes)" : "REPORT-ONLY (no writes)",
    sports,
    asOf,
    compareWindow: `${from}..${asOf}`,
    floor: svc.MIN_USED_WEIGHT,
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

  // ---- AFTER: what the unified method produces ------------------------
  // Report mode never writes, so the recompute runs against a container
  // handle whose upsert is a no-op capture.
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
    // Re-read so the report quotes what actually landed.
    for (const sport of sports) {
      after[sport] = {
        ...(after[sport] ?? {}),
        stored: await readStored(series, sport, from, asOf),
      };
    }
  } else {
    for (const sport of sports) {
      after[sport] = await dryRun(svc, compute, series, sport, asOf, from);
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
          },
    }));
  }

  console.log(JSON.stringify({
    event: "market_index_rebuild_done",
    mode: apply ? "APPLY" : "REPORT-ONLY",
    sports: sports.length,
    note: apply
      ? "series recomputed under the unified method"
      : "no writes performed - re-run with --apply to persist",
  }));
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
  const ensured = await compute.ensureBasket(soldComps, series, sport, fullFrom);
  if (!ensured) return { latestLevel: null, published: 0, withheld: 0 };

  let basket = ensured.basket;
  let epoch = basket.epoch;
  let memberIds = basket.members.map((m) => m.cardId);
  let memberSet = new Set(memberIds);

  const allRows = await svc.fetchSales(
    soldComps,
    sport,
    svc.addDays(fullFrom, -svc.VALUE_WINDOW_DAYS),
    svc.addDays(asOf, 1),
  );

  const carry = await svc.loadCarryForward(series, sport);
  const seed = svc.groupByCard(
    allRows.filter((r) => r.soldAt < fullFrom && memberSet.has(r.cardId)),
  );
  for (const id of memberIds) {
    const agg = seed.get(id);
    if (agg && agg.values.length > 0) {
      const v = agg.values[agg.values.length - 1];
      if (v > 0 && !carry.has(id)) carry.set(id, { value: v, asOf: fullFrom });
    }
  }

  let published = 0;
  let withheld = 0;
  let latestLevel = null;
  let latestUsedWeight = null;
  let wouldWithholdLatest = false;
  let priorLevel = null;

  for (let day = fullFrom; day <= asOf; day = svc.addDays(day, 1)) {
    const dayEpoch = svc.rebalanceEpochFor(day);
    if (dayEpoch !== epoch) {
      const rolled = await compute.ensureBasket(soldComps, series, sport, day);
      if (rolled) {
        basket = rolled.basket;
        epoch = basket.epoch;
        memberIds = basket.members.map((m) => m.cardId);
        memberSet = new Set(memberIds);
      }
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

  return { latestLevel, published, withheld, latestUsedWeight, wouldWithholdLatest };
}

function flag(args, name) {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
