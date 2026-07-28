#!/usr/bin/env -S npx tsx
import { computeHobbyIqFmv } from "../src/services/portfolioiq/hobbyIqFmv.service.js";

async function main(): Promise<void> {
  const cases: Array<{ slug: string; gradeCompany?: string; gradeValue?: number }> = [
    { slug: "hiq:baseball:2026:bowman:cpa-eha:blue-refractor:auto" },
    { slug: "hiq:baseball:2026:bowman:cpa-eha:blue-x-fractor:auto" },
    { slug: "hiq:baseball:2026:chrome-prospects-autographs:cpa-eha:gold-refractor:auto", gradeCompany: "PSA", gradeValue: 9 },
    { slug: "hiq:baseball:2026:chrome-prospects-autographs:cpa-eha:gold-refractor:auto" },  // raw
    { slug: "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto", gradeCompany: "PSA", gradeValue: 9 },
    { slug: "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto" },  // raw
  ];
  for (const c of cases) {
    const r = await computeHobbyIqFmv({
      hobbyiqCardId: c.slug,
      gradeCompany: c.gradeCompany ?? null,
      gradeValue: c.gradeValue ?? null,
    });
    console.log(`\n▸ ${c.slug}  ${c.gradeCompany ? c.gradeCompany + " " + c.gradeValue : "Raw"}`);
    console.log(`  fmv:            $${r.fmv?.toFixed(2) ?? "null"}`);
    console.log(`  method:         ${r.method}`);
    console.log(`  compCount:      ${r.compCount}`);
    console.log(`  min/max:        $${r.min?.toFixed(2) ?? "?"} / $${r.max?.toFixed(2) ?? "?"}`);
    console.log(`  trend:          ${r.trend.direction} (${r.trend.slopePerMonthPct.toFixed(2)}%/mo, ${r.trend.method})`);
    console.log(`  basisNote:      ${r.basisNote}`);
    console.log(`  confidence:     ${r.confidence.toFixed(3)}`);
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
