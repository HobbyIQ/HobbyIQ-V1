/* Investigation script: Victor Figueroa Black & White Red Ink CPA-VF */
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING missing"); process.exit(1); }
  const client = new CosmosClient(conn);
  const db = client.database("hobbyiq");

  // Try a Cosmos JOIN across nested holdings for the specific match.
  const portfolio = db.container("portfolio");
  const q1 = {
    query: "SELECT c.userId, h FROM c JOIN h IN c.holdings WHERE CONTAINS(LOWER(h.cardTitle ?? ''), 'figueroa') OR CONTAINS(LOWER(h.playerName ?? ''), 'figueroa') OR UPPER(h.cardNumber ?? '') = 'CPA-VF'",
  };
  const { resources: hits } = await portfolio.items.query(q1, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`Direct JOIN hits: ${hits.length}`);
  for (const r of hits.slice(0, 20)) {
    console.log(`  user=${r.userId} title="${r.h.cardTitle}" player="${r.h.playerName}" cardId=${r.h.cardId} parallel="${r.h.parallel}" fmv=${r.h.fairMarketValue}`);
  }

  if (hits.length === 0) {
    // Try full raw scan just for the specific card
    console.log("\nDoing raw scan of portfolio holdings...");
    const { resources: allUsers } = await portfolio.items.query("SELECT * FROM c", { enableCrossPartitionQuery: true }).fetchAll();
    console.log(`Total user docs: ${allUsers.length}`);
    let holdingsTotal = 0;
    for (const u of allUsers) {
      const list = Array.isArray(u.holdings) ? u.holdings
        : Array.isArray(u.portfolio?.holdings) ? u.portfolio.holdings
        : [];
      holdingsTotal += list.length;
      console.log(`  user=${u.userId ?? u.id} holdings=${list.length} keys=[${Object.keys(u).slice(0, 20).join(",")}]`);
      for (const h of list) {
        const scan = JSON.stringify(h).toLowerCase();
        if (scan.includes("figueroa") || scan.includes("cpa-vf")) {
          console.log(`  MATCH: user=${u.userId ?? u.id} holding=${h.id}`);
          console.log(JSON.stringify(h, null, 2).slice(0, 2000));
        }
      }
    }
    console.log(`Total holdings scanned: ${holdingsTotal}`);
    return;
  }

  // Assume first hit is Drew's holding.
  const h = hits[0].h;
  const cardId = h.cardId;

  console.log(`\n=== SOLD_COMPS FOR cardId=${cardId} (grouped by parallel) ===`);
  const sold = db.container("sold_comps");
  const compsQuery = {
    query: "SELECT c.parallel, c.price, c.soldAt, c.title, c.source, c.contributorUserId, c.printRun, c.isAuto FROM c WHERE c.cardId = @cid ORDER BY c.soldAt DESC",
    parameters: [{ name: "@cid", value: cardId }],
  };
  const { resources: comps } = await sold.items.query(compsQuery, { partitionKey: cardId }).fetchAll();

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
    console.log(`  parallel=${JSON.stringify(parallel)} n=${rows.length} med=$${med?.toFixed(2) ?? "-"} range=$${prices[0]?.toFixed(2) ?? "-"}-$${prices[prices.length - 1]?.toFixed(2) ?? "-"}`);
  }

  console.log(`\nTotal comps for cardId: ${comps.length}`);

  // Look for Black & White Red Ink or "Red Ink" or "SSP" across sold_comps.
  console.log("\n=== 'Red Ink' matches across sold_comps ===");
  const bwriQuery = {
    query: "SELECT TOP 30 c.cardId, c.parallel, c.price, c.soldAt, c.title, c.source, c.cardNumber, c.printRun FROM c WHERE CONTAINS(LOWER(c.parallel ?? ''), 'red ink') OR CONTAINS(LOWER(c.title ?? ''), 'red ink')",
  };
  const { resources: bwri } = await sold.items.query(bwriQuery, { enableCrossPartitionQuery: true }).fetchAll();
  console.log(`  ${bwri.length} Red Ink comps in sold_comps`);
  for (const r of bwri.slice(0, 20)) {
    console.log(`  ${r.soldAt?.slice(0, 10)} #${r.cardNumber || "?"} $${r.price} src=${r.source} parallel="${r.parallel || ""}" title="${(r.title || "").slice(0, 80)}"`);
  }

  // Card catalog check.
  console.log("\n=== CARD_CATALOG entries for #CPA-VF ===");
  const catalog = db.container("card_catalog");
  const catQuery = {
    query: "SELECT c.id, c.hobbyiqCardId, c.player, c.year, c.set, c.parallel, c.cardNumber, c.isAuto, c.printRun, c.source FROM c WHERE UPPER(c.cardNumber ?? '') = 'CPA-VF'",
  };
  const { resources: catRows } = await catalog.items.query(catQuery, { enableCrossPartitionQuery: true }).fetchAll();
  for (const r of catRows.slice(0, 30)) {
    console.log(`  id=${r.id} year=${r.year} parallel="${r.parallel || ""}" hobbyiqCardId="${r.hobbyiqCardId || ""}"`);
  }
  console.log(`  ${catRows.length} catalog rows total`);
}

main().catch(err => { console.error(err); process.exit(1); });
