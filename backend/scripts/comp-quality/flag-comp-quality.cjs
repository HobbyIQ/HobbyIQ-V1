#!/usr/bin/env node
// CF-COMP-QUALITY-FLAG (Drew, 2026-07-24). Multi-rule comp quality
// analysis on sold_comps. Persists a qualityFlags string[] on each row
// so downstream (FMV endpoint, iOS) can filter or downweight.
//
// Rules implemented:
//   R1 price-outlier         — sale >3× or <0.33× slug's raw-tier median
//                              (only when slug has >= 5 comps at same
//                              grade tier for a stable baseline)
//   R2 raw-priced-like-graded — source="raw" but price > 3× slug's raw
//                              median AND slug has graded comps AT
//                              price levels close to this. Likely a
//                              mis-tagged slabbed card.
//   R3 orphan-parallel       — sold_comps.parallel doesn't match any
//                              parallel from card_catalog for the same
//                              (year, cardNumber, releaseName). Suggests
//                              parser hallucinated a variant.
//   R4 same-day-same-slug-dupe — multiple rows share (hobbyiqCardId,
//                              price rounded, soldAt day). All but the
//                              richest get flagged (kept in pool but
//                              filtered by FMV).
//
// Env:
//   FLAG_APPLY=true — persist qualityFlags. Default: dry-run (count only).
//   FLAG_CONCURRENCY=16 — parallel patches.
//
// Usage:
//   node backend/scripts/comp-quality/flag-comp-quality.cjs --sport baseball --min-year 2020

