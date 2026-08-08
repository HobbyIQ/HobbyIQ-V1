// CF-CATALOG-GAP-SNAPSHOT v4 (Drew, 2026-08-08). Correct paths after
// dumping full staging doc. Title = raw.vendorPayload.title. Clean
// fields under c.clean.*. Status semantics: pending (fresh, awaiting
// cleaning), promoted (moved to sold_comps), plus other admin states.

const { CosmosClient } = require("@azure/cosmos");

async function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label} @ ${ms}ms`)), ms)),
  ]);
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn);
  const staging = c.database("hobbyiq").container("comps_staging");

  console.log("=== ALL distinct statuses in top-1000 by observedAt DESC ===");
  const q = await withTimeout(staging.items.query({
    query: "SELECT TOP 1000 c.status FROM c ORDER BY c.observedAt DESC",
  }, { maxItemCount: 1000 }).fetchNext(), 60000, "top-1000-status");
  const byStatus = new Map();
  for (const r of q.resources) {
    const s = r.status || "(null)";
    byStatus.set(s, (byStatus.get(s) || 0) + 1);
  }
  [...byStatus.entries()].sort((a, b) => b[1] - a[1]).forEach(([s, n]) => console.log(`  ${s.padEnd(30)} ${n}`));

  console.log("\n=== 500 latest PENDING or CATALOG-UNMATCHED — top gap buckets ===");
  const q2 = await withTimeout(staging.items.query({
    query: "SELECT TOP 500 c.status, c.hobbyiqCardId, c.clean.cardYear AS cy, c.clean.setName AS sn, c.clean.sport AS sp, c.raw.vendorPayload.title AS title FROM c WHERE c.status = 'pending' OR c.status = 'catalog-unmatched' ORDER BY c.observedAt DESC",
  }, { maxItemCount: 500 }).fetchNext(), 60000, "pending-500");
  console.log(`  fetched: ${q2.resources.length}`);

  const byBucket = new Map();
  const titles = [];
  for (const r of q2.resources) {
    const key = `${r.cy ?? "?"} | ${(r.sn ?? "?").padEnd(30).slice(0, 30)} | ${r.sp ?? "?"}`;
    byBucket.set(key, (byBucket.get(key) || 0) + 1);
    if (titles.length < 15) titles.push(r.title || "(no title)");
  }
  console.log("\n  TOP 25 (year | setName | sport):");
  [...byBucket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  });
  console.log("\n  Sample titles (parseable? indicative of what's showing up):");
  titles.forEach(t => console.log(`    · ${t.slice(0, 100)}`));
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
