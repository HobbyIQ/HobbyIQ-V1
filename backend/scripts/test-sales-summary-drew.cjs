/**
 * Quick verification: for each of Drew's holdings, look up the catalog
 * row (canonical slug) and show what a salesSummary WOULD contain.
 * Read-only — no writes.
 */
const { CosmosClient } = require("@azure/cosmos");

function median(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database("hobbyiq");
  const portfolio = db.container("portfolio");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  const USER = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";
  const { resource: doc } = await portfolio.item(USER, USER).read();
  const holdings = Object.values(doc.holdings ?? {});

  const now = Date.now();
  const c30 = now - 30 * 86400_000;
  const c90 = now - 90 * 86400_000;
  const c180 = now - 180 * 86400_000;

  console.log(`\n▸ Sales-summary preview per Drew's holdings:\n`);
  console.log(`${"card".padEnd(58)} ${"n".padStart(5)}  ${"30d".padStart(8)} ${"90d".padStart(8)} ${"180d".padStart(8)}  trend`);

  for (const h of holdings) {
    if (h.cardStatus === "pending-review") continue;
    const cardId = h.cardId ?? h.hobbyiqCardId;
    if (!cardId) continue;

    const { resources } = await sold.items.query({
      query: "SELECT c.price, c.soldAt FROM c WHERE (c.cardId = @cid OR c.hobbyiqCardId = @cid) AND c.price > 0",
      parameters: [{ name: "@cid", value: cardId }],
    }, { maxItemCount: 500 }).fetchAll();

    const px30 = [], px90 = [], px180 = [];
    for (const r of resources) {
      const t = Date.parse(r.soldAt);
      if (!Number.isFinite(t)) continue;
      if (t >= c30) px30.push(r.price);
      if (t >= c90) px90.push(r.price);
      if (t >= c180) px180.push(r.price);
    }
    const m30 = median(px30);
    const m90 = median(px90);
    const m180 = median(px180);
    let trend = "flat";
    if (m30 !== null && m90 !== null && m90 > 0) {
      const pct = (m30 / m90 - 1) * 100;
      if (pct > 1) trend = `↑ ${pct.toFixed(1)}%`;
      else if (pct < -1) trend = `↓ ${Math.abs(pct).toFixed(1)}%`;
    }

    const title = (h.playerName ?? "?") + " " + (h.cardYear ?? "") + " " + (h.product ?? h.setName ?? "") + " #" + (h.cardNumber ?? "?");
    console.log(
      `${title.slice(0, 58).padEnd(58)} ${String(resources.length).padStart(5)}  ${(m30 !== null ? "$" + m30.toFixed(0) : "-").padStart(8)} ${(m90 !== null ? "$" + m90.toFixed(0) : "-").padStart(8)} ${(m180 !== null ? "$" + m180.toFixed(0) : "-").padStart(8)}  ${trend}`,
    );
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
