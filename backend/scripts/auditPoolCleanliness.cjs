// CF-POOL-CLEAN-AUDIT (Drew, 2026-08-08). Real "what fraction of the
// 3.9M sold_comps pool is CLEAN vs needs re-cleaning?" audit. Samples
// N rows (default 10K), evaluates each on 6 cleanliness axes, reports
// aggregate + per-axis + intersection stats.
//
// Axes (any failure = "dirty"):
//   1. hobbyiqCardId assigned (catalog-matched)
//   2. playerName populated + not garbage-prefixed
//   3. setName populated
//   4. cardYear valid (1900-2100)
//   5. sport tag matches title (no F1/WWE/Pokemon as baseball)
//   6. parallel populated OR explicitly "base"

const { CosmosClient } = require("@azure/cosmos");

// Same regex as tcaWebhook.routes.ts CATEGORY_MARKERS (post-Skybox fix)
const NON_SPORT_MARKERS = [
  [/\b(pokemon|pok[eé]?mon)\b/i, "pokemon"],
  [/\b(SV\d{1,2}|SWSH\d{1,2}|XY\d{1,3}|BW\d{1,3}|HGSS\d{1,3}|DP\d{1,3}|PL\d{1,3})\b/i, "pokemon"],
  [/\b(SV:|SWSH:|XY:|BW:|HGSS:|scarlet\s*&\s*violet|sword\s*&\s*shield|prismatic\s+evolutions|surging\s+sparks|obsidian\s+flames|paldea\s+evolved|fusion\s+strike)\b/i, "pokemon"],
  [/\b(reverse\s+holofoil|holofoil|rainbow\s+rare|full\s+art\s+trainer|shining\s+rare)\b/i, "pokemon"],
  [/\b(yugioh|yu-?gi-?oh)\b/i, "yugioh"],
  [/\b(magic\s+the\s+gathering|\bmtg\b|hearthstone|lorcana|flesh\s+and\s+blood)\b/i, "tcg-other"],
  [/\b(dragon\s*ball|one\s+piece|weiss\s+schwarz|digimon|hunter\s*x\s*hunter|jujutsu\s+kaisen|attack\s+on\s+titan|naruto|my\s+hero\s+academia|demon\s+slayer)\b/i, "anime-tcg"],
  [/\b(star\s+wars|halo|final\s+fantasy|ultraman|kaiju|godzilla|marvel|dc\s+comics|funko|topps\s+wacky|garbage\s+pail|dungeons|d\s*&\s*d|d&d|world\s+of\s+warcraft|\bwow\b|the\s+boys)\b/i, "non-sport"],
  [/\b(formula\s*1|formula\s*one|\bf1\b|nascar|indycar|motogp)\b/i, "motorsport"],
  [/\b(\bwwe\b|\bwwf\b|\baew\b|wrestling|\bufc\b|\bmma\b|pride\s+fc|bellator)\b/i, "combat-sport"],
];
function titleImpliedSport(title) {
  if (!title) return null;
  for (const [rx, tag] of NON_SPORT_MARKERS) if (rx.test(title)) return tag;
  return null;
}
const VALID_5_SPORTS = new Set(["baseball", "basketball", "football", "hockey", "soccer"]);
const GARBAGE_NAME_PREFIX = /^(wwe|formula|pokemon|yugioh|magic the|one piece|dragon ball|attack on|marvel|dc |star wars|halo|topps|panini|bowman|fleer|donruss|upper deck|score|pinnacle|goudey|leaf|reverse|holofoil|black drew|wwe |aew )\s/i;

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const SAMPLE_N = Number(process.env.SAMPLE_N || 10000);
  const c = new CosmosClient(conn);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log(`Sampling ${SAMPLE_N} sold_comps rows (recent + older mix)...`);
  const startMs = Date.now();
  // Get a sample — mix recent + older by using ORDER BY observedAt DESC.
  const q = await sc.items.query({
    query: `SELECT TOP ${SAMPLE_N} c.hobbyiqCardId, c.playerName, c.setName, c.cardYear, c.sport, c.parallel, c.title, c.source, c.observedAt FROM c ORDER BY c._ts DESC`,
  }, { maxItemCount: SAMPLE_N }).fetchNext();
  const rows = q.resources || [];
  console.log(`  fetched ${rows.length} rows in ${((Date.now()-startMs)/1000).toFixed(1)}s`);

  const fail = { hiq: 0, player: 0, playerGarbage: 0, setName: 0, cardYear: 0, sportMismatch: 0, parallel: 0 };
  const bySource = {};
  let allClean = 0;
  const dirtySamples = [];

  for (const r of rows) {
    const src = (r.source || "(null)").slice(0, 20);
    bySource[src] = bySource[src] || { total: 0, clean: 0 };
    bySource[src].total++;

    const flags = [];
    if (!r.hobbyiqCardId || r.hobbyiqCardId === "") { fail.hiq++; flags.push("no-hiq"); }
    if (!r.playerName || !r.playerName.trim()) { fail.player++; flags.push("no-player"); }
    else if (GARBAGE_NAME_PREFIX.test(r.playerName)) { fail.playerGarbage++; flags.push("garbage-player"); }
    if (!r.setName || !r.setName.trim()) { fail.setName++; flags.push("no-set"); }
    const y = r.cardYear;
    if (typeof y !== "number" || y < 1900 || y > 2100) { fail.cardYear++; flags.push("bad-year"); }
    const impliedSport = titleImpliedSport(r.title);
    const rowSport = String(r.sport || "").toLowerCase();
    if (impliedSport && VALID_5_SPORTS.has(rowSport) && impliedSport !== rowSport) {
      // e.g., title says pokemon but sport tag says baseball
      fail.sportMismatch++;
      flags.push(`sport-mismatch(${impliedSport}→${rowSport})`);
    }
    if (!r.parallel || r.parallel === "") { fail.parallel++; flags.push("no-parallel"); }

    if (flags.length === 0) {
      allClean++;
      bySource[src].clean++;
    } else if (dirtySamples.length < 6) {
      dirtySamples.push({ flags: flags.join(","), title: (r.title || "").slice(0, 70), source: r.source });
    }
  }

  const pct = (n) => ((n / rows.length) * 100).toFixed(1);
  console.log(`\n=== CLEANLINESS AUDIT (${rows.length} rows) ===\n`);
  console.log(`  CLEAN (all axes pass):      ${allClean.toLocaleString()} (${pct(allClean)}%)`);
  console.log(`  DIRTY (at least 1 issue):   ${(rows.length - allClean).toLocaleString()} (${pct(rows.length - allClean)}%)`);
  console.log(`\n  DIRTY breakdown (row may fail multiple axes):`);
  console.log(`    missing hobbyiqCardId:    ${fail.hiq.toLocaleString().padStart(7)} (${pct(fail.hiq)}%)`);
  console.log(`    missing playerName:       ${fail.player.toLocaleString().padStart(7)} (${pct(fail.player)}%)`);
  console.log(`    garbage playerName:       ${fail.playerGarbage.toLocaleString().padStart(7)} (${pct(fail.playerGarbage)}%)`);
  console.log(`    missing setName:          ${fail.setName.toLocaleString().padStart(7)} (${pct(fail.setName)}%)`);
  console.log(`    bad/missing cardYear:     ${fail.cardYear.toLocaleString().padStart(7)} (${pct(fail.cardYear)}%)`);
  console.log(`    sport-vs-title mismatch:  ${fail.sportMismatch.toLocaleString().padStart(7)} (${pct(fail.sportMismatch)}%)`);
  console.log(`    missing parallel:         ${fail.parallel.toLocaleString().padStart(7)} (${pct(fail.parallel)}%)`);

  console.log(`\n=== BY SOURCE ===`);
  Object.entries(bySource).sort((a, b) => b[1].total - a[1].total).slice(0, 8).forEach(([s, x]) => {
    const cleanPct = x.total ? ((x.clean / x.total) * 100).toFixed(0) : "0";
    console.log(`  ${s.padEnd(22)} ${x.total.toLocaleString().padStart(7)} rows  ${cleanPct}% clean`);
  });

  console.log(`\n=== SAMPLE DIRTY ROWS ===`);
  dirtySamples.forEach((s, i) => {
    console.log(`  ${i+1}. [${s.source}] ${s.flags}`);
    console.log(`     ${s.title}`);
  });
}

main().catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
