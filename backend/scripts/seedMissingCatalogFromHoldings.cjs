// Create catalog stubs for slugs referenced by holdings but missing from catalog.
// Uses holding.playerName + parsed slug identity to build the row.
const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const {
  deriveCatalogEntry,
  upsertCatalogEntry,
} = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "cardCatalog.service.js"));

const APPLY = process.env.APPLY === "true";

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const db = new CosmosClient(conn).database("hobbyiq");
  const portfolio = db.container("portfolio");
  const catalog = db.container("card_catalog");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}`);

  const { resources: docs } = await portfolio.items.query({
    query: `SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)`,
  }, { enableCrossPartitionQuery: true }).fetchAll();

  // Build slug → holding (first match wins)
  const slugToHolding = new Map();
  for (const d of docs) {
    for (const h of Object.values(d.holdings || {})) {
      if (!h.hobbyiqCardId) continue;
      if (!slugToHolding.has(h.hobbyiqCardId)) slugToHolding.set(h.hobbyiqCardId, { h, userId: d.userId });
    }
  }
  console.log(`  ${slugToHolding.size} unique slugs from holdings`);

  let created = 0, exists = 0, failed = 0;
  for (const [slug, { h, userId }] of slugToHolding) {
    // Check catalog
    const cq = await catalog.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.id = @s OR c.hobbyiqCardId = @s`,
      parameters: [{ name: "@s", value: slug }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    if ((cq.resources[0] || 0) > 0) { exists++; continue; }

    // Parse slug
    const parts = slug.split(":");
    if (parts.length < 7) continue;
    const [_, sport, yearStr, setKey, cardNumber, parallel, autoFlag, tail] = parts;
    const year = Number(yearStr);
    const isAuto = autoFlag === "auto";
    const printRun = tail && tail.startsWith("num-") ? Number(tail.slice(4)) : (h.printRun ?? null);
    const parallelDisplay = h.parallel || parallel.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    const entry = deriveCatalogEntry({
      sport, year,
      setKey: h.setName || h.product || setKey,
      cardNumber,
      parallel: parallelDisplay,
      isAuto,
      printRun: Number.isFinite(printRun) && printRun > 0 ? printRun : null,
      playerName: h.playerName || "Unknown",
      source: `holding-seeded-${new Date().toISOString().slice(0,10)}`,
      confidence: "medium",
      vendorIds: {},
    });
    if (!entry) { failed++; continue; }
    // If the generator produced a DIFFERENT slug from what we wanted,
    // don't create a stub — that means the holding's slug doesn't match
    // its own fields (a separate fix needed).
    if (entry.id !== slug) {
      console.log(`  SKIP ${slug} — generator wants ${entry.id} from same fields`);
      failed++;
      continue;
    }

    console.log(`  ${APPLY ? "creating" : "would create"}  ${slug}  ${h.playerName}`);
    if (APPLY) {
      try { await upsertCatalogEntry(entry); created++; }
      catch (err) { failed++; console.warn(`    fail: ${err.message||err}`); }
    } else {
      created++;
    }
  }

  console.log(`\n[done] created=${created} exists=${exists} failed=${failed}`);
}
main().catch(e => { console.error(e); process.exit(1); });
