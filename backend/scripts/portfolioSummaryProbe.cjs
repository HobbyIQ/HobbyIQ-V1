const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database("hobbyiq");
  const portfolio = db.container("portfolio");
  const USER = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

  const { resource: doc } = await portfolio.item(USER, USER).read();
  const holdings = Object.values(doc?.holdings || {});

  let totalCost = 0, totalValue = 0;
  let n = 0, noFmv = 0, extreme = 0;
  const rows = [];
  for (const h of holdings) {
    if ((h.cardStatus === "sold") || h.deleted) continue;
    n++;
    const qty = Math.max(1, h.quantity ?? 1);
    const cost = (h.totalCostBasis ?? (h.purchasePrice ?? 0) * qty) || 0;
    const fmv = h.fairMarketValue != null ? h.fairMarketValue * qty : null;
    const est = h.estimatedValue != null ? h.estimatedValue * qty : null;
    const display = fmv != null ? fmv : est;
    totalCost += cost;
    if (display != null) totalValue += display; else noFmv++;
    rows.push({
      id: h.id?.slice(0, 8),
      title: (h.cardTitle || h.playerName || "?").slice(0, 50),
      grade: h.gradeCompany ? `${h.gradeCompany} ${h.gradeValue}` : "Raw",
      cost: cost.toFixed(2),
      fmv: fmv != null ? fmv.toFixed(2) : "-",
      est: est != null ? est.toFixed(2) : "-",
      display: display != null ? display.toFixed(2) : "-",
      pl: display != null ? (display - cost).toFixed(2) : "-",
      valuationStatus: h.valuationStatus || "?",
      pricingSource: h.pricingSource || "?",
      lastUpdated: h.lastUpdated?.slice(0, 16),
    });
  }
  console.log(`Holdings: ${n}, no-fmv: ${noFmv}, extreme ratio (>5x or <10%): ${extreme}`);
  console.log(`Total cost: $${totalCost.toFixed(2)}, Total value: $${totalValue.toFixed(2)}, P/L: $${(totalValue - totalCost).toFixed(2)}`);
  console.log("\n=== Per-holding (sorted by |P/L| desc) ===");
  rows.sort((a, b) => {
    const av = Math.abs(Number(a.pl) || 0), bv = Math.abs(Number(b.pl) || 0);
    return bv - av;
  });
  console.log("ID       | GRADE     | COST     | FMV      | EST      | DISPLAY  | P/L        | STATUS     | SOURCE          | TITLE");
  for (const r of rows) {
    console.log(`${r.id.padEnd(8)} | ${r.grade.padEnd(9)} | ${r.cost.padStart(8)} | ${r.fmv.padStart(8)} | ${r.est.padStart(8)} | ${r.display.padStart(8)} | ${(r.pl || "-").padStart(9)}  | ${r.valuationStatus.padEnd(10)} | ${r.pricingSource.padEnd(15)} | ${r.title}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
