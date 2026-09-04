#!/usr/bin/env node
/**
 * census-persist-gate.cjs -- READ-ONLY. The blast radius of the two-rung
 * persist whitelist in holdingValuation.ts: holdings whose persisted
 * fairMarketValue is null, grouped by the rung the ONE valuation path
 * actually returns for them live.
 *
 * Env: COSMOS_CONNECTION_STRING (required). No writes, ever.
 */
const { CosmosClient } = require("@azure/cosmos");

const OLD_WHITELIST_OK = (rung, valueSource) =>
  (valueSource === "observed" && typeof rung === "string" && rung.startsWith("exact-pool-")) ||
  (valueSource === "estimated" && rung === "grade-curve-estimate");

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const portfolio = db.container("portfolio");
  const { resources: docs } = await portfolio.items.query({ query: "SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" }).fetchAll();
  const rows = [];
  for (const d of docs) for (const [hid, h] of Object.entries(d.holdings || {})) rows.push({ userId: d.userId, hid, h });
  const nullFmv = rows.filter((r) => r.h.fairMarketValue === null || r.h.fairMarketValue === undefined);
  console.log(JSON.stringify({
    stage: "persisted",
    docs: docs.length,
    holdings: rows.length,
    nullFairMarketValue: nullFmv.length,
    byPersistedRung: nullFmv.reduce((a, r) => { const k = r.h.fmvRung ?? `(none:${r.h.fmvRungAbsentReason ? "reason" : "absent"})`; a[k] = (a[k] || 0) + 1; return a; }, {}),
    byUser: nullFmv.reduce((a, r) => { a[r.userId] = (a[r.userId] || 0) + 1; return a; }, {}),
    withheldProse: nullFmv.filter((r) => typeof r.h.fmvRungAbsentReason === "string" && r.h.fmvRungAbsentReason.includes("the engine could not price")).length,
    withheldNoMeta: nullFmv.filter((r) => typeof r.h.fmvRungAbsentReason === "string" && r.h.fmvRungAbsentReason.includes("the engine could not price") && !r.h.pricingSourceMeta).length,
    estimatedValueDestroyed: nullFmv.filter((r) => typeof r.h.fmvRungAbsentReason === "string" && r.h.fmvRungAbsentReason.includes("the engine could not price") && (r.h.estimatedValue === null || r.h.estimatedValue === undefined)).length,
  }, null, 2));
  require("fs").writeFileSync(process.env.CENSUS_OUT || "/c/tmp/census-nullfmv.json", JSON.stringify(nullFmv.map((r) => ({
    userId: r.userId, hid: r.hid,
    playerName: r.h.playerName ?? null, cardYear: r.h.cardYear ?? null, setName: r.h.setName ?? null,
    parallel: r.h.parallel ?? null, cardNumber: r.h.cardNumber ?? null, printRun: r.h.printRun ?? null,
    hobbyiqCardId: r.h.hobbyiqCardId ?? null, cardId: r.h.cardId ?? null,
    gradeCompany: r.h.gradeCompany ?? null, gradeValue: r.h.gradeValue ?? null,
    quantity: r.h.quantity ?? 1, purchasePrice: r.h.purchasePrice ?? null, totalCostBasis: r.h.totalCostBasis ?? null,
    fmvRung: r.h.fmvRung ?? null, fmvRungAbsentReason: r.h.fmvRungAbsentReason ?? null,
    estimatedValue: r.h.estimatedValue ?? null, estimateBasis: r.h.estimateBasis ?? null,
    valuationStatus: r.h.valuationStatus ?? null, isEstimate: r.h.isEstimate ?? null,
    pricingSourceMeta: r.h.pricingSourceMeta ?? null,
  })), null, 2));
  console.log(`\nwrote ${nullFmv.length} candidate holdings to ${process.env.CENSUS_OUT || "/c/tmp/census-nullfmv.json"}`);
})().catch((e) => { console.error(e); process.exit(1); });