const path = require("path");
const backend = path.resolve(__dirname, "..", "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const APPLY = process.env.FLAG_APPLY === "true";
const CONCURRENCY = Number(process.env.FLAG_CONCURRENCY || "16");

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
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
  const sport = arg("sport", "baseball");
  const minYear = Number(arg("min-year", "2020")) || 2020;
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = client.database("hobbyiq").container("sold_comps");
  const cc = client.database("hobbyiq").container("card_catalog");

  console.log(`[comp-quality-flag] scanning sold_comps sport=${sport} year>=${minYear}...`);
  console.log(`  apply: ${APPLY} (FLAG_APPLY=true to persist)`);
  console.log(`  concurrency: ${CONCURRENCY}`);

  // Pull rows
  const q = `SELECT c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.price, c.soldAt, c.source, c.gradeCompany, c.gradeValue, c.setName, c.qualityFlags
             FROM c WHERE c.sport = @sp AND c.cardYear >= @y`;
  const it = sc.items.query({ query: q, parameters: [{ name: "@sp", value: sport }, { name: "@y", value: minYear }] }, { maxItemCount: 5000 });
  const rows = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    process.stdout.write(`\r  scanned ${rows.length}`);
  }
  console.log(`\n  total: ${rows.length}\n`);

  // Group by slug + grade-tier for R1 and R2 baselines
  const bySlugGrade = new Map();
  for (const r of rows) {
    if (!r.hobbyiqCardId) continue;
    const tier = r.gradeCompany ? `${r.gradeCompany}${r.gradeValue}` : "raw";
    const key = `${r.hobbyiqCardId}::${tier}`;
    if (!bySlugGrade.has(key)) bySlugGrade.set(key, []);
    bySlugGrade.get(key).push(r);
  }

  // Precompute medians for each (slug, tier)
  const medians = new Map();
  for (const [k, arr] of bySlugGrade.entries()) {
    const prices = arr.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0);
    if (prices.length >= 5) medians.set(k, median(prices));
  }

  // Build card_catalog parallel index for R3
  console.log("  loading card_catalog parallels for orphan-parallel rule...");
  const parQ = `SELECT c.cardId, c.year, c.number, c.releaseName, c.parallels FROM c WHERE c.source = 'cardsight' AND c.sport = @sp`;
  const parIt = cc.items.query({ query: parQ, parameters: [{ name: "@sp", value: sport }] }, { maxItemCount: 5000 });
  const catalogRows = [];
  while (parIt.hasMoreResults()) {
    const { resources } = await parIt.fetchNext();
    if (Array.isArray(resources)) catalogRows.push(...resources);
    process.stdout.write(`\r  catalog rows ${catalogRows.length}`);
  }
  console.log();
  // Index: (year|numberUpper) → set of allowed parallel names (lowercase + slug)
  const allowedParallelsByCard = new Map();
  for (const c of catalogRows) {
    const numKey = `${c.year}|${String(c.number || "").toUpperCase()}`;
    if (!allowedParallelsByCard.has(numKey)) allowedParallelsByCard.set(numKey, new Set(["base", ""]));
    const set = allowedParallelsByCard.get(numKey);
    for (const p of (c.parallels || [])) {
      const n = String(p?.name || "").toLowerCase();
      if (n) set.add(n);
    }
  }
  console.log(`  ${allowedParallelsByCard.size} distinct card identities in catalog\n`);

  // R4 setup — same-day-same-slug-price
  const dayKey = (r) => `${r.hobbyiqCardId}|${Math.round(Number(r.price) * 100)}|${String(r.soldAt ?? "").slice(0, 10)}`;
  const dayGroups = new Map();
  for (const r of rows) {
    if (!r.hobbyiqCardId) continue;
    const k = dayKey(r);
    if (!dayGroups.has(k)) dayGroups.set(k, []);
    dayGroups.get(k).push(r);
  }

  // Score rows for R4 keep-vs-flag
  function richScore(r) {
    let s = 0;
    if (r.source === "cardsight") s += 1000;
    if (r.parallel) s += 10;
    if (r.gradeCompany) s += 10;
    return s;
  }

  // Apply rules
  const flagCounts = { "price-outlier": 0, "raw-priced-like-graded": 0, "orphan-parallel": 0, "same-day-same-slug-dupe": 0 };
  const patches = [];

  for (const r of rows) {
    const flags = new Set();
    const price = Number(r.price);
    if (!Number.isFinite(price) || price <= 0) continue;

    // R1 — price outlier
    if (r.hobbyiqCardId) {
      const tier = r.gradeCompany ? `${r.gradeCompany}${r.gradeValue}` : "raw";
      const med = medians.get(`${r.hobbyiqCardId}::${tier}`);
      if (med && med > 0) {
        const ratio = price / med;
        if (ratio > 3 || ratio < 0.33) flags.add("price-outlier");
      }
    }

    // R2 — raw priced like graded
    if (r.hobbyiqCardId && !r.gradeCompany) {
      const rawMed = medians.get(`${r.hobbyiqCardId}::raw`);
      if (rawMed && price > rawMed * 3) {
        // check if this slug has graded comps in that price band
        const gradedTiers = [...medians.entries()].filter(([k]) => k.startsWith(`${r.hobbyiqCardId}::`) && !k.endsWith("::raw"));
        const bandMatch = gradedTiers.some(([, gm]) => price >= gm * 0.5 && price <= gm * 2);
        if (bandMatch) flags.add("raw-priced-like-graded");
      }
    }

    // R3 — orphan parallel
    if (r.parallel && r.cardYear && r.cardNumber) {
      const numKey = `${r.cardYear}|${String(r.cardNumber).toUpperCase()}`;
      const allowed = allowedParallelsByCard.get(numKey);
      if (allowed && allowed.size > 1) {
        const pn = String(r.parallel).toLowerCase();
        const matches = [...allowed].some((a) => a === pn || pn.includes(a) || a.includes(pn));
        if (!matches) flags.add("orphan-parallel");
      }
    }

    // R4 — same-day dupe
    if (r.hobbyiqCardId) {
      const g = dayGroups.get(dayKey(r));
      if (g && g.length > 1) {
        const richest = g.slice().sort((a, b) => richScore(b) - richScore(a))[0];
        if (r.id !== richest.id) flags.add("same-day-same-slug-dupe");
      }
    }

    if (flags.size === 0) continue;
    // Merge with existing qualityFlags if any
    const existing = new Set(Array.isArray(r.qualityFlags) ? r.qualityFlags : []);
    let changed = false;
    for (const f of flags) {
      if (!existing.has(f)) { existing.add(f); changed = true; }
      flagCounts[f]++;
    }
    if (changed) {
      patches.push({ id: r.id, partitionKey: r.cardId, flags: [...existing] });
    }
  }

  console.log("=== Flag counts (rows flagged, may double-count multi-flag rows) ===");
  Object.entries(flagCounts).forEach(([f, n]) => console.log(`  ${f.padEnd(28)} ${n}`));
  console.log(`\nRows with changed qualityFlags to persist: ${patches.length}`);

  if (!APPLY) {
    console.log("\n*** DRY-RUN. Set FLAG_APPLY=true to persist. ***");
    console.log("\n10 sample patches:");
    patches.slice(0, 10).forEach(p => console.log(`  ${p.id}  flags=[${p.flags.join(",")}]`));
    return;
  }

  console.log(`\nPatching ${patches.length} rows at concurrency ${CONCURRENCY}...`);
  const t0 = Date.now();
  let done = 0;
  const result = await runInParallel(patches, async (p) => {
    await sc.item(p.id, p.partitionKey).patch([{ op: "set", path: "/qualityFlags", value: p.flags }]);
    done++;
    if (done % 500 === 0) {
      const rate = (done / ((Date.now() - t0) / 1000)).toFixed(0);
      process.stdout.write(`\r  patched ${done}/${patches.length} (${rate}/s)`);
    }
  });
  console.log(`\n  patched ${result.ok} / errors ${result.err} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}
main().catch(e => { console.error(e); process.exit(1); });
