#!/usr/bin/env node
// CF-PHASH-CENTROIDS (Drew, 2026-07-25). For each hobbyiqCardId with
// enough pHashed comps, computes the "canonical fingerprint" — the
// dominant image cluster within that slug. Written to a new container
// `slug_phash_centroids` keyed by /hobbyiqCardId so the reslug step
// can look up the reference in one read.
//
// Clustering: single-linkage on 64-bit dhash-v1 with hamming threshold
// 12. Centroid = medoid of the largest cluster (hash with minimum
// sum-of-distances to all others in the cluster).
//
// Env:
//   CENTROID_APPLY=true — persist. Default: dry-run.
//   CENTROID_MIN_COMPS=5 — minimum pHashed comps required per slug.
//   CENTROID_CONCURRENCY=12

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const APPLY = process.env.CENTROID_APPLY === "true";
const MIN_COMPS = Number(process.env.CENTROID_MIN_COMPS || "5");
const CONCURRENCY = Number(process.env.CENTROID_CONCURRENCY || "12");
const HAMMING_THRESHOLD = 12;

function hamming(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    dist += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return dist;
}

/** Single-linkage cluster on the hashes. Returns { clusters, medoids }. */
function clusterHashes(hashes) {
  const n = hashes.length;
  const parent = new Array(n).fill(0).map((_, i) => i);
  function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (hamming(hashes[i], hashes[j]) <= HAMMING_THRESHOLD) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  const clusters = [...groups.values()].sort((a, b) => b.length - a.length);
  return clusters;
}

function medoid(indices, hashes) {
  let best = indices[0];
  let bestSum = Infinity;
  for (const i of indices) {
    let sum = 0;
    for (const j of indices) sum += hamming(hashes[i], hashes[j]);
    if (sum < bestSum) { bestSum = sum; best = i; }
  }
  return { hashIndex: best, meanDist: bestSum / Math.max(1, indices.length - 1) };
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
  const { container: centroids } = await db.containers.createIfNotExists({
    id: "slug_phash_centroids",
    partitionKey: { paths: ["/hobbyiqCardId"] },
  });

  console.log(`[phash-centroids] MIN_COMPS=${MIN_COMPS} threshold=${HAMMING_THRESHOLD} apply=${APPLY}`);
  console.log(`  scanning sold_comps for pHashed rows...`);
  const q = `SELECT c.hobbyiqCardId, c.phash FROM c WHERE IS_DEFINED(c.phash) AND c.phash != null AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null AND c.hobbyiqCardId != ''`;
  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  const bySlug = new Map();
  let scanned = 0;
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (!Array.isArray(resources)) continue;
    for (const r of resources) {
      const slug = String(r.hobbyiqCardId);
      const hash = String(r.phash);
      if (!bySlug.has(slug)) bySlug.set(slug, []);
      bySlug.get(slug).push(hash);
    }
    scanned += resources.length;
    process.stdout.write(`\r  scanned=${scanned} distinct-slugs=${bySlug.size}`);
  }
  console.log(`\n  ${bySlug.size} distinct slugs, ${scanned} pHashed rows total\n`);

  // Filter to slugs with enough comps
  const candidates = [];
  for (const [slug, hashes] of bySlug.entries()) {
    if (hashes.length >= MIN_COMPS) candidates.push({ slug, hashes });
  }
  console.log(`  ${candidates.length} slugs with >=${MIN_COMPS} pHashed comps`);

  // Compute centroids
  const docs = [];
  for (const { slug, hashes } of candidates) {
    const clusters = clusterHashes(hashes);
    const biggest = clusters[0];
    const dominance = biggest.length / hashes.length;
    const { hashIndex, meanDist } = medoid(biggest, hashes);
    docs.push({
      id: slug,
      hobbyiqCardId: slug,
      centroidHash: hashes[hashIndex],
      totalPhashed: hashes.length,
      clusterSize: biggest.length,
      clusterDominancePct: Math.round(dominance * 1000) / 10,
      meanIntraClusterDistance: Math.round(meanDist * 10) / 10,
      totalClusters: clusters.length,
      computedAt: new Date().toISOString(),
      algo: "dhash-v1",
    });
  }
  console.log(`  computed ${docs.length} centroid docs`);

  // Sample the strongest + weakest clusters
  docs.sort((a, b) => b.clusterDominancePct - a.clusterDominancePct);
  console.log(`\n  top 5 strongest clusters (highest dominance):`);
  docs.slice(0, 5).forEach(d => console.log(`    ${d.clusterDominancePct}%  ${d.clusterSize}/${d.totalPhashed}  ${d.hobbyiqCardId.slice(0, 80)}`));
  console.log(`\n  weakest 5 (lowest dominance — likely mislabel-heavy):`);
  docs.slice(-5).reverse().forEach(d => console.log(`    ${d.clusterDominancePct}%  ${d.clusterSize}/${d.totalPhashed}  ${d.hobbyiqCardId.slice(0, 80)}`));

  if (!APPLY) {
    console.log(`\n*** DRY-RUN. Set CENTROID_APPLY=true to persist. ***`);
    return;
  }

  console.log(`\nPersisting ${docs.length} centroids at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(docs, async (d) => {
    await centroids.items.upsert(d);
    done++;
    if (done % 500 === 0) process.stdout.write(`\r  written ${done}/${docs.length}`);
  });
  console.log(`\n  written ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e => { console.error(e); process.exit(1); });
