#!/usr/bin/env node
// CF-AB-FMV (Drew, 2026-07-30). A/B compare the new composite-neighbor
// FMV path against the legacy 8-rung ladder for a mix of Drew's own
// holdings and random slugs with recent activity. For each slug, call
// computeHobbyIqFmv twice — once with HOBBYIQFMV_COMPOSITE_ENABLED=true,
// once =false — then diff.
//
// Env:
//   COSMOS_CONNECTION_STRING     — required
//   DREW_USER_ID                 — default user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4
//   RANDOM_SAMPLE                — default 50
//   MIN_COMPS                    — HOBBYIQFMV_COMPOSITE_MIN_COMPS override
//   MAX_DIST                     — HOBBYIQFMV_COMPOSITE_MAX_DIST override

const path = require("path");
const backend = __dirname + "/..";
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const DREW = process.env.DREW_USER_ID || "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";
const RANDOM_SAMPLE = Number(process.env.RANDOM_SAMPLE || "50");

async function main() {
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const portfolio = client.database("hobbyiq").container("portfolio");
  const sold = client.database("hobbyiq").container("sold_comps");

  // 1) Drew's holdings
  const { resources: drewDocs } = await portfolio.items.query({
    query: "SELECT c.holdings FROM c WHERE c.userId = @u",
    parameters: [{ name: "@u", value: DREW }],
  }).fetchAll();
  const holdingsMap = drewDocs[0]?.holdings ?? {};
  const drewHoldings = Object.values(holdingsMap)
    .filter(h => h && h.hobbyiqCardId)
    .map(h => ({
      source: "drew-holding",
      title: (h.playerName ? h.playerName + " " : "") + (h.cardTitle || h.parallel || h.product || ""),
      hobbyiqCardId: h.hobbyiqCardId,
      gradeCompany: h.gradeCompany ?? null,
      gradeValue: h.gradeValue ?? null,
    }));

  // 2) Random sold slugs with composite + recent
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const { resources: rand } = await sold.items.query({
    query: `SELECT DISTINCT VALUE c.hobbyiqCardId
            FROM c
            WHERE c.soldAt >= @cut
              AND IS_DEFINED(c.composite) AND c.composite != null
              AND c.hobbyiqCardId != null
              AND STARTSWITH(c.hobbyiqCardId, 'hiq:')`,
    parameters: [{ name: "@cut", value: cutoff }],
  }, { maxItemCount: 20000 }).fetchAll();

  // Fisher-Yates shuffle
  for (let i = rand.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rand[i], rand[j]] = [rand[j], rand[i]];
  }
  const randomSlugs = rand.slice(0, RANDOM_SAMPLE).map(slug => ({
    source: "random",
    title: slug.replace(/^hiq:/, ""),
    hobbyiqCardId: slug,
    gradeCompany: null,
    gradeValue: null,
  }));

  const targets = [...drewHoldings, ...randomSlugs];
  console.log(`[A/B FMV composite vs legacy]`);
  console.log(`  Drew holdings: ${drewHoldings.length}`);
  console.log(`  Random slugs:  ${randomSlugs.length}`);
  console.log(`  Total:         ${targets.length}\n`);

  // 3) Load FMV service twice (fresh) — toggle flag between calls
  //    require cache is per-key, so we set env BEFORE requiring
  const results = [];

  // ---- LEGACY path (flag off) ----
  process.env.HOBBYIQFMV_COMPOSITE_ENABLED = "false";
  delete require.cache[require.resolve(path.join(backend, "dist/services/portfolioiq/hobbyIqFmv.service.js"))];
  const legacyMod = require(path.join(backend, "dist/services/portfolioiq/hobbyIqFmv.service.js"));

  console.log("Running legacy pass...");
  const BATCH = 8;
  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const batchResults = await Promise.all(chunk.map(async t => {
      try {
        const r = await legacyMod.computeHobbyIqFmv({
          hobbyiqCardId: t.hobbyiqCardId,
          gradeCompany: t.gradeCompany,
          gradeValue: t.gradeValue,
        });
        return { target: t, legacy: r, composite: null };
      } catch (e) {
        return { target: t, legacy: null, composite: null, error: String(e).slice(0, 80) };
      }
    }));
    results.push(...batchResults);
    console.log(`  legacy: ${Math.min(i + BATCH, targets.length)}/${targets.length}`);
  }

  // ---- COMPOSITE path (flag on) ----
  process.env.HOBBYIQFMV_COMPOSITE_ENABLED = "true";
  delete require.cache[require.resolve(path.join(backend, "dist/services/portfolioiq/hobbyIqFmv.service.js"))];
  const compositeMod = require(path.join(backend, "dist/services/portfolioiq/hobbyIqFmv.service.js"));

  console.log("Running composite pass...");
  for (let i = 0; i < results.length; i += BATCH) {
    const chunk = results.slice(i, i + BATCH);
    await Promise.all(chunk.map(async row => {
      try {
        const r = await compositeMod.computeHobbyIqFmv({
          hobbyiqCardId: row.target.hobbyiqCardId,
          gradeCompany: row.target.gradeCompany,
          gradeValue: row.target.gradeValue,
        });
        row.composite = r;
      } catch (e) {
        row.error = String(e).slice(0, 80);
      }
    }));
    console.log(`  composite: ${Math.min(i + BATCH, results.length)}/${results.length}`);
  }

  // 4) Diff report
  console.log(`\n════════════════ RESULTS ════════════════\n`);
  const pctDelta = (a, b) => {
    if (a == null || b == null) return null;
    if (a === 0) return null;
    return ((b - a) / a) * 100;
  };

  const report = results.map(row => {
    const L = row.legacy?.fmv;
    const C = row.composite?.fmv;
    return {
      source: row.target.source,
      title: row.target.title?.slice(0, 40) || "",
      slug: row.target.hobbyiqCardId,
      grade: row.target.gradeCompany ? `${row.target.gradeCompany} ${row.target.gradeValue}` : "raw",
      legacyMethod: row.legacy?.method ?? "err",
      legacyFmv: L,
      legacyN: row.legacy?.compCount ?? 0,
      compositeMethod: row.composite?.method ?? "err",
      compositeFmv: C,
      compositeN: row.composite?.compCount ?? 0,
      pctDelta: pctDelta(L, C),
    };
  });

  // Bucket by outcome
  const bothPriced = report.filter(r => r.legacyFmv != null && r.compositeFmv != null);
  const compositeOnly = report.filter(r => r.compositeFmv != null && r.legacyFmv == null);
  const legacyOnly = report.filter(r => r.legacyFmv != null && r.compositeFmv == null);
  const neither = report.filter(r => r.legacyFmv == null && r.compositeFmv == null);

  console.log(`SUMMARY:`);
  console.log(`  both paths priced:      ${bothPriced.length}`);
  console.log(`  composite ONLY:         ${compositeOnly.length}   ← would be pool-widening wins`);
  console.log(`  legacy ONLY:            ${legacyOnly.length}      ← would be composite regressions`);
  console.log(`  neither priced:         ${neither.length}\n`);

  const usedComposite = report.filter(r => r.compositeMethod === "composite-neighbor").length;
  console.log(`  composite path FIRED:   ${usedComposite}/${report.length}`);
  console.log(`  (rest fell through to legacy 8-rung ladder)\n`);

  if (bothPriced.length > 0) {
    const deltas = bothPriced.map(r => r.pctDelta).filter(d => d != null).sort((a, b) => a - b);
    const med = deltas[Math.floor(deltas.length / 2)];
    const p10 = deltas[Math.floor(deltas.length * 0.1)];
    const p90 = deltas[Math.floor(deltas.length * 0.9)];
    console.log(`DELTA (composite vs legacy, both priced):`);
    console.log(`  p10: ${p10?.toFixed(1)}%`);
    console.log(`  median: ${med?.toFixed(1)}%`);
    console.log(`  p90: ${p90?.toFixed(1)}%\n`);
  }

  console.log(`══ TOP 15 by absolute delta (both priced) ══`);
  bothPriced.sort((a, b) => Math.abs(b.pctDelta ?? 0) - Math.abs(a.pctDelta ?? 0));
  bothPriced.slice(0, 15).forEach(r => {
    console.log(`  ${r.source.padEnd(14)} ${r.grade.padEnd(8)} L:$${r.legacyFmv?.toFixed(0).padStart(6)} (${r.legacyMethod.padEnd(24)} n=${r.legacyN})  C:$${r.compositeFmv?.toFixed(0).padStart(6)} (${r.compositeMethod.padEnd(20)} n=${r.compositeN})  ${r.pctDelta > 0 ? "+" : ""}${r.pctDelta?.toFixed(1)}%`);
    console.log(`    ${r.title.padEnd(40)}  ${r.slug}`);
  });

  if (compositeOnly.length > 0) {
    console.log(`\n══ COMPOSITE-ONLY wins (legacy said no-basis) ══`);
    compositeOnly.slice(0, 10).forEach(r => {
      console.log(`  ${r.source.padEnd(14)} $${r.compositeFmv?.toFixed(0)}  ${r.title}  ${r.slug}`);
    });
  }
  if (legacyOnly.length > 0) {
    console.log(`\n══ LEGACY-ONLY (composite regressions to no-basis) ══`);
    legacyOnly.slice(0, 10).forEach(r => {
      console.log(`  ${r.source.padEnd(14)} $${r.legacyFmv?.toFixed(0)} (${r.legacyMethod})  ${r.title}  ${r.slug}`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
