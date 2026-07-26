#!/usr/bin/env node
// CF-PHASH-VERIFY-RESLUG (Drew, 2026-07-25). Uses the per-slug pHash
// centroids to auto-verify + auto-reslug sold_comps rows whose image
// doesn't match the pool it's in.
//
// Algorithm per phashed row:
//   1. Look up centroid for this row's hobbyiqCardId
//   2. Compute hamming distance to centroid
//   3. If distance <= 12 → row's image matches the pool → OK
//   4. If distance > 20 → suspect mismatch
//      a. Look up sibling centroids (same year+cardNumber+isAuto+sport)
//      b. Find sibling with distance <= 12 to this row's hash
//      c. Present in that pool → RESLUG to the sibling
//      d. Not present → flag image-verification-inconclusive
//
// Env:
//   RESLUG_APPLY=true — persist. Default: dry-run.
//   RESLUG_CONCURRENCY=12
//   RESLUG_DISTANCE_MISMATCH=20 — hamming threshold to declare mismatch
//   RESLUG_DISTANCE_MATCH=12    — hamming threshold to declare match

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { parseHobbyIqCardId, computeHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const APPLY = process.env.RESLUG_APPLY === "true";
const CONCURRENCY = Number(process.env.RESLUG_CONCURRENCY || "12");
const MISMATCH_THRESHOLD = Number(process.env.RESLUG_DISTANCE_MISMATCH || "20");
const MATCH_THRESHOLD = Number(process.env.RESLUG_DISTANCE_MATCH || "12");
// CF-PHASH-RESLUG-CHUNKED (Drew, 2026-07-26). Cap patches applied per
// run so a nightly cron drains the backlog over N runs instead of
// dying at GH Actions' 6h job cap. 0 = no limit (default matches prior
// behavior). Set to e.g. 400000 for a ~5h/run cadence.
const LIMIT = Number(process.env.RESLUG_LIMIT || "0");
// Sort patches by id before slicing so successive runs process
// different chunks (rather than always re-attempting the same top-N
// which the mismatch computer may re-detect on the next centroid pass).
const CHUNK_SORT = (process.env.RESLUG_CHUNK_SORT || "id").toLowerCase();

function hamming(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return dist;
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
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const sc = db.container("sold_comps");
  const centroids = db.container("slug_phash_centroids");

  console.log(`[phash-verify-reslug] MISMATCH>=${MISMATCH_THRESHOLD} MATCH<=${MATCH_THRESHOLD} apply=${APPLY}`);
  console.log(`  loading centroids...`);
  const cIt = centroids.items.query({ query: "SELECT c.hobbyiqCardId, c.centroidHash, c.clusterDominancePct, c.totalPhashed FROM c" });
  const centroidsBySlug = new Map();
  while (cIt.hasMoreResults()) {
    const { resources } = await cIt.fetchNext();
    if (Array.isArray(resources)) for (const r of resources) centroidsBySlug.set(r.hobbyiqCardId, r);
  }
  console.log(`  ${centroidsBySlug.size} centroids loaded`);

  // Build sibling groups (year, cardNumber, isAuto, sport) → [slugs]
  const siblings = new Map();
  for (const slug of centroidsBySlug.keys()) {
    const parsed = parseHobbyIqCardId(slug);
    if (!parsed) continue;
    const key = `${parsed.sport}|${parsed.year}|${String(parsed.cardNumber).toUpperCase()}|${parsed.isAuto ? "a" : "n"}`;
    if (!siblings.has(key)) siblings.set(key, []);
    siblings.get(key).push(slug);
  }
  console.log(`  ${siblings.size} sibling groups\n`);

  console.log(`  scanning sold_comps for pHashed rows...`);
  const q = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.phash, c.parallel, c.setName, c.playerName, c.cardYear, c.cardNumber, c.isAuto, c.printRun, c.sport, c.qualityFlags FROM c WHERE IS_DEFINED(c.phash) AND c.phash != null AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null`;
  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });

  const actions = { ok: 0, noCentroid: 0, mismatch: 0, reslug: 0, inconclusive: 0 };
  const patches = [];
  let scanned = 0;

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      scanned++;
      const centroid = centroidsBySlug.get(r.hobbyiqCardId);
      if (!centroid) { actions.noCentroid++; continue; }
      const dist = hamming(String(r.phash), String(centroid.centroidHash));
      if (dist <= MATCH_THRESHOLD) { actions.ok++; continue; }
      if (dist < MISMATCH_THRESHOLD) { actions.ok++; continue; }

      // Mismatch — find sibling
      actions.mismatch++;
      const parsed = parseHobbyIqCardId(r.hobbyiqCardId);
      if (!parsed) { actions.inconclusive++; continue; }
      const sibKey = `${parsed.sport}|${parsed.year}|${String(parsed.cardNumber).toUpperCase()}|${parsed.isAuto ? "a" : "n"}`;
      const sibs = siblings.get(sibKey) || [];
      let bestSlug = null, bestDist = Infinity;
      for (const sibSlug of sibs) {
        if (sibSlug === r.hobbyiqCardId) continue;
        const sibCentroid = centroidsBySlug.get(sibSlug);
        if (!sibCentroid) continue;
        const d = hamming(String(r.phash), String(sibCentroid.centroidHash));
        if (d < bestDist) { bestDist = d; bestSlug = sibSlug; }
      }
      if (bestSlug && bestDist <= MATCH_THRESHOLD) {
        // Reslug to sibling — extract parallel from new slug
        const sibParsed = parseHobbyIqCardId(bestSlug);
        if (sibParsed && sibParsed.parallel) {
          actions.reslug++;
          patches.push({
            id: r.id,
            partitionKey: r.cardId,
            action: "reslug",
            oldSlug: r.hobbyiqCardId,
            newSlug: bestSlug,
            newParallelSlug: sibParsed.parallel,
            dist,
            bestSibDist: bestDist,
          });
        } else {
          actions.inconclusive++;
        }
      } else {
        actions.inconclusive++;
        const flags = Array.isArray(r.qualityFlags) ? [...r.qualityFlags] : [];
        if (!flags.includes("image-mismatch")) flags.push("image-mismatch");
        patches.push({
          id: r.id,
          partitionKey: r.cardId,
          action: "flag-mismatch",
          oldSlug: r.hobbyiqCardId,
          flags,
          dist,
        });
      }
    }
    process.stdout.write(`\r  scanned=${scanned} ok=${actions.ok} noCent=${actions.noCentroid} reslug=${actions.reslug} incl=${actions.inconclusive}`);
  }
  console.log(`\n\nSummary:`);
  console.log(`  rows scanned:            ${scanned}`);
  console.log(`  image matches centroid:  ${actions.ok}`);
  console.log(`  no centroid for slug:    ${actions.noCentroid}`);
  console.log(`  mismatched to centroid:  ${actions.mismatch}`);
  console.log(`    -> reslugged to sibling: ${actions.reslug}`);
  console.log(`    -> flagged inconclusive: ${actions.inconclusive}`);
  console.log(`  total patches ready:     ${patches.length}\n`);

  console.log(`10 sample patches:`);
  patches.slice(0, 10).forEach(p => {
    if (p.action === "reslug") console.log(`  RESLUG dist=${p.dist} sib=${p.bestSibDist}  ${p.oldSlug.slice(0, 60)} → parallel="${p.newParallelSlug}"`);
    else console.log(`  FLAG   dist=${p.dist}  ${p.oldSlug.slice(0, 60)}`);
  });

  if (!APPLY) {
    console.log(`\n*** DRY-RUN. Set RESLUG_APPLY=true to persist. ***`);
    return;
  }

  // CF-PHASH-RESLUG-CHUNKED: honor per-run cap so nightly cron drains
  // the backlog over multiple runs instead of dying at GH Actions' 6h
  // job cap. Sort by id first so successive runs pick a stable
  // deterministic slice (round-robin as centroid state evolves).
  let toApply = patches;
  if (CHUNK_SORT === "id") toApply = patches.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (LIMIT > 0 && toApply.length > LIMIT) {
    console.log(`  chunking: applying first ${LIMIT} of ${toApply.length} patches (RESLUG_LIMIT=${LIMIT}). Remaining will apply on next run.`);
    toApply = toApply.slice(0, LIMIT);
  }

  console.log(`\nPatching ${toApply.length} rows at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(toApply, async (p) => {
    if (p.action === "reslug") {
      await sc.item(p.id, p.partitionKey).patch([
        { op: "set", path: "/hobbyiqCardId", value: p.newSlug },
      ]);
    } else {
      await sc.item(p.id, p.partitionKey).patch([
        { op: "set", path: "/qualityFlags", value: p.flags },
      ]);
    }
    done++;
    if (done % 500 === 0) process.stdout.write(`\r  patched ${done}/${toApply.length}`);
  });
  console.log(`\n  patched ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  const remaining = patches.length - toApply.length;
  if (remaining > 0) {
    console.log(`  BACKLOG: ${remaining} patches remaining — next run picks up`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
