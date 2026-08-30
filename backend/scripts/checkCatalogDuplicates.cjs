/**
 * checkCatalogDuplicates.cjs -- the `catalog_duplicates` canary axis (D30).
 *
 * Drew, 2026-08-30: "This will be a big big big issue for us if sales are split
 * across different cards in the card catalog of the same card." D30's fleet
 * consolidates the backlog; this watches so a split pool cannot come BACK
 * silently after it.
 *
 * WHAT IT MEASURES, and why the second number is the one that matters:
 *
 *   multi-row groups   two catalog rows on one identity key. Large and mostly
 *                      harmless on its own -- an empty duplicate row splits no
 *                      pool, which is why the purge removed 81,749 rows while
 *                      sales-split groups barely moved (9,572 -> 7,636).
 *   SALES-SPLIT groups the same identity with sales on MORE THAN ONE row. This
 *                      is the defect: one card, two pools, and an FMV computed
 *                      from half its own comps. The alert is keyed on THIS.
 *
 * It reuses the fleet's own decision (`decideDuplicateGroup`) rather than a
 * second copy of the rules -- a canary that re-implements the invariant stops
 * measuring it the first time the invariant moves (the same reason
 * checkSoldCompsCleanliness requires D28's real `judgeCardNumber`). A group the
 * fleet would call AMBIGUOUS is expected to stay split, so it is reported and
 * NOT alerted on: those are Drew's to rule, not a regression.
 *
 * Requires backend/dist (the workflow builds it).
 *
 * Env:
 *   COSMOS_CONNECTION_STRING       required
 *   SPORTS / YEARS                 optional scope (default: a sampled slice)
 *   SAMPLE_ROWS                    max catalog rows to scan (default 400000)
 *   MAX_SALES_SPLIT_GROUPS         alert above this many (default 250)
 *   MAX_NEW_SPLIT_PCT              alert if split groups exceed this share of
 *                                  multi-row groups (default 5.0)
 */
"use strict";
const path = require("path");
const { CosmosClient } = require("@azure/cosmos");

const backend = path.resolve(__dirname, "..");
const { identityKeyOf, printRunOf } = require(path.join(backend, "dist", "services", "catalog", "foldTwinRuleChecklistNumbered.js"));
const { decideDuplicateGroup } = require(path.join(backend, "dist", "services", "catalog", "duplicateWinnerRule.js"));

