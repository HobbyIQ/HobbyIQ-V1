#!/usr/bin/env node
// CF-BACKFILL-GRADE-FROM-CH-DAILY (Drew, 2026-07-30). Vendor data is
// authoritative for grade — sellers on eBay populate the item-specifics
// grader/grade fields, CH's ingest captures them structurally into
// ch_daily_sales. Title text is a fallback: it can be ambiguous ("PSA
// graded" without a number) or missing.
//
// This backfill patches sold_comps rows where gradeCompany/gradeValue
// are null by joining to ch_daily_sales on:
//   1. cardId (same partition on ch_daily_sales via card_id)
//   2. sale-day match (soldAt YYYY-MM-DD == sale_date YYYY-MM-DD)
//   3. price match (priceCents ± $1 rounding tolerance)
//
// When a unique CH row matches with a non-Raw grader + parseable grade,
// we patch the sold_comps doc with the vendor-canonical values.
//
// Only-improve guardrail: never overwrite an existing gradeCompany/
// gradeValue; only fill nulls. Never demote a graded row to null.
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   BACKFILL_APPLY=true          — actually write (default dry-run)
//   BACKFILL_CONCURRENCY=8       — parallel patches (kept low because
//                                   composite backfill is competing)
//   BACKFILL_LIMIT=100000        — max null-grade rows scanned per pass
//   BACKFILL_SOURCE=cardhedge    — filter by source ("cardhedge" default;
//                                   pass "any" for cross-source join)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const APPLY = process.env.BACKFILL_APPLY === "true";
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || "8");
const LIMIT = Number(process.env.BACKFILL_LIMIT || "100000");
const SOURCE_FILTER = process.env.BACKFILL_SOURCE || "cardhedge";

