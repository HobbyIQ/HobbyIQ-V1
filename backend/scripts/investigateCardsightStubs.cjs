// Deep-dive on cardsight catalog docs — what's actually IN them, can
// any subset be canonicalized, and what's the ceiling on "recoverable"?
// From the earlier sample: 74% of no-slug docs are cardsight, only 3%
// have cardNumber. Understanding these tells us whether they belong in
// card_catalog at all or should migrate to a search-hint container.
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database("hobbyiq").container("card_catalog");

  console.log("[cardsight-investigation] TOP 150 cardsight docs (smallest RU I dare at 4K)...");
  const { resources } = await cat.items.query({
    query: `SELECT TOP 150 c.id, c.source, c.setName, c["set"] AS setAlt,
                   c.cardNumber, c["number"] AS numberAlt,
                   c.year, c.cardYear, c.title, c.player, c.playerName,
                   c.hobbyiqCardId, c.searchText
            FROM c WHERE STARTSWITH(c.id, 'cardsight::')`,
    parameters: [],
  }, { maxItemCount: 30 }).fetchAll();

  console.log(`Fetched ${resources.length}\n`);

  // What fields do they have?
  const stats = {
    total: resources.length,
    hasHobbyiqCardId: 0,
    hasCardNumber: 0,
    hasSetName: 0,
    hasYear: 0,
    hasSport: 0,
    hasPlayer: 0,
    hasTitle: 0,
    hasSearchText: 0,
    allSlugFields: 0,
    hasCardNumberAndYearAndSet: 0,
    hasTitleAndSet: 0,
  };
  const cardNumberSet = new Set();
  const playerSet = new Set();
  for (const r of resources) {
    if (r.hobbyiqCardId) stats.hasHobbyiqCardId++;
    const cn = r.cardNumber || r.numberAlt;
    const set = r.setName || r.setAlt;
    const yr = r.year || r.cardYear;
    const player = r.player || r.playerName;
    if (cn) { stats.hasCardNumber++; cardNumberSet.add(cn); }
    if (set) stats.hasSetName++;
    if (yr) stats.hasYear++;
    if (player) { stats.hasPlayer++; playerSet.add(player); }
    if (r.title) stats.hasTitle++;
    if (r.searchText) stats.hasSearchText++;
    if (cn && set && yr) stats.allSlugFields++;
    if (cn && yr && set) stats.hasCardNumberAndYearAndSet++;
    if (r.title && set) stats.hasTitleAndSet++;
  }

  console.log("=== FIELD PRESENCE ===");
  for (const [k, v] of Object.entries(stats)) {
    if (k === "total") { console.log(`  ${k}: ${v}`); continue; }
    console.log(`  ${k.padEnd(28)} ${v}/${stats.total}  (${((v / stats.total) * 100).toFixed(0)}%)`);
  }
  console.log(`\ndistinct cardNumbers: ${cardNumberSet.size}`);
  console.log(`distinct players: ${playerSet.size}`);

  // 12 example docs
  console.log("\n=== 12 EXAMPLES ===");
  for (const r of resources.slice(0, 12)) {
    const cn = r.cardNumber || r.numberAlt || '<none>';
    const set = r.setName || r.setAlt || '<none>';
    const yr = r.year || r.cardYear || '<none>';
    const player = r.player || r.playerName || '<none>';
    console.log(`  ---`);
    console.log(`  id       : ${r.id?.slice(0, 60)}`);
    console.log(`  set/#   : "${(set || '').slice(0, 40)}" #${cn}`);
    console.log(`  year/sport: ${yr} / <sport not projected>`);
    console.log(`  player   : ${player}`);
    console.log(`  title    : ${(r.title || '').slice(0, 60)}`);
    console.log(`  searchText: ${(r.searchText || '').slice(0, 80)}`);
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
