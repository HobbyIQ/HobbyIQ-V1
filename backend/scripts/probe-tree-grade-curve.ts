#!/usr/bin/env -S npx tsx
import { buildTreeGradeCurve } from "../src/services/compiq/treeGradeCurve.service.js";

async function main(): Promise<void> {
  const cardsightId = "1625707759165x532501567379903170";
  console.log(`Testing tree grade curve for Cardsight cardId=${cardsightId} (no slug provided — service must resolve)`);
  const result = await buildTreeGradeCurve({ cardIdOrSlug: cardsightId });
  if (!result) { console.log("null result"); return; }
  console.log(`variantSlug: ${result.variantSlug}`);
  console.log(`totalSampleCount: ${result.totalSampleCount}`);
  console.log(`entries: ${result.entries.length}`);
  for (const e of result.entries) {
    console.log(`  ${e.gradeLabel.padEnd(12)} n=${String(e.sampleCount).padStart(4)}  window=${e.windowDays}d  mv=$${e.marketValue ?? "null"}  wMed=$${e.weightedMedian ?? "null"}  trend=${e.trendDirection}${e.trendPctPerWeek ? " " + e.trendPctPerWeek + "%/wk" : ""}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
