#!/usr/bin/env node
// CF-VALUE-BAND-V2 measurement harness (Drew, 2026-07-26).
//
// Runs both the v1 baseline-only value-band lookup AND the v2
// sport+family fall-through lookup on every priced holding in a user's
// portfolio (or a specific user via --userId=xxxx), then prints the
// per-holding divergence.
//
// Purpose: BEFORE we let v2 change any live FMV, we want to see how
// much movement it produces on Drew's actual 36 holdings. If the sport-
// family layer materially shifts multipliers, dimension richness is
// helping; if near-identical, v2 isn't worth the calibration overhead
// and we know Option C would be waste.
//
// Read-only. No writes to Cosmos.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node backend/scripts/gradeiq-v2-compare.cjs [--userId=xxxx]

const path = require("path");
const backend = path.resolve(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

// Load compiled dist so we use the SAME resolver + classifier code the engine runs.
const { classifyFamily, lookupValueBandMultiplier, lookupValueBandMultiplierWithScope, valueBandBucketOf } =
  require(path.join(backend, "dist/services/compiq/gradeCalibrationConfig.js"));

const arg = (name, fallback) => {
  const i = process.argv.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  const raw = process.argv[i];
  const eq = raw.indexOf("=");
  return eq >= 0 ? raw.slice(eq + 1) : process.argv[i + 1] ?? fallback;
};

const USER_ID_FILTER = arg("userId", null);

function inferSport(setName, cardTitle) {
  const text = `${setName ?? ""} ${cardTitle ?? ""}`.toLowerCase();
  if (text.includes("baseball")) return "baseball";
  if (text.includes("football") || text.includes("nfl")) return "football";
  if (text.includes("basketball") || text.includes("nba")) return "basketball";
  if (text.includes("hockey") || text.includes("nhl")) return "hockey";
  if (/\bbowman\b/.test(text)) return "baseball";
  if (/\btopps\s+chrome\b/.test(text) && !text.includes("f1") && !text.includes("ufc")) return "baseball";
  return null;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING missing"); process.exit(1); }
  const client = new CosmosClient(conn);
  const container = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("portfolio");

  const query = USER_ID_FILTER
    ? { query: "SELECT * FROM c WHERE c.userId = @u", parameters: [{ name: "@u", value: USER_ID_FILTER }] }
    : { query: "SELECT * FROM c" };

  const it = container.items.query(query, { maxItemCount: 100 });
  const rows = [];
  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    if (Array.isArray(resources)) rows.push(...resources);
  }
  console.log(`[gradeiq-v2-compare] ${rows.length} portfolio docs scanned`);

  const results = [];
  for (const doc of rows) {
    const holdings = doc.holdings ?? {};
    for (const [hid, h] of Object.entries(holdings)) {
      // Only compare rows the value-band lookup would fire on: graded,
      // priced (positive Raw anchor is required).
      if (!h.gradeCompany || typeof h.gradeValue !== "number") continue;
      const rawAnchor = Number(h.fairMarketValue ?? h.purchasePrice);
      if (!Number.isFinite(rawAnchor) || rawAnchor <= 0) continue;

      const bucket = valueBandBucketOf(rawAnchor);
      if (!bucket) continue;

      const family = classifyFamily(h.product ?? h.setName ?? "") ?? null;
      const sport = inferSport(h.setName ?? h.product ?? null, h.cardTitle ?? null);

      const v1 = lookupValueBandMultiplier(rawAnchor, h.gradeCompany, h.gradeValue);
      const v2res = lookupValueBandMultiplierWithScope(rawAnchor, h.gradeCompany, h.gradeValue, { sport, family });
      const v2 = v2res?.medianRatio ?? null;

      const divergencePct = (v1 !== null && v2 !== null && v1 > 0)
        ? Math.round(((v2 - v1) / v1) * 1000) / 10
        : null;

      results.push({
        userId: doc.userId,
        holdingId: hid,
        player: h.playerName ?? "",
        year: h.cardYear,
        product: h.product ?? h.setName ?? "",
        parallel: h.parallel ?? "",
        grade: `${h.gradeCompany} ${h.gradeValue}`,
        rawAnchor: Math.round(rawAnchor * 100) / 100,
        bucket, sport, family,
        v1_multiplier: v1,
        v2_multiplier: v2,
        v2_scope: v2res?.scope ?? "uncovered",
        v2_sampleSize: v2res?.sampleSize ?? 0,
        divergencePct,
      });
    }
  }

  console.log(`\n[gradeiq-v2-compare] ${results.length} priced graded holdings compared`);

  // Summary by scope
  const byScope = new Map();
  for (const r of results) {
    const k = r.v2_scope;
    byScope.set(k, (byScope.get(k) ?? 0) + 1);
  }
  console.log("\nv2 resolution scope distribution:");
  for (const [scope, count] of [...byScope.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${scope.padEnd(15)} ${count}`);
  }

  // Divergence bins
  const bins = { same: 0, small: 0, moderate: 0, large: 0, onlyOne: 0 };
  for (const r of results) {
    if (r.divergencePct === null) { bins.onlyOne++; continue; }
    const abs = Math.abs(r.divergencePct);
    if (abs < 1) bins.same++;
    else if (abs < 10) bins.small++;
    else if (abs < 30) bins.moderate++;
    else bins.large++;
  }
  console.log("\nDivergence distribution (v2 vs v1):");
  console.log(`  same (<1%):       ${bins.same}`);
  console.log(`  small (1-10%):    ${bins.small}`);
  console.log(`  moderate (10-30%): ${bins.moderate}`);
  console.log(`  large (>30%):     ${bins.large}`);
  console.log(`  v1 or v2 null:    ${bins.onlyOne}`);

  // Per-holding table
  console.log("\nPer-holding detail (sorted by abs divergence):");
  const sorted = results.slice().sort((a, b) => Math.abs(b.divergencePct ?? 0) - Math.abs(a.divergencePct ?? 0));
  for (const r of sorted) {
    const div = r.divergencePct === null ? "  n/a " : (r.divergencePct >= 0 ? "+" : "") + r.divergencePct.toFixed(1) + "%";
    console.log(
      `  ${r.player.padEnd(22)} ${String(r.year ?? "").padEnd(4)} ${r.product.slice(0, 26).padEnd(26)} ` +
      `[${r.grade.padEnd(8)}] $${r.rawAnchor.toString().padEnd(8)} ` +
      `v1=${(r.v1_multiplier ?? "n/a").toString().padEnd(6)} ` +
      `v2=${(r.v2_multiplier ?? "n/a").toString().padEnd(6)} ` +
      `(${r.v2_scope.padEnd(13)} n=${r.v2_sampleSize.toString().padEnd(4)}) ` +
      `div=${div}`
    );
  }
}
main().catch(e => { console.error(e); process.exit(1); });
