// CF-BECKETT-SWEEP-2026 (Drew, 2026-08-12). Runner for the 2026 checklist
// sweep. runBeckettSweep() existed but nothing ever called it.
//
// WHY 2026 SPECIFICALLY: seven 2026 products currently resolve their
// parallels by PROXY off the 2025 actuals files —
//   2026-bowman-chrome, 2026-bowman-mega, 2026-topps,
//   2026-topps-chrome, 2026-topps-chrome-platinum,
//   2026-topps-finest, 2026-topps-heritage
// A proxy inherits 2025's parallel list, so any parallel NEW for 2026 is
// structurally uncreatable. Confirmed case: 2026 Topps Chrome #136 "White
// Refractor" has real sales and no catalog row, because the 2025 Topps
// Chrome list (43 parallels, baseballcardpedia) contains no "white" entry.
// Per the actuals-only rule we will not invent it — we fetch the real 2026
// checklist instead.
//
// SOURCE: Beckett's publicly-hosted S3 .xlsx checklists. Owner-attested
// permission is recorded in backend/docs/data-sources.md. This is NOT a
// site scrape. Request spacing (500ms) and concurrency (<=3) are enforced
// inside the orchestrator; this runner does not override them.
//
// PHASE A ONLY: the sweep fetches + stages files. It writes NOTHING to
// Cosmos. Turning staged output into parallels-*.json actuals is a separate,
// reviewable step — deliberately, so a bad fetch cannot reach the catalog.
//
// Env:
//   YEARS=2026            comma-separated (default 2026)
//   BRANDS="a,b"          override brand list (default: DEFAULT_BRANDS)
//   SOURCE=beckett        beckett | cardboard-connection
//   FORCE=true            re-fetch even when a staged file exists

const path = require("path");
const fs = require("fs");

const distPath = path.resolve(__dirname, "..", "dist", "agents", "beckett", "sweepOrchestrator.js");
if (!fs.existsSync(distPath)) {
  console.error(`missing dist at ${distPath} — run \`npx tsc\` first`);
  process.exit(2);
}
const { runBeckettSweep, DEFAULT_BRANDS } = require(distPath);

const YEARS = (process.env.YEARS || "2026").split(",").map((y) => Number(y.trim())).filter(Boolean);
const BRANDS = process.env.BRANDS
  ? process.env.BRANDS.split(",").map((b) => b.trim()).filter(Boolean)
  : undefined;
const SOURCE = process.env.SOURCE || "beckett";
const FORCE = process.env.FORCE === "true";

(async () => {
  const brands = BRANDS ?? DEFAULT_BRANDS;
  console.log(`▸ Beckett sweep — PHASE A (fetch + stage only, no Cosmos writes)`);
  console.log(`  source:      ${SOURCE}`);
  console.log(`  years:       ${YEARS.join(", ")}`);
  console.log(`  brands (${brands.length}): ${brands.join(", ")}`);
  console.log(`  force:       ${FORCE}\n`);

  const t0 = Date.now();
  const summary = await runBeckettSweep({
    source: SOURCE,
    years: YEARS,
    brands: BRANDS,
    force: FORCE,
  });

  console.log(`\n================ SWEEP SUMMARY ================`);
  console.log(`  attempted   ${summary.tuplesAttempted}`);
  console.log(`  ok          ${summary.tuplesOk}`);
  console.log(`  missing     ${summary.tuplesMissing}`);
  console.log(`  errored     ${summary.tuplesError}`);
  console.log(`  duration    ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const results = summary.results || [];
  const ok = results.filter((r) => r.ok);
  if (ok.length) {
    console.log(`\n  FETCHED (these are the new 2026 actuals candidates):`);
    for (const r of ok) console.log(`    ${r.year} ${r.brand}  <- ${r.sourceUrl}`);
  }
  const missing = results.filter((r) => !r.ok);
  if (missing.length) {
    console.log(`\n  NOT FOUND (Beckett has no checklist at any tried URL):`);
    for (const r of missing.slice(0, 20)) console.log(`    ${r.year} ${r.brand}  (${r.reason ?? "no match"})`);
    if (missing.length > 20) console.log(`    ... +${missing.length - 20} more`);
  }
  console.log(`\n[done] staged only — nothing written to Cosmos.`);
})().catch((e) => {
  console.error("ERR", e && e.message ? e.message : e);
  process.exit(1);
});
