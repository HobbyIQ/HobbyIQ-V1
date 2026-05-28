// player_trends indexing policy verification.
//
// Originally built for CF-PLAYERNAME-CANONICALIZATION Phase 2f
// (2026-05-28). Retained as a reusable check for any new field added
// to the container: verifies the field falls under the default `/*`
// include (and isn't explicitly excluded), so queries against it are
// indexed lookups rather than scans.
//
// Re-run whenever a new field is added to a PlayerScore type that
// callers will query against. The script hardcodes a check for
// `/playerNameNormalized` exclusion; edit the path inline for other
// fields when adapting.
//
// Read-only.
//
// Required env: COSMOS_CONNECTION_STRING

const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING not set"); process.exit(2); }

  const client = new CosmosClient(conn);
  const c = client.database("hobbyiq").container("player_trends");

  console.log("=== player_trends indexing policy ===");
  const { resource: containerDef } = await c.read();
  console.log(JSON.stringify(containerDef.indexingPolicy, null, 2));

  console.log("");
  console.log("=== Index coverage assessment ===");
  const pol = containerDef.indexingPolicy || {};
  const inclPaths = pol.includedPaths || [];
  const exclPaths = pol.excludedPaths || [];

  const includesEverything = inclPaths.some((p) => p.path === "/*");
  const explicitlyExcluded = exclPaths.some(
    (p) => p.path === "/playerNameNormalized/?" || p.path === "/playerNameNormalized/*"
  );

  console.log("  includes /* (covers all paths by default):", includesEverything);
  console.log("  explicit /playerNameNormalized exclusion :", explicitlyExcluded);
  console.log("");
  if (includesEverything && !explicitlyExcluded) {
    console.log("VERDICT: playerNameNormalized is INDEXED by default policy.");
    console.log("  Cosmos automatically indexes all paths under /* (excluding _etag).");
    console.log("  The new field will be indexed on next write per the upsert path.");
    console.log("  No policy change required.");
  } else {
    console.log("VERDICT: NEEDS INVESTIGATION.");
    console.log("  Either the default /* include is missing OR playerNameNormalized");
    console.log("  is explicitly excluded. Add an explicit include before the field");
    console.log("  goes into the query path.");
  }
}

main().catch((e) => { console.error("FATAL:", e && e.message || e); process.exit(1); });
