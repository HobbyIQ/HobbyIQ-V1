const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const portfolio = db.container("portfolio");

  // holdings is a MAP (Record<id, holding>), not an array. Iterate values.
  const { resources: users } = await portfolio.items.query({
    query: "SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)",
  }, { enableCrossPartitionQuery: true }).fetchAll();

  console.log(`Users: ${users.length}`);
  let matched = null;
  for (const u of users) {
    const map = u.holdings || {};
    const entries = Object.entries(map);
    if (entries.length > 0) {
      console.log(`  user=${u.userId} holdings-map size=${entries.length}`);
    }
    for (const [hid, h] of entries) {
      const scan = JSON.stringify(h).toLowerCase();
      if (scan.includes("figueroa") || scan.includes("cpa-vf")) {
        console.log(`\nMATCH user=${u.userId} holdingId=${hid}`);
        console.log(JSON.stringify(h, null, 2));
        matched = { userId: u.userId, holding: h };
      }
    }
  }

  if (!matched) return;

  // Now dig into sold_comps for this cardId.
  const cardId = matched.holding.cardId;
  console.log(`\n=== SOLD_COMPS FOR cardId=${cardId} (grouped by parallel) ===`);
  const sold = db.container("sold_comps");
  const { resources: comps } = await sold.items.query({
    query: "SELECT c.parallel, c.price, c.soldAt, c.title, c.source, c.contributorUserId, c.printRun, c.isAuto FROM c WHERE c.cardId = @cid",
    parameters: [{ name: "@cid", value: cardId }],
  }, { partitionKey: cardId }).fetchAll();

  const byParallel = new Map();
  for (const c of comps) {
    const key = (c.parallel || "(none)").toString();
    let arr = byParallel.get(key);
    if (!arr) { arr = []; byParallel.set(key, arr); }
    arr.push(c);
  }
  for (const [parallel, rows] of [...byParallel.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const prices = rows.map(r => r.price).filter(p => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
    const med = prices.length > 0 ? prices[Math.floor(prices.length / 2)] : null;
    console.log(`  n=${rows.length} med=$${med?.toFixed(2) ?? "-"} range=$${prices[0]?.toFixed(2) ?? "-"}-$${prices[prices.length - 1]?.toFixed(2) ?? "-"} parallel=${JSON.stringify(parallel)}`);
  }
  console.log(`\nTotal comps for cardId: ${comps.length}`);

  // Red Ink SSP anywhere in sold_comps
  console.log(`\n=== 'Red Ink' or 'CPA-VF' matches across ALL sold_comps ===`);
  const { resources: bwri } = await sold.items.query({
    query: "SELECT TOP 30 c.cardId, c.parallel, c.price, c.soldAt, c.title, c.source, c.cardNumber FROM c WHERE CONTAINS(LOWER(c.title ?? ''), 'red ink') OR CONTAINS(LOWER(c.parallel ?? ''), 'red ink') OR UPPER(c.cardNumber ?? '') = 'CPA-VF'",
  }, { enableCrossPartitionQuery: true }).fetchAll();
  for (const r of bwri) {
    console.log(`  ${r.soldAt?.slice(0, 10)} #${r.cardNumber || "?"} $${r.price} src=${r.source} parallel="${r.parallel || ""}" title="${(r.title || "").slice(0, 80)}"`);
  }
  console.log(`  ${bwri.length} matching rows`);

  // Card catalog — "set" is a reserved word in Cosmos SQL, bracket-quote it
  console.log(`\n=== card_catalog rows for CPA-VF ===`);
  const catalog = db.container("card_catalog");
  const { resources: catRows } = await catalog.items.query({
    query: 'SELECT c.id, c.hobbyiqCardId, c.player, c.year, c["set"] AS setName, c.parallel, c.cardNumber, c.isAuto, c.printRun, c.source FROM c WHERE UPPER(c.cardNumber ?? "") = "CPA-VF" OR CONTAINS(LOWER(c.id ?? ""), "cpa-vf") OR CONTAINS(LOWER(c.hobbyiqCardId ?? ""), "cpa-vf")',
  }, { enableCrossPartitionQuery: true }).fetchAll();
  for (const r of catRows) {
    console.log(`  id=${r.id} year=${r.year} set="${r.setName}" parallel="${r.parallel || ""}" hobbyiqCardId=${r.hobbyiqCardId} source=${r.source}`);
  }
  console.log(`  ${catRows.length} catalog rows total`);

  // Sold-comps for the specific hobbyiqCardId slug
  console.log(`\n=== sold_comps for hobbyiqCardId=${matched.holding.hobbyiqCardId} ===`);
  const { resources: hiqComps } = await sold.items.query({
    query: "SELECT c.cardId, c.parallel, c.price, c.soldAt, c.title, c.source FROM c WHERE c.hobbyiqCardId = @hiq",
    parameters: [{ name: "@hiq", value: matched.holding.hobbyiqCardId }],
  }, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`  ${hiqComps.length} comps for this slug`);
  for (const r of hiqComps.slice(0, 10)) {
    console.log(`  ${r.soldAt?.slice(0, 10)} $${r.price} src=${r.source} parallel="${r.parallel || ""}" title="${(r.title || "").slice(0, 80)}"`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
