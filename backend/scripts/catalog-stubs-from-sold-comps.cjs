// CF-CATALOG-STUBS-FROM-SOLD-COMPS (Drew, 2026-08-10). Fallback catalog
// coverage for products where no authoritative checklist source works
// (basketball/football/hockey are blocked without Puppeteer + Beckett).
//
// Strategy: for each distinct hobbyiqCardId in sold_comps that has NO
// catalog row AND meets a min-comp-count threshold, insert a stub
// catalog row. The playerName is derived from the most common
// vendor-reported playerName across the sold_comps of that slug.
//
// Stub rows are marked source="sold-comps-stub-YYYY-MM-DD" so they can
// be identified + upgraded once an authoritative checklist arrives.
// The stub row's identity fields (year, setKey, cardNumber, parallel,
// isAuto, printRun) come from the slug — those are already canonical
// via the generator, so the stub isn't guessing structure, only player.
//
// Scope: PRODUCT WHITELIST env for safety. Default = no products (require
// explicit opt-in to prevent overwriting authoritative catalog).
//
// Env:
//   APPLY=true                  write to catalog
//   PRODUCTS="sport:year:setKey,sport:year:setKey"   comma-separated product keys
//   MIN_COMPS=5                 min sold_comps per slug to consider
//   MAX_PER_PRODUCT=1000        cap for safety

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const {
  deriveCatalogEntry,
  upsertCatalogEntry,
} = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "cardCatalog.service.js"));

const APPLY = process.env.APPLY === "true";
const PRODUCTS = (process.env.PRODUCTS || "").split(",").map((s) => s.trim()).filter(Boolean);
const MIN_COMPS = Number(process.env.MIN_COMPS || 5);
const MAX_PER_PRODUCT = Number(process.env.MAX_PER_PRODUCT || 1000);

if (PRODUCTS.length === 0) {
  console.error("PRODUCTS required — e.g. PRODUCTS=basketball:2019:panini-select,football:2025:panini");
  process.exit(2);
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const db = new CosmosClient(conn).database("hobbyiq");
  const sold = db.container("sold_comps");
  const catalog = db.container("card_catalog");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}  products=${PRODUCTS.length}  minComps=${MIN_COMPS}`);

  let totalWrote = 0, totalSkipExisting = 0, totalMissingPlayer = 0;
  for (const prod of PRODUCTS) {
    const [sport, yearStr, setKey] = prod.split(":");
    const year = Number(yearStr);
    if (!sport || !year || !setKey) { console.warn(`  skip malformed: ${prod}`); continue; }
    console.log(`\n=== ${sport}/${year}/${setKey} ===`);
    const prefix = `hiq:${sport}:${year}:${setKey}:`;

    // 1. Aggregate sold_comps for this product: distinct slugs + top playerName per slug
    const q = await sold.items.query({
      query: `SELECT c.hobbyiqCardId, c.playerName FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)`,
      parameters: [{ name: "@p", value: prefix }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    console.log(`  ${q.resources.length} sold_comps rows`);

    // Group by slug, count + collect playerNames
    const slugMap = new Map();
    for (const r of q.resources) {
      const s = slugMap.get(r.hobbyiqCardId) ?? { count: 0, players: new Map() };
      s.count++;
      const pn = String(r.playerName || "").trim();
      if (pn && pn.length > 1) s.players.set(pn, (s.players.get(pn) || 0) + 1);
      slugMap.set(r.hobbyiqCardId, s);
    }
    const eligible = [...slugMap.entries()].filter(([_, v]) => v.count >= MIN_COMPS);
    console.log(`  ${slugMap.size} distinct slugs, ${eligible.length} above threshold`);

    // 2. For each eligible slug, check if catalog already has it; if not,
    //    upsert a stub with the most-common playerName.
    let wrote = 0, skipped = 0, missingPlayer = 0;
    for (const [slug, agg] of eligible.slice(0, MAX_PER_PRODUCT)) {
      // Pick highest-count playerName
      const topPlayer = [...agg.players.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (!topPlayer) { missingPlayer++; continue; }

      // Check catalog
      const cq = await catalog.items.query({
        query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s`,
        parameters: [{ name: "@s", value: slug }],
      }, { enableCrossPartitionQuery: true }).fetchAll();
      if ((cq.resources[0] || 0) > 0) { skipped++; continue; }

      // Parse slug parts to derive
      const parts = slug.split(":");
      const cardNumber = parts[4] || "";
      const parallel = parts[5] || "Base";
      const autoFlag = parts[6] || "no-auto";
      const printRun = parts[7] && parts[7].startsWith("num-") ? Number(parts[7].slice(4)) : null;

      const entry = deriveCatalogEntry({
        sport, year, setKey,
        cardNumber, parallel, isAuto: autoFlag === "auto", printRun,
        playerName: topPlayer,
        source: `sold-comps-stub-${new Date().toISOString().slice(0, 10)}`,
        confidence: "low",
        vendorIds: {},
      });
      if (!entry) { missingPlayer++; continue; }

      if (APPLY) {
        try {
          await upsertCatalogEntry(entry);
          wrote++;
        } catch (err) {
          console.warn(`    fail ${entry.id}: ${err.message||err}`);
        }
      } else {
        if (wrote < 5) console.log(`    ${slug}  →  ${topPlayer}`);
        wrote++;
      }
    }
    console.log(`  ${APPLY ? "wrote" : "would write"}=${wrote}  skipped-existing=${skipped}  missing-player=${missingPlayer}`);
    totalWrote += wrote; totalSkipExisting += skipped; totalMissingPlayer += missingPlayer;
  }

  console.log(`\n[done] ${APPLY ? "wrote" : "would write"}=${totalWrote}  skipped-existing=${totalSkipExisting}  missing-player=${totalMissingPlayer}`);
}
main().catch(e => { console.error(e); process.exit(1); });
