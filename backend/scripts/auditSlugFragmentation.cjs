// CF-SLUG-FRAG-AUDIT (Drew, 2026-08-10). Audit sold_comps for
// bare-product-family vs chrome-product-family fragmentation:
//   bowman  vs  bowman-chrome
//   topps   vs  topps-chrome
//   bowman  vs  bowman-chrome-sapphire
//
// A card with cardNumber prefix CPA-, BCP-, TPA-, TCPA- (etc.) exists
// ONLY under the chrome family. If its comps live under the bare family,
// they are misslugged.
//
// Also detect :num-<N> variants where the base slug already exists for
// the same identity (indicates the parallel's printRun is inherent and
// :num-N should not be a separate slug).

const { CosmosClient } = require("@azure/cosmos");

const CHROME_ONLY_PREFIXES = [
  { prefix: "cpa-", family: "bowman-chrome", canonicalFrom: "bowman", note: "CPA = Chrome Prospect Autographs" },
  { prefix: "bcp-", family: "bowman-chrome", canonicalFrom: "bowman", note: "BCP = Bowman Chrome Prospects" },
  { prefix: "cpa", family: "bowman-chrome", canonicalFrom: "bowman", note: "CPA (no dash) = Chrome Prospect Auto" },
  { prefix: "bdc-", family: "bowman-draft-chrome", canonicalFrom: "bowman-draft", note: "BDC = Bowman Draft Chrome" },
  { prefix: "tcpa-", family: "topps-chrome", canonicalFrom: "topps", note: "TCPA = Topps Chrome Prospect Auto" },
  { prefix: "cra-", family: "topps-chrome", canonicalFrom: "topps", note: "CRA = Chrome Rookie Auto (Topps Chrome)" },
];

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const sold = new CosmosClient(conn).database("hobbyiq").container("sold_comps");

  console.log("=== 1) chrome-only cardNumber under bare family (misslug) ===");
  const misslugTotals = {};
  const bigOffenders = [];
  for (const { prefix, canonicalFrom, family, note } of CHROME_ONLY_PREFIXES) {
    // Slug shape: hiq:<sport>:<year>:<family>:<cardNumber>:<parallel>:<auto|no-auto>[:num-N]
    // Bare family segment index = 3 (0=hiq, 1=sport, 2=year, 3=family, 4=cardNumber)
    const q = await sold.items.query({
      query: `SELECT c.hobbyiqCardId, c.cardNumber, c.parallel, c.printRun, c.playerName
              FROM c
              WHERE STARTSWITH(c.hobbyiqCardId, @bareFam)
                AND CONTAINS(c.hobbyiqCardId, @needle)`,
      parameters: [
        { name: "@bareFam", value: `hiq:baseball:2026:${canonicalFrom}:` },
        { name: "@needle", value: `:${canonicalFrom}:${prefix}` },
      ],
    }, { enableCrossPartitionQuery: true }).fetchAll();

    if (q.resources.length === 0) continue;
    const bySlug = new Map();
    for (const r of q.resources) {
      const k = r.hobbyiqCardId;
      if (!bySlug.has(k)) bySlug.set(k, { count: 0, sample: r });
      bySlug.get(k).count++;
    }
    console.log(`\n  prefix ${prefix} (${note}): ${q.resources.length} misslugged rows across ${bySlug.size} slug(s)`);
    misslugTotals[prefix] = { rows: q.resources.length, slugs: bySlug.size };
    // biggest offenders
    const top = [...bySlug.entries()].sort((a,b)=>b[1].count-a[1].count).slice(0, 5);
    for (const [slug, { count, sample }] of top) {
      console.log(`    ${count.toString().padStart(4)} rows  ${slug}  (${sample.playerName || "?"})`);
      bigOffenders.push({ slug, count, prefix, canonicalFrom, family, player: sample.playerName });
    }
  }

  console.log("\n\n=== 2) :num-N slug where base slug also exists (inherent-run duplication) ===");
  // A cleaner test would be per (year, family, cardNumber, parallel, isAuto): if
  // both `:auto` and `:auto:num-N` exist, the num-N is dupe. Do it via distinct
  // slug enumeration ending in :num-<N>. Sample first.
  const q = await sold.items.query({
    query: `SELECT DISTINCT c.hobbyiqCardId FROM c
            WHERE CONTAINS(c.hobbyiqCardId, ':num-')
              AND STARTSWITH(c.hobbyiqCardId, 'hiq:baseball:2026:bowman-chrome:cpa-')`,
  }, { enableCrossPartitionQuery: true }).fetchAll();

  // for each :num-N slug, compute the base (drop last segment if :num-<N>)
  const dupePairs = [];
  const baseCounts = new Map();
  for (const r of q.resources) {
    const slug = r.hobbyiqCardId;
    const m = slug.match(/^(.+):num-\d+$/);
    if (!m) continue;
    const base = m[1];
    // check if base slug exists
    if (!baseCounts.has(base)) {
      const bc = await sold.items.query({
        query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s`,
        parameters: [{ name: "@s", value: base }],
      }, { enableCrossPartitionQuery: true }).fetchAll();
      baseCounts.set(base, bc.resources[0] || 0);
    }
    if (baseCounts.get(base) > 0) {
      const nc = await sold.items.query({
        query: `SELECT VALUE COUNT(1) FROM c WHERE c.hobbyiqCardId = @s`,
        parameters: [{ name: "@s", value: slug }],
      }, { enableCrossPartitionQuery: true }).fetchAll();
      dupePairs.push({ base, baseCount: baseCounts.get(base), num: slug, numCount: nc.resources[0] || 0 });
    }
  }
  console.log(`  found ${dupePairs.length} pair(s) with base + :num-N both populated`);
  for (const p of dupePairs.slice(0, 20)) {
    console.log(`    base ${p.baseCount.toString().padStart(4)}  |  num ${p.numCount.toString().padStart(4)}  |  ${p.num}`);
  }

  console.log("\n\n=== SUMMARY ===");
  console.log("Chrome-only misslugs by prefix:");
  for (const [k, v] of Object.entries(misslugTotals)) console.log(`  ${k.padEnd(6)}: ${v.rows.toString().padStart(5)} rows across ${v.slugs.toString().padStart(4)} slugs`);
  const totalMisslug = Object.values(misslugTotals).reduce((a,b)=>a+b.rows,0);
  console.log(`  TOTAL: ${totalMisslug} misslugged rows`);
  console.log(`Inherent-run duplication (CPA sample): ${dupePairs.length} pairs`);

  // Save findings
  const fs = require("fs");
  const findings = { misslugTotals, bigOffenders, dupePairs, generatedAt: new Date().toISOString() };
  fs.writeFileSync("scripts/slug-frag-findings.json", JSON.stringify(findings, null, 2));
  console.log("\n  written: backend/scripts/slug-frag-findings.json");
}
main().catch(e => { console.error(e); process.exit(1); });
