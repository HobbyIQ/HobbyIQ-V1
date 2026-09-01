// CF-CROSS-SOURCE-DEDUP (Drew, 2026-08-03). Same physical eBay
// sale often gets ingested from multiple vendors (CardHedge + TCA
// + Cardsight). The existing contentHash dedup is per-source, so
// cross-source duplicates slip through.
//
// -- WHAT THIS SCRIPT USED TO DO, AND WHY IT NEVER RAN ----------------------
//
// rev-1 keyed on (title-hash, price, soldAt DAY) and HARD-DELETED every row
// but the earliest. Both halves were wrong, and the workflow that dispatches
// it (sold-comps-clean.yml) has ZERO runs ever -- so nothing has been lost.
// It is a landmine to defuse, not a leak to stop.
//
//   (a) THE DAY BUCKET. Two identical-title sales of the same card at the same
//       price 19 hours apart are TWO REAL SALES. They share a day, so rev-1
//       collapsed them. af14c29c fixed exactly this by moving to minute
//       precision -- but only in crossSourceDedupSoldComps.cjs, its sibling.
//       That fix is backported here as defence in depth.
//
//   (b) THE MISSING DISCRIMINATOR. Neither precision nor title nor price says
//       whether two rows are one sale. `sourceExternalId` does: it is the eBay
//       item id, it is present on every row, and it is half of the doc id
//       `{source}::{sourceExternalId}`. Two rows with DIFFERENT external ids
//       are two different listings -- two real sales -- however identical
//       everything else looks. So a shared external id is now REQUIRED before
//       anything is excluded, and time precision is only a secondary bucket.
//
//   (c) THE DELETE. The pool is the moat and a vendor may never re-emit a sale
//       it has already reported. A dedup NEVER hard-deletes. Exclusion is
//       flaggedWrong=true, which every FMV read path already filters
//       (canonicalFmv.service.ts:1073,:1292; marketMovers, playerDetail,
//       priceSeries, setDetail, verifyQueue; cohortBacktest), plus provenance
//       naming the surviving row -- so the mark is auditable and reversible.
//
// Match key: (title-hash, price, soldAt-MINUTE) buckets the candidates; a
// shared sourceExternalId PROVES they are one sale. Keep the richest row.
//
// Idempotent -- re-runs are safe (only-improve: an already-flagged row is
// never re-stamped and never unflagged).
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 flag (else dry-run: print the full would-flag list)
//   MAX_MINUTES=50             wall-clock cap
//   BATCH=1000                 rows per Cosmos query page
//   MIN_PRICE=1                skip rows with price < this (avoid noise)
//   TIME_PRECISION=minute      minute (default) | hour | day

const { CosmosClient } = require("@azure/cosmos");
const crypto = require("crypto");
const path = require("path");
// CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW (D18, 2026-08-29). This writes. Counters,
// disjoint: intended = rows proven duplicate; written = flags acknowledged;
// skipped = already flagged; failed = patches that threw.
const { reportWrites } = require(path.join(__dirname, "..", "dist/services/ops/writeReconciliation.js"));
const { pickSurvivor } = require(path.join(__dirname, "lib", "collision-triage.cjs"));

const APPLY = process.env.APPLY === "true" || process.env.BACKFILL_APPLY === "true";
const MAX_MINUTES = Math.max(1, Number(process.env.MAX_MINUTES || 50));
const BATCH = Math.max(200, Number(process.env.BATCH || 1000));
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));
const MIN_PRICE = Math.max(0, Number(process.env.MIN_PRICE || 1));
// af14c29c, backported. rev-1's day bucket collapsed real sales hours apart.
const TIME_PRECISION = (process.env.TIME_PRECISION || "minute").toLowerCase();
const TIME_SLICE_LEN = TIME_PRECISION === "day" ? 10 : TIME_PRECISION === "hour" ? 13 : 16;

function titleHash(t) {
  return crypto.createHash("sha256").update(String(t ?? "").toLowerCase().trim()).digest("hex").slice(0, 16);
}

function groupKey(row) {
  const when = String(row.soldAt ?? "").slice(0, TIME_SLICE_LEN);
  const price = typeof row.price === "number" ? row.price.toFixed(2) : String(row.price);
  return `${titleHash(row.title)}|${price}|${when}`;
}

