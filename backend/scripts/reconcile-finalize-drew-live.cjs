#!/usr/bin/env node
// CF-RECONCILE-FINALIZE (2026-07-12).
//
// Live E2E: finalize Drew's 4 stuck eBay reconcile entries against prod
// Cosmos. Directly invokes applyFinalize + computeLedgerFinancials on
// each entry and writes back. Mirrors what POST /erp/unreconciled/:id/
// finalize does at the route layer.

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { CosmosClient } = require("@azure/cosmos");
const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

async function main() {
  const dist = (rel) => path.resolve(__dirname, "..", "dist", "services", "portfolioiq", rel);
  const { applyFinalize } = await import(pathToFileURL(dist("erpAgingOverride.service.js")).href);
  const { enrichEntryForClient } = await import(pathToFileURL(dist("erpReconciliation.service.js")).href);
  const { computeLedgerFinancials } = await import(pathToFileURL(dist("portfolioStore.service.js")).href);

  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client.database("hobbyiq").container("portfolio");
  const { resources } = await container.items
    .query({
      query: "SELECT * FROM c WHERE c.userId = @u",
      parameters: [{ name: "@u", value: USER_ID }],
    })
    .fetchAll();
  const doc = resources[0];
  if (!doc) throw new Error(`no portfolio doc for ${USER_ID}`);

  const stuck = (doc.ledger ?? []).filter((e) => e.source === "ebay" && e.needsReconciliation === true);
  console.log(`▶ ${stuck.length} stuck ebay entries`);
  if (stuck.length === 0) return;

  let anyChanged = false;
  for (const entry of stuck) {
    const idx = doc.ledger.findIndex((e) => e.id === entry.id);
    const priorPnl = Number(entry.realizedProfitLoss ?? 0);
    const { entry: after, adjustment } = applyFinalize(
      entry,
      { reason: "user-marked-no-fees (live E2E backfill 2026-07-12)" },
      USER_ID,
    );
    const granularSum =
      (after.finalValueFee ?? 0)
      + (after.paymentProcessingFee ?? 0)
      + (after.promotedListingFee ?? 0)
      + (after.adFee ?? 0)
      + (after.otherFees ?? 0)
      + (after.actualShippingCost ?? 0);
    const financials = computeLedgerFinancials({
      grossProceeds: after.grossProceeds,
      feesTotal: granularSum,
      tax: 0,
      shipping: 0,
      gradingCost: after.gradingCost ?? null,
      suppliesCost: after.suppliesCost ?? null,
      costBasisSold: after.costBasisSold,
      netPayoutOverride: after.netPayout ?? null,
    });
    const finalEntry = {
      ...after,
      netProceeds: financials.netProceeds,
      realizedProfitLoss: financials.realizedProfitLoss,
      realizedProfitLossPct: financials.realizedProfitLossPct,
    };
    doc.ledger[idx] = finalEntry;
    anyChanged = true;

    const delta = Math.round((financials.realizedProfitLoss - priorPnl) * 100) / 100;
    const wire = enrichEntryForClient(finalEntry);
    console.log(
      `  ${(entry.playerName ?? "?").padEnd(24)} $${String(entry.grossProceeds).padStart(6)} → ` +
      `needsReconciliation=${wire.needsReconciliation} ` +
      `reconciledVia=${wire.reconciledVia} ` +
      `pnl=${financials.realizedProfitLoss} (Δ${delta})`,
    );
  }

  if (anyChanged) {
    doc.lastUpdated = new Date().toISOString();
    await container.item(doc.id, doc.userId).replace(doc);
    console.log(`▶ Wrote portfolio doc`);
  }

  const stillStuck = (doc.ledger ?? []).filter((e) => e.source === "ebay" && e.needsReconciliation === true);
  console.log(`▶ Still stuck: ${stillStuck.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
