#!/usr/bin/env node
// CF-SEARCH-ENRICH (Drew, 2026-07-24; searchTokens 2026-07-25).
// Backfills three fields on card_catalog to make search fast + smart:
//
//   1. searchText: lowercase concat of (player, releaseName, cardNumber,
//      parallels[].name). Kept for the fuzzy fallback path.
//   2. searchTokens: string[] of unique alpha-num tokens from searchText.
//      canonicalCardSearch uses ARRAY_CONTAINS(c.searchTokens, @t) which
//      IS index-accelerated — drops cold cross-partition scan from
//      3-10s (post-autoscale) to <1s. CONTAINS on a scalar string is not
//      index-accelerated for substring; ARRAY_CONTAINS on an indexed
//      string array IS. This is the "do it right" fix (Drew 2026-07-25).
//   3. recentSaleCount: number of sold_comps rows in the last 90 days
//      whose (cardYear, UPPER(cardNumber)) match this catalog card.
//      Used as a popularity boost in search ranking.
//
// All three computed in ONE pass. searchText/searchTokens are per-row
// (cheap). recentSaleCount requires a pre-aggregated (year|number) map
// built from a single sold_comps scan up front.
//
// Env:
//   SEARCH_ENRICH_APPLY=true — persist. Default: dry-run.
//   SEARCH_ENRICH_CONCURRENCY=12
//
// Usage:
//   node backend/scripts/comp-quality/backfill-search-fields.cjs --sport baseball

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

// CF-ARG-BOTH-FORMS (2026-08-21). This accepted only `--name value`. A
// `--minYear=2026` silently fell through to the fallback, so the scan ran
// UNSCOPED while the log said years=any..any — a wrong flag that looked like
// a working one. Accept both forms.
function arg(name, fallback) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const APPLY = process.env.SEARCH_ENRICH_APPLY === "true";
const CONCURRENCY = Number(process.env.SEARCH_ENRICH_CONCURRENCY || "12");
// CF-SEARCH-ENRICH-BOUNDED-BATCH (2026-08-20). Widening the scan took the
// nightly's workload from a few thousand cardsight rows to ~3.03M rows
// missing tokens. Draining that in one unattended pass would saturate RU on
// an account whose /search latency is ALREADY the open problem.
//
// 0 or unset = unlimited (the manual, supervised mode). The nightly sets a
// real number so it drains incrementally.
const MAX_PATCHES = Number(process.env.SEARCH_ENRICH_MAX_PATCHES || "0") || Infinity;
// CF-SEARCH-ENRICH-SKIP-SALES (2026-08-20). Building the recent-sale map
// scans ~3.02M sold_comps rows BEFORE a single catalog row is written, and it
// is rebuilt on every invocation. When the goal is tokens — which is what
// unblocks the indexed search path — that scan is pure overhead.
//
// Safe because of the CF-SEARCH-ENRICH-SPORT-ALL guard: an empty map means
// recentSaleCount is CARRIED FORWARD from the existing row, never written as
// 0. Skipping therefore leaves the field exactly as it was.
const SKIP_SALES = process.env.SEARCH_ENRICH_SKIP_SALES === "true";
// Bulk patching. Cosmos caps a bulk call at 100 operations.
const BULK = process.env.SEARCH_ENRICH_BULK !== "false";
const BULK_BATCH = 100;
// CF-SEARCH-ENRICH-STREAMING (2026-08-21). The scan used to buffer EVERY
// patch and write once at the end. Fine for a missing-only pass of a few
// thousand rows; fatal for a full re-tokenisation, where 99.94% of 35.7M rows
// change. Measured before this fix: 1.47GB resident at 1.79M buffered patches
// (~820 bytes each) => ~29GB at full scale against an 8GB heap. It would have
// died around 9-10M rows AFTER a long scan, having written nothing.
//
// Flush during the scan instead. Memory stays flat and the job remains ONE
// scan, rather than N bounded passes each re-scanning all 35.7M rows.
const FLUSH_EVERY = Number(process.env.SEARCH_ENRICH_FLUSH_EVERY || "50000");
// MISSING_ONLY mode: only pull rows that lack searchTokens. Used by the
// nightly cron so we don't re-scan 866k already-indexed rows every day.
const MISSING_ONLY = process.env.SEARCH_ENRICH_MISSING_ONLY === "true";

