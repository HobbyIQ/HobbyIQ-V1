#!/usr/bin/env node
/**
 * CF-IDENTITY-SPLIT-AUDIT (Drew, 2026-08-18: "they all need to go to the
 * correct card ... we have to get the data clean").
 *
 * Finds ONE physical card whose sales are spread over SEVERAL comp pools.
 * That is the defect behind both pricing bugs reported today, and it is
 * invisible to a per-row check because every individual row looks fine:
 *
 *   1987 Topps Traded Tiffany Maddux PSA 10 showed $245 (worth ~$1,600)
 *     -> Tiffany sales sat on the bare `topps` key with base Traded sales,
 *        so the pool's PSA 10 median was $105 with a few $1,000 outliers.
 *
 *   2024 Bowman Draft Blue Refractor Caminiti auto showed $5.52 (worth ~$200)
 *     -> its four real Blue Refractor sales ($76/$160/$205/$215) were split
 *        across bowman-chrome vs bowman-draft AND across :num-150 vs no
 *        print-run segment, leaving the queried pool empty.
 *
 * TWO SPLIT AXES, because those are the two the slug encodes redundantly:
 *
 *   setKey   — same (sport, year, cardNumber, parallel, auto, printRun) filed
 *              under two or more products. One of them is wrong.
 *   printRun — the SAME card with and without the trailing :num-N segment. A
 *              card does not change identity because a seller omitted "/150",
 *              yet the two forms never share a pool.
 *
 * RANKED BY HARM, NOT BY COUNT. A split only matters if the pools disagree on
 * price: two pools with the same median are a tidiness problem, while a $105
 * pool beside a $1,000 pool is a user seeing the wrong number. Harm is the
 * ratio between the richest and poorest pool of the same card, so the report
 * surfaces the cards whose owners are being misinformed the most.
 *
 * READ-ONLY. This never writes. It names the repair for each finding so the
 * fix is a reviewed reslug, not a side effect of the audit.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-identity-splits.cjs \
 *     [--limit=N] [--minRows=3] [--minRatio=2] [--top=40] [--year=2024]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const LIMIT = Number(arg("limit", "0")) || Infinity;
const MIN_ROWS = Number(arg("minRows", "3"));
const MIN_RATIO = Number(arg("minRatio", "2"));
const TOP = Number(arg("top", "40"));
const YEAR = arg("year", "");

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const where = ["IS_DEFINED(c.hobbyiqCardId)", "NOT IS_NULL(c.hobbyiqCardId)", "IS_DEFINED(c.price)"];
  if (YEAR) where.push(`c.cardYear = ${Number(YEAR)}`);
  const iter = sold.items.query(
    `SELECT c.hobbyiqCardId, c.price, c.gradeCompany, c.gradeValue FROM c WHERE ${where.join(" AND ")}`,
    { maxItemCount: 2000 },
  );

  /** slug -> prices[]  (raw only: mixing grades would fake a price gap that is
   *  really just PSA 10 vs ungraded, and this audit is about IDENTITY). */
  const pools = new Map();
  let scanned = 0;

  while (iter.hasMoreResults() && scanned < LIMIT) {
    const { resources } = await iter.fetchNext();
    for (const r of resources || []) {
      if (scanned >= LIMIT) break;
      scanned++;
      if (r.gradeCompany) continue;               // raw only — see note above
      const p = Number(r.price);
      if (!Number.isFinite(p) || p <= 0) continue;
      const arr = pools.get(r.hobbyiqCardId);
      if (arr) arr.push(p); else pools.set(r.hobbyiqCardId, [p]);
    }
    if (scanned % 200000 < 2000) process.stderr.write(`\r  scanned=${scanned} pools=${pools.size}   `);
  }
  process.stderr.write("\n");

  // hiq:sport:year:setKey:cardNumber:parallel:auto[:printRun]
  const bySetKey = new Map();   // identity WITHOUT setKey  -> [{setKey, slug, prices}]
  const byPrintRun = new Map(); // identity WITHOUT printRun -> [{run, slug, prices}]

  for (const [slug, prices] of pools) {
    if (prices.length < MIN_ROWS) continue;
    const p = slug.split(":");
    if (p.length < 7) continue;
    const [, sport, year, setKey, num, par, auto] = p;
    const run = p[7] || "(none)";
    const kA = [sport, year, num, par, auto, run].join("|");
    const kB = [sport, year, setKey, num, par, auto].join("|");
    (bySetKey.get(kA) || bySetKey.set(kA, []).get(kA)).push({ variant: setKey, slug, prices });
    (byPrintRun.get(kB) || byPrintRun.set(kB, []).get(kB)).push({ variant: run, slug, prices });
  }

  /**
   * NUMBERED vs NUMBERED IS NOT A SPLIT.
   *
   * The first version of this audit reported Orange /49 beside Orange /99 as
   * one card in two pools. They are two different cards: for most modern
   * parallels the serial IS the parallel, so a price gap between them is the
   * market working, not a defect. Counting them inflated the finding list with
   * rows nobody should touch.
   *
   * The real suspect on this axis is a numbered pool beside an UNNUMBERED one
   * ("(none)"), where the same sale is filed differently depending on whether
   * the seller typed "/150". Those are compared; numbered-vs-numbered is
   * dropped, and a group is only interesting if the unnumbered form is present.
   */
  const printRunSuspect = (variants) =>
    variants.some((v) => v.variant === "(none)") && variants.length >= 2;

  const report = (title, map, repair, filter) => {
    const findings = [];
    for (const [, variants] of map) {
      if (variants.length < 2) continue;
      if (filter && !filter(variants)) continue;
      const meds = variants.map((v) => ({ ...v, med: median(v.prices), n: v.prices.length }));
      const hi = Math.max(...meds.map((m) => m.med));
      const lo = Math.min(...meds.map((m) => m.med));
      if (lo <= 0 || hi / lo < MIN_RATIO) continue;
      findings.push({ ratio: hi / lo, rows: meds.reduce((s, m) => s + m.n, 0), meds });
    }
    findings.sort((a, b) => (b.ratio * Math.log10(b.rows + 1)) - (a.ratio * Math.log10(a.rows + 1)));
    console.log(`\n${"=".repeat(78)}\n${title}`);
    console.log(`${findings.length} split cards where the pools disagree by >= ${MIN_RATIO}x`);
    console.log(`REPAIR: ${repair}\n`);
    for (const f of findings.slice(0, TOP)) {
      console.log(`  ${f.ratio.toFixed(1)}x price gap across ${f.meds.length} pools, ${f.rows} raw sales:`);
      for (const m of f.meds.sort((a, b) => b.med - a.med)) {
        console.log(`     $${String(m.med).padEnd(9)} n=${String(m.n).padStart(4)}  ${m.slug}`);
      }
    }
    return findings.length;
  };

  console.log(`\nscanned=${scanned} rawPools=${pools.size} (pools with >=${MIN_ROWS} raw sales are compared)`);
  const a = report(
    "AXIS 1 — SAME CARD, DIFFERENT setKey",
    bySetKey,
    "reslug-setkey-from-setname.cjs --from=<wrong key>  (only-improve + no-demotion guard applies)",
  );
  const b = report(
    "AXIS 2 — SAME CARD, UNNUMBERED POOL beside a NUMBERED one",
    byPrintRun,
    "decide ONE canonical form for the printRun segment, then collapse the other into it",
    printRunSuspect,
  );

  /**
   * AXIS 3 — slugs that are malformed regardless of any other row. Found while
   * reading Axis 2 output: `hiq:baseball:2024:::base:no-auto` has an EMPTY
   * setKey and an EMPTY cardNumber, and `...:base:no-auto:bgs-10` carries a
   * GRADE in the print-run slot. Neither can ever match a real card, so these
   * pools are unreachable sales rather than mis-filed ones.
   */
  const malformed = { emptySegment: [], gradeAsPrintRun: [], other: [] };
  for (const [slug, prices] of pools) {
    if (prices.length < MIN_ROWS) continue;
    const p = slug.split(":");
    if (p.length < 7) { malformed.other.push([slug, prices.length]); continue; }
    if (p.slice(1, 7).some((s) => s === "")) malformed.emptySegment.push([slug, prices.length]);
    else if (p[7] && !/^num-\d+$/.test(p[7])) malformed.gradeAsPrintRun.push([slug, prices.length]);
  }
  console.log(`\n${"=".repeat(78)}\nAXIS 3 — MALFORMED SLUGS (unreachable pools, not mis-filed ones)\n`);
  for (const [label, rows] of [
    ["empty segment (setKey/cardNumber blank)", malformed.emptySegment],
    ["non-numeric print-run segment (grade leaked in?)", malformed.gradeAsPrintRun],
    ["fewer than 7 segments", malformed.other],
  ]) {
    console.log(`  ${String(rows.length).padStart(5)} pools — ${label}`);
    for (const [s, n] of rows.sort((x, y) => y[1] - x[1]).slice(0, 6)) console.log(`          n=${String(n).padStart(4)}  ${s}`);
  }

  console.log(`\n${"=".repeat(78)}\nsetKey splits: ${a}   unnumbered-vs-numbered splits: ${b}`);
  console.log(`malformed pools: ${malformed.emptySegment.length + malformed.gradeAsPrintRun.length + malformed.other.length}`);
  console.log("READ-ONLY — nothing was written.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
