#!/usr/bin/env -S node --experimental-strip-types
// CF-DEVIN-TAYLOR-BLACK-DIAG (Drew, 2026-07-28). $650 → $4 divergence.
// Same shape as the Hartman/Hartshorn diags: dump pool state at every
// plausible slug + cross-slug scan so we can see WHERE the $4 is
// coming from and what's polluting the Black pool.

import { CosmosClient } from "@azure/cosmos";

interface Row {
  price?: number;
  soldAt?: string;
  source?: string;
  title?: string;
  parallel?: string;
  cardYear?: number;
  cardNumber?: string;
  isAuto?: boolean;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  hobbyiqCardId?: string;
  cardId?: string;
}

async function main(): Promise<void> {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sc = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
  const cutoffIso = new Date(Date.now() - 180 * 86400000).toISOString();

  // Try both bowman-draft and bowman-draft-chrome + a couple of parallel spellings
  const slugCandidates = [
    "hiq:baseball:2025:bowman-draft:cpa-dt:black:auto",
    "hiq:baseball:2025:bowman-draft:cpa-dt:black-refractor:auto",
    "hiq:baseball:2025:bowman-draft:cpa-dt:base:auto",
    "hiq:baseball:2025:bowman-draft-chrome:cpa-dt:black:auto",
    "hiq:baseball:2025:bowman-draft-chrome:cpa-dt:black-refractor:auto",
    "hiq:baseball:2025:chrome-prospects-autographs:cpa-dt:black:auto",
    "hiq:baseball:2025:chrome-prospects-autographs:cpa-dt:black-refractor:auto",
  ];
  for (const slug of slugCandidates) {
    const { resources } = await sc.items.query({
      query: "SELECT c.price, c.soldAt, c.source, c.title, c.parallel, c.cardNumber, c.isAuto, c.gradeCompany, c.gradeValue, c.hobbyiqCardId FROM c WHERE c.hobbyiqCardId = @s AND c.soldAt >= @cutoff ORDER BY c.soldAt DESC",
      parameters: [{ name: "@s", value: slug }, { name: "@cutoff", value: cutoffIso }],
    }).fetchAll();
    if (resources.length === 0) continue;
    console.log(`\n▸ ${slug}  (n=${resources.length})`);
    const prices = (resources as Row[]).map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
    console.log(`  prices: [${prices.map((p) => "$" + p.toFixed(2)).join(", ")}]  median=$${prices[Math.floor(prices.length/2)].toFixed(2)}`);
    for (const r of resources as Row[]) {
      const grade = r.gradeCompany ? `${r.gradeCompany}-${r.gradeValue}` : "Raw";
      console.log(`    $${String(r.price).padStart(8)} | ${(r.soldAt ?? "").slice(0, 10)} | ${(r.source ?? "?").padEnd(20)} | ${grade.padEnd(8)} | par="${r.parallel ?? ""}"`);
      if (r.title) console.log(`             title="${r.title}"`);
    }
  }

  console.log(`\n▸ Cross-slug scan: (2025, CPA-DT, isAuto=true) any parallel — last 180d`);
  const { resources: idRows } = await sc.items.query({
    query: "SELECT c.hobbyiqCardId, c.parallel, c.price, c.soldAt, c.source, c.title FROM c WHERE c.cardYear = 2025 AND UPPER(c.cardNumber ?? '') = 'CPA-DT' AND c.isAuto = true AND c.soldAt >= @cutoff ORDER BY c.soldAt DESC",
    parameters: [{ name: "@cutoff", value: cutoffIso }],
  }).fetchAll();
  console.log(`  count=${idRows.length}`);
  const byPar: Record<string, number[]> = {};
  for (const r of idRows as Row[]) {
    const par = String(r.parallel ?? "unknown").toLowerCase();
    (byPar[par] ??= []).push(Number(r.price));
  }
  for (const [par, prices] of Object.entries(byPar)) {
    const sorted = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
    if (sorted.length === 0) continue;
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`    par="${par.padEnd(28)}"  n=${sorted.length.toString().padStart(3)}  median=$${median.toFixed(2)}  range=$${sorted[0].toFixed(0)}-$${sorted[sorted.length-1].toFixed(0)}`);
  }

  console.log(`\n▸ Top 15 highest-price comps at this cardNumber:`);
  const sortedByPrice = [...(idRows as Row[])].sort((a, b) => Number(b.price) - Number(a.price));
  for (const r of sortedByPrice.slice(0, 15)) {
    console.log(`    $${String(r.price).padStart(9)} | ${(r.soldAt ?? "").slice(0, 10)} | ${(r.source ?? "?").padEnd(20)} | par="${r.parallel ?? ""}" | slug=${r.hobbyiqCardId ?? ""}`);
    if (r.title) console.log(`                title="${r.title}"`);
  }
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
