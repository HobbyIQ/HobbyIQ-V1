// CF-HISTORICAL-POLLUTION-COUNT (Drew, 2026-08-08). How much sport-tag
// pollution do we need to clean out of sold_comps + card_catalog?
// Post-fix (766bf0c1) new rows land correctly; this measures the debt
// from the pre-fix weeks when TCA's vendor sport tag was trusted.
//
// Uses light TOP-N sampling instead of full GROUP BY so it finishes
// against 3.9M rows at current RU.

const { CosmosClient } = require("@azure/cosmos");

async function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${label} @ ${ms}ms`)), ms)),
  ]);
}

// Same detector as tcaWebhook.routes.ts CATEGORY_MARKERS (post-766bf0c1)
const MARKERS = [
  [/\b(pokemon|pok[eé]?mon)\b/i, "pokemon"],
  [/\b(SV\d{1,2}|SWSH\d{1,2}|XY\d{1,3}|BW\d{1,3}|HGSS\d{1,3}|DP\d{1,3}|PL\d{1,3})\b/i, "pokemon"],
  [/\b(SV:|SWSH:|XY:|BW:|HGSS:|scarlet\s*&\s*violet|sword\s*&\s*shield|prismatic\s+evolutions|surging\s+sparks|obsidian\s+flames|paldea\s+evolved|fusion\s+strike)\b/i, "pokemon"],
  [/\b(reverse\s+holofoil|holofoil|rainbow\s+rare|full\s+art\s+trainer|shining\s+rare)\b/i, "pokemon"],
  [/\b\d{1,3}\/\d{2,3}\b/, "pokemon"],
  [/\b(yugioh|yu-?gi-?oh)\b/i, "yugioh"],
  [/\b(magic\s+the\s+gathering|\bmtg\b|hearthstone|lorcana|flesh\s+and\s+blood)\b/i, "tcg-other"],
  [/\b(dragon\s*ball|one\s+piece|weiss\s+schwarz|digimon|hunter\s*x\s*hunter|jujutsu\s+kaisen|attack\s+on\s+titan|naruto|my\s+hero\s+academia|demon\s+slayer)\b/i, "anime-tcg"],
  [/\b(star\s+wars|halo|final\s+fantasy|ultraman|kaiju|godzilla|marvel|dc\s+comics|funko|topps\s+wacky|garbage\s+pail|dungeons|d\s*&\s*d|d&d|world\s+of\s+warcraft|\bwow\b|the\s+boys|skybox)\b/i, "non-sport"],
  [/\b(formula\s*1|formula\s*one|\bf1\b|nascar|indycar|motogp)\b/i, "motorsport"],
  [/\b(\bwwe\b|\bwwf\b|\baew\b|wrestling|\bufc\b|\bmma\b|pride\s+fc|bellator)\b/i, "combat-sport"],
];
function detect(title) {
  if (!title) return null;
  for (const [rx, tag] of MARKERS) if (rx.test(title)) return tag;
  return null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const c = new CosmosClient(conn);
  const sc = c.database("hobbyiq").container("sold_comps");
  const cat = c.database("hobbyiq").container("card_catalog");

  console.log("=== SAMPLING 5000 sold_comps rows with sport=baseball ===");
  const q = await withTimeout(
    sc.items.query({
      query: "SELECT TOP 5000 c.title, c.sport, c.playerName FROM c WHERE c.sport = 'baseball' ORDER BY c._ts DESC",
    }, { maxItemCount: 5000 }).fetchNext(),
    60000, "sc-sample-5000"
  );
  const rows = q.resources ?? [];
  console.log(`  fetched: ${rows.length}`);

  const buckets = {};
  const samples = {};
  for (const r of rows) {
    const tag = detect(r.title);
    if (!tag) continue;
    buckets[tag] = (buckets[tag] || 0) + 1;
    if (!samples[tag]) samples[tag] = [];
    if (samples[tag].length < 3) samples[tag].push((r.title || "").slice(0, 90));
  }
  const totalPolluted = Object.values(buckets).reduce((s, n) => s + n, 0);
  const pollutionPct = ((totalPolluted / rows.length) * 100).toFixed(1);

  console.log(`\n=== POLLUTION in sold_comps sport=baseball (of ${rows.length} recent) ===`);
  console.log(`  polluted:  ${totalPolluted}  (${pollutionPct}%)`);
  console.log(`  clean:     ${rows.length - totalPolluted}`);
  console.log(`\n  by category:`);
  Object.entries(buckets).sort((a, b) => b[1] - a[1]).forEach(([tag, n]) => {
    const pct = ((n / rows.length) * 100).toFixed(1);
    console.log(`    ${tag.padEnd(15)} ${String(n).padStart(5)}  (${pct}%)`);
    (samples[tag] || []).forEach(s => console.log(`      · ${s}`));
  });

  console.log(`\n\n=== SAMPLING 2000 card_catalog rows with sport=baseball ===`);
  const qc = await withTimeout(
    cat.items.query({
      query: "SELECT TOP 2000 c.title, c.sport, c.setName, c.playerName FROM c WHERE c.sport = 'baseball' ORDER BY c._ts DESC",
    }, { maxItemCount: 2000 }).fetchNext(),
    60000, "cat-sample-2000"
  );
  const catRows = qc.resources ?? [];
  console.log(`  fetched: ${catRows.length}`);

  const catBuckets = {};
  const catSamples = {};
  for (const r of catRows) {
    const searchText = [r.title, r.setName, r.playerName].filter(Boolean).join(" ");
    const tag = detect(searchText);
    if (!tag) continue;
    catBuckets[tag] = (catBuckets[tag] || 0) + 1;
    if (!catSamples[tag]) catSamples[tag] = [];
    if (catSamples[tag].length < 3) catSamples[tag].push((searchText || "").slice(0, 90));
  }
  const catTotalPolluted = Object.values(catBuckets).reduce((s, n) => s + n, 0);
  const catPct = ((catTotalPolluted / catRows.length) * 100).toFixed(1);
  console.log(`\n  polluted:  ${catTotalPolluted}  (${catPct}%)`);
  console.log(`  by category:`);
  Object.entries(catBuckets).sort((a, b) => b[1] - a[1]).forEach(([tag, n]) => {
    console.log(`    ${tag.padEnd(15)} ${n}`);
    (catSamples[tag] || []).forEach(s => console.log(`      · ${s}`));
  });

  console.log(`\n=== EXTRAPOLATION ===`);
  console.log(`  sold_comps sport=baseball ~= 2M rows (rough — full pool 3.9M, baseball is main slice)`);
  console.log(`  If ${pollutionPct}% pollution holds full-pool: ~${Math.round(2_000_000 * totalPolluted / rows.length / 1000)}K polluted sold_comps rows`);
  console.log(`  card_catalog ~= 5.7M rows total; sport=baseball unknown slice`);
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
