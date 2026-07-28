#!/usr/bin/env -S node --experimental-strip-types
// CF-HARTMAN-POOL-DIAG (Drew, 2026-07-28). Auto-discovers Hartman's
// holdings + slug from the portfolio, then dumps every sold_comps row
// at that slug plus close variants and a cross-parallel scan so we can
// see WHY the direct-slug + trajectory result underprices the card
// relative to observed $1200+ sales.

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
  flagged?: boolean;
  flagReason?: string;
}

async function main(): Promise<void> {
  const identifier = (process.argv[2] ?? "").trim();
  if (!identifier) { console.error("Usage: diagnoseHartmanPool.ts <email-or-userId>"); process.exit(2); }
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const users = db.container(process.env.COSMOS_USERS_CONTAINER ?? "users");
  const portfolio = db.container(process.env.COSMOS_PORTFOLIO_CONTAINER ?? "portfolio");
  const soldComps = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");

  const isEmail = identifier.includes("@");
  const userQ = isEmail
    ? { query: 'SELECT c.userId FROM c WHERE c.docType = "user" AND c.emailLower = @v', parameters: [{ name: "@v", value: identifier.toLowerCase() }] }
    : { query: 'SELECT c.userId FROM c WHERE c.docType = "user" AND c.userId = @v', parameters: [{ name: "@v", value: identifier }] };
  const { resources: userRows } = await users.items.query(userQ).fetchAll();
  if (userRows.length === 0) { console.error("no user found"); process.exit(1); }
  const { userId } = userRows[0];

  const { resource: portfolioDoc } = await portfolio.item(userId, userId).read();
  const holdings = Object.values((portfolioDoc as { holdings?: Record<string, unknown> }).holdings ?? {}) as Array<Record<string, unknown>>;
  const hartman = holdings.filter((x) => String(x.playerName ?? "").toLowerCase().includes("hartman"));
  if (hartman.length === 0) { console.error("no Hartman holdings"); process.exit(1); }

  console.log(`\n▸ Found ${hartman.length} Hartman holding(s)`);
  for (const h of hartman) {
    console.log(`\n  ═══════ holding ${h.id} ═══════`);
    console.log(`  cardTitle:       ${h.cardTitle}`);
    console.log(`  playerName:      ${h.playerName}`);
    console.log(`  cardYear:        ${h.cardYear}`);
    console.log(`  product:         ${h.product}`);
    console.log(`  parallel:        ${h.parallel}`);
    console.log(`  cardNumber:      ${h.cardNumber}`);
    console.log(`  isAuto:          ${h.isAuto}`);
    console.log(`  grade:           ${h.gradeCompany ?? "Raw"} ${h.gradeValue ?? ""}`);
    console.log(`  cardId:          ${h.cardId ?? "(null)"}`);
    console.log(`  hobbyiqCardId:   ${h.hobbyiqCardId ?? "(null)"}`);
    console.log(`  fairMarketValue: ${h.fairMarketValue}`);
    console.log(`  estimatedValue:  ${h.estimatedValue}`);
    console.log(`  valuationStatus: ${h.valuationStatus}`);
    console.log(`  pricingSource:   ${h.pricingSource}`);
    console.log(`  pricingMeta:     ${JSON.stringify(h.pricingMeta)}`);
  }

  const blue = hartman.filter((h) => {
    const par = String(h.parallel ?? "").toLowerCase();
    return par.includes("blue") && h.isAuto === true;
  });

  const cutoffIso = new Date(Date.now() - 180 * 86400000).toISOString();
  for (const bh of blue) {
    const slugs = new Set<string>();
    if (typeof bh.hobbyiqCardId === "string") slugs.add(bh.hobbyiqCardId);

    for (const slug of slugs) {
      console.log(`\n▸ sold_comps for slug=${slug}  (last 180d)`);
      const { resources } = await soldComps.items.query({
        query: "SELECT * FROM c WHERE c.hobbyiqCardId = @s AND c.soldAt >= @cutoff ORDER BY c.soldAt DESC",
        parameters: [{ name: "@s", value: slug }, { name: "@cutoff", value: cutoffIso }],
      }).fetchAll();
      console.log(`  count=${resources.length}`);
      for (const r of resources as Row[]) {
        const grade = r.gradeCompany ? `${r.gradeCompany}-${r.gradeValue}` : "Raw";
        const flag = r.flagged ? ` [FLAGGED:${r.flagReason ?? "?"}]` : "";
        console.log(`  $${String(r.price).padStart(9)} | ${(r.soldAt ?? "").slice(0, 10)} | ${(r.source ?? "?").padEnd(20)} | ${grade.padEnd(8)} | par="${r.parallel ?? ""}"${flag}`);
        if (r.title) console.log(`              title="${r.title}"`);
      }
      const prices = (resources as Row[]).map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
      if (prices.length > 0) {
        console.log(`  → prices sorted: [${prices.map((p) => "$" + p.toFixed(2)).join(", ")}]  median=$${prices[Math.floor(prices.length / 2)].toFixed(2)}`);
      }
    }

    if (bh.cardYear && bh.cardNumber) {
      console.log(`\n▸ Cross-slug scan: (${bh.cardYear}, ${bh.cardNumber}, isAuto=true) any parallel — last 180d`);
      const { resources: idRows } = await soldComps.items.query({
        query: "SELECT c.hobbyiqCardId, c.parallel, c.price, c.soldAt, c.source, c.title FROM c WHERE c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = true AND c.soldAt >= @cutoff ORDER BY c.soldAt DESC",
        parameters: [{ name: "@y", value: bh.cardYear }, { name: "@cn", value: String(bh.cardNumber).toUpperCase() }, { name: "@cutoff", value: cutoffIso }],
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
      const sortedByPrice = [...(idRows as Row[])].sort((a, b) => Number(b.price) - Number(a.price));
      console.log(`\n  Top 15 highest-price comps (any parallel):`);
      for (const r of sortedByPrice.slice(0, 15)) {
        console.log(`    $${String(r.price).padStart(9)} | ${(r.soldAt ?? "").slice(0, 10)} | ${(r.source ?? "?").padEnd(20)} | par="${r.parallel ?? ""}" | slug=${r.hobbyiqCardId ?? ""}`);
        if (r.title) console.log(`                title="${r.title}"`);
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
