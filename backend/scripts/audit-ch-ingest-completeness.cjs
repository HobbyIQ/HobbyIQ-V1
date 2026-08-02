#!/usr/bin/env node
// CF-AUDIT-CH-INGEST-COMPLETENESS (Drew, 2026-08-01).
//
// For a sample of popular cardIds, compare:
//   - CH's actual sales count in last 90d (queried live via /cards/comps)
//   - Our sold_comps count for the same (cardId, grade, 90d)
//
// Gap % tells us how much of CH's data we're missing. Zyla probe
// suggested a ~40% gap on Trout 2011 Update PSA 10 (Zyla=125, ours=78);
// this script measures whether that gap holds across a broader sample.
//
// Env:
//   CARD_HEDGE_API_KEY         required
//   CARD_HEDGE_CLIENT_ID       required
//   COSMOS_CONNECTION_STRING   required

const { CosmosClient } = require("@azure/cosmos");

const CH_KEY = process.env.CARD_HEDGE_API_KEY;
if (!CH_KEY) { console.error("CARD_HEDGE_API_KEY required"); process.exit(1); }
if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }

const CH_BASE = "https://api.cardhedger.com/v1";
const CH_HEAD = {
  "X-API-Key": CH_KEY,
  "Content-Type": "application/json",
};

// Sample: seed anchors + auto-widen from our own catalog.
const SEED = [
  { label: "Trout 2011 Update US175",             cardId: "1586812246197x228181943611293700", grade: "PSA 10" },
  { label: "Ohtani 2018 Update US285",            cardId: "1643689299948x370228624882925600", grade: "PSA 10" },
  { label: "Hartman 2026 BC Auto CPA-EHA",        cardId: "1778542173652x303328120692600800", grade: "Raw" },
];

async function widenSample(sc, cutoff90) {
  // Auto-augment with ~12 popular CH-source cards from sold_comps.
  // Popular = highest 90d sale count per (cardId, gradeCompany, gradeValue).
  try {
    const query = "SELECT TOP 100 c.cardId, c.gradeCompany, c.gradeValue, c.playerName, c.cardYear, c.cardNumber " +
                  "FROM c WHERE c.source = 'cardhedge' AND c.soldAt >= @from AND IS_DEFINED(c.cardId)";
    const { resources } = await sc.items.query({ query, parameters: [{ name: "@from", value: cutoff90 }] }).fetchAll();
    // Group by (cardId, grade) and count
    const bucket = new Map();
    for (const r of resources) {
      if (!r.cardId) continue;
      const gradeKey = r.gradeCompany && r.gradeValue !== undefined && r.gradeValue !== null
        ? `${r.gradeCompany} ${r.gradeValue}`
        : "Raw";
      const k = `${r.cardId}||${gradeKey}`;
      const b = bucket.get(k) || { cardId: r.cardId, grade: gradeKey, count: 0, label: `${r.playerName} ${r.cardYear} #${r.cardNumber}` };
      b.count++;
      bucket.set(k, b);
    }
    // Top 12 by count, excluding SEED cardIds already present
    const seedIds = new Set(SEED.map(s => s.cardId + "||" + s.grade));
    const extras = [...bucket.values()]
      .filter(b => !seedIds.has(b.cardId + "||" + b.grade))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
    return extras;
  } catch (e) { return []; }
}

let SAMPLE = [...SEED];

async function chComps(cardId, grade, count) {
  const res = await fetch(`${CH_BASE}/cards/comps`, {
    method: "POST",
    headers: CH_HEAD,
    body: JSON.stringify({ card_id: cardId, count, grade, include_raw_prices: true }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { error: `HTTP ${res.status}: ${t.slice(0, 200)}`, sales: [] };
  }
  const body = await res.json();
  const raw = Array.isArray(body?.raw_prices) ? body.raw_prices : [];
  return { sales: raw };
}

async function main() {
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");
  const now = Date.now();
  const cutoff90 = new Date(now - 90 * 86_400_000).toISOString();

  const extras = await widenSample(sc, cutoff90);
  SAMPLE = [...SEED, ...extras];
  console.log(`Sample size: ${SAMPLE.length} (${SEED.length} seed + ${extras.length} auto-widened from top-active CH cards)\n`);

  console.log("=== CH ingest completeness audit ===\n");
  console.log("| Card | Grade | CH live (90d) | Our pool (90d) | Gap % | CH limit hit? |");
  console.log("|---|---|---|---|---|---|");

  let totalCh = 0, totalUs = 0;

  for (const s of SAMPLE) {
    // Pull CH sales with max count (test 200 to see if ceiling matters)
    const chRes = await chComps(s.cardId, s.grade, 100);
    if (chRes.error) { console.log(`| ${s.label} | ${s.grade} | ERR: ${chRes.error} | - | - | - |`); continue; }
    const chSales90 = chRes.sales.filter(x => {
      const d = x?.sale_date;
      return d && String(d) >= cutoff90;
    });
    const chTotal = chRes.sales.length;
    const chIn90 = chSales90.length;
    const hitLimit = chTotal >= 200 ? "yes(cap)" : "no";

    // Query our sold_comps for same (cardId, grade, 90d)
    // Grade parse: "PSA 10" → gradeCompany=PSA, gradeValue=10
    let gradeCompany = null, gradeValue = null;
    if (s.grade !== "Raw") {
      const m = s.grade.match(/^(PSA|BGS|SGC|CGC)\s+(\d+(?:\.\d+)?)$/i);
      if (m) { gradeCompany = m[1].toUpperCase(); gradeValue = Number(m[2]); }
    }
    const params = [
      { name: "@cid", value: s.cardId },
      { name: "@from", value: cutoff90 },
    ];
    let query = `SELECT VALUE COUNT(1) FROM c WHERE c.cardId = @cid AND c.soldAt >= @from`;
    if (gradeCompany !== null && gradeValue !== null) {
      query += ` AND c.gradeCompany = @gc AND c.gradeValue = @gv`;
      params.push({ name: "@gc", value: gradeCompany }, { name: "@gv", value: gradeValue });
    } else {
      // Raw = no gradeCompany
      query += ` AND (NOT IS_DEFINED(c.gradeCompany) OR c.gradeCompany = null OR c.gradeCompany = '')`;
    }
    const { resources } = await sc.items.query({ query, parameters: params }).fetchAll();
    const ourCount = Number(resources[0]) || 0;

    const gap = chIn90 === 0 ? 0 : Math.round((1 - ourCount / chIn90) * 100);
    console.log(`| ${s.label} | ${s.grade} | ${chIn90} | ${ourCount} | ${gap}% | ${hitLimit} |`);
    totalCh += chIn90;
    totalUs += ourCount;
  }

  console.log(`\n=== Overall ===`);
  console.log(`  CH live total (90d):  ${totalCh}`);
  console.log(`  Our pool total (90d): ${totalUs}`);
  const overallGap = totalCh === 0 ? 0 : Math.round((1 - totalUs / totalCh) * 100);
  console.log(`  Overall gap:          ${overallGap}%`);
  console.log(`\nInterpretation:`);
  console.log(`  0-10%:  ingest is complete — Zyla wouldn't add anything`);
  console.log(`  10-30%: minor gap — check if related to grade filter parsing or dedup`);
  console.log(`  30%+:   real ingest gap — targeted re-ingest justified`);
}

main().catch(e => { console.error(e); process.exit(1); });