// CF-SEARCH-ENRICH-BOTH-SHAPES (2026-08-20). card_catalog holds TWO row
// shapes and this only ever read one of them.
//
//   cardsight rows : player, releaseName, number, parallels[].name, attributes[]
//   canonical rows : playerName, setKey, cardNumber, parallel, parallelSlug
//
// The job was scoped `WHERE c.source = 'cardsight'`, so reading only the
// first shape was self-consistent — and also why every non-cardsight row in
// the catalog still has no searchTokens, which is what forces
// catalogSearch's seven unindexed CONTAINS branches and the 20s+ scans.
//
// Read both. A row that carries neither shape produces no parts, and the
// caller REFUSES it rather than writing an empty token array — see the
// refusal guard at the patch site.
function buildSearchText(row) {
  const parts = [];
  // player
  if (row.player) parts.push(String(row.player));
  if (row.playerName && row.playerName !== row.player) parts.push(String(row.playerName));
  // product / set
  if (row.releaseName) parts.push(String(row.releaseName));
  if (row.setName && row.setName !== row.releaseName) parts.push(String(row.setName));
  if (row.setKey && row.setKey !== row.setName && row.setKey !== row.releaseName) {
    parts.push(String(row.setKey).replace(/-/g, " "));
  }
  // card number
  if (row.number) parts.push(String(row.number));
  if (row.cardNumber && row.cardNumber !== row.number) parts.push(String(row.cardNumber));
  if (row.year) parts.push(String(row.year));
  // parallels: array shape (cardsight) and scalar shape (canonical)
  if (Array.isArray(row.parallels)) {
    for (const p of row.parallels) if (p?.name) parts.push(String(p.name));
  }
  if (row.parallel && String(row.parallel).toLowerCase() !== "base") {
    parts.push(String(row.parallel));
  }
  if (row.parallelSlug && row.parallelSlug !== row.parallel) {
    parts.push(String(row.parallelSlug).replace(/-/g, " "));
  }
  if (Array.isArray(row.attributes)) {
    for (const a of row.attributes) if (a) parts.push(String(a));
  }
  return parts.join(" ").toLowerCase();
}

// Tokenize searchText into unique alphanumeric tokens for ARRAY_CONTAINS
// lookups. Mirrors canonicalCardSearch's tokenize() (kept simple + sync).
// Also includes card-number fragments (e.g. "cpa-eha" → also "cpa" + "eha")
// so users typing either half of a hyphenated card number hit the row.
function buildSearchTokens(searchText) {
  if (!searchText) return [];
  const seen = new Set();
  const out = [];
  // Split on whitespace + non-alphanum, keeping hyphenated tokens whole
  // AND their halves so both "cpa-eha" and "cpa" match.
  const rawTokens = String(searchText).toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  for (const raw of rawTokens) {
    // Emit the full token (may contain hyphen, e.g. "cpa-eha", "o-pee-chee")
    if (raw.length >= 2 && !seen.has(raw)) { seen.add(raw); out.push(raw); }
    // Also emit hyphen-split fragments so partial-cardNumber queries hit
    if (raw.includes("-")) {
      for (const frag of raw.split("-")) {
        if (frag.length >= 2 && !seen.has(frag)) { seen.add(frag); out.push(frag); }
      }
    }
  }
  return out;
}

