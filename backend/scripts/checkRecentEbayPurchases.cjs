// Check recent eBay-imported holdings for image enrichment state
const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const portfolio = client.database("hobbyiq").container("portfolio");
  const { resources } = await portfolio.items.query({
    query: `SELECT * FROM c WHERE IS_DEFINED(c.holdings)`,
  }, { enableCrossPartitionQuery: true }).fetchAll();

  const rows = [];
  for (const doc of resources) {
    for (const [hid, h] of Object.entries(doc.holdings || {})) {
      if (h.source === "ebay-auto" || (h.notes && String(h.notes).includes("eBay purchase"))) {
        rows.push({
          userId: doc.userId?.slice(-8),
          hid: hid.slice(0, 8),
          addedAt: h.addedAt,
          hasPhotos: Array.isArray(h.photos) && h.photos.length > 0,
          photoCount: (h.photos || []).length,
          ebayImageUrl: !!h.ebayImageUrl,
          enrichedFromEbay: !!h.enrichedFromEbay,
          player: (h.playerName || "").slice(0, 30),
          title: (h.cardTitle || "").slice(0, 60),
        });
      }
    }
  }
  rows.sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));

  console.log(`[${rows.length} ebay-imported holdings]`);
  console.log(`\n== summary ==`);
  const withPhotos = rows.filter((r) => r.hasPhotos).length;
  const enriched = rows.filter((r) => r.enrichedFromEbay).length;
  console.log(`  with photos: ${withPhotos}/${rows.length}`);
  console.log(`  enrichedFromEbay=true: ${enriched}/${rows.length}`);
  console.log(`\n== last 20 imports ==`);
  for (const r of rows.slice(0, 20)) {
    const flag = r.hasPhotos ? "📷" : "❌";
    console.log(`  ${r.addedAt?.slice(0,19)}  ${flag}  photos=${r.photoCount} enriched=${r.enrichedFromEbay}  ${r.player}  "${r.title}"`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