async function fetchWithRetry(iterator, maxRetries = 6) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await iterator.fetchNext(); }
    catch (err) {
      const msg = String(err?.message || "");
      const code = err?.code ?? err?.statusCode;
      if ((code === 429 || msg.includes("request rate is too large")) && attempt < maxRetries) {
        const wait = 2000 * (attempt + 1);
        process.stdout.write(`\r  [429 backoff ${wait}ms attempt ${attempt+1}]  `);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0, ok = 0, err = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { await worker(items[idx]); ok++; }
      catch { err++; }
    }
  });
  await Promise.all(workers);
  return { ok, err };
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database("hobbyiq");
  const sc = db.container("sold_comps");
  const ch = db.container("ch_daily_sales");

  console.log(`[backfill-grade-from-ch-daily]`);
  console.log(`  apply: ${APPLY}`);
  console.log(`  concurrency: ${CONCURRENCY}`);
  console.log(`  limit: ${LIMIT}`);
  console.log(`  source filter: ${SOURCE_FILTER}\n`);

  // Query null-grade sold_comps rows where we might find a CH-daily match.
  // Filter to source="cardhedge" (default) since those rows have cardId ==
  // ch chCardId, which is our join key. Pass BACKFILL_SOURCE=any to include
  // eBay + cardsight sources (join by (title, day, price) heuristic).
  const sourceClause = SOURCE_FILTER === "any"
    ? ""
    : "AND c.source = @source ";
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.title, c.price, c.soldAt,
      c.gradeCompany, c.gradeValue, c.source
    FROM c
    WHERE (NOT IS_DEFINED(c.gradeCompany) OR c.gradeCompany = null)
      AND (NOT IS_DEFINED(c.gradeValue) OR c.gradeValue = null)
      AND IS_STRING(c.cardId)
      ${sourceClause}
      AND c.price > 0
  `;
  const params = [{ name: "@n", value: LIMIT }];
  if (SOURCE_FILTER !== "any") params.push({ name: "@source", value: SOURCE_FILTER });

  const it = sc.items.query({ query, parameters: params }, { maxItemCount: 2000 });
  const rows = [];
  while (it.hasMoreResults()) {
    const page = await fetchWithRetry(it);
    if (page && Array.isArray(page.resources)) rows.push(...page.resources);
    process.stdout.write(`\r  scanning ${rows.length}`);
    if (rows.length >= LIMIT) break;
  }
  console.log(`\r  ${rows.length} null-grade rows scanned.        \n`);

  const patches = [];
  const graderDist = {};
  const gradeDist = {};
  let noChMatch = 0, ambiguousMatch = 0, chRaw = 0, chUnparsed = 0;

  // Look up CH-daily rows per unique cardId (partition query) → cache and
  // reuse for all sold_comps rows sharing that cardId. Bounds RUs.
  const cardIdCache = new Map();
  async function getCHSalesForCard(cardId) {
    if (cardIdCache.has(cardId)) return cardIdCache.get(cardId);
    const chIt = ch.items.query(
      {
        query: `SELECT c.price_history_id, c.sale_date, c.price, c.grade, c.grader FROM c WHERE c.card_id = @cid`,
        parameters: [{ name: "@cid", value: cardId }],
      },
      { partitionKey: cardId, maxItemCount: 500 },
    );
    const results = [];
    while (chIt.hasMoreResults()) {
      const p = await fetchWithRetry(chIt);
      if (p && Array.isArray(p.resources)) results.push(...p.resources);
    }
    cardIdCache.set(cardId, results);
    return results;
  }

  console.log(`  Cross-referencing ch_daily_sales (RU budget: retry-backed)...\n`);
  let processed = 0;
  for (const r of rows) {
    processed++;
    if (processed % 250 === 0) process.stdout.write(`\r  processed ${processed}/${rows.length}`);

    let chSales;
    try { chSales = await getCHSalesForCard(r.cardId); }
    catch { noChMatch++; continue; }
    if (!chSales || chSales.length === 0) { noChMatch++; continue; }

    // Match on (soldAt day, price ± $1). soldAt is ISO string.
    const soldDay = String(r.soldAt || "").slice(0, 10);
    const priceCents = Math.round(Number(r.price) * 100);
    if (!soldDay || !priceCents) { noChMatch++; continue; }

    const candidates = chSales.filter(ch => {
      const chDay = String(ch.sale_date || "").slice(0, 10);
      if (chDay !== soldDay) return false;
      const chPriceCents = Math.round(Number(ch.price) * 100);
      return Math.abs(chPriceCents - priceCents) <= 100; // ±$1
    });

    if (candidates.length === 0) { noChMatch++; continue; }
    if (candidates.length > 1) {
      // Ambiguous — multiple CH rows same day+price. If they all agree on
      // grader/grade, use it; otherwise skip.
      const graderSet = new Set(candidates.map(x => `${x.grader}::${x.grade}`));
      if (graderSet.size > 1) { ambiguousMatch++; continue; }
    }
    const chMatch = candidates[0];

    const grader = String(chMatch.grader || "").trim().toUpperCase();
    const gradeStr = String(chMatch.grade || "").trim();
    if (!grader || grader === "RAW" || grader === "UNGRADED") { chRaw++; continue; }
    const gradeValue = parseFloat(gradeStr);
    if (!Number.isFinite(gradeValue) || gradeValue <= 0) { chUnparsed++; continue; }

    graderDist[grader] = (graderDist[grader] ?? 0) + 1;
    gradeDist[`${grader}_${gradeValue}`] = (gradeDist[`${grader}_${gradeValue}`] ?? 0) + 1;

    patches.push({
      id: r.id,
      partitionKey: r.cardId,
      gradeCompany: grader,
      gradeValue,
      title: String(r.title || "").slice(0, 80),
    });
  }
  console.log(`\r  processed ${processed}/${rows.length}                              \n`);

  console.log(`════════════════ MATCH DISTRIBUTION ════════════════`);
  console.log(`  no CH-daily row for cardId:              ${noChMatch.toLocaleString()}`);
  console.log(`  ambiguous CH match (different graders):  ${ambiguousMatch.toLocaleString()}`);
  console.log(`  CH row was Raw / ungraded:               ${chRaw.toLocaleString()}`);
  console.log(`  CH row grade unparseable:                ${chUnparsed.toLocaleString()}`);
  console.log(`  ready to patch:                          ${patches.length.toLocaleString()}`);

  console.log(`\n════════════════ GRADER DISTRIBUTION (patches) ════════════════`);
  Object.entries(graderDist).sort((a,b) => b[1] - a[1]).forEach(([g, cnt]) => {
    console.log(`  ${String(cnt).padStart(7)}  ${g}`);
  });

  console.log(`\n════════════════ TOP GRADE DISTRIBUTION (patches) ════════════════`);
  Object.entries(gradeDist).sort((a,b) => b[1] - a[1]).slice(0, 15).forEach(([g, cnt]) => {
    console.log(`  ${String(cnt).padStart(7)}  ${g}`);
  });

  if (patches.length > 0) {
    console.log(`\n  Sample 5 patches:`);
    patches.slice(0, 5).forEach(p => {
      console.log(`    ${p.gradeCompany} ${p.gradeValue}  ${p.title}`);
    });
  }

  if (!APPLY || patches.length === 0) {
    console.log(`\n  Dry-run / no work. Re-dispatch with BACKFILL_APPLY=true to apply.`);
    return;
  }

  console.log(`\n  Applying ${patches.length} patches (concurrency ${CONCURRENCY})...`);
  const t0 = Date.now();
  let done = 0;
  const { ok, err } = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([
      { op: "set", path: "/gradeCompany", value: p.gradeCompany },
      { op: "set", path: "/gradeValue", value: p.gradeValue },
    ]);
    if (++done % 500 === 0) process.stdout.write(`\r    ${done}/${patches.length} patched`);
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\r    ${done}/${patches.length} patched (${secs}s)  ok=${ok} err=${err}`);

  console.log(`\n════════════════ SUMMARY ════════════════`);
  console.log(`  patched:  ${ok}`);
  console.log(`  errors:   ${err}`);
}

main().catch(e => { console.error(e); process.exit(1); });
