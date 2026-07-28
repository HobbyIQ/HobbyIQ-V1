#!/usr/bin/env -S npx tsx
// CF-HOBBYIQ-FMV-PROJECT-NOT-MEDIAN verification (Drew, 2026-07-28).
// Calls computeHobbyIqFmv against live Cosmos for the Hartshorn slug
// AND a control (Devin Taylor or any dense pool) so we can see the
// projected next-sale value vs what a plain median would say.
//
// Usage:
//   export COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query \"[?name=='COSMOS_CONNECTION_STRING'].value\" -o tsv)"
//   export CARD_HEDGE_API_KEY="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query \"[?name=='CARD_HEDGE_API_KEY'].value\" -o tsv)"
//   npx tsx backend/scripts/callFmvHartshorn.ts

import { computeHobbyIqFmv } from "../src/services/portfolioiq/hobbyIqFmv.service.js";

const SLUGS = [
  "hiq:baseball:2025:bowman-draft:cpa-jha:blue:auto",       // Hartshorn (thin, 2 same-day)
  "hiq:baseball:2025:bowman-draft:cpa-jha:base:auto",       // Hartshorn base (dense, 241 comps)
];

async function main(): Promise<void> {
  for (const slug of SLUGS) {
    console.log(`\n▸ ${slug}`);
    const r = await computeHobbyIqFmv({ hobbyiqCardId: slug });
    console.log(`  fmv:            $${r.fmv?.toFixed(2) ?? "null"}`);
    console.log(`  method:         ${r.method}`);
    console.log(`  compCount:      ${r.compCount}`);
    console.log(`  min / max:      $${r.min?.toFixed(2) ?? "?"} / $${r.max?.toFixed(2) ?? "?"}`);
    console.log(`  trend:          ${r.trend.direction} (${r.trend.slopePerMonthPct.toFixed(2)}%/mo, ${r.trend.method})`);
    console.log(`  basisNote:      ${r.basisNote}`);
    console.log(`  confidence:     ${r.confidence.toFixed(3)}`);
    console.log(`  quality.score:  ${r.quality.score.toFixed(3)}`);
    if (r.recentComps.length > 0) {
      console.log(`  recent comps (${r.recentComps.length}):`);
      for (const c of r.recentComps.slice(0, 5)) {
        console.log(`    $${c.price.toFixed(2).padStart(8)} | ${c.soldAt.slice(0, 10)} | ${c.source} | par="${c.parallel ?? ""}"`);
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error(`[fmv-call] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
