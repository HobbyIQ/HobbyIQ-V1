// CF-OBSERVED-NEEDS-COMPS sweep (2026-08-22).
//
// The Caminiti card showed $4.99 against a $205.40 cost because a cross-setkey
// rung found ONE comp and published it as an observed fair market value. This
// finds every other holding in the same state.
//
// Read-only. Reports, changes nothing.
const { CosmosClient } = require("@azure/cosmos");

const MIN_COMPS = Number(process.env.MIN_COMPS || 3);

const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
  .database("hobbyiq")
  .container("portfolio");

const money = (n) =>
  n == null || !Number.isFinite(Number(n)) ? "—" : "$" + Number(n).toFixed(2);

(async () => {
  const { resources } = await c.items
    .query({ query: "SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" })
    .fetchAll();

  const affected = [];
  let totalHoldings = 0;
  let ourPoolPriced = 0;
  const byMethod = new Map();

  for (const doc of resources) {
    for (const [hid, h] of Object.entries(doc.holdings || {})) {
      totalHoldings++;
      const meta = h?.pricingSourceMeta;
      if (!meta || h?.pricingSource !== "our-pool") continue;
      ourPoolPriced++;

      const method = String(meta.method ?? "?");
      const comps = Number(meta.compsUsed ?? 0);
      const broad = method !== "direct-slug";
      const key = method + (broad && comps < MIN_COMPS ? "  [THIN]" : "");
      byMethod.set(key, (byMethod.get(key) ?? 0) + 1);

      // The defect: a BROAD rung, under the comp floor, presented as observed.
      if (!broad || comps >= MIN_COMPS) continue;
      if (h?.valuationStatus !== "observed") continue;

      const value = Number(h.predictedPrice ?? h.fairMarketValue ?? NaN);
      const cost = Number(h.totalCostBasis ?? h.purchasePrice ?? NaN);
      const pnlPct =
        Number.isFinite(value) && Number.isFinite(cost) && cost > 0
          ? ((value - cost) / cost) * 100
          : null;

      affected.push({
        userId: doc.userId,
        hid,
        title: String(h.cardTitle ?? h.playerName ?? "?").slice(0, 54),
        parallel: String(h.parallel ?? "—").slice(0, 22),
        method,
        comps,
        value,
        cost,
        pnlPct,
      });
    }
  }

  console.log("holdings scanned:            " + totalHoldings);
  console.log("priced from our-pool:        " + ourPoolPriced);
  console.log("comp floor under test:       " + MIN_COMPS + " (broad rungs only)");
  console.log("");
  console.log("rung distribution:");
  for (const [k, n] of [...byMethod.entries()].sort((a, b) => b[1] - a[1])) {
    console.log("   " + String(n).padStart(5) + "  " + k);
  }

  console.log("");
  console.log("AFFECTED — broad rung, under the floor, published as OBSERVED: " + affected.length);
  if (!affected.length) return;

  // Worst first: the ones a user is most likely to notice are the big
  // negative swings against a real cost basis.
  affected.sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0));

  console.log("");
  console.log(
    "  " + "value".padStart(10) + "  " + "cost".padStart(10) + "  " +
    "P&L".padStart(9) + "  n  " + "method".padEnd(18) + "  card",
  );
  for (const a of affected.slice(0, 40)) {
    console.log(
      "  " + money(a.value).padStart(10) +
      "  " + money(a.cost).padStart(10) +
      "  " + (a.pnlPct == null ? "—" : a.pnlPct.toFixed(1) + "%").padStart(9) +
      "  " + String(a.comps) +
      "  " + a.method.padEnd(18) +
      "  " + a.title + (a.parallel !== "—" ? "  [" + a.parallel + "]" : ""),
    );
  }
  if (affected.length > 40) {
    console.log("  … and " + (affected.length - 40) + " more not shown");
  }

  const withCost = affected.filter((a) => Number.isFinite(a.cost) && a.cost > 0);
  const understated = withCost.filter((a) => a.pnlPct != null && a.pnlPct < -50);
  console.log("");
  console.log("  with a real cost basis:            " + withCost.length);
  console.log("  showing worse than -50% P&L:       " + understated.length);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
