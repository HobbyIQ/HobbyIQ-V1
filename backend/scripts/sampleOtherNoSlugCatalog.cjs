// Sample no-slug catalog docs that aren't cardsight and aren't id=hiq:
// prefix. Understand what class of data they are so we can decide
// whether they're fixable, junk, or migratable.
const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const cat = client.database("hobbyiq").container("card_catalog");

  console.log("[other-sample] sampling 100 no-slug docs that aren't cardsight and aren't id=hiq:...");
  // Reduced TOP + fewer projected fields to minimize RU cost at 4K.
  const { resources } = await cat.items.query({
    query: `SELECT TOP 100 c.id, c.source, c.setName, c.cardNumber, c.year, c.cardYear, c.sport, c.playerName, c.title
            FROM c WHERE (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = '')
              AND NOT STARTSWITH(c.id, 'cardsight::')
              AND NOT STARTSWITH(c.id, 'hiq:')`,
  }, { maxItemCount: 25 }).fetchAll();

  console.log(`Fetched ${resources.length} docs.\n`);

  const bySource = new Map();
  for (const r of resources) {
    const src = r.source || (r.id?.split("::")[0]) || "unknown";
    if (!bySource.has(src)) {
      bySource.set(src, {
        n: 0, hasCardNumber: 0, hasSetName: 0, hasYear: 0, hasSport: 0, hasPlayer: 0, hasAllSlugFields: 0,
        idShape: new Map(),
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
    if (cn && set && yr) s.hasAllSlugFields++;
    // ID shape prefix (first ~15 chars)
    const idShape = r.id ? r.id.slice(0, 15) : "<no-id>";
    s.idShape.set(idShape, (s.idShape.get(idShape) || 0) + 1);
  }

  console.log("=== BY SOURCE ===");
  const sorted = [...bySource.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [src, s] of sorted) {
    console.log(`\n  ${src}  (${s.n} docs)`);
    console.log(`    hasCardNumber: ${s.hasCardNumber}/${s.n}  (${((s.hasCardNumber / s.n) * 100).toFixed(0)}%)`);
    console.log(`    hasSetName:    ${s.hasSetName}/${s.n}  (${((s.hasSetName / s.n) * 100).toFixed(0)}%)`);
    console.log(`    hasYear:       ${s.hasYear}/${s.n}  (${((s.hasYear / s.n) * 100).toFixed(0)}%)`);
    console.log(`    hasSport:      ${s.hasSport}/${s.n}  (${((s.hasSport / s.n) * 100).toFixed(0)}%)`);
    console.log(`    hasPlayer:     ${s.hasPlayer}/${s.n}  (${((s.hasPlayer / s.n) * 100).toFixed(0)}%)`);
    console.log(`    hasAllSlugFields (cn+set+yr): ${s.hasAllSlugFields}/${s.n}  (${((s.hasAllSlugFields / s.n) * 100).toFixed(0)}%)`);
    const idShapes = [...s.idShape.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    console.log(`    id prefixes:   ${idShapes.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }

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
      const cn = e.cardNumber || e.numberAlt || '<none>';
      const set = e.setName || e.setKey || e.setAlt || '<none>';
      const yr = e.year || e.cardYear || '<none>';
      const player = e.playerName || e.player || '<none>';
      console.log(`    id=${(e.id || '').slice(0, 50)} | y=${yr} | sport=${e.sport || '<none>'} | set=${(set || '').slice(0, 30)} | #${cn} | ${player} | title=${(e.title || '').slice(0, 40)}`);
    }
  }
}

main().catch((e) => { console.error(e?.message || e); process.exit(1); });
