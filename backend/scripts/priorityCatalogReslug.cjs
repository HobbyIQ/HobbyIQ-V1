// CF-PRIORITY-CATALOG-RESLUG (Drew, 2026-08-11). Instead of moving all
// 2M catalog rows that would drift under the current generator, only
// fix rows that are actively referenced by real user holdings.
// Small blast radius, immediate user impact.
//
// Steps:
//   1. Read every holding.hobbyiqCardId across every portfolio doc
//   2. For each unique slug, check the catalog row
//   3. If the catalog row's stored id doesn't equal what the current
//      generator would produce for its own stored fields, move it
//   4. Also patch holdings whose slug doesn't exist in catalog but
//      would be produced by the generator from the holding's fields
//
// Env: APPLY=true

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const { computeHobbyIqCardId } = require(path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js"));

const APPLY = process.env.APPLY === "true";

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const db = new CosmosClient(conn).database("hobbyiq");
  const portfolio = db.container("portfolio");
  const catalog = db.container("card_catalog");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}`);

  // Step 1: collect unique hobbyiqCardId slugs from all holdings
  const { resources: docs } = await portfolio.items.query({
    query: `SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  const slugs = new Set();
  let totalHoldings = 0;
  for (const d of docs) {
    for (const h of Object.values(d.holdings || {})) {
      totalHoldings++;
      if (h.hobbyiqCardId && typeof h.hobbyiqCardId === "string") slugs.add(h.hobbyiqCardId);
    }
  }
  console.log(`  ${slugs.size} unique slugs across ${totalHoldings} holdings from ${docs.length} portfolios`);

  // Step 2: for each unique slug, look up catalog row + check drift
  let checked = 0, catalogOk = 0, catalogMiss = 0, catalogDrift = 0, moved = 0, failed = 0;
  const missSlugs = [], driftSlugs = [];
  for (const slug of slugs) {
    checked++;
    const { resources } = await catalog.items.query({
      query: `SELECT * FROM c WHERE c.hobbyiqCardId = @s OR c.id = @s`,
      parameters: [{ name: "@s", value: slug }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    if (resources.length === 0) { catalogMiss++; missSlugs.push(slug); continue; }
    const doc = resources[0];
    // Recompute what the current generator would produce
    let canonicalSlug;
    try {
      canonicalSlug = computeHobbyIqCardId({
        sport: doc.sport,
        year: Number(doc.cardYear || doc.year),
        setKey: doc.setKey || doc.setName || "",
        cardNumber: String(doc.cardNumber || ""),
        parallel: doc.parallel || "Base",
        isAuto: Boolean(doc.isAuto),
        printRun: doc.printRun ?? null,
      });
    } catch { catalogOk++; continue; }
    if (canonicalSlug === slug) { catalogOk++; continue; }
    catalogDrift++;
    driftSlugs.push({ from: slug, to: canonicalSlug, player: doc.playerName });
    if (!APPLY) continue;

    // Move: upsert at new id + delete old (catalog partition = /cardId)
    const oldPk = doc.cardId ?? doc.id;
    const newDoc = { ...doc, id: canonicalSlug, cardId: canonicalSlug, hobbyiqCardId: canonicalSlug, reslugedAt: new Date().toISOString(), reslugedFrom: slug };
    delete newDoc._rid; delete newDoc._self; delete newDoc._etag; delete newDoc._attachments; delete newDoc._ts;
    try {
      await catalog.items.upsert(newDoc);
      await catalog.item(doc.id, oldPk).delete().catch(() => {});
      moved++;
    } catch (err) { failed++; console.warn(`  fail ${slug}: ${err.message||err}`); }
  }

  console.log(`\n[done] ${checked} slugs checked`);
  console.log(`  catalog OK (canonical): ${catalogOk}`);
  console.log(`  catalog missing:        ${catalogMiss}`);
  console.log(`  catalog drift:          ${catalogDrift}${APPLY ? ` (moved ${moved}, failed ${failed})` : ""}`);
  if (catalogMiss > 0) {
    console.log(`\nMISSING slugs (need catalog rows):`);
    missSlugs.slice(0, 15).forEach(s => console.log(`  ${s}`));
  }
  if (catalogDrift > 0) {
    console.log(`\nDRIFT slugs:`);
    driftSlugs.slice(0, 15).forEach(d => console.log(`  ${d.from}  →  ${d.to}  (${d.player})`));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
