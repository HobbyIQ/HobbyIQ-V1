// Sample 15 card_catalog rows that lack a cardId (partition-key field)
// so we can see what they are and whether they're the sales-derived
// duplicates or something else entirely.
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database("hobbyiq").container("card_catalog");

  const { resources } = await cat.items.query({
    query: `SELECT TOP 15 * FROM c WHERE
              (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = '')
              AND (NOT IS_DEFINED(c.cardId) OR c.cardId = null OR c.cardId = '')`,
  }, { enableCrossPartitionQuery: true }).fetchAll();

  console.log(`Found ${resources.length} sample rows.\n`);
  for (const doc of resources) {
    console.log(`\n=== ${(doc.id || '<no-id>').slice(0, 50)} ===`);
    console.log(`  id            : ${doc.id}`);
    console.log(`  cardId        : ${doc.cardId ?? '<undefined>'}`);
    console.log(`  hobbyiqCardId : ${doc.hobbyiqCardId ?? '<undefined>'}`);
    console.log(`  source        : ${doc.source}`);
    console.log(`  player/player.: ${doc.player ?? doc.playerName ?? '<null>'}`);
    console.log(`  year/cardYear : ${doc.year ?? doc.cardYear ?? '<null>'}`);
    console.log(`  setName/set   : ${doc.setName ?? doc.set ?? '<null>'}`);
    console.log(`  cardNumber/#  : ${doc.cardNumber ?? doc.number ?? '<null>'}`);
    console.log(`  parallel      : ${doc.parallel ?? '<null>'}`);
    console.log(`  isAuto        : ${doc.isAuto ?? '<null>'}`);
    console.log(`  synthesizedAt : ${doc.synthesizedAt ?? '<null>'}`);
    console.log(`  salesCount    : ${doc.salesCount ?? '<n/a>'}`);
  }

  // Also count by source so we know composition
  console.log("\n\n=== composition by source (missing cardId + missing hobbyiqCardId) ===");
  const { resources: bySrc } = await cat.items.query({
    query: `SELECT c.source AS bucket, COUNT(1) AS n FROM c WHERE
              (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = '')
              AND (NOT IS_DEFINED(c.cardId) OR c.cardId = null OR c.cardId = '')
            GROUP BY c.source`,
  }, { enableCrossPartitionQuery: true }).fetchAll();
  for (const b of bySrc.sort((a, b) => b.n - a.n)) {
    console.log(`  ${(b.bucket || '<null>').padEnd(24)} ${b.n}`);
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
