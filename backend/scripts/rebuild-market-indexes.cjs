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
      process.exit(1);
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

  console.log(JSON.stringify({
    event: "market_index_rebuild_done",
    mode: apply ? "APPLY" : "REPORT-ONLY",
    sports: sports.length,
    note: apply
      ? "series recomputed under the unified method"
      : "no writes performed - re-run with --apply to persist",
  }));
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
