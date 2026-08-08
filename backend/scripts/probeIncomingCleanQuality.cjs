// CF-INCOMING-CLEAN-QUALITY (Drew, 2026-08-08). For 200 latest TCA
// rows: what % is landing with clean fields + a hobbyiqCardId that
// actually matches a card_catalog entry?

const { CosmosClient } = require("@azure/cosmos");

async function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label} @ ${ms}ms`)), ms)),
  ]);
}

// Heuristics for spotting parse garbage:
//   playerName starts with a set-word prefix ("WWE X", "Formula X",
//   "Pokemon X") = title-parser fell back on random tokens
const GARBAGE_NAME_PREFIX = /^(wwe|formula|pokemon|yugioh|magic the|one piece|dragon ball|attack on|marvel|dc |star wars|halo|topps|panini|bowman|fleer|donruss|upper deck|score|pinnacle|goudey|leaf)\s/i;

const VALID_SPORTS = new Set(["baseball", "basketball", "football", "hockey", "soccer"]);

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn);
  const sc = c.database("hobbyiq").container("sold_comps");
  const catalog = c.database("hobbyiq").container("card_catalog");

  console.log("=== FETCHING LATEST 200 TCA ROWS ===");
  const q = await withTimeout(
    sc.items.query({
      query: "SELECT TOP 200 c.observedAt, c.title, c.sport, c.playerName, c.hobbyiqCardId, c.setName, c.cardNumber, c.parallel FROM c WHERE c.source = 'tca-ebay' ORDER BY c.observedAt DESC",
    }, { maxItemCount: 200 }).fetchNext(),
    45000, "latest-200"
  );
  const rows = q.resources ?? [];
  console.log(`  rows: ${rows.length}`);
  if (rows.length === 0) return;

  // ── field-level quality signals ──
  const hasHiq = rows.filter(r => r.hobbyiqCardId).length;
  const hasSport = rows.filter(r => r.sport).length;
  const validSport = rows.filter(r => VALID_SPORTS.has((r.sport || "").toLowerCase())).length;
  const hasPlayer = rows.filter(r => r.playerName).length;
  const garbagePlayer = rows.filter(r => r.playerName && GARBAGE_NAME_PREFIX.test(r.playerName)).length;
  const hasCardNum = rows.filter(r => r.cardNumber).length;
  const hasSetName = rows.filter(r => r.setName).length;

  console.log(`\n=== FIELD PRESENCE (n=${rows.length}) ===`);
  console.log(`  hobbyiqCardId set:  ${hasHiq}  (${(hasHiq / rows.length * 100).toFixed(0)}%)`);
  console.log(`  sport set:          ${hasSport}  (${(hasSport / rows.length * 100).toFixed(0)}%)`);
  console.log(`  sport ∈ VALID_5:    ${validSport}  (${(validSport / rows.length * 100).toFixed(0)}%)`);
  console.log(`  playerName set:     ${hasPlayer}  (${(hasPlayer / rows.length * 100).toFixed(0)}%)`);
  console.log(`  playerName GARBAGE: ${garbagePlayer}  (${(garbagePlayer / rows.length * 100).toFixed(0)}%)`);
  console.log(`  cardNumber set:     ${hasCardNum}  (${(hasCardNum / rows.length * 100).toFixed(0)}%)`);
  console.log(`  setName set:        ${hasSetName}  (${(hasSetName / rows.length * 100).toFixed(0)}%)`);

  // ── SPORT breakdown ──
  const bySport = {};
  for (const r of rows) {
    const s = (r.sport || "(null)").toLowerCase();
    bySport[s] = (bySport[s] || 0) + 1;
  }
  console.log(`\n=== SPORT DISTRIBUTION ===`);
  Object.entries(bySport).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => {
    console.log(`  ${s.padEnd(20)} ${n}`);
  });

  // ── CATALOG MATCH — sample 20 hiq slugs, point-lookup each ──
  console.log(`\n=== CATALOG MATCH TEST (sample 20 slugs) ===`);
  const slugs = rows.filter(r => r.hobbyiqCardId).slice(0, 20).map(r => r.hobbyiqCardId);
  let matched = 0, missing = 0, errored = 0;
  const missingSamples = [];
  for (const slug of slugs) {
    try {
      const { resource } = await catalog.item(slug, slug).read();
      if (resource) matched++;
      else { missing++; if (missingSamples.length < 5) missingSamples.push(slug); }
    } catch (e) {
      if (e?.code === 404) { missing++; if (missingSamples.length < 5) missingSamples.push(slug); }
      else errored++;
    }
  }
  console.log(`  matched to catalog: ${matched} / ${slugs.length}`);
  console.log(`  MISSING in catalog: ${missing} / ${slugs.length}`);
  console.log(`  errored:            ${errored} / ${slugs.length}`);
  if (missingSamples.length) {
    console.log(`  sample missing slugs:`);
    missingSamples.forEach(s => console.log(`    ${s}`));
  }

  // ── SAMPLE ROWS for eyeball ──
  console.log(`\n=== 5 SAMPLE ROWS (eyeball for parse quality) ===`);
  rows.slice(0, 5).forEach((r, i) => {
    console.log(`\n  ${i + 1}. title=${(r.title || "").slice(0, 90)}`);
    console.log(`     sport=${r.sport}  player=${r.playerName}  set=${r.setName}  cn=${r.cardNumber}  parallel=${r.parallel}`);
    console.log(`     hiq=${(r.hobbyiqCardId || "(none)").slice(0, 100)}`);
  });
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
