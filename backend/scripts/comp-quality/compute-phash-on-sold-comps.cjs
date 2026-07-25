#!/usr/bin/env node
// CF-PHASH-COMPUTE-SOLD-COMPS (Drew, 2026-07-25). Phase A of the
// image-verification foundation. Downloads each sold_comps row's image,
// computes dhash-v1 pHash via the existing phashCompute service, and
// persists to the row. Zero LLM cost. Runs several hours.
//
// Idempotent — skips rows already tagged with `phash`.
//
// Env:
//   PHASH_APPLY=true — persist. Default: dry-run (just prints counts).
//   PHASH_CONCURRENCY=16 — parallel image downloads.
//   PHASH_LIMIT=0 — safety cap on rows processed (0 = unlimited).
//   PHASH_MIN_PRICE=0 — only process rows priced >= this (0 = all).

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { computeDhashFromUrl } = require(path.join(backend, "dist/services/attribution/phashCompute.service.js"));

const APPLY = process.env.PHASH_APPLY === "true";
const CONCURRENCY = Number(process.env.PHASH_CONCURRENCY || "16");
const LIMIT = Number(process.env.PHASH_LIMIT || "0");
const MIN_PRICE = Number(process.env.PHASH_MIN_PRICE || "0");

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
  const sc = client.database("hobbyiq").container("sold_comps");

  console.log(`[phash-compute] apply=${APPLY} concurrency=${CONCURRENCY} limit=${LIMIT || "∞"} minPrice=${MIN_PRICE}`);
  console.log(`  scanning sold_comps for rows needing phash...`);

  const whereParts = [
    "IS_DEFINED(c.imageUrl)", "c.imageUrl != null", "c.imageUrl != ''",
    "(NOT IS_DEFINED(c.phash) OR c.phash = null OR c.phash = '')",
  ];
  if (MIN_PRICE > 0) whereParts.push(`c.price >= ${MIN_PRICE}`);
  const q = `SELECT c.id, c.cardId, c.imageUrl FROM c WHERE ${whereParts.join(" AND ")}`;

  const targets = [];
  const it = sc.items.query({ query: q }, { maxItemCount: 5000 });
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (!Array.isArray(resources)) continue;
    targets.push(...resources);
    if (LIMIT > 0 && targets.length >= LIMIT) { targets.length = LIMIT; break; }
    process.stdout.write(`\r  targets=${targets.length}`);
  }
  console.log(`\n  ${targets.length} rows need phash\n`);

  if (targets.length === 0) return;
  if (!APPLY) {
    console.log(`*** DRY-RUN. Set PHASH_APPLY=true to compute + persist. ***`);
    console.log(`\nEstimated time at ${CONCURRENCY} concurrent: ~${Math.round(targets.length / CONCURRENCY * 0.25 / 60)}-${Math.round(targets.length / CONCURRENCY * 0.4 / 60)} min`);
    console.log(`Estimated bandwidth: ~${Math.round(targets.length * 30 / 1024)}MB (30KB avg per image)`);
    return;
  }

  const t0 = Date.now();
  let done = 0, computed = 0, failed = 0;
  const result = await runInParallel(targets, async (r) => {
    const res = await computeDhashFromUrl(r.imageUrl, { timeoutMs: 12_000, maxBytes: 2_000_000 });
    if (res && res.hash) {
      try {
        await sc.item(r.id, r.cardId).patch([
          { op: "set", path: "/phash", value: res.hash },
          { op: "set", path: "/phashAlgo", value: "dhash-v1" },
        ]);
        computed++;
      } catch { failed++; }
    } else {
      failed++;
    }
    done++;
    if (done % 1000 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(1);
      const eta = ((targets.length - done) / Math.max(1, done / ((Date.now() - t0) / 1000)) / 60).toFixed(0);
      process.stdout.write(`\r  done=${done}/${targets.length} computed=${computed} failed=${failed} @${rate}/s eta=${eta}min`);
    }
  });
  console.log(`\n\nSummary: computed=${computed} failed=${failed} in ${((Date.now() - t0) / 60_000).toFixed(1)}min`);
}
main().catch(e => { console.error(e); process.exit(1); });
