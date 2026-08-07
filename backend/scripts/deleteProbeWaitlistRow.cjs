// One-off (Drew, 2026-08-07). Delete the smoke-test probe row from
// the waitlist container. Partition key is /email so this is a point
// delete, not a scan.

const { CosmosClient } = require("@azure/cosmos");

const EMAIL = "probe-test-1786142763@example.com";

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn);
  const wl = c.database("hobbyiq").container("waitlist");

  // The row's `id` == the row's email in this store (see
  // waitlistStore.service.ts). Delete by (id, partitionKey).
  console.log(`[delete-probe] deleting id="${EMAIL}" pk="${EMAIL}"…`);
  try {
    const res = await wl.item(EMAIL, EMAIL).delete();
    console.log(`  status=${res.statusCode}`);
  } catch (e) {
    if (e?.code === 404) console.log("  already gone (404)");
    else throw e;
  }
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
