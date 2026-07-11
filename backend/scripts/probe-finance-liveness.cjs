#!/usr/bin/env node
/**
 * CF-FINANCE-LIVENESS-PROBE (2026-07-11).
 *
 * Read-only. Answers "is the finance backend actually running?" by:
 *   1. Enumerating portfolio-value-history docs (populated by reprice job)
 *   2. Enumerating subscription-events (populated by /notifications)
 *   3. Enumerating expense docs (populated by POST /erp/expenses)
 *
 * If everything is empty on prod, the backend is theoretically ready but
 * has never actually processed real user activity — a "vaporware-adjacent"
 * signal even though the code is real.
 */
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");

  const checks = [
    { container: "portfolio_value_history", label: "Portfolio value history snapshots (reprice job output)" },
    { container: "subscription_events", label: "Apple subscription events (Apple → us S2S notifications)" },
    { container: "portfolio_expenses", label: "Expense entries (POST /erp/expenses)" },
    { container: "portfolio_reprice_runs", label: "Reprice job run records" },
    { container: "tax_filings", label: "Tax filing 1099-K records" },
  ];

  for (const c of checks) {
    console.log(`\n▶ ${c.container}`);
    console.log(`  ${c.label}`);
    try {
      const container = db.container(c.container);
      const { resources: countRow } = await container.items
        .query({ query: "SELECT VALUE COUNT(1) FROM c" })
        .fetchAll();
      const count = countRow[0] ?? 0;
      console.log(`  count: ${count}`);
      if (count > 0) {
        const { resources: sample } = await container.items
          .query({ query: "SELECT TOP 3 * FROM c ORDER BY c._ts DESC" })
          .fetchAll();
        for (const row of sample) {
          const ts = new Date((row._ts ?? 0) * 1000).toISOString();
          const summary = row.userId ?? row.id ?? "(no key)";
          console.log(`    ${ts}  ${summary}`);
        }
      }
    } catch (err) {
      console.log(`  ✗ ${err.code ?? err.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
