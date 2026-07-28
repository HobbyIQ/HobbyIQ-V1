#!/usr/bin/env -S npx tsx
/**
 * CF-BASE-CARD-FALLBACK-DIAG follow-up (Drew, 2026-07-28).
 *
 * One-off trigger for repriceHoldingsForUser — invokes the same
 * function the 6h cron runs, on demand. Use to verify the our-pool
 * + sibling fallback wire-in (PRs #891 + #892) actually fires on
 * a user's Missing holdings without waiting for the next 09:00 UTC
 * schedule.
 *
 * Requires the app's full runtime env (Cosmos + CH). Simplest way:
 *   export COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query \"[?name=='COSMOS_CONNECTION_STRING'].value\" -o tsv)"
 *   export CARD_HEDGE_API_KEY="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query \"[?name=='CARD_HEDGE_API_KEY'].value\" -o tsv)"
 *   export AUTH_SESSION_SECRET="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query \"[?name=='AUTH_SESSION_SECRET'].value\" -o tsv)"
 *   npx tsx backend/scripts/triggerReprice.ts <email-or-userId>
 *
 * Never blocks: repriceHoldingsForUser handles all its own errors.
 * Prints the summary counts on completion.
 */

import { CosmosClient } from "@azure/cosmos";
import { repriceHoldingsForUser } from "../src/services/portfolioiq/portfolioStore.service.js";

async function main(): Promise<void> {
  const identifier = (process.argv[2] ?? "").trim();
  if (!identifier) {
    console.error("Usage: triggerReprice.ts <email-or-userId>");
    process.exit(2);
  }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("COSMOS_CONNECTION_STRING env var required");
    process.exit(2);
  }

  // Resolve email → userId if needed.
  let userId = identifier;
  if (identifier.includes("@")) {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    const users = db.container(process.env.COSMOS_USERS_CONTAINER ?? "users");
    const { resources } = await users.items
      .query({
        query: 'SELECT c.userId FROM c WHERE c.docType = "user" AND c.emailLower = @v',
        parameters: [{ name: "@v", value: identifier.toLowerCase() }],
      })
      .fetchAll();
    if (resources.length === 0) {
      console.error(`No user found for ${identifier}`);
      process.exit(1);
    }
    userId = (resources[0] as { userId: string }).userId;
  }

  console.log(`▸ Triggering reprice for ${userId}…`);
  const t0 = Date.now();
  const result = await repriceHoldingsForUser(userId, "manual-trigger", {
    // Bypass the throttle so back-to-back invocations still fire.
    userThrottleMs: 0,
    // Reprice ALL holdings, not just the stalest N.
    maxHoldings: 10_000,
  });
  const ms = Date.now() - t0;

  console.log(`\n▸ Done in ${(ms / 1000).toFixed(1)}s`);
  console.log(`  requested: ${result.requested}`);
  console.log(`  repriced:  ${result.repriced}`);
  console.log(`  skipped:   ${result.skipped}`);
  if (result.reason) console.log(`  reason:    ${result.reason}`);
  if (result.updates && result.updates.length > 0) {
    console.log(`\n  Update reasons:`);
    const byReason: Record<string, number> = {};
    for (const u of result.updates) {
      const key = (u as { reason?: string }).reason ?? "unspecified";
      byReason[key] = (byReason[key] ?? 0) + 1;
    }
    for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason.padEnd(40)} ${count}`);
    }
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[triggerReprice] fatal: ${msg}`);
  process.exit(1);
});
