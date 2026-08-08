// One-off (Drew, 2026-08-08). Call the observed-grade-curve service
// directly for the Ohtani 2018 BC RC to see the raw payload — which
// field carries the $7,200 anchor that's collapsing across PSA tiers.

const path = require("path");

async function main() {
  process.env.COSMOS_CONNECTION_STRING = process.env.COSMOS_CONNECTION_STRING || "";
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const distRoot = path.resolve(__dirname, "..", "dist");
  const svc = require(path.join(distRoot, "services", "compiq", "observedGradeCurve.service.js"));
  console.log("service exports:", Object.keys(svc).slice(0, 20));

  const CID = "hiq:baseball:2018:bowman-chrome:1:base:no-auto";
  const fn = svc.buildObservedGradeCurve;
  if (!fn) { console.error("no buildObservedGradeCurve export"); process.exit(1); }

  const result = await fn(CID, { skipTrajectory: false });
  console.log("\n=== result shape ===");
  console.log("  totalSampleCount:", result?.totalSampleCount);
  console.log("  entries:", result?.entries?.length);
  console.log("");
  for (const e of (result?.entries || [])) {
    console.log(`  ${(e.grader + ' ' + (e.grade ?? '')).trim().padEnd(10)}  n=${String(e.sampleCount).padStart(3)}  value=${e.value ?? '?'}  trendAdj=${e.trendAdjustedValue ?? '?'}  valueSource=${e.valueSource}  estFrom=${e.estimatedFrom || '-'}  estMult=${e.estimatedMultiplier ?? '-'}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error("FAILED:", e?.stack || e?.message || e); process.exit(1); });
