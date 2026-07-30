#!/usr/bin/env node
// CF-DISCOVER-AUTO-CARDNUMBER-PREFIXES (Drew, 2026-07-30). Mine
// sold_comps for cardNumber prefixes that empirically correlate with
// isAuto=true. Any prefix where >= AUTO_THRESHOLD of samples are
// isAuto AND count >= MIN_SAMPLES becomes a candidate for the
// isCardNumberAutoSubset rule in parseTitleIdentity.service.ts.
//
// Read-only. Prints a candidate list — no writes.
//
// Env:
//   COSMOS_CONNECTION_STRING  — required
//   AUTO_THRESHOLD=0.90       — min fraction of prefix that must be auto
//   MIN_SAMPLES=20            — min row count for a prefix to be listed
//   YEAR_MIN=2005             — restrict to modern era (Drew's ask)

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const AUTO_THRESHOLD = Number(process.env.AUTO_THRESHOLD || "0.90");
const MIN_SAMPLES = Number(process.env.MIN_SAMPLES || "20");
const YEAR_MIN = Number(process.env.YEAR_MIN || "2005");

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database("hobbyiq").container("sold_comps");

  console.log(`[discover-auto-cardnumber-prefixes]`);
  console.log(`  auto_threshold: ${AUTO_THRESHOLD}`);
  console.log(`  min_samples:    ${MIN_SAMPLES}`);
  console.log(`  year_min:       ${YEAR_MIN}\n`);

  // Fetch (cardNumber, isAuto, cardYear) for all rows in the modern
  // era with a real cardNumber. Streaming — accumulate per prefix.
  const query = `
    SELECT c.cardNumber, c.isAuto
    FROM c
    WHERE IS_STRING(c.cardNumber)
      AND LENGTH(c.cardNumber) > 0
      AND c.cardYear >= @year_min
  `;
  const it = sc.items.query(
    { query, parameters: [{ name: "@year_min", value: YEAR_MIN }] },
    { maxItemCount: 5000 }
  );

  // Prefix stats: prefix -> { total, auto, examples }
  const stats = {};
  let scanned = 0;
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      const cn = String(r.cardNumber || "").toUpperCase().replace(/^#/, "");
      // Extract letter prefix before hyphen or first digit.
      const m = cn.match(/^([A-Z]+)(?:-|\d)/);
      if (!m) continue;
      const prefix = m[1];
      if (prefix.length < 2 || prefix.length > 6) continue;
      if (!stats[prefix]) stats[prefix] = { total: 0, auto: 0, examples: [] };
      stats[prefix].total++;
      if (r.isAuto === true) stats[prefix].auto++;
      if (stats[prefix].examples.length < 3) stats[prefix].examples.push(cn);
    }
    if (scanned % 100000 === 0) process.stdout.write(`\r  scanned ${scanned}`);
  }
  console.log(`\r  ${scanned} rows scanned; ${Object.keys(stats).length} distinct letter prefixes\n`);

  // Filter to high-auto-fraction + min-sample prefixes.
  const candidates = Object.entries(stats)
    .filter(([_, s]) => s.total >= MIN_SAMPLES && (s.auto / s.total) >= AUTO_THRESHOLD)
    .sort((a, b) => b[1].auto - a[1].auto);

  // Also list borderline (0.70-0.90) so Drew can eyeball.
  const borderline = Object.entries(stats)
    .filter(([_, s]) => s.total >= MIN_SAMPLES && (s.auto / s.total) >= 0.70 && (s.auto / s.total) < AUTO_THRESHOLD)
    .sort((a, b) => (b[1].auto / b[1].total) - (a[1].auto / a[1].total));

  console.log(`═══ CONFIDENT AUTO PREFIXES (>= ${(AUTO_THRESHOLD*100).toFixed(0)}%, n >= ${MIN_SAMPLES}) ═══`);
  console.log(`  Prefix       auto/total  ratio    examples`);
  candidates.forEach(([p, s]) => {
    const ratio = (s.auto / s.total * 100).toFixed(1);
    console.log(`  ${p.padEnd(12)} ${String(s.auto).padStart(5)}/${String(s.total).padStart(5)}  ${ratio.padStart(5)}%   ${s.examples.slice(0, 3).join(", ")}`);
  });

  console.log(`\n═══ BORDERLINE (70-${(AUTO_THRESHOLD*100).toFixed(0)}%, likely mixed subsets) ═══`);
  borderline.slice(0, 30).forEach(([p, s]) => {
    const ratio = (s.auto / s.total * 100).toFixed(1);
    console.log(`  ${p.padEnd(12)} ${String(s.auto).padStart(5)}/${String(s.total).padStart(5)}  ${ratio.padStart(5)}%   ${s.examples.slice(0, 2).join(", ")}`);
  });

  console.log(`\n═══ SUGGESTED REGEX for isCardNumberAutoSubset ═══`);
  const regexPrefixes = candidates.map(([p]) => p).join("|");
  console.log(`  /^(${regexPrefixes})(-|$)/`);
}

main().catch(e => { console.error(e); process.exit(1); });
