// One-off verification: Bobby Cox slug→numeric merge.
// Reads player_trends and player_trend_history to confirm:
//   - id=112764 numeric record exists with current score
//   - id=bobby-cox slug record is gone (404)
//   - player_trend_history for playerId=112764 contains 7 copied snapshots
//   - player_trend_history for playerId=bobby-cox is empty
const { CosmosClient } = require("@azure/cosmos");
(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("no conn"); process.exit(2); }
  const client = new CosmosClient(conn);
  const trends = client.database("hobbyiq").container("player_trends");
  const hist = client.database("hobbyiq").container("player_trend_history");

  console.log("=== player_trends ===");
  try {
    const { resource: numeric } = await trends.item("112764", "112764").read();
    console.log("numeric id=112764:", numeric ? JSON.stringify({
      id: numeric.id, playerId: numeric.playerId, playerName: numeric.playerName,
      playerNameNormalized: numeric.playerNameNormalized,
      playerIQScore: numeric.playerIQScore, playerIQDirection: numeric.playerIQDirection,
      updatedAt: numeric.updatedAt, dataSource: numeric.dataSource,
    }) : "MISSING");
  } catch (err) { console.log("numeric read err:", err.code || err.message); }

  try {
    const { resource: slug } = await trends.item("bobby-cox", "bobby-cox").read();
    if (slug) console.log("slug id=bobby-cox: STILL PRESENT (unexpected)", slug.id);
    else console.log("slug id=bobby-cox: null (unexpected, expected 404)");
  } catch (err) {
    if (err.code === 404) console.log("slug id=bobby-cox: 404 (expected)");
    else console.log("slug read err:", err.code || err.message);
  }

  console.log("\n=== player_trend_history counts ===");
  for (const pid of ["112764", "bobby-cox"]) {
    try {
      const { resources } = await hist.items
        .query({ query: "SELECT VALUE COUNT(1) FROM c WHERE c.playerId = @pid",
          parameters: [{ name: "@pid", value: pid }] }, { partitionKey: pid })
        .fetchAll();
      console.log(`playerId=${pid}: ${resources[0]} snapshots`);
    } catch (err) { console.log(`playerId=${pid} count err:`, err.code || err.message); }
  }

  console.log("\n=== player_trend_history details for playerId=112764 ===");
  try {
    const { resources } = await hist.items
      .query({ query: 'SELECT c.id, c.playerId, c.snapshotAt, c.timestamp FROM c WHERE c.playerId = "112764" ORDER BY c.id',
        parameters: [] }, { partitionKey: "112764" })
      .fetchAll();
    for (const s of resources) console.log(JSON.stringify(s));
  } catch (err) { console.log("hist query err:", err.code || err.message); }
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
