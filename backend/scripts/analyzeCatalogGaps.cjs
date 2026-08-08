// CF-CATALOG-GAP-TRIAGE (Drew, 2026-08-08). Pool the sold_comps rows
// that never got a hobbyiqCardId (~0.9% of the 3.9M pool = ~35K rows),
// group by (cardYear, setName, sport), rank by count. The biggest
// buckets = the highest-leverage sets to add to card_catalog: filling
// one product-checklist unblocks N unmatched historical rows at once.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   TOP_N                      default 30 buckets to report
//   MIN_ROWS                   default 3 (bucket must have >= N rows)
//   SAMPLE_LIMIT               default 15000 (cap unmatched-row scan)

const { CosmosClient } = require("@azure/cosmos");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const TOP_N = Number(process.env.TOP_N || 30);
  const MIN_ROWS = Number(process.env.MIN_ROWS || 3);
  const LIMIT = Number(process.env.SAMPLE_LIMIT || 15000);

  const c = new CosmosClient(conn);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log(`Scanning up to ${LIMIT.toLocaleString()} sold_comps rows without hobbyiqCardId...`);
  const startMs = Date.now();
  const q = await sc.items.query({
    query: `SELECT TOP ${LIMIT} c.cardYear, c.setName, c.sport, c.playerName, c.title, c.source
            FROM c
            WHERE (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = "")
            ORDER BY c._ts DESC`,
  }, { maxItemCount: LIMIT }).fetchNext();
  const rows = q.resources || [];
  console.log(`  fetched ${rows.length.toLocaleString()} unmatched rows in ${((Date.now()-startMs)/1000).toFixed(1)}s`);

  if (rows.length === 0) {
    console.log("  (no unmatched rows — pool is 100% matched)");
    return;
  }

  // Bucket by (cardYear, setName, sport). Skip rows where all three
  // are missing — those need parsing work, not catalog additions.
  const buckets = new Map();
  let noKey = 0;
  for (const r of rows) {
    const year = r.cardYear ?? null;
    const set = (r.setName ?? "").trim() || null;
    const sport = (r.sport ?? "").trim().toLowerCase() || null;
    if (!year && !set) { noKey++; continue; }
    const key = `${year ?? "?"}\t${set ?? "?"}\t${sport ?? "?"}`;
    if (!buckets.has(key)) buckets.set(key, { year, set, sport, count: 0, samples: [] });
    const b = buckets.get(key);
    b.count++;
    if (b.samples.length < 3 && r.title) b.samples.push(r.title.slice(0, 90));
  }

  const ranked = [...buckets.values()]
    .filter((b) => b.count >= MIN_ROWS)
    .sort((a, b) => b.count - a.count);

  console.log(`\n=== TOP ${Math.min(TOP_N, ranked.length)} CATALOG GAPS (of ${buckets.size.toLocaleString()} distinct buckets) ===\n`);
  console.log(`  rank  count  year   sport         setName`);
  console.log(`  ----  -----  ----   ----------    -----------------------------------------------`);
  ranked.slice(0, TOP_N).forEach((b, i) => {
    console.log(`  ${String(i+1).padStart(4)}  ${String(b.count).padStart(5)}  ${String(b.year ?? "?").padEnd(6)}  ${String(b.sport ?? "?").padEnd(12)}  ${(b.set ?? "?").slice(0, 46)}`);
  });

  const sumTopN = ranked.slice(0, TOP_N).reduce((s, b) => s + b.count, 0);
  const sumAll = ranked.reduce((s, b) => s + b.count, 0);
  console.log(``);
  console.log(`  top-${TOP_N} unlock:      ${sumTopN.toLocaleString()} rows (of ${sumAll.toLocaleString()} matchable via bucket)`);
  console.log(`  no-key rows:      ${noKey.toLocaleString()} (need parser fix, not catalog fill)`);
  console.log(``);
  console.log(`=== SAMPLE TITLES from top-5 buckets ===`);
  ranked.slice(0, 5).forEach((b, i) => {
    console.log(`  #${i+1} ${b.year} ${b.set} (${b.sport}, ${b.count} rows):`);
    b.samples.forEach((t) => console.log(`      · ${t}`));
  });
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
