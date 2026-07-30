#!/usr/bin/env node
// CF-AUDIT-LADDER-VIOLATIONS (Drew, 2026-07-30). Phase 4: scan
// sold_comps against the parallel-vocabulary ladders and REPORT
// rows whose (product, year, color, serialRun) tuple is impossible
// per the vocab. Does NOT mutate anything — this is a diagnostic
// pass whose output feeds the verify_queue reason
// `impossible-serial-for-ladder`.
//
// Requires the composite fields to be present (from
// backfill-composite-fields). Only checks rows with colorFamily
// non-null.
//
// Env:
//   COSMOS_CONNECTION_STRING   — required
//   AUDIT_LIMIT=500000          — max rows scanned

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { validateAgainstLadder, findLadder } = require(path.join(backend, "dist/services/portfolioiq/parallelVocabulary.service.js"));

const LIMIT = Number(process.env.AUDIT_LIMIT || "500000");

// Map slug setKey → productLine name used in ladders. Ladders use
// human names like "Bowman Chrome"; slug uses "bowman-chrome".
function slugSetKeyToProduct(setKey) {
  if (!setKey) return null;
  const map = {
    "bowman-chrome":                 "Bowman Chrome",
    "bowman-chrome-draft":           "Bowman Chrome",
    "bowman-chrome-sapphire":        "Bowman Chrome",
    "bowman-draft":                  "Bowman",
    "bowman-paper":                  "Bowman (paper)",
    "bowman-draft-paper":            "Bowman (paper)",
    "bowman":                        "Bowman",
    "topps-chrome":                  "Topps Chrome",
    "topps-chrome-update":           "Topps Chrome Update",
    "topps":                         "Topps Series 1",
    "topps-heritage":                "Topps Heritage",
  };
  return map[setKey] ?? null;
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log(`[audit-ladder-violations]`);
  console.log(`  limit: ${LIMIT}\n`);

  // Only rows with composite fields present + colorFamily set. We
  // can't validate a ladder without a color.
  const query = `
    SELECT TOP @n
      c.id, c.cardId, c.hobbyiqCardId, c.title, c.cardYear,
      c.printRun, c.composite
    FROM c
    WHERE IS_DEFINED(c.composite)
      AND c.composite != null
      AND IS_STRING(c.composite.colorFamily)
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@n", value: LIMIT }] },
    { maxItemCount: 5000 }
  );
  const rows = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
    if (rows.length % 25000 < 5000) process.stdout.write(`\r  scanning ${rows.length}`);
  }
  console.log(`\r  ${rows.length} rows with composite.colorFamily.        \n`);

  const violations = [];
  const stats = {
    "matched-verified": 0,
    "matched-probable": 0,
    "no-ladder": 0,
    "color-not-in-ladder": 0,
    "impossible-serial": 0,
    "no-product-map": 0,
  };
  const impossibleByColor = {};

  for (const r of rows) {
    const parts = String(r.hobbyiqCardId ?? "").split(":");
    if (parts.length < 4) { stats["no-product-map"]++; continue; }
    const setKey = parts[3];
    const product = slugSetKeyToProduct(setKey);
    if (!product) { stats["no-product-map"]++; continue; }

    const v = validateAgainstLadder(product, r.cardYear, r.composite.colorFamily, r.printRun ?? null);
    stats[v.verdict] = (stats[v.verdict] ?? 0) + 1;
    if (v.verdict === "impossible-serial") {
      const key = `${product} ${r.composite.colorFamily}`;
      impossibleByColor[key] = (impossibleByColor[key] ?? 0) + 1;
      if (violations.length < 30) {
        violations.push({
          slug: r.hobbyiqCardId,
          product,
          color: r.composite.colorFamily,
          expected: v.expectedRun,
          observed: v.observedRun,
          title: String(r.title ?? "").slice(0, 80),
        });
      }
    }
  }

  console.log(`\n═══ Ladder validation stats ═══`);
  Object.entries(stats).forEach(([k, v]) => console.log(`  ${String(v).padStart(8)}  ${k}`));

  if (stats["impossible-serial"] > 0) {
    console.log(`\n═══ Impossible-serial breakdown (top 20 by product+color) ═══`);
    Object.entries(impossibleByColor)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));
    console.log(`\n═══ Sample violations (up to 30) ═══`);
    violations.forEach(v => {
      console.log(`  ${v.product} ${v.color}: expected /${v.expected}, observed /${v.observed}`);
      console.log(`    slug: ${v.slug}`);
      console.log(`    title: ${v.title}`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
