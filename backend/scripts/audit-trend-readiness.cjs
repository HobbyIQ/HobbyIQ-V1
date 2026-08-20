#!/usr/bin/env node
/**
 * CF-TREND-READINESS (Drew, 2026-08-20: "Every card in the catalog with all
 * possible grades. All sold comps matching to the correct card and grade to be
 * able to see trends").
 *
 * Measures whether the comp pool can actually SUPPORT a trend, per (card,
 * grade) — the unit the product is built on.
 *
 * WHY THIS BEFORE ANY MORE REPAIR. Everything today fixed the CORRECTNESS of
 * matches: Black Label conflated with Pristine 10, grade fractions read as
 * serials, "Non Auto" read as signed, pools split across setKeys. All real, all
 * worth fixing. But a trend needs ENOUGH SALES ON ONE CARD IN ONE GRADE OVER
 * TIME, and that has never been measured.
 *
 * The answer decides where the next week goes, and the two possibilities point
 * in opposite directions:
 *
 *   series are THIN   -> perfect matching still yields no trend. Coverage and
 *                        acquisition are the only levers that matter.
 *   series are FAT but SCATTERED -> the sales exist and are landing on the wrong
 *                        keys. Matching is the lever.
 *
 * Choosing between those on intuition is exactly what produced today's
 * reversals, so it gets measured instead.
 *
 * THE UNIT IS (card, grade), NOT card. A PSA 10 and a raw copy of the same card
 * are different price series — averaging them is the mistake that made a Black
 * Label look like an ordinary BGS 10. Grade comes from FIELDS via gradeOf();
 * identity from cardIdentityKey(), so the grade explode does not fracture a card
 * into twelve phantom ones.
 *
 * SPAN MATTERS AS MUCH AS COUNT. Ten sales in one week is not a trend, it is an
 * event. So each series reports distinct months touched alongside its count.
 *
 * READ-ONLY.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-trend-readiness.cjs \
 *     [--sport=baseball] [--family=] [--minComps=5] [--minMonths=3] [--top=15]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { cardIdentityKey, gradeOf } = require(path.join(backend, "dist/services/portfolioiq/cardIdentityKey.service.js"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SPORT = arg("sport", "baseball");
const FAMILY = arg("family", "");
const MIN_COMPS = Number(arg("minComps", "5"));
const MIN_MONTHS = Number(arg("minMonths", "3"));
const TOP = Number(arg("top", "15"));
const REFRESH_PAGES = Number(arg("refreshPages", "400"));

const newClient = () => new CosmosClient(process.env.COSMOS_CONNECTION_STRING);

async function scanAll(container, sql, onRow, label) {
  let token, rows = 0, throttles = 0, drained = false;
  while (!drained) {
    const c = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container(container);
    const iter = c.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let legPages = 0, progressed = false;
    while (iter.hasMoreResults()) {
      let page;
      try { page = await iter.fetchNext(); }
      catch (e) {
        if (e?.code !== 429 && e?.code !== 503) throw e;
        throttles++;
        const w = Math.min(60_000, (e.retryAfterInMs ?? 1000) + 1000 * Math.min(throttles, 20));
        process.stderr.write(`\r  ${label} throttled (${throttles}) ${Math.round(w / 1000)}s   `);
        await new Promise((r) => setTimeout(r, w));
        break;
      }
      token = page.continuationToken;
      progressed = true;
      for (const r of page.resources || []) { rows++; onRow(r); }
      legPages++;
      if (rows % 500000 < 2000) process.stderr.write(`\r  ${label} scanned=${rows}   `);
      if (!iter.hasMoreResults()) { drained = true; break; }
      if (legPages >= REFRESH_PAGES) break;
    }
    if (!drained && !progressed && !token) break;
  }
  process.stderr.write("\n");
  return rows;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) { console.error("FATAL: connection string missing/truncated"); process.exit(1); }
  console.log(`[trend-readiness] sport=${SPORT} family=${FAMILY || "(all)"} minComps=${MIN_COMPS} minMonths=${MIN_MONTHS}\n`);

  // series key -> { n, months:Set }
  const series = new Map();
  const cardsSeen = new Set();
  let comps = 0, noSlug = 0, undated = 0;

  const where = [`STARTSWITH(c.hobbyiqCardId, "hiq:${SPORT}:")`];
  if (FAMILY) where.push(`CONTAINS(c.hobbyiqCardId, ":${FAMILY}")`);

  await scanAll("sold_comps", {
    query: `SELECT c.hobbyiqCardId, c.gradeCompany, c.gradeValue, c.gradeTier, c.soldAt
             FROM c WHERE ${where.join(" AND ")}`,
    parameters: [],
  }, (r) => {
    comps++;
    const id = cardIdentityKey({ hobbyiqCardId: r.hobbyiqCardId });
    if (!id) { noSlug++; return; }
    cardsSeen.add(id);
    const { tier } = gradeOf(r);
    const k = `${id}|${tier}`;
    let e = series.get(k);
    if (!e) series.set(k, (e = { n: 0, months: new Set() }));
    e.n++;
    // Month, not day — a trend is a shape over months.
    const d = String(r.soldAt ?? "");
    if (d.length >= 7) e.months.add(d.slice(0, 7)); else undated++;
  }, "comps");

  const all = [...series.values()];
  const tradable = all.filter((s) => s.n >= MIN_COMPS);
  const trendable = all.filter((s) => s.n >= MIN_COMPS && s.months.size >= MIN_MONTHS);
  const counts = all.map((s) => s.n).sort((a, b) => a - b);
  const med = counts[Math.floor(counts.length / 2)] ?? 0;
  const p90 = counts[Math.floor(counts.length * 0.9)] ?? 0;
  const pc = (n) => `${((n / Math.max(all.length, 1)) * 100).toFixed(1)}%`;

  console.log(`comps scanned            : ${comps.toLocaleString()}`);
  console.log(`  unusable (no slug)     : ${noSlug.toLocaleString()}`);
  console.log(`  undated                : ${undated.toLocaleString()}`);
  console.log(`distinct CARDS           : ${cardsSeen.size.toLocaleString()}`);
  console.log(`distinct (card, grade) SERIES : ${all.length.toLocaleString()}\n`);

  console.log(`median comps per series  : ${med}`);
  console.log(`p90 comps per series     : ${p90}\n`);

  console.log(`series with >= ${MIN_COMPS} comps            : ${tradable.length.toLocaleString()}  ${pc(tradable.length)}`);
  console.log(`series ALSO spanning >= ${MIN_MONTHS} months : ${trendable.length.toLocaleString()}  ${pc(trendable.length)}   <- can show a TREND\n`);

  // Distribution — where does the mass sit?
  const buckets = [[1, 1], [2, 2], [3, 4], [5, 9], [10, 24], [25, 99], [100, Infinity]];
  console.log("comps-per-series distribution:");
  for (const [lo, hi] of buckets) {
    const n = all.filter((s) => s.n >= lo && s.n <= hi).length;
    const bar = "#".repeat(Math.round((n / Math.max(all.length, 1)) * 40));
    console.log(`   ${String(lo).padStart(3)}${hi === Infinity ? "+ " : `-${String(hi).padEnd(3)}`} ${String(n).padStart(8)}  ${pc(n).padStart(6)}  ${bar}`);
  }

  console.log("\nmonths-spanned distribution (series with >= minComps):");
  for (const [lo, hi] of [[1, 1], [2, 2], [3, 5], [6, 11], [12, Infinity]]) {
    const n = tradable.filter((s) => s.months.size >= lo && s.months.size <= hi).length;
    const bar = "#".repeat(Math.round((n / Math.max(tradable.length, 1)) * 40));
    console.log(`   ${String(lo).padStart(2)}${hi === Infinity ? "+ " : `-${String(hi).padEnd(2)}`} mo ${String(n).padStart(8)}  ${bar}`);
  }

  console.log("\nVERDICT");
  const share = trendable.length / Math.max(all.length, 1);
  if (share < 0.10) {
    console.log("  Series are THIN. Most (card, grade) pairs cannot support a trend no");
    console.log("  matter how perfectly they are matched — COVERAGE is the lever, not matching.");
  } else if (share < 0.30) {
    console.log("  Mixed. A minority of series are trendable; both coverage and matching");
    console.log("  move the number, so scope any repair to series that are already close.");
  } else {
    console.log("  Series are FAT. The sales exist — MATCHING quality is the lever.");
  }
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
