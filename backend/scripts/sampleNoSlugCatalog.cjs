// Sample docs from card_catalog where hobbyiqCardId is missing — group
// by source to understand what class of data these actually are. Small
// query (TOP 500 total, one pass) to keep RU cheap while dedup audit
// runs in parallel.
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database("hobbyiq").container("card_catalog");

  console.log("[no-slug-sample] fetching TOP 500 no-hobbyiqCardId docs to see what they are...");
  const { resources } = await cat.items.query({
    query: `SELECT TOP 500 c.id, c.source, c.setName, c.setKey, c["set"] AS setAlt,
                   c.cardNumber, c["number"] AS numberAlt,
                   c.year, c.cardYear, c.sport, c.playerName, c.player,
                   c.parallel, c.isAuto, c.title, c.verificationStatus
            FROM c WHERE NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = ''`,
  }).fetchAll();

  console.log(`Fetched ${resources.length} sample docs.\n`);

  // Group by source, count field presence per source
  const bySource = new Map();
  for (const r of resources) {
    const src = r.source || (r.id?.split("::")[0]) || "unknown";
    if (!bySource.has(src)) {
      bySource.set(src, {
        n: 0,
        hasCardNumber: 0,
        hasSetName: 0,
        hasYear: 0,
        hasSport: 0,
        hasPlayer: 0,
        hasAll4: 0,
      });
    }
    const s = bySource.get(src);
    s.n++;
    const cn = r.cardNumber || r.numberAlt;
    const set = r.setName || r.setKey || r.setAlt;
    const yr = r.year || r.cardYear;
    const sport = r.sport;
    const player = r.playerName || r.player;
    if (cn) s.hasCardNumber++;
    if (set) s.hasSetName++;
    if (yr) s.hasYear++;
    if (sport) s.hasSport++;
    if (player) s.hasPlayer++;
    if (cn && set && yr) s.hasAll4++;
  }

  console.log("=== BY SOURCE (of the 500 sample) ===");
  const sorted = [...bySource.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [src, s] of sorted) {
    console.log(`\n  ${src}  (${s.n} docs)`);
    console.log(`    hasCardNumber: ${s.hasCardNumber}/${s.n}  (${((s.hasCardNumber / s.n) * 100).toFixed(0)}%)`);
    console.log(`    hasSetName:    ${s.hasSetName}/${s.n}  (${((s.hasSetName / s.n) * 100).toFixed(0)}%)`);
    console.log(`    hasYear:       ${s.hasYear}/${s.n}  (${((s.hasYear / s.n) * 100).toFixed(0)}%)`);
    console.log(`    hasSport:      ${s.hasSport}/${s.n}  (${((s.hasSport / s.n) * 100).toFixed(0)}%)`);
    console.log(`    hasPlayer:     ${s.hasPlayer}/${s.n}  (${((s.hasPlayer / s.n) * 100).toFixed(0)}%)`);
    console.log(`    hasAllSlugFields (cn+set+yr): ${s.hasAll4}/${s.n}  (${((s.hasAll4 / s.n) * 100).toFixed(0)}%)`);
  }

  // Print 3 example docs per source so we can see what they LOOK like
  console.log("\n=== EXAMPLES ===");
  const bySrcExamples = new Map();
  for (const r of resources) {
    const src = r.source || (r.id?.split("::")[0]) || "unknown";
    if (!bySrcExamples.has(src)) bySrcExamples.set(src, []);
    if (bySrcExamples.get(src).length < 3) bySrcExamples.get(src).push(r);
  }
  for (const [src, exs] of bySrcExamples) {
    console.log(`\n  Source: ${src}`);
    for (const e of exs) {
      const cn = e.cardNumber || e.numberAlt || '<no cardNumber>';
      const set = e.setName || e.setKey || e.setAlt || '<no setName>';
      const yr = e.year || e.cardYear || '<no year>';
      const player = e.playerName || e.player || '<no player>';
      console.log(`    id=${e.id?.slice(0, 40)} | year=${yr} | sport=${e.sport || '<no sport>'} | set=${set} | #${cn} | ${player} | title=${(e.title || '').slice(0, 50)}`);
    }
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
