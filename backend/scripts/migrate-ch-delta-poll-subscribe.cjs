/* eslint-disable */
// CF-CH-DELTA-POLL-MIGRATION (2026-06-30): one-shot batch-subscribe of
// every existing portfolio holding to CardHedge's delta-poll feed.
// Idempotent — CH dedupes subscriptions per (client_id, card_id, grade),
// so re-running this script is safe. Run once after CARD_HEDGE_CLIENT_ID
// is provisioned to enroll the back-catalog (subscribe-on-add covers
// holdings created AFTER the wire shipped in PR #212).
//
// USAGE
//   # Verify env vars are set, then run from backend/ directory:
//   #   CARD_HEDGE_API_KEY (data-plane auth — required)
//   #   CARD_HEDGE_CLIENT_ID (subscription auth — required, else dormant)
//   #   COSMOS_CONNECTION_STRING (to read userDocs — required)
//   #
//   #   cd backend
//   #   node scripts/migrate-ch-delta-poll-subscribe.cjs --dry-run
//   #   node scripts/migrate-ch-delta-poll-subscribe.cjs --apply
//
// SAFE BY DEFAULT
// --dry-run reports counts + sample identities; sends zero CH calls.
// --apply hits CH's /cards/subscribe-price-updates with chunks of 100,
// and prints the per-user + total subscription counts.
//
// NON-FATAL
// Individual user-doc read failures are logged + skipped (per the
// existing migrateExistingHoldingsToDeltaPoll helper). CH-side
// individual subscription failures are part of the batch response
// (CH always returns HTTP 200 even with per-item failures).

const path = require("path");

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");
  if (!dryRun && !apply) {
    console.error("usage: node migrate-ch-delta-poll-subscribe.cjs --dry-run | --apply");
    process.exit(2);
  }
  if (!process.env.CARD_HEDGE_API_KEY) {
    console.error("FATAL: CARD_HEDGE_API_KEY env var required");
    process.exit(1);
  }
  if (!process.env.CARD_HEDGE_CLIENT_ID) {
    console.error("FATAL: CARD_HEDGE_CLIENT_ID env var required (subscription auth)");
    process.exit(1);
  }
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING env var required to read user docs");
    process.exit(1);
  }

  // Lazy require so the script's fail-fast banner runs without
  // touching the heavy module graph.
  const distPath = path.join(__dirname, "..", "dist", "services", "portfolioiq", "portfolioStore.service.js");
  let portfolioStore;
  try {
    portfolioStore = require(distPath);
  } catch (e) {
    console.error(`FATAL: failed to require compiled portfolio store at ${distPath}`);
    console.error("Run 'npm run build' in backend/ first to produce dist/.");
    console.error(e?.message ?? e);
    process.exit(1);
  }

  const { listAllPortfolioUserIds, readUserDoc, migrateExistingHoldingsToDeltaPoll } = portfolioStore;
  if (typeof listAllPortfolioUserIds !== "function" || typeof migrateExistingHoldingsToDeltaPoll !== "function") {
    console.error("FATAL: expected migration helpers missing from portfolioStore. Rebuild backend/.");
    process.exit(1);
  }

  if (dryRun) {
    console.log("=== DRY-RUN ===\n");
    const userIds = await listAllPortfolioUserIds();
    let totalHoldings = 0;
    let sampleIdentities = [];
    for (const userId of userIds) {
      try {
        const doc = await readUserDoc(userId);
        const holdings = Object.values(doc.holdings ?? {});
        totalHoldings += holdings.length;
        for (const h of holdings.slice(0, 3)) {
          if (sampleIdentities.length < 15) {
            sampleIdentities.push({
              userId,
              holdingId: h.id,
              cardId: h.cardId ?? null,
              gradingCompany: h.gradingCompany ?? null,
              gradeValue: h.gradeValue ?? null,
            });
          }
        }
      } catch (e) {
        console.warn(`  [skip] userId=${userId}: ${e?.message ?? e}`);
      }
    }
    console.log(`Users scanned: ${userIds.length}`);
    console.log(`Holdings observed: ${totalHoldings}`);
    console.log(`Sample identities (first 15):`);
    for (const s of sampleIdentities) {
      console.log(`  ${JSON.stringify(s)}`);
    }
    console.log("\nNo CH calls fired. Re-run with --apply to subscribe.");
    return;
  }

  console.log("=== APPLY ===\n");
  console.log("Calling migrateExistingHoldingsToDeltaPoll() — this batches CH subscribe-price-updates in chunks of 100.");
  const start = Date.now();
  const result = await migrateExistingHoldingsToDeltaPoll();
  const ms = Date.now() - start;
  console.log("\n=== RESULT ===");
  console.log(`Users scanned:         ${result.usersScanned}`);
  console.log(`Holdings submitted:    ${result.holdingsSubmitted}`);
  console.log(`Holdings subscribed:   ${result.holdingsSubscribed}`);
  console.log(`Duration:              ${ms}ms`);
  if (result.holdingsSubmitted !== result.holdingsSubscribed) {
    console.warn(`\n  WARN: ${result.holdingsSubmitted - result.holdingsSubscribed} holdings did not subscribe successfully.`);
    console.warn("  Check App Insights for [cardhedge.client] subscribe-price-updates HTTP traces.");
  }
}

main().catch((err) => {
  console.error("migration failed:", err?.stack ?? err);
  process.exit(1);
});
