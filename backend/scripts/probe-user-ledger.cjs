#!/usr/bin/env node
/**
 * CF-MANUAL-SELL-ERP-GAP (2026-07-11) — read-only diagnostic.
 *
 * Reads Drew's portfolio doc and dumps every ledger entry with its
 * key fields. If /sell wrote entries but /pnl doesn't surface them,
 * this reveals the write-side vs read-side gap.
 */
const { CosmosClient } = require("@azure/cosmos");

const USER_ID = process.argv[2] ?? "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("portfolio");
  const { resources } = await container.items
    .query({ query: "SELECT * FROM c WHERE c.userId = @u", parameters: [{ name: "@u", value: USER_ID }] })
    .fetchAll();
  const doc = resources[0];
  if (!doc) { console.log("NO DOC"); return; }

  const holdings = Object.entries(doc.holdings ?? {});
  const ledger = doc.ledger ?? [];
  console.log(`userId: ${doc.userId}`);
  console.log(`holdings: ${holdings.length}`);
  console.log(`ledger entries: ${ledger.length}`);
  console.log(`ledger array TYPE: ${Array.isArray(doc.ledger) ? "array" : typeof doc.ledger}`);
  console.log(`ledger IN doc keys: ${Object.keys(doc).filter(k => /ledger|sold|sale|trade/i.test(k)).join(", ")}`);
  console.log();

  if (ledger.length > 0) {
    console.log("Full ledger inventory:");
    for (const e of ledger) {
      console.log(`  ${e.soldAt.slice(0, 10)}  ${e.reconciledVia ?? "?"}  needsRec=${e.needsReconciliation ?? "absent"}  ${e.playerName}  gross=$${e.grossProceeds} realized=$${e.realizedProfitLoss}`);
    }
    console.log();
    console.log("First entry (full JSON):");
    console.log(JSON.stringify(ledger[0], null, 2));
  }

  // Any holdings with cardStatus set?
  const soldHoldings = holdings.filter(([, h]) => {
    const status = String(h.cardStatus ?? h.statusCategory ?? "").toLowerCase();
    return status === "sold";
  });
  console.log(`\nHoldings with cardStatus/statusCategory === "sold": ${soldHoldings.length}`);
  for (const [key, h] of soldHoldings.slice(0, 5)) {
    console.log(`  holdingId=${key}  title=${h.title ?? h.cardName ?? "?"}  status=${h.cardStatus ?? h.statusCategory}`);
  }

  // Also — any keys that look like trades?
  console.log(`\ntrades on user doc: ${(doc.trades ?? []).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
