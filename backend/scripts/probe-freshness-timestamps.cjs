// CF-PORTFOLIOHOLDING-FIELD-PRUNE Phase C — read-only probe for freshness
// timestamp coverage in production portfolio holdings.
//
// Counts, across all holdings of all users in the 'portfolio' container:
//   - total holdings
//   - holdings with predictedPriceUpdatedAt != null
//   - holdings with movementUpdatedAt != null
//   - holdings with neither (would fall to "Needs refresh" under the new recipe)
//   - holdings with lastUpdated > predictedPriceUpdatedAt by > 1h (potential
//     reprice-FAILURE candidates — lastUpdated bumped but pricing-timestamp
//     frozen; the exact case the recipe is designed to surface honestly)
//
// Usage:
//   $env:COSMOS_CONNECTION_STRING = "<conn-str>"
//   node backend/scripts/probe-freshness-timestamps.cjs
//
// Drew runs this; agent shell does not carry production credentials.
// Read-only: containers.readAll() + items.query SELECT only. No writes.

const { CosmosClient } = require("@azure/cosmos");

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) {
  console.error("FATAL: COSMOS_CONNECTION_STRING not set");
  process.exit(1);
}

const HOUR_MS = 60 * 60 * 1000;

(async () => {
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const container = db.container("portfolio");

  let totalHoldings = 0;
  let withPredicted = 0;
  let withMovement = 0;
  let withEither = 0;
  let withNeither = 0;
  let withLastUpdatedAheadOfPredicted = 0;
  let userCount = 0;

  const iter = container.items.query("SELECT * FROM c").getAsyncIterator();
  for await (const page of iter) {
    for (const userDoc of page.resources) {
      userCount += 1;
      const holdings = userDoc.holdings ?? {};
      for (const holding of Object.values(holdings)) {
        totalHoldings += 1;
        const predicted = holding.predictedPriceUpdatedAt ?? null;
        const movement = holding.movementUpdatedAt ?? null;
        const last = holding.lastUpdated ?? null;
        if (predicted != null) withPredicted += 1;
        if (movement != null) withMovement += 1;
        if (predicted != null || movement != null) withEither += 1;
        else withNeither += 1;

        if (predicted != null && last != null) {
          const predTs = new Date(predicted).getTime();
          const lastTs = new Date(last).getTime();
          if (Number.isFinite(predTs) && Number.isFinite(lastTs) && lastTs - predTs > HOUR_MS) {
            withLastUpdatedAheadOfPredicted += 1;
          }
        }
      }
    }
  }

  console.log("=== Freshness-timestamp coverage probe ===");
  console.log(`users:                                       ${userCount}`);
  console.log(`total holdings:                              ${totalHoldings}`);
  console.log(`with predictedPriceUpdatedAt != null:        ${withPredicted}`);
  console.log(`with movementUpdatedAt != null:              ${withMovement}`);
  console.log(`with either (covered by recipe):             ${withEither}`);
  console.log(`with neither (-> "Needs refresh" forever):   ${withNeither}`);
  console.log(`with lastUpdated > predictedPriceUpdatedAt:  ${withLastUpdatedAheadOfPredicted}`);
  console.log("    ^ candidates for the reprice-FAILURE case the recipe surfaces correctly");
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(2);
});
