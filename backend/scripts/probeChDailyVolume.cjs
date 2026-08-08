// CF-CH-VOLUME-CHECK v3 (Drew, 2026-08-07). Broader window — top 500
// so we can see cadence pattern (bursts vs steady) not just a 2-sec
// snapshot dominated by one user's cache-warm burst.

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
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log("=== LATEST 500 sold_comps rows with source=cardhedge — hour bucketing ===");
  const q = await withTimeout(
    sc.items.query({
      query: "SELECT TOP 500 c.observedAt FROM c WHERE c.source = 'cardhedge' ORDER BY c.observedAt DESC",
    }, { maxItemCount: 500 }).fetchNext(),
    45000, "latest-500"
  );
  const rows = q.resources ?? [];
  console.log(`  rows fetched: ${rows.length}`);

  const byHour = new Map();
  for (const r of rows) {
    const h = String(r.observedAt).slice(0, 13); // "2026-08-08T00"
    byHour.set(h, (byHour.get(h) || 0) + 1);
  }
  const sorted = [...byHour.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  console.log(`\n  hour bucket           rows in that hour`);
  console.log(`  ----                  ----`);
  for (const [h, n] of sorted) {
    console.log(`  ${h}Z              ${String(n).padStart(4)}`);
  }

  if (rows.length > 0) {
    const spanMs = new Date(rows[0].observedAt).getTime() - new Date(rows[rows.length - 1].observedAt).getTime();
    const spanH = spanMs / 3600000;
    console.log(`\n  full span across 500 rows: ${spanH.toFixed(2)}h`);
    console.log(`  average rate: ${(500 / Math.max(spanH, 0.001)).toFixed(0)} rows/hour = ${(500 / Math.max(spanH, 0.001) * 24).toFixed(0)} rows/day`);
    console.log(`  note: heavily bursty; single-player cache-warm can dump 50+ rows in <3sec`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
