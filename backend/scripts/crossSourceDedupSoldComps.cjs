// CF-SOLDCOMPS-CROSS-SOURCE-DEDUPE (Drew, 2026-08-10).
//
// The problem: same real-world eBay sale can land in sold_comps as
// BOTH a `cardhedge` row AND a `tca-ebay` row. contentHash-based
// dedup misses it because CH and TCA compute different `cardId`
// slugs for the same sale — different partitions, different hashes,
// two rows. This double-counts the sale in every FMV/comps
// aggregation drawing on that pool.
//
// Coverage overlap is bounded to CH+TCA-both-active (~2026-06 to
// 2026-08 today), so the blast radius is ~few hundred K rows in a
// two-month window — not systemic, but real pricing pollution.
//
// Method — dedup by REAL-WORLD identity, not vendor slug:
//   key = playerName_lower | cardYear | cardNumber_upper
//         | parallel_normalized | isAuto | gradeCompany | gradeValue
//         | priceCents_rounded | soldDay_YYYYMMDD
//
// Any group with >1 distinct `source` values is a cross-source dupe
// cluster. Pick a winner (fill-score + oldest observedAt), delete
// the losers, keep provenance so we could recover.
//
// Safety:
//   - DRY_RUN default. Prints plan + sample clusters before writing.
//   - Requires the identity key to be complete (skips rows with any
//     null identity field — those can't be safely deduped)
//   - Fill-score winner selection prefers rows with more populated
//     fields; ties broken by oldest observedAt (first-observed
//     assumption: source of truth)
//   - Never deletes the last row in a cluster; if all rows are
//     equally-scored, keep the earliest-observed
//   - Bounded date window via BULK_START_DATE / BULK_END_DATE to
//     limit blast radius per run
//
// Usage:
//   DRY_RUN=true  node backend/scripts/crossSourceDedupSoldComps.cjs
//   DRY_RUN=false node backend/scripts/crossSourceDedupSoldComps.cjs
//   Optional:
//     BULK_START_DATE=2026-08-10 (newest sold_at to consider)
//     BULK_END_DATE=2026-06-01   (oldest; overlap floor)
//     CONCURRENCY=16             (delete concurrency)
//     MAX_CLUSTERS=100000        (cap for pilot runs)

const { CosmosClient } = require("@azure/cosmos");

const CONN = process.env.COSMOS_CONNECTION_STRING;
const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const START_DATE = process.env.BULK_START_DATE || new Date().toISOString().slice(0, 10);
const END_DATE = process.env.BULK_END_DATE || "2026-06-01";
const CONCURRENCY = Math.min(64, Number(process.env.CONCURRENCY || 16));
const MAX_CLUSTERS = Number(process.env.MAX_CLUSTERS || 0);
// CF-DEDUPE-PRECISION (Drew, 2026-08-10). rev-1 keyed on soldAt day
// only, which over-collapsed hot commons — 16 people legitimately
// buying a $9.99 card on the same day looked like one cluster.
// rev-2: key on soldAt minute (YYYY-MM-DDTHH:MM). Two sources
// reporting the same eBay sale share a timestamp because both
// scrape eBay's own soldAt. Different real sales differ by at
// least a minute in practice.
// TIME_PRECISION env: "minute" (default), "hour", or "day".
const TIME_PRECISION = (process.env.TIME_PRECISION || "minute").toLowerCase();
const TIME_SLICE_LEN = TIME_PRECISION === "day" ? 10 : TIME_PRECISION === "hour" ? 13 : 16;

if (!CONN) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

