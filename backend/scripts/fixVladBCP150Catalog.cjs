// CF-VLAD-BCP150-CATALOG-HOTFIX (Drew, 2026-08-10). Move the specific
// catalog row for 2018 Vlad Guerrero Jr BCP150 from bowman-chrome-mega-box
// → bowman-chrome so it matches the consolidated sold_comps pool.

const { CosmosClient } = require("@azure/cosmos");
const APPLY = process.env.APPLY === "true";

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const catalog = new CosmosClient(conn).database("hobbyiq").container("card_catalog");
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"}`);

  // Find via query (partition = /sport = 'baseball')
  const { resources } = await catalog.items.query({
    query: `SELECT * FROM c WHERE c.cardYear = 2018 AND LOWER(c.cardNumber) = 'bcp150' AND c.sport = 'baseball'`,
  }, { enableCrossPartitionQuery: true }).fetchAll();

  console.log(`  found ${resources.length} row(s)`);
  for (const doc of resources) {
    const oldSlug = doc.hobbyiqCardId || doc.id;
    const newSlug = "hiq:baseball:2018:bowman-chrome:bcp150:base:no-auto";
    if (oldSlug === newSlug) { console.log(`  already canonical: ${oldSlug}`); continue; }
    console.log(`  moving: ${oldSlug} → ${newSlug}`);
    if (!APPLY) continue;
    const newDoc = { ...doc, id: newSlug, hobbyiqCardId: newSlug, setKey: "bowman-chrome", reslugedAt: new Date().toISOString(), reslugedFrom: oldSlug };
    delete newDoc._rid; delete newDoc._self; delete newDoc._etag; delete newDoc._attachments; delete newDoc._ts;
    await catalog.items.upsert(newDoc);
    console.log(`    ✓ inserted at new id`);
    await catalog.item(doc.id, "baseball").delete().catch((e) => console.warn(`    delete old warn: ${e.message||e}`));
    console.log(`    ✓ deleted old row`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
