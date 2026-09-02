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
// The identity key above BUCKETS the candidates. It does NOT prove they are
// one sale: `sourceExternalId` does. It is the eBay item id, it is present on
// every row, and it is half of the doc id `{source}::{sourceExternalId}`. Two
// rows with DIFFERENT external ids are two different listings -- two real
// sales -- however identical the rest of the key looks. rev-2 ignored the
// field entirely, so two $9.99 sales in the same minute with different item
// ids collapsed into one. A SHARED external id is now required before
// anything is excluded.
//
// THAT RULE IS IMPORTED, NOT WRITTEN HERE (D3). It lived in this file and again
// in sold-comps-cross-source-dedup.cjs, with a copy of `externalIdOf` in each,
// and the tests guarding both asserted over SOURCE TEXT -- so a mutant reverting
// either script to the whole-bucket collapse passed all 81 of them. It now lives
// in scripts/lib/cross-source-cluster.cjs, both scripts import it, and the tests
// EXECUTE both scripts and confirm each mutant is lethal.
//
// And the exclusion is a FLAG, not a delete. The pool is the moat: a vendor
// may never re-emit a sale it has already reported, so a dedup never
// hard-deletes. flaggedWrong=true is already filtered by every FMV read path
// (canonicalFmv.service.ts:1073,:1292; marketMovers, playerDetail,
// priceSeries, setDetail, verifyQueue; cohortBacktest), and the provenance
// fields name the surviving row -- auditable, and reversible by clearing one
// boolean.
//
// Safety:
//   - DRY_RUN default. Prints plan + sample clusters + the full would-flag
//     list before writing.
//   - Requires the identity key to be complete (skips rows with any
//     null identity field — those can't be safely deduped)
//   - Fill-score winner selection prefers rows with more populated
//     fields; ties broken by oldest observedAt (first-observed
//     assumption: source of truth)
//   - Never flags the last row in a cluster; if all rows are
//     equally-scored, keep the earliest-observed
//   - Only-improve: a row already flagged is never re-stamped and
//     never unflagged, so a re-run cannot overwrite a human ruling
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
const path = require("path");
// THE DISCRIMINATOR IS IMPORTED, NOT COPIED. Both dedup scripts and the
// contentHash triage must agree on what an item id is and on when a bucket has
// PROVEN a duplicate. This file used to declare its own `externalIdOf` and its
// own bucket-by-id loop; the tests that guarded them asserted over source text,
// so a mutant reverting the whole-bucket collapse passed every one. The rule now
// lives in scripts/lib/cross-source-cluster.cjs and the tests execute it.
const { provenClustersOf, externalIdOf } = require(path.join(__dirname, "lib", "cross-source-cluster.cjs"));

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
/** D31: the trailing " Refractor" is NO LONGER stripped. The retracted rule
 *  held that a colour and its colour-refractor sibling were one card; D31 says
 *  the checklist decides per card, and Topps Finest #197 lists `Uncommon` AND
 *  `Uncommon Refractor` as two of them. Stripping the word put two different
 *  cards' sales in one cluster, where this script would have excluded one of
 *  them as a duplicate of the other. Mirrors scripts/lib/relocate-sold-comp.cjs. */
function normParallel(s) {
  return String(s ?? "").trim().toLowerCase()
    .replace(/\s+/g, " ");
}
function normGradeCo(s) {
  const t = String(s ?? "").trim().toUpperCase();
  return t || "RAW";
}

// `externalIdOf` is imported above from scripts/lib/collision-triage.cjs (via
// cross-source-cluster). It returns the eBay item id trimmed, or null when the
// row carries none -- a row with no external id can never PROVE sameness, so it
// is never excluded on this rule. It is deliberately NOT unwrapped to an inner
// listing id: CardHedge's two shapes (`ch-daily::<price_history_id>` and the
// composed `ch-comp::<cardId>::<soldAt>::<cents>`) share no listing id to
// extract, so any unwrapping would be a guess dressed as a proof. That
// population has its own lane: scripts/collapse-ch-dual-ids.cjs, which pairs on
// (day, price) and REFUSES on parallel or grade variance.

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