async function runInParallel(items, worker, concurrency = CONCURRENCY) {
  let i = 0;
  let ok = 0, err = 0;
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
  // Default kept as baseball so an existing invocation behaves identically.
  // Pass --sport all to cover every sport, which is what the widened scan
  // is for.
  const sport = arg("sport", "baseball");
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const cc = client.database("hobbyiq").container("card_catalog");
  const sc = client.database("hobbyiq").container("sold_comps");

  // CF-SEARCH-ENRICH-YEAR-SCOPE (2026-08-21). A full re-tokenisation is 35.7M
  // rows (~13h at the 200,000 RU/s ceiling, which is partition-bound and will
  // not go higher). Search traffic skews hard to recent product, so scope by
  // year and run newest-first: value lands early and each year is resumable.
  //   2026 829,705 | 2025 7,135,739 | 2024 1,965,345 | 2023 1,408,357
  const minYear = Number(arg("minYear", "0")) || 0;
  const maxYear = Number(arg("maxYear", "0")) || 0;
  const yearFilter = (minYear ? " AND c.year >= @minY" : "") + (maxYear ? " AND c.year <= @maxY" : "");
  const yearParams = [
    ...(minYear ? [{ name: "@minY", value: minYear }] : []),
    ...(maxYear ? [{ name: "@maxY", value: maxYear }] : []),
  ];
  console.log(`[search-enrich] scope: sport=${sport}  years=${minYear||"any"}..${maxYear||"any"}  apply=${APPLY}  missingOnly=${MISSING_ONLY}`);

  // Pass 1: build recent-sale-count map from sold_comps (last 90 days)
  const cutoffIso = new Date(Date.now() - 90 * 86_400_000).toISOString();
  if (SKIP_SALES) {
    console.log("  SKIPPING recent-sale map (SEARCH_ENRICH_SKIP_SALES=true).");
    console.log("  recentSaleCount will be carried forward, not recomputed.");
  }
  if (!SKIP_SALES) console.log(`  building recent-sale-count map (>= ${cutoffIso})...`);
  // CF-SEARCH-ENRICH-SPORT-ALL (2026-08-20). This query kept `c.sport = @sp`
  // after the catalog scan learned about --sport all. No row has sport
  // literally "all", so the map came back EMPTY and every patch would have
  // carried recentSaleCount: 0 — clobbering the real count on 3,030,193 rows.
  // Caught by reading a dry run rather than its headline.
  const rscSportFilter = sport && sport !== "all" ? " AND c.sport = @sp" : "";
  const rscParams = [{ name: "@from", value: cutoffIso }];
  if (rscSportFilter) rscParams.push({ name: "@sp", value: sport });
  const rscQuery = `SELECT c.cardYear, c.cardNumber FROM c WHERE c.soldAt >= @from${rscSportFilter} AND IS_DEFINED(c.cardNumber) AND c.cardNumber != null AND c.cardNumber != ''`;
  const rscIt = SKIP_SALES ? null : sc.items.query({ query: rscQuery, parameters: rscParams }, { maxItemCount: 5000 });
  const recentCountByYearNumber = new Map();
  let scannedSales = 0;
  while (rscIt && rscIt.hasMoreResults()) {
    const { resources } = await rscIt.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      if (!r.cardYear || !r.cardNumber) continue;
      const key = `${r.cardYear}|${String(r.cardNumber).toUpperCase()}`;
      recentCountByYearNumber.set(key, (recentCountByYearNumber.get(key) || 0) + 1);
    }
    scannedSales += (resources || []).length;
    process.stdout.write(`\r  sales scanned=${scannedSales} distinct=${recentCountByYearNumber.size}`);
  }
  if (!SKIP_SALES) console.log(`\n  ${recentCountByYearNumber.size} distinct (year|number) keys with recent sales`);
  if (!SKIP_SALES && recentCountByYearNumber.size === 0) {
    console.warn("  WARNING: sales map is EMPTY — recentSaleCount will be CARRIED FORWARD, not recomputed.");
  }

  // Pass 2: scan card_catalog, compute searchText + searchTokens + lookup recentSaleCount
  // MISSING_ONLY mode narrows the scan to rows where searchTokens is undefined
  // — used by the nightly cron to avoid re-scanning already-indexed rows.
  console.log(`  scanning card_catalog${MISSING_ONLY ? " (missing-only)" : ""}...`);
  const missingFilter = MISSING_ONLY
    // An EMPTY array must count as missing. It is defined and not null, so
    // the original predicate skipped such rows forever — exactly the
    // well-formed-wrong-row trap that hides a row from every later sweep.
    ? " AND (NOT IS_DEFINED(c.searchTokens) OR c.searchTokens = null OR ARRAY_LENGTH(c.searchTokens) = 0)"
    : "";
  // CF-SEARCH-ENRICH-WIDEN (2026-08-20). Was:
  //     WHERE c.source = 'cardsight' AND c.sport = @sp
  //
  // Both filters were invisible from the workflow name ("Nightly
  // searchTokens backfill") and between them excluded almost the whole
  // catalog: every tree-built node, every checklist-scraped row, every
  // CH-derived row, and every sport except baseball. Cardsight was retired
  // from matching on 2026-08-16, so the job was backfilling a dead source
  // nightly and reporting success.
  //
  // Now: no source filter, and sport is opt-IN via --sport. Projection
  // carries both row shapes so buildSearchText can see canonical rows.
  const sportFilter = sport && sport !== "all" ? " AND c.sport = @sp" : "";
  const ccParams = [...(sportFilter ? [{ name: "@sp", value: sport }] : []), ...yearParams];
  const ccQuery = `SELECT c.id, c.cardId, c.player, c.playerName, c.releaseName, c.setName, c.setKey, c.number, c.cardNumber, c.year, c.parallels, c.parallel, c.parallelSlug, c.attributes, c.searchText, c.recentSaleCount FROM c WHERE STARTSWITH(c.id, 'hiq:')${sportFilter}${yearFilter}${missingFilter}`;
  const ccIt = cc.items.query({ query: ccQuery, parameters: ccParams }, { maxItemCount: 5000 });
  const patches = [];
  let scanned = 0, unchanged = 0, refused = 0, deferred = 0;
  // Writer, callable mid-scan. Totals accumulate across flushes.
  let wroteOk = 0, wroteErr = 0, throttled = 0, flushes = 0;
  const opsFor = (pp) => ({
    operationType: "Patch",
    id: pp.id,
    partitionKey: pp.partitionKey,
    resourceBody: {
      operations: [
        { op: "set", path: "/searchText", value: pp.searchText },
        { op: "set", path: "/searchTokens", value: pp.searchTokens },
        { op: "set", path: "/recentSaleCount", value: pp.recentSaleCount },
      ],
    },
  });

  // RETRY ON 429 IS NOT OPTIONAL. The set-sport repair had none and silently
  // lost 659 rows to throttling; only a second full pass recovered them.
  async function flush(batchRows) {
    if (!APPLY || batchRows.length === 0) return;
    flushes++;
    const batches = [];
    for (let i = 0; i < batchRows.length; i += BULK_BATCH) batches.push(batchRows.slice(i, i + BULK_BATCH));
    const r = await runInParallel(batches, async (batch) => {
      let pending = batch;
      for (let attempt = 0; attempt < 6 && pending.length > 0; attempt++) {
        if (attempt > 0) await new Promise((r2) => setTimeout(r2, Math.min(8000, 250 * 2 ** attempt)));
        const res = await cc.items.bulk(pending.map(opsFor));
        const retry = [];
        for (let k = 0; k < res.length; k++) {
          const code = res[k]?.statusCode ?? 0;
          if (code >= 200 && code < 300) wroteOk++;
          else if (code === 429 || code === 449 || code === 503) { throttled++; retry.push(pending[k]); }
          else wroteErr++;
        }
        pending = retry;
      }
      wroteErr += pending.length;
    });
    // r.err counts BATCHES that threw outright; convert to rows.
    wroteErr += r.err * BULK_BATCH;
  }

  while (ccIt.hasMoreResults()) {
    const { resources } = await ccIt.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      scanned++;
      const searchText = buildSearchText(r);
      const searchTokens = buildSearchTokens(searchText);
      // REFUSE rather than fall back. A row we cannot tokenise must be left
      // ALONE, not stamped with an empty array: `searchTokens: []` is
      // defined and not null, so it would satisfy the missing-only filter
      // forever after and the row could never be repaired. Skipping leaves
      // it visible to the next run.
      if (searchTokens.length === 0) { refused++; continue; }
      const key = `${r.year}|${String(r.number || "").toUpperCase()}`;
      const recentSaleCount = recentCountByYearNumber.get(key) || 0;
      // If the sales map is empty we have NO information about recency, and
      // writing 0 would assert something false on every row. Carry the
      // existing value forward instead. Independent of the fix above: this
      // also protects a run where the sales scan legitimately returns nothing.
      const haveSalesData = recentCountByYearNumber.size > 0;
      const effectiveRecentSaleCount = haveSalesData ? recentSaleCount : (r.recentSaleCount ?? 0);
      // Skip only when all three match — searchTokens compared by
      // stringified sort so array-order differences don't force rewrites.
      // CF-SEARCH-ENRICH-NARROW-SCAN (2026-08-21). The scan used to project
      // c.searchTokens for every row purely to detect "unchanged" — the large
      // array field, across 8M rows, competing for the same RU as the writes.
      // Same projection-width cost that makes the fallback SEARCH queries slow.
      //
      // Unnecessary: searchTokens is buildSearchTokens(searchText), a pure
      // deterministic function. Equal searchText implies equal tokens, so
      // comparing the string alone is sufficient AND strictly cheaper.
      if (r.searchText === searchText && (r.recentSaleCount ?? 0) === effectiveRecentSaleCount) {
        unchanged++;
        continue;
      }
      if (patches.length >= MAX_PATCHES) { deferred++; continue; }
      patches.push({
        id: r.id,
        partitionKey: r.cardId,
        searchText,
        searchTokens,
        recentSaleCount: effectiveRecentSaleCount,
      });
    }
    if (APPLY && patches.length >= FLUSH_EVERY) {
      await flush(patches);
      patches.length = 0; // release before the next page
    }
    process.stdout.write(
      `\r  scanned=${scanned} unchanged=${unchanged} refused=${refused} ` +
      `written=${wroteOk} err=${wroteErr} thr=${throttled} buf=${patches.length}`,
    );
  }
  console.log(`\nSummary:`);
  console.log(`  scanned:      ${scanned}`);
  console.log(`  unchanged:    ${unchanged}`);
  console.log(`  refused:      ${refused}   (no tokenisable fields — left untouched, NOT stamped empty)`);
  console.log(`  to patch:     ${patches.length}`);
  // NEVER let a cap look like completion. A bounded run that prints only
  // its own batch size reads identically to a finished backfill.
  if (deferred > 0) {
    console.log(`  DEFERRED:     ${deferred}   (capped by SEARCH_ENRICH_MAX_PATCHES=${MAX_PATCHES}) — re-run to continue`);
    console.log(`  NOT DONE. ${deferred} rows still need tokens after this batch.`);
  }

  if (!APPLY) {
    if (patches.length > 0) console.log(`\n*** DRY-RUN. Set SEARCH_ENRICH_APPLY=true to persist. ***`);
    return;
  }

  const t0 = Date.now();
  await flush(patches); // remainder
  patches.length = 0;

  console.log(`\n  written:      ${wroteOk}`);
  console.log(`  errors:       ${wroteErr}`);
  console.log(`  throttled:    ${throttled}   (retried, not lost)`);
  console.log(`  flushes:      ${flushes}   (streamed during the scan, memory stayed flat)`);
  if (wroteErr > 0) console.log(`  ${wroteErr} rows FAILED — re-run to pick them up.`);
  void t0;

  // CF-SEARCH-ENRICH-COVERAGE-ASSERT: never let the run's own counters be
  // the last word. Re-query the data and print what is actually left.
  try {
    const remainQ = {
      query:
        "SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @pfx) " +
        "AND (NOT IS_DEFINED(c.searchTokens) OR c.searchTokens = null OR ARRAY_LENGTH(c.searchTokens) = 0)" +
        (sportFilter ? " AND c.sport = @sp" : ""),
      parameters: [{ name: "@pfx", value: "hiq:" }, ...ccParams],
    };
    const { resources: rem } = await cc.items.query(remainQ).fetchAll();
    const stillMissing = Array.isArray(rem) ? rem[0] : null;
    console.log(`\n  COVERAGE: ${stillMissing} rows still lack searchTokens.`);
  } catch (e) {
    console.warn(`  coverage check failed: ${e.message} — do NOT read this run as complete`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
