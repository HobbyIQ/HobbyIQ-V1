// CF-CANONICAL-OVERRIDE-DIVERGENCE sweep (2026-08-22).
//
// Nick Kurtz P-3 showed $3,724.61 against a $6.85 cost. computeEstimate had the
// right answer ($3.75, sibling-pool, 282 sales); the CF-CANONICAL-FMV-OVERRIDE
// block at compiqEstimate.service.ts:8650 then replaced it with a 0.21-confidence
// `neighbor-parallel` result — a rung that queries ch_daily_sales by product name
// with NO player and NO cardNumber filter, so it prices any card off the last 100
// raw sales in the whole product family.
//
// Two populations, both visible from stored fields alone (no re-pricing needed):
//
//   A  malformed graded identity — gradingCompany set, gradeValue absent. Rungs 1-2
//      can't match a grade, so the ladder falls to neighbor-parallel.
//   B  FMV/predictedPrice divergence — the Kurtz signature. These two come from
//      different code paths; when they disagree by >10x one of them is wrong, and
//      predictedPrice is the one that tracked the real comp pool.
//
// Read-only. Reports, changes nothing.
const { CosmosClient } = require("@azure/cosmos");

const DIVERGENCE = Number(process.env.DIVERGENCE || 10);

const cs = process.env.COSMOS_CONNECTION_STRING;
if (!cs) {
  console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
  process.exit(1);
}

const c = new CosmosClient(cs).database("hobbyiq").container("portfolio");

const money = (n) =>
  n == null || !Number.isFinite(Number(n)) ? "—" : "$" + Number(n).toFixed(2);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

(async () => {
  const { resources } = await c.items
    .query({ query: "SELECT c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)" })
    .fetchAll();

  if (!resources.length) {
    console.error("FATAL: zero portfolio docs returned. The sweep proved nothing.");
    process.exit(2);
  }

  const malformed = [];
  const diverged = [];
  let totalHoldings = 0;
  let priced = 0;
  const bySource = new Map();

  for (const doc of resources) {
    for (const [hid, h] of Object.entries(doc.holdings || {})) {
      if (!h) continue;
      totalHoldings++;

      bySource.set(
        String(h.pricingSource ?? "(absent)"),
        (bySource.get(String(h.pricingSource ?? "(absent)")) ?? 0) + 1,
      );

      const company = h.gradingCompany ?? h.gradeCompany ?? null;
      const gradeVal = num(h.gradeValue);
      const row = {
        userId: doc.userId, hid,
        player: h.playerName ?? "?", product: h.product ?? "?",
        parallel: h.parallel ?? null, slug: h.hobbyiqCardId ?? null,
        company, gradeVal,
        fmv: num(h.fairMarketValue), pred: num(h.predictedPrice),
        cost: num(h.purchasePrice), status: h.valuationStatus ?? null,
        source: h.pricingSource ?? null,
      };

      if (company && gradeVal === null) malformed.push(row);

      if (row.fmv !== null && row.pred !== null && row.fmv > 0 && row.pred > 0) {
        priced++;
        const ratio = row.fmv / row.pred;
        if (ratio >= DIVERGENCE || ratio <= 1 / DIVERGENCE) {
          diverged.push({ ...row, ratio });
        }
      }
    }
  }

  if (!totalHoldings) {
    console.error("FATAL: portfolio docs exist but contain zero holdings. The sweep proved nothing.");
    process.exit(2);
  }

  console.log(`portfolios: ${resources.length}   holdings: ${totalHoldings}   with FMV+predicted: ${priced}`);
  console.log("pricingSource:", [...bySource.entries()].map(([k, v]) => `${k}=${v}`).join("  "));

  console.log(`\n=== A. malformed graded identity (company set, gradeValue absent): ${malformed.length} ===`);
  for (const r of malformed.slice(0, 40)) {
    console.log(`  ${r.player} · ${r.product} · ${r.company} (no grade)  fmv=${money(r.fmv)} pred=${money(r.pred)} cost=${money(r.cost)}`);
    console.log(`      ${r.userId} / ${r.hid}`);
  }
  if (malformed.length > 40) console.log(`  ... and ${malformed.length - 40} more NOT shown`);

  diverged.sort((a, b) => b.ratio - a.ratio);
  console.log(`\n=== B. FMV/predicted divergence >= ${DIVERGENCE}x: ${diverged.length} ===`);
  for (const r of diverged.slice(0, 40)) {
    console.log(`  ${r.ratio.toFixed(0).padStart(6)}x  ${r.player} · ${r.product}${r.parallel ? " · " + r.parallel : ""}`);
    console.log(`          fmv=${money(r.fmv)} pred=${money(r.pred)} cost=${money(r.cost)} status=${r.status} source=${r.source} grade=${r.company ?? "raw"}${r.gradeVal ?? ""}`);
    console.log(`          ${r.userId} / ${r.hid}`);
  }
  if (diverged.length > 40) console.log(`  ... and ${diverged.length - 40} more NOT shown`);

  const both = diverged.filter((d) => d.company && d.gradeVal === null);
  console.log(`\n=== C. in BOTH populations (malformed grade AND diverged): ${both.length} ===`);
  for (const r of both.slice(0, 40)) {
    console.log(`  ${r.ratio.toFixed(0).padStart(6)}x  ${r.player} · ${r.product} · ${r.company} (no grade)  fmv=${money(r.fmv)} pred=${money(r.pred)}`);
  }

  console.log(`\nSUMMARY  holdings=${totalHoldings}  malformedGrade=${malformed.length}  diverged=${diverged.length}  both=${both.length}`);
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
