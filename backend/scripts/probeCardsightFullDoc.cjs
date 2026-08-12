// Probe: pull 10 full cardsight catalog docs where cardYear is missing.
// Inspect every field so we can find where the year hides. Print keys +
// primitive values (skip long arrays/objects to keep output readable).
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database("hobbyiq").container("card_catalog");

  const { resources } = await cat.items.query({
    query: `SELECT TOP 10 * FROM c
            WHERE STARTSWITH(c.id, 'cardsight::')
              AND (NOT IS_DEFINED(c.cardYear) OR c.cardYear = null)
              AND (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null)`,
  }, { enableCrossPartitionQuery: true }).fetchAll();

  console.log(`Found ${resources.length} sample cardsight docs.\n`);
  for (const doc of resources) {
    console.log(`\n=== ${doc.id?.slice(0, 40)} ===`);
    for (const [k, v] of Object.entries(doc)) {
      if (k.startsWith("_")) continue; // Cosmos internals
      const tag = typeof v;
      if (v === null || v === undefined) {
        console.log(`  ${k.padEnd(28)} = null`);
      } else if (tag === "string" || tag === "number" || tag === "boolean") {
        const s = String(v);
        console.log(`  ${k.padEnd(28)} = ${s.length > 120 ? s.slice(0, 120) + '…' : s}`);
      } else if (Array.isArray(v)) {
        console.log(`  ${k.padEnd(28)} = [array len=${v.length}] ${JSON.stringify(v.slice(0, 3))}${v.length > 3 ? '…' : ''}`);
      } else if (tag === "object") {
        const keys = Object.keys(v).slice(0, 8).join(", ");
        console.log(`  ${k.padEnd(28)} = {${keys}${Object.keys(v).length > 8 ? ',…' : ''}}`);
      }
    }
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
