// CF-PLAYERTRENDS-DUPLICATE-RECORDS Phase 1 Steps 1+2 — survey
// duplicate scope + side-by-side comparison of paired records.
//
// Read-only. Identifies all duplicate pairs (same playerNameNormalized,
// different id) and dumps each pair's differentiating fields so the
// authoritative-id question can be answered empirically.
//
// Also pulls per-pair trend history counts from player_trend_history so
// we can see which record has more data when deciding the winner.
//
// Required env: COSMOS_CONNECTION_STRING

const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const client = new CosmosClient(conn);
  const trends = client.database("hobbyiq").container("player_trends");
  const history = client.database("hobbyiq").container("player_trend_history");

  // ── Step 1: Pull ALL trend records + group by canonical name ────────
  console.log("=== Step 1: Group by playerNameNormalized ===");
  const { resources: all } = await trends.items.query("SELECT * FROM c").fetchAll();
  console.log(`Total records: ${all.length}`);

  const byCanonical = new Map();
  for (const r of all) {
    const key = r.playerNameNormalized || (r.playerName || "").toLowerCase().trim();
    if (!byCanonical.has(key)) byCanonical.set(key, []);
    byCanonical.get(key).push(r);
  }

  const duplicateKeys = [...byCanonical.entries()].filter(([_, rs]) => rs.length > 1);
  console.log(`Distinct players: ${byCanonical.size}`);
  console.log(`Players with duplicates: ${duplicateKeys.length}`);
  console.log("");

  if (duplicateKeys.length === 0) {
    console.log("No duplicates found — anomaly may have self-resolved or been masked by today's canonicalization backfill.");
    return;
  }

  // ── Step 2: For each duplicate pair, dump side-by-side ─────────────
  console.log("=== Step 2: Side-by-side comparison per duplicate set ===");
  for (const [canonical, records] of duplicateKeys) {
    console.log("");
    console.log("------------------------------------------------------------------");
    console.log(`canonical: "${canonical}"  (${records.length} records)`);

    // Pull trend history counts for each id
    const historyCounts = await Promise.all(records.map(async (r) => {
      try {
        const { resources } = await history.items
          .query({
            query: "SELECT VALUE COUNT(1) FROM c WHERE c.playerId = @pid",
            parameters: [{ name: "@pid", value: r.playerId }],
          }, { partitionKey: r.playerId })
          .fetchAll();
        return resources[0] ?? 0;
      } catch (err) {
        return `err:${err.message.slice(0, 40)}`;
      }
    }));

    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const idShape =
        /^\d+$/.test(r.id) ? "numeric (mlb-id)" :
        /^[a-z0-9-]+$/.test(r.id) ? "slug" :
        "other";
      console.log(JSON.stringify({
        idx: i,
        id: r.id,
        playerId: r.playerId,
        idShape,
        playerName: r.playerName,
        playerNameNormalized: r.playerNameNormalized || null,
        mlbPlayerId: r.mlbPlayerId,
        playerIQScore: r.playerIQScore,
        playerIQDirection: r.playerIQDirection,
        team: r.team,
        league: r.league,
        level: r.level,
        updatedAt: r.updatedAt,
        dataSource: r.dataSource,
        confidence: r.confidence,
        marketScore_count: r.market?.cardCount,
        marketScore_samples: r.market?.totalSamples,
        marketScore_confidence: r.market?.confidence,
        performanceScore: r.performance?.performanceScore,
        performanceConfidence: r.performance?.confidence,
        trendHistorySnapshots: historyCounts[i],
      }));
    }
  }

  console.log("");
  console.log("=== END ===");
}

main().catch((e) => { console.error("FATAL:", e?.message || e); process.exit(1); });
