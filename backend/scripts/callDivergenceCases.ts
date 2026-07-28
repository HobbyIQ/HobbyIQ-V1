#!/usr/bin/env -S npx tsx
// CF-DIVERGENCE-DIAG (Drew, 2026-07-28). Call FMV against the exact
// slugs from the divergence email so we can see what the engine
// currently returns and whether it's fabricating.

import { computeHobbyIqFmv } from "../src/services/portfolioiq/hobbyIqFmv.service.js";

async function main(): Promise<void> {
  const cases: Array<{ label: string; slug: string; gradeCompany?: string; gradeValue?: number }> = [
    { label: "Devin Taylor Black auto Raw", slug: "hiq:baseball:2025:bowman-draft:cpa-dt:black:auto" },
    { label: "Devin Taylor Black auto PSA 10", slug: "hiq:baseball:2025:bowman-draft:cpa-dt:black:auto", gradeCompany: "PSA", gradeValue: 10 },
    { label: "Devin Taylor Black auto PSA 9", slug: "hiq:baseball:2025:bowman-draft:cpa-dt:black:auto", gradeCompany: "PSA", gradeValue: 9 },
    { label: "Hartman Blue Refractor auto (2026 Bowman)", slug: "hiq:baseball:2026:bowman:cpa-eha:blue-refractor:auto" },
    { label: "Hartman Blue X-Fractor auto", slug: "hiq:baseball:2026:bowman:cpa-eha:blue-x-fractor:auto" },
    { label: "Hartman Orange Shimmer Refractor auto PSA 10", slug: "hiq:baseball:2026:bowman:cpa-eha:orange-shimmer-refractor:auto", gradeCompany: "PSA", gradeValue: 10 },
    { label: "Hartman Gold Refractor auto PSA 9", slug: "hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto", gradeCompany: "PSA", gradeValue: 9 },
  ];
  for (const c of cases) {
    const r = await computeHobbyIqFmv({ hobbyiqCardId: c.slug, gradeCompany: c.gradeCompany ?? null, gradeValue: c.gradeValue ?? null });
    console.log(`\n▸ ${c.label}`);
    console.log(`  slug:        ${c.slug}${c.gradeCompany ? ` (${c.gradeCompany} ${c.gradeValue})` : " (Raw)"}`);
    console.log(`  fmv:         ${r.fmv === null ? "null" : "$" + r.fmv.toFixed(2)}`);
    console.log(`  method:      ${r.method}`);
    console.log(`  compCount:   ${r.compCount}`);
    console.log(`  basisNote:   ${r.basisNote}`);
    console.log(`  confidence:  ${r.confidence.toFixed(3)}`);
  }
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