const SPORTS = String(process.env.SPORTS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const YEARS = String(process.env.YEARS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
const SAMPLE_ROWS = Number(process.env.SAMPLE_ROWS || 400000);
const MAX_SALES_SPLIT_GROUPS = Number(process.env.MAX_SALES_SPLIT_GROUPS || 250);
const MAX_NEW_SPLIT_PCT = Number(process.env.MAX_NEW_SPLIT_PCT || 5.0);

const f = (n) => Number(n).toLocaleString();
const retry = async (fn, tries = 6) => { let wait = 500; for (let a = 0; ; a++) { try { return await fn(); } catch (e) { const m = String(e?.message ?? e); if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(m) || a >= tries) throw e; await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000); } } };

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("::error::[catalog-duplicates-canary] COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 20, maxWaitTimeInSeconds: 90 } } }).database("hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const where = ['STARTSWITH(c.id, "hiq:")', "NOT IS_DEFINED(c.gradeTier)"];
  const params = [];
  if (SPORTS.length) { where.push("ARRAY_CONTAINS(@sports, c.sport)"); params.push({ name: "@sports", value: SPORTS }); }
  if (YEARS.length) { where.push("ARRAY_CONTAINS(@years, c.year)"); params.push({ name: "@years", value: YEARS }); }

  console.log(`[catalog-duplicates-canary] scope sports=${SPORTS.join(",") || "(all)"} years=${YEARS.join(",") || "(all)"} sample<=${f(SAMPLE_ROWS)}`);

  const groups = new Map();
  let rows = 0;
  const it = cat.items.query({ query: `SELECT c.id, c.source, c.sport, c.year, c.setKey, c.cardNumber, c.parallelSlug, c.isAuto, c.printRun, c.playerName FROM c WHERE ${where.join(" AND ")}`, parameters: params }, { maxItemCount: 1000 });
  while (it.hasMoreResults() && rows < SAMPLE_ROWS) {
    const { resources } = await retry(() => it.fetchNext());
    for (const r of resources ?? []) {
      rows++;
      const key = identityKeyOf(r);
      const list = groups.get(key) ?? [];
      list.push(r);
      groups.set(key, list);
    }
  }

  const multi = [...groups.entries()].filter(([, rs]) => rs.length > 1);
  console.log(`  scanned ${f(rows)} rows -> ${f(groups.size)} identities, ${f(multi.length)} multi-row groups`);

  // The expensive half: only multi-row groups can have a split pool, and only
  // those the fleet would CONSOLIDATE are a defect. Ambiguous groups are Drew's.
  let salesSplit = 0, salesInSplit = 0, ambiguousSplit = 0;
  const samples = [];
  const byKind = new Map();

  for (const [key, rs] of multi) {
    const decision = decideDuplicateGroup({ rows: rs });
    if (decision.kind === "not-a-group") continue;

    const counts = [];
    for (const r of rs) {
      const q = await retry(() => pool.items.query({
        query: "SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s OR STARTSWITH(c.hobbyiqCardId, @p)",
        parameters: [{ name: "@s", value: r.id }, { name: "@p", value: `${r.id}:` }],
      }).fetchAll());
      counts.push({ id: r.id, source: r.source, n: Number(q.resources?.[0] ?? 0), printRun: printRunOf(r) });
    }
    const withSales = counts.filter((c) => c.n > 0);
    if (withSales.length < 2) continue;

    if (decision.kind === "ambiguous") {
      // Expected to stay split until Drew rules. Reported, never alerted on.
      ambiguousSplit++;
      byKind.set(`ambiguous:${decision.why}`, (byKind.get(`ambiguous:${decision.why}`) ?? 0) + 1);
      continue;
    }

    salesSplit++;
    salesInSplit += withSales.reduce((a, c) => a + c.n, 0);
    byKind.set(`consolidatable:${decision.winnerBy}`, (byKind.get(`consolidatable:${decision.winnerBy}`) ?? 0) + 1);
    if (samples.length < 5) samples.push({ key, rows: withSales });
  }

  const splitPct = multi.length ? (100 * salesSplit) / multi.length : 0;

  console.log(`\n  SALES-SPLIT groups the fleet WOULD consolidate  ${f(salesSplit)}  (${splitPct.toFixed(2)}% of multi-row)`);
  console.log(`  sales sitting in those split groups             ${f(salesInSplit)}`);
  console.log(`  split groups that are AMBIGUOUS (Drew's)        ${f(ambiguousSplit)}   <- expected; not a regression`);
  if (byKind.size) {
    console.log(`\n  by reason:`);
    for (const [k, v] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(52)} ${String(f(v)).padStart(8)}`);
  }
  if (samples.length) {
    console.log(`\n  samples:`);
    for (const s of samples) {
      console.log(`    ${s.key}`);
      for (const r of s.rows) console.log(`      ${r.n} sales  ${r.id}  [${r.source}]${r.printRun ? ` /${r.printRun}` : ""}`);
    }
  }

  const alerts = [];
  if (salesSplit > MAX_SALES_SPLIT_GROUPS) {
    alerts.push(`CATALOG_DUPLICATES: ${f(salesSplit)} identities have sales split across rows the fleet would consolidate (limit ${f(MAX_SALES_SPLIT_GROUPS)}). One card, two pools -- FMV is computed from half its comps.`);
  }
  if (splitPct > MAX_NEW_SPLIT_PCT) {
    alerts.push(`CATALOG_DUPLICATES: ${splitPct.toFixed(2)}% of multi-row groups are sales-split, above ${MAX_NEW_SPLIT_PCT}% -- a writer is minting rivals to rows that already exist.`);
  }

  if (alerts.length) {
    for (const a of alerts) console.error(`::error::[catalog-duplicates-canary] ${a}`);
    console.error("::error::Re-run consolidate-catalog-duplicates (REPORT ONLY first) and check what is minting the rival rows.");
    process.exit(1);
  }
  console.log(`\n[catalog-duplicates-canary] OK -- ${f(salesSplit)} consolidatable split groups, within limits.`);
}

main().catch((e) => {
  console.error("::error::[catalog-duplicates-canary] FAILED:", e?.stack || e?.message || e);
  process.exit(1);
});
