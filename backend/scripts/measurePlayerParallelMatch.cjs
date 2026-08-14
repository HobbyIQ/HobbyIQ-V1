#!/usr/bin/env node
// CF-PLAYER-PARALLEL-MATCH-FEASIBILITY (Drew, 2026-08-14: "yes do it").
//
// The blocked pile is not a checklist gap. Every top blocked set already has a
// real ingested checklist, and the two that looked absent turned out to be
// parse defects. What is actually blocked is sales whose titles carry
//
//   player + set + parallel + serial          but NO card number
//
//   "2025-26 Bowman Chrome AJ Dybantsa Aqua X-Fractor 1st Prospect 079/125"
//   "Elijah Arroyo 2025 Topps Chrome Black Purple Mini-Diamond Refractor RC 42/75"
//
// No parser improvement reaches these — the card number is simply not present.
// Matching on player + parallel could, because the catalog already stores
// playerSlug and parallelSlug.
//
// MEASURE BEFORE BUILDING. The risk is not "does it match" but "does it match
// the RIGHT card": if a set has two cards for the same player in the same
// parallel (base + insert, or two subsets), a player+parallel match is
// ambiguous, and silently picking one files a real sale against the wrong card
// — the same class of harm as the serial bug, arrived at from the other side.
//
// So every candidate is bucketed as UNIQUE / AMBIGUOUS / NONE, and only UNIQUE
// counts as resolvable. Ambiguity is reported, never resolved by guessing.
//
//   node scripts/measurePlayerParallelMatch.cjs --sample 400

const path = require("node:path");
const { CosmosClient } = require(path.join(__dirname, "..", "node_modules/@azure/cosmos"));
const { slugify } = require(path.join(__dirname, "..", "dist/services/portfolioiq/hobbyIqCardId.service.js"));

const args = process.argv.slice(2);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SAMPLE = Number(val("--sample", "400"));
const CONCURRENCY = Number(val("--concurrency", "16"));

const cn = process.env.COSMOS_CONNECTION_STRING;
if (!cn) { console.error("COSMOS_CONNECTION_STRING is unset."); process.exit(1); }
const db = new CosmosClient(cn).database(process.env.COSMOS_DATABASE || "hobbyiq");
const staging = db.container("comps_staging");
const catalog = db.container(process.env.COSMOS_CARD_CATALOG_CONTAINER || "card_catalog");

function parseSlug(slug) {
  const p = String(slug).split(":");
  if (p.length < 7) return null;
  return {
    vertical: p[1], year: Number(p[2]), setKey: p[3], cardNumber: p[4],
    parallelSlug: p[5], isAuto: p[6] === "auto",
    printRun: p[7] && p[7].startsWith("num-") ? p[7].slice(4) : null,
  };
}
async function mapLimit(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i]); }
  }));
}