/** The eBay item id, trimmed, or null. Null can never prove sameness. */
function externalIdOf(row) {
  const v = row?.sourceExternalId;
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const cosmos = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sold = cosmos.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  console.log(`[xsrc-dedup] ${APPLY ? "APPLY (flag only -- never a delete)" : "DRY RUN"} maxMin=${MAX_MINUTES} batch=${BATCH} concurrency=${CONCURRENCY} minPrice=${MIN_PRICE} precision=${TIME_PRECISION}`);
  console.log(`[xsrc-dedup] a shared sourceExternalId is REQUIRED to exclude anything; different external id = two real sales.`);
  const startMs = Date.now();
  const budgetMs = MAX_MINUTES * 60_000;

  // Phase 1: scan all rows, build grouping index
  const q = {
    query: `SELECT c.id, c.cardId, c.title, c.price, c.soldAt, c.source, c.sourceExternalId,
                   c.observedAt, c.parallel, c.gradeCompany, c.gradeValue, c.hobbyiqCardId,
                   c.playerName, c.cardNumber, c.imageUrl, c.team, c.setName, c.cardYear,
                   c.sport, c.printRun, c.normalizedSetKey, c.verifiedByUser, c.flaggedWrong
            FROM c WHERE IS_DEFINED(c.title) AND c.price >= @minp`,
    parameters: [{ name: "@minp", value: MIN_PRICE }],
  };
  const iter = sold.items.query(q, { maxItemCount: BATCH });
  const groups = new Map();  // key -> [row, ...]
  let scanned = 0;

  while (iter.hasMoreResults()) {
    if (Date.now() - startMs > budgetMs) { console.warn("wall-clock cap during scan"); break; }
    const { resources } = await iter.fetchNext();
    for (const row of resources) {
      scanned++;
      if (!row.title || !row.soldAt || !(row.price >= MIN_PRICE)) continue;
      const key = groupKey(row);
      let arr = groups.get(key);
      if (!arr) { arr = []; groups.set(key, arr); }
      arr.push(row);
    }
    if (scanned % 100000 === 0) {
      const el = ((Date.now() - startMs) / 1000).toFixed(0);
      console.log(`  scan: rows=${scanned.toLocaleString()} groups=${groups.size.toLocaleString()} el=${el}s`);
    }
  }

  // Phase 2: within each bucket, a SHARED sourceExternalId proves one sale.
  let dupeGroups = 0, dupeRows = 0, flagged = 0, already = 0, errors = 0, attempted = 0;
  let refusedDifferentIds = 0, refusedNoId = 0;
  const sourcesCrossed = new Map();
  const inflight = new Set();

  for (const [key, arr] of groups.entries()) {
    if (arr.length < 2) continue;

    // THE DISCRIMINATOR. Bucket by external id; only ids seen more than once
    // are proven duplicates. Rows whose id is unique in the bucket -- or that
    // carry no id at all -- are left completely alone.
    const byExternal = new Map();
    let noId = 0;
    for (const row of arr) {
      const ext = externalIdOf(row);
      if (ext === null) { noId++; continue; }
      const list = byExternal.get(ext) ?? [];
      list.push(row);
      byExternal.set(ext, list);
    }
    refusedNoId += noId;
    const proven = [...byExternal.values()].filter((list) => list.length > 1);
    if (proven.length === 0) {
      // Every row in this bucket is a distinct listing: identical title, price
      // and minute, different item ids. Two people bought the same card at the
      // same price in the same minute. That happens, and both sales are real.
      refusedDifferentIds += arr.length;
      continue;
    }

    for (const list of proven) {
      const distinctSources = new Set(list.map((r) => r.source));
      dupeGroups++;
      dupeRows += list.length;
      const combo = [...distinctSources].sort().join("+");
      sourcesCrossed.set(combo, (sourcesCrossed.get(combo) || 0) + 1);

      // Richest row survives (the store's own scoreForCanonical shape), ties to
      // the earliest observed -- the record closest to the sale itself.
      const survivor = pickSurvivor(list);
      const losers = list.filter((r) => r !== survivor);

      if (!APPLY) {
        console.log(`  [would flag] ${key}  sources=${combo}`);
        console.log(`      SURVIVOR ${survivor.id}  [${survivor.source}]  ext=${externalIdOf(survivor)}  $${survivor.price}  ${survivor.soldAt}`);
        for (const r of losers) console.log(`      FLAG     ${r.id}  [${r.source}]  ext=${externalIdOf(r)}${r.flaggedWrong === true ? "   (already flagged)" : ""}`);
        continue;
      }

      for (const row of losers) {
        if (row.flaggedWrong === true) { already++; continue; }  // only-improve
        while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
        attempted++;
        const p = sold.item(row.id, row.cardId).patch([
          { op: "set", path: "/flaggedWrong", value: true },
          { op: "set", path: "/flaggedReason", value: "dedup-superseded" },
          { op: "set", path: "/dedupSupersededBy", value: String(survivor.id) },
          { op: "set", path: "/dedupReason", value: `cross-source-dedup:shared-sourceExternalId:${externalIdOf(row)}` },
          { op: "set", path: "/dedupAt", value: new Date().toISOString() },
        ])
          .then(() => { flagged++; })
          .catch((err) => {
            errors++;
            if (errors < 10) console.warn(`  flag err id=${row.id}: ${err?.code ?? err?.message}`);
          })
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
    }

    if (dupeGroups % 10000 === 0 && dupeGroups > 0) {
      const el = ((Date.now() - startMs) / 1000).toFixed(0);
      console.log(`  dedup: clusters=${dupeGroups.toLocaleString()} flagged=${flagged.toLocaleString()} errors=${errors} el=${el}s`);
    }
  }
  await Promise.all([...inflight]);

  console.log(`\n[xsrc-dedup] DONE — scanned=${scanned.toLocaleString()} buckets=${groups.size.toLocaleString()} provenClusters=${dupeGroups.toLocaleString()} provenRows=${dupeRows.toLocaleString()} flagged=${flagged.toLocaleString()} alreadyFlagged=${already.toLocaleString()} errors=${errors} el=${((Date.now()-startMs)/1000).toFixed(0)}s`);
  console.log(`  REFUSED (left alone, both sales real):`);
  console.log(`    same bucket, different external ids   ${refusedDifferentIds.toLocaleString()}`);
  console.log(`    rows carrying no external id          ${refusedNoId.toLocaleString()}`);
  console.log("Cross-source combos (proven clusters only):");
  for (const [combo, n] of [...sourcesCrossed.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${combo.padEnd(35)} ${n.toLocaleString()}`);
  }
  if (!APPLY) console.log("(dry-run — nothing written; the would-flag list is above)");
  if (APPLY) {
    console.log(`  reconciled: intended ${attempted.toLocaleString()} = written ${flagged.toLocaleString()} + skipped 0 + failed ${errors.toLocaleString()}`);
    reportWrites({ job: "sold-comps-cross-source-dedup", intended: attempted, written: flagged, skipped: 0, failed: errors });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
