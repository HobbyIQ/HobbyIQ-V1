// Check catalog + sold_comps for the 4 Griffey holdings marked MISSING
const { CosmosClient } = require("@azure/cosmos");
async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  const db = new CosmosClient(conn).database("hobbyiq");
  const catalog = db.container("card_catalog");
  const sold = db.container("sold_comps");

  const targets = [
    { year: 1999, num: "76",  name: "Black Diamond Double" },
    { year: 1999, num: "S1",  name: "Upper Deck Retro Numbered" },
    { year: 1998, num: "50",  name: "Upper Deck SPx Finite Radiance" },
    { year: 1999, num: "D24", name: "Black Diamond D24" },
  ];

  for (const t of targets) {
    console.log(`\n=== ${t.year} ${t.name} Griffey #${t.num} ===`);

    // Catalog check by year + cardNumber + griffey
    const cq = await catalog.items.query({
      query: `SELECT c.id, c.hobbyiqCardId, c.setKey, c.setName, c.cardNumber, c.parallel, c.playerName
              FROM c
              WHERE c.cardYear = @y
                AND UPPER(c.cardNumber) = @n
                AND CONTAINS(LOWER(c.playerName ?? ''), 'griffey')`,
      parameters: [
        { name: "@y", value: t.year },
        { name: "@n", value: String(t.num).toUpperCase() },
      ],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    console.log(`  catalog rows: ${cq.resources.length}`);
    for (const r of cq.resources.slice(0, 10)) {
      console.log(`    ${r.hobbyiqCardId}  set=${r.setKey}/${r.setName}  parallel=${r.parallel}`);
    }

    // Also look for ANY catalog row matching year+num regardless of player name
    if (cq.resources.length === 0) {
      const cq2 = await catalog.items.query({
        query: `SELECT c.id, c.hobbyiqCardId, c.setKey, c.setName, c.cardNumber, c.playerName
                FROM c
                WHERE c.cardYear = @y AND UPPER(c.cardNumber) = @n`,
        parameters: [
          { name: "@y", value: t.year },
          { name: "@n", value: String(t.num).toUpperCase() },
        ],
      }, { enableCrossPartitionQuery: true }).fetchAll();
      console.log(`  (no griffey; broader match by year+#: ${cq2.resources.length} rows)`);
      for (const r of cq2.resources.slice(0, 8)) {
        console.log(`    player=${r.playerName}  set=${r.setKey}  ${r.hobbyiqCardId}`);
      }
    }

    // sold_comps check
    const sq = await sold.items.query({
      query: `SELECT DISTINCT c.hobbyiqCardId, COUNT(1) AS n
              FROM c
              WHERE c.cardYear = @y
                AND UPPER(c.cardNumber) = @n
                AND CONTAINS(LOWER(c.playerName ?? ''), 'griffey')
              GROUP BY c.hobbyiqCardId`,
      parameters: [
        { name: "@y", value: t.year },
        { name: "@n", value: String(t.num).toUpperCase() },
      ],
    }, { enableCrossPartitionQuery: true }).fetchAll();
    console.log(`  sold_comps slug pool:`);
    for (const r of sq.resources) console.log(`    ${r.hobbyiqCardId}: ${r.n}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
