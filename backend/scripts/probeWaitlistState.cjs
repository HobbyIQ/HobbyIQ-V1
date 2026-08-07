// One-off (Drew, 2026-08-07). Waitlist snapshot with aggressive timeouts
// and logging so we fail fast instead of hanging.

const { CosmosClient } = require("@azure/cosmos");

async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label} @ ${ms}ms`)), ms)),
  ]);
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  console.log(`[probe-waitlist] conn len=${conn.length}`);
  console.log("[probe-waitlist] init CosmosClient…");
  const c = new CosmosClient(conn);
  const wl = c.database("hobbyiq").container("waitlist");

  console.log("[probe-waitlist] read container metadata (fast RU-cheap call)…");
  const meta = await withTimeout(wl.read(), 10000, "container-read");
  console.log(`  container id=${meta.resource?.id}  ru-charge=${meta.headers?.["x-ms-request-charge"]}`);

  console.log("[probe-waitlist] read latest 15 via query iterator…");
  const iter = wl.items.query(
    "SELECT TOP 15 c.email, c.source, c.joinedAt FROM c ORDER BY c.joinedAt DESC",
    { maxItemCount: 15 }
  );
  const first = await withTimeout(iter.fetchNext(), 15000, "fetchNext");
  console.log(`  got ${first.resources?.length ?? 0} rows`);
  for (const r of first.resources ?? []) {
    console.log(`    ${r.joinedAt}  ${(r.email || "(no email)").padEnd(40)}  source=${r.source}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
