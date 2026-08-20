#!/usr/bin/env node
/**
 * CF-SERIES-HEALTH (Drew, 2026-08-20: "focus on the smaller ones ... let's fix
 * what we can").
 *
 * Ranks the series that can actually show a TREND by how likely they are to
 * show a WRONG one.
 *
 * WHY SCOPE TO TRENDABLE SERIES. Measured over 6,950,635 baseball comps:
 *
 *   by SERIES  14.9% are trendable — the median series holds ONE sale
 *   by SALES   73.0% of sales sit in a trendable series
 *
 * So repairing "the container" spends most of its effort on a tail that carries
 * under a tenth of the volume. The 183,417 trendable series are where a user
 * actually sees a number, and they are a far smaller and more tractable target.
 *
 * DISPERSION IS THE PROXY. One card in one grade should trade in a band. When a
 * single (card, grade) series spans two orders of magnitude, something in it does
 * not belong — and every defect found in the last two days shows up exactly this
 * way:
 *
 *   a Black Label pooled with ordinary BGS 10s        $510 median vs $160
 *   a "Non Auto" card inside an AUTO pool             $22.49 floor under a $769 top
 *   a /10 and a /499 sharing an unnumbered pool       $645 beside $3.25
 *   a football card in a baseball set
 *
 * IT IS A RANKING, NOT A VERDICT. Wide dispersion is also normal for raw
 * ungraded cards, where condition varies genuinely. So this reports candidates
 * with sample titles at each extreme and lets a human see the cause, rather than
 * asserting contamination. Nothing is repaired from a dispersion number alone.
 *
 * THE UNIT IS (card, grade). A PSA 10 and a raw copy are different price series
 * — averaging them is the mistake that made a Black Label look like an ordinary
 * ten. Identity comes from cardIdentityKey so the catalog's grade explode does
 * not fracture one card into twelve, and grade from gradeOf so it is read from
 * FIELDS rather than sniffed out of a slug.
 *
 * READ-ONLY.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-series-health.cjs \
 *     [--sport=baseball] [--minComps=5] [--minMonths=3] [--spread=10] [--top=25]
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
const MIN_COMPS = Number(arg("minComps", "5"));
const MIN_MONTHS = Number(arg("minMonths", "3"));
/** p90/p10 ratio above which a single (card, grade) series is suspicious. */
const SPREAD = Number(arg("spread", "10"));
const TOP = Number(arg("top", "25"));
const REFRESH_PAGES = Number(arg("refreshPages", "400"));
const LEG_MAX_MS = Number(arg("legMaxMinutes", "20")) * 60_000;

const newClient = () => new CosmosClient(process.env.COSMOS_CONNECTION_STRING);

async function scanAll(container, sql, onRow, label) {
  let token, rows = 0, throttles = 0, drained = false;
  while (!drained) {
    const c = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container(container);
    const iter = c.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let legPages = 0, progressed = false;
    const legStart = Date.now();
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
      if (legPages >= REFRESH_PAGES || Date.now() - legStart > LEG_MAX_MS) break;
    }
    if (!drained && !progressed && !token) break;
  }
  process.stderr.write("\n");
  return rows;
}

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) { console.error("FATAL: connection string missing/truncated"); process.exit(1); }
  console.log(`[series-health] sport=${SPORT} minComps=${MIN_COMPS} minMonths=${MIN_MONTHS} spread=${SPREAD}x\n`);

  const series = new Map();   // key -> { prices, months:Set, lo, hi }
  await scanAll("sold_comps", {
    query: `SELECT c.hobbyiqCardId, c.gradeCompany, c.gradeValue, c.gradeTier,
                   c.price, c.soldAt, c.title, c.playerName
             FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p) AND c.price > 0`,
    parameters: [{ name: "@p", value: `hiq:${SPORT}:` }],
  }, (r) => {
    const id = cardIdentityKey({ hobbyiqCardId: r.hobbyiqCardId });
    if (!id) return;
    const { tier } = gradeOf(r);
    const k = `${id}|${tier}`;
    let e = series.get(k);
    if (!e) series.set(k, (e = { prices: [], months: new Set(), lo: null, hi: null, player: r.playerName }));
    const p = Number(r.price) || 0;
    if (p <= 0) return;
    e.prices.push(p);
    const d = String(r.soldAt ?? "");
    if (d.length >= 7) e.months.add(d.slice(0, 7));
    // Keep only the extremes' titles — holding every title would not fit.
    if (!e.lo || p < e.lo.p) e.lo = { p, t: r.title };
    if (!e.hi || p > e.hi.p) e.hi = { p, t: r.title };
  }, "comps");

  const trendable = [];
  for (const [k, e] of series) {
    if (e.prices.length < MIN_COMPS || e.months.size < MIN_MONTHS) continue;
    const s = e.prices.slice().sort((a, b) => a - b);
    const p10 = pct(s, 0.10) || s[0];
    const p90 = pct(s, 0.90);
    const spread = p10 > 0 ? p90 / p10 : Infinity;
    trendable.push({ k, e, n: s.length, med: pct(s, 0.5), p10, p90, spread });
  }
  const suspect = trendable.filter((t) => t.spread >= SPREAD);
  suspect.sort((a, b) => b.spread - a.spread || b.n - a.n);

  const pc = (n) => `${((n / Math.max(trendable.length, 1)) * 100).toFixed(1)}%`;
  console.log(`TRENDABLE series (>= ${MIN_COMPS} comps, >= ${MIN_MONTHS} months) : ${trendable.length.toLocaleString()}`);
  console.log(`  p90/p10 spread >= ${SPREAD}x  -> SUSPECT              : ${suspect.length.toLocaleString()}  ${pc(suspect.length)}`);
  console.log(`  tight enough to trust                         : ${(trendable.length - suspect.length).toLocaleString()}  ${pc(trendable.length - suspect.length)}\n`);

  console.log("spread distribution across trendable series:");
  for (const [lo, hi] of [[1, 2], [2, 3], [3, 5], [5, 10], [10, 25], [25, 100], [100, Infinity]]) {
    const n = trendable.filter((t) => t.spread >= lo && t.spread < hi).length;
    const bar = "#".repeat(Math.round((n / Math.max(trendable.length, 1)) * 40));
    console.log(`   ${String(lo).padStart(3)}-${hi === Infinity ? "inf" : String(hi).padEnd(3)}x ${String(n).padStart(7)}  ${bar}`);
  }

  console.log(`\nWORST OFFENDERS — a user looking at these sees a wrong number:`);
  for (const t of suspect.slice(0, TOP)) {
    console.log(`\n   ${t.spread.toFixed(0)}x spread  n=${t.n}  median $${t.med}   ${t.k}`);
    console.log(`      LOW  $${String(t.lo?.p ?? "?").padEnd(9)} ${String(t.e.lo?.t ?? "").slice(0, 72)}`);
    console.log(`      HIGH $${String(t.hi?.p ?? "?").padEnd(9)} ${String(t.e.hi?.t ?? "").slice(0, 72)}`);
  }
  console.log("\nREAD-ONLY. Dispersion RANKS a candidate; it never proves contamination.");
  console.log("Raw ungraded series are legitimately wide — read the titles before repairing.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
