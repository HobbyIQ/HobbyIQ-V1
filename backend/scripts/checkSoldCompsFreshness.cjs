// CF-FRESHNESS-CANARY (Drew, 2026-08-07). Cron-driven canary that
// queries MAX(observedAt) on sold_comps and fails loudly if the pool
// isn't receiving fresh writes.
//
// Backstop against silent ingest failures — the 2026-08-03..07 TCA
// firehose APPLY-fallback bug is the motivating case: green workflow
// runs, zero data writes, no alert for 5 days.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   MAX_STALENESS_HOURS        default 25 (tolerates one full inter-
//                              cron window: TCA cron is 24h + slop)

const { CosmosClient } = require("@azure/cosmos");

const MAX_STALENESS_HOURS = Number(process.env.MAX_STALENESS_HOURS || 25);

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("::error::COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  const q = await sc.items.query({
    query: "SELECT TOP 1 c.observedAt, c.source FROM c WHERE IS_DEFINED(c.observedAt) ORDER BY c.observedAt DESC",
  }, { maxItemCount: 1 }).fetchAll();

  if (!q.resources.length) {
    console.error("::error::sold_comps is EMPTY — no rows with observedAt");
    process.exit(1);
  }

  const latest = q.resources[0];
  const stalenessH = (Date.now() - new Date(latest.observedAt).getTime()) / 3600000;

  console.log(`[freshness-canary] latest observedAt: ${latest.observedAt}  source=${latest.source || "(unknown)"}`);
  console.log(`[freshness-canary] staleness:         ${stalenessH.toFixed(1)}h`);
  console.log(`[freshness-canary] threshold:         ${MAX_STALENESS_HOURS}h`);

  if (stalenessH > MAX_STALENESS_HOURS) {
    console.error(`::error::sold_comps STALE: latest ingest ${stalenessH.toFixed(1)}h ago (threshold ${MAX_STALENESS_HOURS}h)`);
    console.error(`::error::Check TCA Firehose Ingest workflow: https://github.com/HobbyIQ/HobbyIQ-V1/actions/workflows/tca-firehose-ingest.yml`);
    process.exit(1);
  }

  console.log(`[freshness-canary] OK — sales index moving`);
}

main().catch((e) => { console.error("::error::[freshness-canary] FAILED:", e?.message || e); process.exit(1); });