(async () => {
  console.log("player+parallel match feasibility, over real blocked rows\n");

  // Sample distinct blocked slugs, weighted to the ones carrying the most sales.
  const { resources } = await staging.items.query({
    query: `SELECT c.hobbyiqCardId AS slug, COUNT(1) AS n FROM c
            WHERE c.status='awaiting-catalog' AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null
            GROUP BY c.hobbyiqCardId`,
  }).fetchAll();
  resources.sort((a, b) => b.n - a.n);
  const step = Math.max(1, Math.floor(resources.length / SAMPLE));
  const picked = resources.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  const sampledSales = picked.reduce((s, r) => s + Number(r.n ?? 0), 0);
  console.log(`distinct blocked slugs: ${resources.length.toLocaleString()}   sampling ${picked.length} (${sampledSales.toLocaleString()} sales)\n`);

  const out = { unique: 0, ambiguous: 0, none: 0, noPlayer: 0 };
  const sales = { unique: 0, ambiguous: 0, none: 0, noPlayer: 0 };
  const uniq = [], amb = [];

  await mapLimit(picked, CONCURRENCY, async (r) => {
    const c = parseSlug(r.slug);
    const n = Number(r.n ?? 0);
    if (!c) { out.none++; sales.none += n; return; }

    // Player comes from the staged identity hint, which the vendor cleaners fill.
    let player = "", title = "";
    try {
      const { resources: rows } = await staging.items.query({
        query: `SELECT TOP 1 c.raw.identityHint.playerName AS p, c.playerName AS p2,
                       c.raw.vendorPayload.title AS t
                FROM c WHERE c.status='awaiting-catalog'`,
      }, { partitionKey: r.slug }).fetchAll();
      player = String(rows[0]?.p ?? rows[0]?.p2 ?? "").trim();
      title = String(rows[0]?.t ?? "");
    } catch { /* fall through */ }

    if (!player) { out.noPlayer++; sales.noPlayer += n; return; }

    const pSlug = slugify(player);
    if (!pSlug) { out.noPlayer++; sales.noPlayer += n; return; }

    // The candidate query the real matcher would run.
    let hits = [];
    try {
      const { resources: h } = await catalog.items.query({
        query: `SELECT TOP 10 c.id, c.cardNumber, c.playerName FROM c
                WHERE c.sport=@v AND c.year=@y AND c.setKey=@s
                  AND c.playerSlug=@p AND c.parallelSlug=@par AND c.isAuto=@a`,
        parameters: [
          { name: "@v", value: c.vertical }, { name: "@y", value: c.year },
          { name: "@s", value: c.setKey }, { name: "@p", value: pSlug },
          { name: "@par", value: c.parallelSlug }, { name: "@a", value: c.isAuto },
        ],
      }).fetchAll();
      hits = h;
    } catch { /* treated as none */ }

    if (hits.length === 1) {
      out.unique++; sales.unique += n;
      if (uniq.length < 8) uniq.push(`${String(n).padStart(4)} sales  ${player} -> ${hits[0].id}\n            ${title.slice(0, 74)}`);
    } else if (hits.length > 1) {
      out.ambiguous++; sales.ambiguous += n;
      if (amb.length < 6) amb.push(`${String(n).padStart(4)} sales  ${player}  ${hits.length} candidates: ${hits.slice(0, 3).map((x) => x.cardNumber).join(", ")}`);
    } else { out.none++; sales.none += n; }
  });

  const tot = picked.length;
  const pct = (x) => `${(100 * x / Math.max(tot, 1)).toFixed(1)}%`;
  const spct = (x) => `${(100 * x / Math.max(sampledSales, 1)).toFixed(1)}%`;
  console.log(`UNIQUE match (resolvable)   : ${out.unique} slugs (${pct(out.unique)})  ${sales.unique.toLocaleString()} sales (${spct(sales.unique)})`);
  console.log(`AMBIGUOUS (>1 candidate)    : ${out.ambiguous} slugs (${pct(out.ambiguous)})  ${sales.ambiguous.toLocaleString()} sales (${spct(sales.ambiguous)})`);
  console.log(`NO candidate                : ${out.none} slugs (${pct(out.none)})  ${sales.none.toLocaleString()} sales`);
  console.log(`no player on the row        : ${out.noPlayer} slugs (${pct(out.noPlayer)})  ${sales.noPlayer.toLocaleString()} sales`);

  console.log(`\nExtrapolated over ${resources.length.toLocaleString()} blocked slugs:`);
  console.log(`  ~${Math.round(resources.length * out.unique / Math.max(tot, 1)).toLocaleString()} would resolve on a UNIQUE player+parallel match`);
  console.log(`  ~${Math.round(resources.length * out.ambiguous / Math.max(tot, 1)).toLocaleString()} would be ambiguous and MUST NOT be auto-resolved`);

  console.log("\nunique-match examples:");
  for (const s of uniq) console.log(`  ${s}`);
  console.log("\nambiguous examples (why guessing would file sales against the wrong card):");
  for (const s of amb) console.log(`  ${s}`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
