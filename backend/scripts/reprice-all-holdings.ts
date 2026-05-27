// CF-PREDICTION-LAYER-CONSISTENCY-COMPLETION (Phase 4) — one-shot backfill.
//
// Post-deploy population: forces autoPriceHolding to fire for every
// holding under the target userId so the new prediction-layer fields
// (predictedPrice, predictedPriceRange, predictedPriceAttribution,
// predictedPriceMechanism, predictedPriceUpdatedAt) get written to Cosmos.
//
// The natural reprice triggers (scheduled job, iOS pull-to-refresh) will
// eventually do this on their own, but this script eliminates the gap
// between schema-extending deploys and stored-state catch-up.
//
// Run from backend/ directory:
//   $env:HOBBYIQ_SIGNIN_USERNAME = 'HobbyIQ'
//   $env:HOBBYIQ_SIGNIN_PASSWORD = '<password>'
//   $env:HBQ_COSMOS_CS = (az webapp config appsettings list -g rg-hobbyiq-dev -n HobbyIQ3 --query "[?name=='COSMOS_CONNECTION_STRING'].value | [0]" -o tsv)
//   npx tsx scripts/reprice-all-holdings.ts
//
// Env vars:
//   HOBBYIQ_SIGNIN_USERNAME — required, account to reprice (defaults to "HobbyIQ" for admin-testing-hobbyiq)
//   HOBBYIQ_SIGNIN_PASSWORD — required, account password
//   HBQ_COSMOS_CS           — required for post-run Cosmos verification
//   HBQ_COSMOS_DB           — optional, defaults to "hobbyiq"
//   PROD_URL                — optional, defaults to HobbyIQ3 production URL
//
// Idempotent: re-running is safe. The /api/portfolio/reprice/batch endpoint
// already gates by per-holding lastUpdated age + per-user throttle, but the
// underlying autoPriceHolding call is itself a deterministic upsert.

import { CosmosClient } from "@azure/cosmos";

const cs = process.env.HBQ_COSMOS_CS;
if (!cs) {
  console.error("HBQ_COSMOS_CS not set");
  process.exit(2);
}
const dbName = process.env.HBQ_COSMOS_DB ?? "hobbyiq";
const username = process.env.HOBBYIQ_SIGNIN_USERNAME ?? "HobbyIQ";
const password = process.env.HOBBYIQ_SIGNIN_PASSWORD;
if (!password) {
  console.error("HOBBYIQ_SIGNIN_PASSWORD not set");
  process.exit(2);
}
const prodUrl =
  process.env.PROD_URL ??
  "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net";

interface SignInResult {
  success: boolean;
  sessionId?: string;
  userId?: string;
  error?: string;
}

interface BatchRepriceResult {
  requested: number;
  repriced: number;
  skipped: number;
  reason?: string;
  examined?: number;
  freshSkipped?: number;
  throttled?: boolean;
  updates: Array<{ id: string; status: string; reason?: string }>;
}

async function signIn(): Promise<{ sessionId: string; userId: string }> {
  const res = await fetch(`${prodUrl}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`signin HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as SignInResult;
  if (!data.success || !data.sessionId || !data.userId) {
    throw new Error(`signin failed: ${data.error ?? JSON.stringify(data)}`);
  }
  return { sessionId: data.sessionId, userId: data.userId };
}

async function repriceBatch(sessionId: string): Promise<BatchRepriceResult> {
  const res = await fetch(`${prodUrl}/api/portfolio/reprice/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-id": sessionId,
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`reprice/batch HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as BatchRepriceResult;
}

async function inspectCosmosCoverage(userId: string): Promise<void> {
  const client = new CosmosClient(cs as string);
  const container = client.database(dbName).container("portfolio");
  const { resource: doc } = await container.item(userId, userId).read();
  if (!doc) {
    console.log(`(verification) no portfolio doc for ${userId}`);
    return;
  }
  const holdings = Object.values((doc.holdings ?? {}) as Record<string, any>);
  const fmvPriced = holdings.filter((h) => typeof h.fairMarketValue === "number" && h.fairMarketValue > 0);
  const predPopulated = holdings.filter((h) => typeof h.predictedPrice === "number" && h.predictedPrice > 0);
  const mechPopulated = holdings.filter((h) => typeof h.predictedPriceMechanism === "string" && h.predictedPriceMechanism.length > 0);

  console.log("");
  console.log("─ Cosmos coverage after reprice ─");
  console.log(`  Total holdings:                       ${holdings.length}`);
  console.log(`  fairMarketValue populated:            ${fmvPriced.length}`);
  console.log(`  predictedPrice populated:             ${predPopulated.length}`);
  console.log(`  predictedPriceMechanism populated:    ${mechPopulated.length}`);
  console.log("");
  console.log("─ Sample (first 5 holdings) ─");
  for (const h of holdings.slice(0, 5)) {
    console.log(
      `  ${String(h.id ?? "(no-id)").slice(0, 14).padEnd(14)} ` +
        `player=${String(h.playerName ?? "?").slice(0, 28).padEnd(28)} ` +
        `fmv=${String(h.fairMarketValue ?? "null").padStart(8)} ` +
        `pred=${String(h.predictedPrice ?? "null").padStart(8)} ` +
        `mech=${h.predictedPriceMechanism ?? "null"}`,
    );
  }
}

(async () => {
  console.log(`[reprice-all-holdings] target=${username} prod=${prodUrl}`);

  const auth = await signIn();
  console.log(`  signed in as userId=${auth.userId}`);

  const result = await repriceBatch(auth.sessionId);
  console.log("");
  console.log(`─ Batch reprice result ─`);
  console.log(`  requested:    ${result.requested}`);
  console.log(`  examined:     ${result.examined ?? "n/a"}`);
  console.log(`  repriced:     ${result.repriced}`);
  console.log(`  skipped:      ${result.skipped}`);
  console.log(`  freshSkipped: ${result.freshSkipped ?? 0}`);
  console.log(`  throttled:    ${Boolean(result.throttled)}`);
  if (result.reason) console.log(`  reason:       ${result.reason}`);

  if (result.throttled) {
    console.log("");
    console.log("(throttled — wait PORTFOLIO_REPRICE_HTTP_THROTTLE_MS ms and re-run)");
    process.exit(1);
  }

  console.log("");
  console.log("─ Per-holding outcomes ─");
  const byStatus: Record<string, number> = {};
  for (const u of result.updates) {
    byStatus[u.status] = (byStatus[u.status] ?? 0) + 1;
  }
  for (const [status, n] of Object.entries(byStatus)) {
    console.log(`  ${status.padEnd(10)} ${n}`);
  }

  const errors = result.updates.filter((u) => u.status === "error");
  if (errors.length > 0) {
    console.log("");
    console.log("─ Errors ─");
    for (const e of errors) {
      console.log(`  ${e.id}: ${e.reason ?? "(no reason)"}`);
    }
  }

  await inspectCosmosCoverage(auth.userId);
})().catch((e) => {
  console.error("FATAL:", (e as Error).message);
  process.exit(1);
});
