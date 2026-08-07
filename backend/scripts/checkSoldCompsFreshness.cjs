// CF-FRESHNESS-CANARY (Drew, 2026-08-07). Cron-driven canary that
// checks freshness of every primary sold_comps ingest source and
// fails loudly if any of them stalls.
//
// Motivating case: 2026-08-03..07 TCA firehose APPLY-fallback bug —
// green workflow runs, zero data writes, no alert for 5 days. First
// version of this canary reported OK because CH runtime API calls
// masked TCA being dead. Per-source check is the correct signal.
//
// Sources monitored (must all be < MAX_STALENESS_HOURS old):
//   tca-ebay      — nightly TCA firehose cron (primary volume feed)
//   cardhedge     — runtime CH getCardSales calls (deprecated 2026-08-02
//                   but still active until phase 3 lands)
//
// Sources NOT monitored (write sporadically, no alert):
//   holding, user-ebay, portfolio-import, ch-daily-manual, admin-*
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   MAX_STALENESS_HOURS        default 25 (tolerates one full inter-
//                              cron window for nightly sources)
//   MONITOR_SOURCES            comma-separated override; default
//                              "tca-ebay,cardhedge"

const { CosmosClient } = require("@azure/cosmos");

const MAX_STALENESS_HOURS = Number(process.env.MAX_STALENESS_HOURS || 25);
const MONITOR_SOURCES = (process.env.MONITOR_SOURCES || "tca-ebay,cardhedge")
  .split(",").map((s) => s.trim()).filter(Boolean);

async function latestObservedAtForSource(sc, source) {
  const q = await sc.items.query({
    query: "SELECT TOP 1 c.observedAt FROM c WHERE c.source = @source AND IS_DEFINED(c.observedAt) ORDER BY c.observedAt DESC",
    parameters: [{ name: "@source", value: source }],
  }, { maxItemCount: 1 }).fetchAll();
  return q.resources[0]?.observedAt ?? null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("::error::COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const sc = client.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[freshness-canary] monitoring sources: ${MONITOR_SOURCES.join(", ")}`);
  console.log(`[freshness-canary] threshold: ${MAX_STALENESS_HOURS}h`);

  const now = Date.now();
  const results = [];
  for (const source of MONITOR_SOURCES) {
    const latest = await latestObservedAtForSource(sc, source);
    const stalenessH = latest ? (now - new Date(latest).getTime()) / 3600000 : Infinity;
    results.push({ source, latest, stalenessH });
  }

  console.log("");
  console.log("source              latest observedAt                staleness");
  console.log("------------------  ---------------------------      ---------");
  for (const r of results) {
    const label = r.source.padEnd(18);
    const ts = (r.latest ?? "(never)").padEnd(32);
    const staleness = r.stalenessH === Infinity ? "∞" : `${r.stalenessH.toFixed(1)}h`;
    console.log(`${label}  ${ts}  ${staleness}`);
  }
  console.log("");

  const stale = results.filter((r) => r.stalenessH > MAX_STALENESS_HOURS);
  if (stale.length) {
    for (const r of stale) {
      const st = r.stalenessH === Infinity ? "NEVER" : `${r.stalenessH.toFixed(1)}h`;
      console.error(`::error::sold_comps source=${r.source} STALE: last write ${st} ago (threshold ${MAX_STALENESS_HOURS}h)`);
    }
    console.error(`::error::Check TCA Firehose Ingest workflow: https://github.com/HobbyIQ/HobbyIQ-V1/actions/workflows/tca-firehose-ingest.yml`);
    process.exit(1);
  }

  console.log(`[freshness-canary] OK — all ${results.length} monitored sources fresh`);
}

main().catch((e) => { console.error("::error::[freshness-canary] FAILED:", e?.message || e); process.exit(1); });
