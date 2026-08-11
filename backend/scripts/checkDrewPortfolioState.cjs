// Sanity check Drew's portfolio: which holdings have valid catalog rows
// vs which are MISSING or misaligned. Post-night-of-changes.
const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const portfolio = db.container("portfolio");
  const catalog = db.container("card_catalog");
  const sold = db.container("sold_comps");
  const DREW = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

  const { resource: doc } = await portfolio.item(DREW, DREW).read();
  const holdings = doc.holdings || {};
  const entries = Object.entries(holdings);
  console.log(`[Drew's portfolio] ${entries.length} holdings`);

  let missingSlug = 0, hasSlug = 0, catalogHit = 0, catalogMiss = 0, compsHit = 0, compsThin = 0;
  const catalogMissRows = [];
  const compsThinRows = [];

  for (const [hid, h] of entries) {
    const slug = h.hobbyiqCardId;
    if (!slug) { missingSlug++; continue; }
    hasSlug++;

    // catalog check
    const cq = await catalog.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s`,
      parameters: [{ name: "@s", value: slug }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    const inCatalog = (cq.resources[0] || 0) > 0;
    if (inCatalog) catalogHit++;
    else { catalogMiss++; catalogMissRows.push({ hid, slug, player: h.playerName, title: h.cardTitle }); }

    // sold_comps check
    const sq = await sold.items.query({
      query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s`,
      parameters: [{ name: "@s", value: slug }],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    const nComps = sq.resources[0] || 0;
    if (nComps >= 3) compsHit++;
    else { compsThin++; compsThinRows.push({ hid, slug, player: h.playerName, nComps }); }
  }

  console.log(`\n== summary ==`);
  console.log(`  missing slug:          ${missingSlug}/${entries.length}`);
  console.log(`  has slug:              ${hasSlug}/${entries.length}`);
  console.log(`    catalog hit:         ${catalogHit}/${hasSlug}`);
  console.log(`    catalog miss:        ${catalogMiss}/${hasSlug}`);
  console.log(`    sold_comps thin (<3): ${compsThin}/${hasSlug}`);
  console.log(`    sold_comps hit (>=3): ${compsHit}/${hasSlug}`);

  if (catalogMissRows.length > 0) {
    console.log(`\n== catalog-miss holdings (won't render clean identity) ==`);
    for (const r of catalogMissRows.slice(0, 20)) {
      console.log(`  ${r.hid.slice(0,8)}  ${r.slug}`);
      console.log(`    player=${r.player}  title="${(r.title||"").slice(0,80)}"`);
    }
  }
  if (compsThinRows.length > 0) {
    console.log(`\n== thin-comp holdings (may not price well) ==`);
    for (const r of compsThinRows.slice(0, 20)) {
      console.log(`  ${r.slug}  n=${r.nComps}  ${r.player}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