/** THE ONE WRITE. Exclude a row from every FMV read path, reversibly, and say
 *  which row superseded it and why. Never a delete: see the header. */
async function flagWithRetry(container, id, pk, { survivingId, reason }, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await container.item(id, pk).patch([
        { op: "set", path: "/flaggedWrong", value: true },
        { op: "set", path: "/flaggedReason", value: "dedup-superseded" },
        { op: "set", path: "/dedupSupersededBy", value: String(survivingId) },
        { op: "set", path: "/dedupReason", value: String(reason) },
        { op: "set", path: "/dedupAt", value: new Date().toISOString() },
      ]);
      return true;
    }
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
    query: `SELECT c.id, c.cardId, c._ts, c.source, c.sourceExternalId, c.observedAt,
                   c.playerName, c.cardYear, c.cardNumber, c.parallel,
                   c.isAuto, c.gradeCompany, c.gradeValue, c.price, c.soldAt,
                   c.hobbyiqCardId, c.imageUrl, c.title, c.team, c.setName,
                   c.sport, c.printRun, c.normalizedSetKey, c.verifiedByUser, c.flaggedWrong
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

  // Find PROVEN dupe clusters. The identity key above only buckets candidates;
  // a shared sourceExternalId is what proves two rows are one sale. A bucket
  // whose rows all carry different item ids is several real sales that happen
  // to match on price and minute, and is left entirely alone.
  const dupeClusters = [];
  const sourceBreakdown = new Map(); // multi-cluster combo → count
  let refusedDifferentIds = 0, refusedNoId = 0, refusedSingleSource = 0;
  for (const [key, rows] of clusters) {
    if (rows.length < 2) continue;

    // THE RULING, imported. A shared item id is the only thing that proves two
    // rows in one bucket are one sale; everything else this bucket holds is
    // several real sales and is counted as refused.
    const { proven, refusedNoId: noId, refusedDifferentIds: diff } = provenClustersOf(rows);
    refusedNoId += noId;
    refusedDifferentIds += diff;
    if (proven.length === 0) continue;

    for (const list of proven) {
      const sources = new Set(list.map(r => r.source));
      // Same source AND same external id is still one sale written twice --
      // an idempotent upsert that did not hold. Worth excluding, and counted
      // on its own line rather than silently dropped as rev-2 did.
      if (sources.size <= 1) refusedSingleSource++;
      dupeClusters.push({ key, rows: list, crossSource: sources.size > 1 });
      const combo = [...sources].sort().join("+");
      sourceBreakdown.set(combo, (sourceBreakdown.get(combo) || 0) + 1);
    }
  }
  dupeClusters.sort((a, b) => b.rows.length - a.rows.length);

  const totalExtras = dupeClusters.reduce((s, c) => s + (c.rows.length - 1), 0);

  console.log("");
  console.log("[plan]");
  console.log(`  rows scanned                : ${scanned.toLocaleString()}`);
  console.log(`  rows skipped (no identity)  : ${skippedNoIdentity.toLocaleString()}`);
  console.log(`  distinct real-world sales   : ${clusters.size.toLocaleString()}`);
  console.log(`  PROVEN dupe clusters        : ${dupeClusters.length.toLocaleString()}   (shared sourceExternalId)`);
  console.log(`    of those, same-source     : ${refusedSingleSource.toLocaleString()}   <- one sale written twice by one path`);
  console.log(`  extra rows to FLAG          : ${totalExtras.toLocaleString()}   <- flaggedWrong=true, never a delete`);
  console.log("");
  console.log("[refused -- left alone, every one a real sale]");
  console.log(`  same key, different item ids: ${refusedDifferentIds.toLocaleString()}`);
  console.log(`  rows carrying no item id    : ${refusedNoId.toLocaleString()}`);
  console.log("");
  console.log("[cross-source combo breakdown]");
  for (const [combo, n] of [...sourceBreakdown.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${combo.padEnd(40)} ${n.toLocaleString().padStart(8)} clusters`);
  }

  if (dupeClusters.length === 0) {
    console.log("");
    console.log("[done] no PROVEN dupes in the window (no two rows share an item id).");
    return;
  }

  const process_clusters = MAX_CLUSTERS > 0 ? dupeClusters.slice(0, MAX_CLUSTERS) : dupeClusters;
  console.log(`  will process: ${process_clusters.length.toLocaleString()} clusters`);

  // Pick winner per cluster: highest fill score, then earliest observedAt
  const patchQueue = [];
  let alreadyFlagged = 0;
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
      // Only-improve: an already-flagged row is left exactly as it is, so a
      // re-run can never overwrite an earlier (possibly human) ruling.
      if (s.row.flaggedWrong === true) { alreadyFlagged++; continue; }
      patchQueue.push({
        id: s.row.id,
        pk: s.row.cardId,
        loserSource: s.row.source,
        winnerId: winner.id,
        winnerSlug: winner.hobbyiqCardId ?? "(none)",
        winnerSource: winner.source,
        sharedExternalId: externalIdOf(s.row),
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
    console.log(`[would flag] the FULL list -- ${patchQueue.length.toLocaleString()} row(s), each superseded by a row sharing its item id:`);
    for (const p of patchQueue) {
      console.log(`  FLAG ${p.id}  [${p.loserSource}]  ext=${p.sharedExternalId}`);
      console.log(`       superseded by ${p.winnerId}  [${p.winnerSource}]  slug=${p.winnerSlug}`);
    }
    console.log("");
    console.log(`[DRY_RUN] no writes. ${alreadyFlagged.toLocaleString()} row(s) already flagged and left untouched.`);
    console.log("[DRY_RUN] Set DRY_RUN=false to flag the losers (flaggedWrong=true; nothing is ever deleted).");
    return;
  }

  console.log("");
  console.log(`[apply] flagging ${patchQueue.length.toLocaleString()} superseded rows (flaggedWrong=true -- never a delete)…`);
  let flagged = 0, flagFailed = 0;
  const inflight = new Set();
  for (const p of patchQueue) {
    while (inflight.size >= CONCURRENCY) await Promise.race([...inflight]);
    const task = flagWithRetry(sc, p.id, p.pk, {
      survivingId: p.winnerId,
      reason: `cross-source-dedup:shared-sourceExternalId:${p.sharedExternalId}`,
    })
      .then(() => {
        flagged++;
        if (flagged % 500 === 0) {
          const eps = (flagged / ((Date.now() - t0) / 1000)).toFixed(0);
          console.log(`  flagged ${flagged.toLocaleString()}/${patchQueue.length.toLocaleString()}  (${eps}/sec)`);
        }
      })
      .catch(err => {
        flagFailed++;
        if (flagFailed <= 10) console.warn(`  flag-fail id=${p.id}: ${(err && err.message) || err}`);
      })
      .finally(() => inflight.delete(task));
    inflight.add(task);
  }
  await Promise.all([...inflight]);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("");
  console.log("[done] nothing was deleted; every exclusion is a reversible flag.");
  console.log(`  flagged             : ${flagged.toLocaleString()}`);
  console.log(`  already flagged     : ${alreadyFlagged.toLocaleString()}   <- only-improve, left untouched`);
  console.log(`  flag-failed         : ${flagFailed.toLocaleString()}`);
  console.log(`  elapsed             : ${elapsed}s`);
  // INTENDED IS EVERY LOSER THIS RUN PROVED, not just the ones it queued. The
  // first form printed `skipped 0` as a literal while counting already-flagged
  // rows on their own line -- self-consistent arithmetic that reconciled a
  // narrower "intended" than the run actually decided, so a run whose losers
  // were ALL already flagged reconciled 0 = 0 + 0 + 0 and said nothing about the
  // rows it had ruled on. Skipped is the real number.
  const intended = patchQueue.length + alreadyFlagged;
  console.log(`  reconciled: intended ${intended.toLocaleString()} = written ${flagged.toLocaleString()} + skipped ${alreadyFlagged.toLocaleString()} + failed ${flagFailed.toLocaleString()}`);
}

main().catch(e => { console.error("[FATAL]", (e && e.stack) || e); process.exit(1); });
