#!/usr/bin/env node
/**
 * run-ebay-finances-enrichment.cjs — the eBay Finances fee enrichment sweep,
 * run on the backfill runner instead of inside the API process.
 *
 * Why (Drew, 2026-08-30 12:40Z, "wont reconcile"): the reconciliation queue
 * showed sales "waiting on 7 fee fields from eBay" forever. Two causes, both in
 * the in-process job: EBAY_FINANCES_ENRICHMENT_SHADOW defaults to TRUE unless
 * the env is exactly "false" (HobbyIQ3 never set it — the job has only ever
 * logged "would-have-enriched"), and every cycle on both workers logged
 * "cycle skipped — another worker holds the lock", so not even the shadow
 * pass ran. Same lock defect the order poll had; same cure: the runner.
 *
 * Same code as the job: runFinancesEnrichmentSweep (candidates = ebay ledger
 * entries with needsReconciliation, 2–90 days old, per-run cap). Writes only
 * with BACKFILL_APPLY=true — otherwise SHADOW stays on and every candidate is
 * logged as would-have-enriched, nothing written.
 *
 * Reconciliation: intended = candidates evaluated; written = enriched;
 * skipped = no finances data yet (eBay has not posted the fees); failed =
 * errors. Exit 1 on errors.
 *
 * Env: COSMOS_CONNECTION_STRING; EBAY_CLIENT_ID/SECRET/ENV/REDIRECT_URI;
 *      AUTH_SESSION_SECRET; BACKFILL_APPLY; EBAY_FINANCES_ENRICHMENT_PER_RUN
 *      (default 100 — raise for a backlog).
 */
const path = require("node:path");
const backend = path.resolve(__dirname, "..");
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

async function main() {
  for (const k of ["COSMOS_CONNECTION_STRING", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "AUTH_SESSION_SECRET"]) {
    if (!process.env[k]) { console.error(`FATAL: ${k} not set`); process.exit(1); }
  }
  // The job reads SHADOW from the env at call time: only the exact string
  // "false" writes. REPORT ONLY keeps shadow on.
  process.env.EBAY_FINANCES_ENRICHMENT_SHADOW = APPLY ? "false" : "true";
  const { runFinancesEnrichmentSweep } = require(path.join(backend, "dist/jobs/ebayFinancesEnrichment.job.js"));
  console.log(`run-ebay-finances-enrichment  ${APPLY ? "APPLY (writes fees, net proceeds, realized P&L)" : "REPORT ONLY -- shadow, nothing written"}  env=${process.env.EBAY_ENV || "(default)"}  perRun=${process.env.EBAY_FINANCES_ENRICHMENT_PER_RUN || "100"}`);
  const s = await runFinancesEnrichmentSweep();
  console.log(`\n${APPLY ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  users                 ${f(s.users)}`);
  console.log(`  candidates            ${f(s.candidatesEvaluated)}   <- ebay, needsReconciliation, 2–90 days old`);
  console.log(`  ENRICHED              ${f(s.enriched)}${APPLY ? "" : "   <- would-have-enriched (shadow)"}`);
  console.log(`  no finances data yet  ${f(s.noFinancesData)}   <- eBay has not posted the fees`);
  console.log(`  skipped fresh (<2d)   ${f(s.skippedFresh)}   skipped over window (>90d) ${f(s.skippedOverWindow)}`);
  console.log(`  errors                ${f(s.errors)}   (${f(s.durationMs)} ms)`);
  if (APPLY) reportWrites({ job: "run-ebay-finances-enrichment", intended: Number(s.candidatesEvaluated ?? 0), written: Number(s.enriched ?? 0), skipped: Number(s.noFinancesData ?? 0), failed: Number(s.errors ?? 0) });
  if (Number(s.errors ?? 0) > 0) { console.error(`FATAL: ${s.errors} error(s)`); process.exit(1); }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || e); process.exit(3); });