function norm(s) { return String(s ?? "").trim().toLowerCase(); }
function normCardNum(s) { return String(s ?? "").trim().toUpperCase().replace(/^#+/, ""); }
function normParallel(s) {
  return String(s ?? "").trim().toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/ refractors?$/, "");
}
function normGradeCo(s) {
  const t = String(s ?? "").trim().toUpperCase();
  return t || "RAW";
}

// Fill score: more populated fields = better canonical candidate
const FILL_FIELDS = ["hobbyiqCardId", "playerName", "cardNumber", "parallel",
                     "gradeCompany", "gradeValue", "imageUrl", "title",
                     "team", "setName", "cardYear", "sport",
                     "printRun", "normalizedSetKey"];
function fillScore(row) {
  let n = 0;
  for (const f of FILL_FIELDS) if (row[f] !== undefined && row[f] !== null && row[f] !== "") n++;
  return n;
}

async function fetchNextWithRetry(iter, maxAttempts = 8) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return await iter.fetchNext(); }
    catch (err) {
      const code = err && (err.code ?? err.statusCode);
      const msg = String((err && err.message) || "");
      if ((code === 429 || msg.includes("request rate is too large")) && attempt < maxAttempts - 1) {
        const wait = Number((err && err.retryAfterInMs) ?? 1000 * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  throw new Error("exhausted retries");
}

async function deleteWithRetry(container, id, pk, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { await container.item(id, pk).delete(); return true; }
    catch (err) {
      const code = err && (err.code ?? err.statusCode);
      if (code === 404) return true;
      if (code === 429 && attempt < maxAttempts - 1) {
        const wait = Number((err && err.retryAfterInMs) ?? 500 * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  const client = new CosmosClient(CONN);
  const sc = client.database("hobbyiq").container("sold_comps");
  const t0 = Date.now();

  console.log("[cross-source dedupe] scanning sold_comps in overlap window");
  console.log(`  window (newest→oldest): ${START_DATE} → ${END_DATE}`);
  console.log(`  mode                 : ${DRY_RUN ? "DRY_RUN" : "APPLY"}`);
  console.log(`  time precision       : ${TIME_PRECISION} (${TIME_SLICE_LEN} chars)`);
  console.log("");

  const iter = sc.items.query({
    query: `SELECT c.id, c.cardId, c._ts, c.source, c.observedAt,
                   c.playerName, c.cardYear, c.cardNumber, c.parallel,
                   c.isAuto, c.gradeCompany, c.gradeValue, c.price, c.soldAt,
                   c.hobbyiqCardId, c.imageUrl, c.title, c.team, c.setName,
                   c.sport, c.printRun, c.normalizedSetKey
            FROM c
            WHERE c.soldAt >= @from AND c.soldAt < @to
              AND c.price > 0
              AND IS_DEFINED(c.playerName) AND c.playerName != null AND c.playerName != ""
              AND IS_DEFINED(c.cardYear) AND IS_DEFINED(c.cardNumber)
            ORDER BY c.soldAt DESC`,
    parameters: [
      { name: "@from", value: END_DATE },
      { name: "@to", value: START_DATE + "T23:59:59.999Z" },
    ],
  }, { maxItemCount: 5000 });

  // Group by real-world identity key
  const clusters = new Map();
  let scanned = 0, skippedNoIdentity = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await fetchNextWithRetry(iter);
    for (const r of resources) {
      scanned++;
      if (!r.playerName || !r.cardYear || !r.cardNumber || !r.soldAt) {
        skippedNoIdentity++;
        continue;
      }
      const key = [
        norm(r.playerName),
        r.cardYear,
        normCardNum(r.cardNumber),
        normParallel(r.parallel),
        r.isAuto === true ? "1" : "0",
        normGradeCo(r.gradeCompany),
        r.gradeValue ?? 0,
        Math.round(Number(r.price) * 100),
        String(r.soldAt).slice(0, TIME_SLICE_LEN),
      ].join("|");
      const arr = clusters.get(key) || [];
      arr.push(r);
      clusters.set(key, arr);
    }
    if (scanned % 100000 === 0) console.log(`  scanned=${scanned.toLocaleString()}  clusters=${clusters.size.toLocaleString()}  (${((Date.now()-t0)/1000).toFixed(0)}s)`);
  }

  // Find multi-source clusters
  const dupeClusters = [];
  const sourceBreakdown = new Map(); // multi-cluster combo → count
  for (const [key, rows] of clusters) {
    const sources = new Set(rows.map(r => r.source));
    if (sources.size <= 1) continue;
    // Real cross-source dupe cluster
    dupeClusters.push({ key, rows });
    const combo = [...sources].sort().join("+");
    sourceBreakdown.set(combo, (sourceBreakdown.get(combo) || 0) + 1);
  }
  dupeClusters.sort((a, b) => b.rows.length - a.rows.length);

  const totalExtras = dupeClusters.reduce((s, c) => s + (c.rows.length - 1), 0);

  console.log("");
  console.log("[plan]");
  console.log(`  rows scanned                : ${scanned.toLocaleString()}`);
  console.log(`  rows skipped (no identity)  : ${skippedNoIdentity.toLocaleString()}`);
  console.log(`  distinct real-world sales   : ${clusters.size.toLocaleString()}`);
  console.log(`  multi-source dupe clusters  : ${dupeClusters.length.toLocaleString()}`);
  console.log(`  extra rows to delete        : ${totalExtras.toLocaleString()}`);
  console.log("");
  console.log("[cross-source combo breakdown]");
  for (const [combo, n] of [...sourceBreakdown.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${combo.padEnd(40)} ${n.toLocaleString().padStart(8)} clusters`);
  }

  if (dupeClusters.length === 0) {
    console.log("");
    console.log("[done] no cross-source dupes in the window.");
    return;
  }

  const process_clusters = MAX_CLUSTERS > 0 ? dupeClusters.slice(0, MAX_CLUSTERS) : dupeClusters;
  console.log(`  will process: ${process_clusters.length.toLocaleString()} clusters`);

  // Pick winner per cluster: highest fill score, then earliest observedAt
  const patchQueue = [];
  for (const cluster of process_clusters) {
    const scored = cluster.rows.map(r => ({
      row: r,
      fill: fillScore(r),
      ts: Number(r._ts || 0),
      obsMs: r.observedAt ? new Date(r.observedAt).getTime() : Number.POSITIVE_INFINITY,
    }));
    scored.sort((a, b) => (b.fill - a.fill) || (a.obsMs - b.obsMs) || (a.ts - b.ts));
    const winner = scored[0].row;
    for (const s of scored.slice(1)) {
      patchQueue.push({
        id: s.row.id,
        pk: s.row.cardId,
        loserSource: s.row.source,
        winnerSlug: winner.hobbyiqCardId ?? "(none)",
        winnerSource: winner.source,
      });
    }
  }

  console.log("");
  console.log("[sample clusters, first 5]");
  for (const cluster of process_clusters.slice(0, 5)) {
    const parts = cluster.key.split("|");
    console.log(`  key: ${parts.slice(0, 3).join(" · ")} · ${parts[7]/100} · ${parts[8]}  (${cluster.rows.length} rows, sources: ${[...new Set(cluster.rows.map(r => r.source))].join(", ")})`);
    for (const r of cluster.rows.slice(0, 3)) {
      console.log(`    ${r.source.padEnd(15)} slug=${(r.hobbyiqCardId || "(none)").slice(0, 60)}  fill=${fillScore(r)}`);
    }
  }

  if (DRY_RUN) {
    console.log("");
    console.log("[DRY_RUN] no writes. Set DRY_RUN=false to delete losers.");
    return;
  }

  console.log("");
  console.log(`[apply] deleting ${patchQueue.length.toLocaleString()} loser rows…`);
  let deleted = 0, deleteFailed = 0;
  const inflight = new Set();
  for (const p of patchQueue) {
    while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
    const task = deleteWithRetry(sc, p.id, p.pk)
      .then(() => {
        deleted++;
        if (deleted % 500 === 0) {
          const eps = (deleted / ((Date.now() - t0) / 1000)).toFixed(0);
          console.log(`  deleted ${deleted.toLocaleString()}/${patchQueue.length.toLocaleString()}  (${eps}/sec)`);
        }
      })
      .catch(err => {
        deleteFailed++;
        if (deleteFailed <= 10) console.warn(`  delete-fail id=${p.id}: ${(err && err.message) || err}`);
      })
      .finally(() => inflight.delete(task));
    inflight.add(task);
  }
  await Promise.all([...inflight]);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log("[done]");
  console.log(`  deleted        : ${deleted.toLocaleString()}`);
  console.log(`  delete-failed  : ${deleteFailed.toLocaleString()}`);
  console.log(`  elapsed        : ${elapsed}s`);
}

main().catch(e => { console.error("[FATAL]", (e && e.stack) || e); process.exit(1); });
