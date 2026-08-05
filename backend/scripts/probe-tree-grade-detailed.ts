#!/usr/bin/env -S npx tsx
import { buildTreeGradeCurve } from "../src/services/compiq/treeGradeCurve.service.js";

async function main(): Promise<void> {
  const result = await buildTreeGradeCurve({
    cardIdOrSlug: "1625707759165x532501567379903170",
    hobbyiqCardId: "hiq:baseball:2018:bowman-chrome:1:base:no-auto",
  });
  if (!result) { console.log("null result"); return; }
  console.log("Tree returns per-tier:");
  for (const e of result.entries) {
    console.log(`\n  ${e.gradeLabel}:`);
    console.log(`    weightedMedian: ${e.weightedMedian}`);
    console.log(`    marketValue:    ${e.marketValue}`);
    console.log(`    predictedPrice: ${e.predictedPrice}`);
    console.log(`    trendPctPerWeek:${e.trendPctPerWeek}`);
    console.log(`    trendDirection: ${e.trendDirection}`);
    console.log(`    sampleCount:    ${e.sampleCount}`);
    console.log(`    window:         ${e.windowDays}d`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
