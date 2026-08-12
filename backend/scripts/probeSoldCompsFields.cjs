// One-off (Drew, 2026-08-07). Just get any 5 rows and dump every
// field so we can see what the schema actually looks like.

const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log("=== 3 arbitrary sold_comps rows, FULL doc ===");
  const q = await sc.items.query({
    query: "SELECT TOP 3 * FROM c WHERE c.source = 'tca-ebay'",
  }, { maxItemCount: 3 }).fetchNext();
  console.log(`rows: ${q.resources?.length ?? 0}`);
  (q.resources ?? []).forEach((r, i) => {
    console.log(`\n--- row ${i + 1} (fields: ${Object.keys(r).length}) ---`);
    Object.keys(r).sort().forEach(k => {
      const v = r[k];
      const strV = typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80);
      console.log(`  ${k.padEnd(25)} = ${strV}`);
    });
  });

  console.log("\n=== 3 CH-source rows, FULL doc ===");
  const qCh = await sc.items.query({
    query: "SELECT TOP 3 * FROM c WHERE c.source = 'cardhedge'",
  }, { maxItemCount: 3 }).fetchNext();
  console.log(`rows: ${qCh.resources?.length ?? 0}`);
  (qCh.resources ?? []).forEach((r, i) => {
    console.log(`\n--- ch-row ${i + 1} (fields: ${Object.keys(r).length}) ---`);
    Object.keys(r).sort().forEach(k => {
      const v = r[k];
      const strV = typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80);
      console.log(`  ${k.padEnd(25)} = ${strV}`);
    });
  });
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
