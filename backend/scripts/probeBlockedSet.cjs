#!/usr/bin/env node
// CF-PROBE-BLOCKED-SET (Drew, 2026-08-14). Diagnostic for the awaiting-catalog
// work-list.
//
// requeueMatchableAwaitingCatalog groups blocked sales by vertical:year:setKey,
// and the top entries came back as sets we plainly DO have — 2025 Topps, 2026
// Topps Chrome, 2025 Bowman. So "missing checklist" is the wrong reading: the
// set is in the catalog, but the specific card (number + parallel) is not.
//
// This prints, for one set, the blocked slugs beside what the catalog actually
// holds — so the gap is visible as a shape (missing parallels? missing insert
// number ranges? a cardNumber format mismatch?) rather than a count.
//
//   node scripts/probeBlockedSet.cjs --set hiq:baseball:2025:topps
//   node scripts/probeBlockedSet.cjs --set hiq:baseball:2025:unknown --sample 40

const { CosmosClient } = require("@azure/cosmos");

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SET = val("--set", "hiq:baseball:2025:topps");
const SAMPLE = Number(val("--sample", "25"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const db = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq");
const staging = db.container("comps_staging");
const catalog = db.container(process.env.COSMOS_CARD_CATALOG_CONTAINER || "card_catalog");

const parts = SET.split(":");            // hiq:{vertical}:{year}:{setKey}
const VERTICAL = parts[1], YEAR = Number(parts[2]), SETKEY = parts[3];

(async () => {
  console.log(`probing ${SET}\n`);

  // ---- what is stuck -------------------------------------------------------
  const { resources: stuck } = await staging.items.query({
    query: `SELECT c.hobbyiqCardId AS slug, COUNT(1) AS n FROM c
            WHERE c.status = 'awaiting-catalog' AND STARTSWITH(c.hobbyiqCardId, @p)
            GROUP BY c.hobbyiqCardId`,
    parameters: [{ name: "@p", value: `${SET}:` }],
  }).fetchAll();
  stuck.sort((a, b) => b.n - a.n);
  const stuckRows = stuck.reduce((s, r) => s + r.n, 0);
  console.log(`blocked slugs: ${stuck.length.toLocaleString()}  covering ${stuckRows.toLocaleString()} sales`);

  // ---- what the catalog holds for the same set ----------------------------
  const { resources: have } = await catalog.items.query({
    query: `SELECT VALUE COUNT(1) FROM c
            WHERE c.sport = @v AND c.year = @y AND c.setKey = @s`,
    parameters: [
      { name: "@v", value: VERTICAL }, { name: "@y", value: YEAR }, { name: "@s", value: SETKEY },
    ],
  }).fetchAll();
  console.log(`catalog rows for ${VERTICAL} ${YEAR} ${SETKEY}: ${(have[0] ?? 0).toLocaleString()}\n`);

  // ---- shape of the gap: parallels present vs demanded --------------------
  const demandPar = new Map(), demandNum = new Map();
  for (const r of stuck) {
    const p = String(r.slug).split(":");
    // hiq:{v}:{y}:{setKey}:{cardNumber}:{parallelSlug}:{auto}[:num-N]
    const num = p[4] ?? "", par = p[5] ?? "";
    demandPar.set(par, (demandPar.get(par) ?? 0) + r.n);
    demandNum.set(num, (demandNum.get(num) ?? 0) + r.n);
  }
  const topPar = [...demandPar.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  console.log("most-demanded parallels among blocked sales:");
  for (const [k, n] of topPar) {
    const { resources: c } = await catalog.items.query({
      query: `SELECT VALUE COUNT(1) FROM c
              WHERE c.sport=@v AND c.year=@y AND c.setKey=@s AND c.parallelSlug=@p`,
      parameters: [
        { name: "@v", value: VERTICAL }, { name: "@y", value: YEAR },
        { name: "@s", value: SETKEY }, { name: "@p", value: k },
      ],
    }).fetchAll();
    const inCat = c[0] ?? 0;
    console.log(`  ${String(n).padStart(6)} sales  parallel="${k}"  -> catalog has ${inCat} row(s) ${inCat ? "" : "  <-- MISSING"}`);
  }

  console.log(`\nsample blocked slugs (top ${SAMPLE} by sales):`);
  for (const r of stuck.slice(0, SAMPLE)) console.log(`  ${String(r.n).padStart(5)}  ${r.slug}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
