#!/usr/bin/env -S node --experimental-strip-types
// CF-HARTSHORN-POOL-DIAG (Drew, 2026-07-28).
// One-off diagnostic. Dumps every sold_comps row for the Hartshorn Blue
// Auto slug plus close variants (blue vs blue-refractor, base) so we
// can explain why direct-slug returned $38.61 with compsUsed=2 when
// Drew observed $600-800 real sales.
//
// Also prints the holding's stored slug + cardId so we can confirm
// slug alignment vs where the real sales actually live in the pool.
//
// Never writes. Silent-on-error.
//
// Usage:
//   export COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query \"[?name=='COSMOS_CONNECTION_STRING'].value\" -o tsv)"
//   node --experimental-strip-types backend/scripts/diagnoseHartshornPool.ts dvabulas@outlook.com

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

const SLUG_VARIANTS = [
  "hiq:baseball:2025:bowman-draft:cpa-jha:blue:auto",
  "hiq:baseball:2025:bowman-draft:cpa-jha:blue-refractor:auto",
  "hiq:baseball:2025:bowman-draft:cpa-jha:base:auto",
];

async function main(): Promise<void> {
  const identifier = (process.argv[2] ?? "").trim();
  if (!identifier) {
    console.error("Usage: diagnoseHartshornPool.ts <email-or-userId>");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("COSMOS_CONNECTION_STRING env var required");
    process.exit(2);
  }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const users = db.container(process.env.COSMOS_USERS_CONTAINER ?? "users");
  const portfolio = db.container(process.env.COSMOS_PORTFOLIO_CONTAINER ?? "portfolio");
  const soldComps = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");

  // Resolve user
  const isEmail = identifier.includes("@");
  const userQ = isEmail
    ? {
        query: 'SELECT c.userId FROM c WHERE c.docType = "user" AND c.emailLower = @v',
        parameters: [{ name: "@v", value: identifier.toLowerCase() }],
      }
    : {
        query: 'SELECT c.userId FROM c WHERE c.docType = "user" AND c.userId = @v',
        parameters: [{ name: "@v", value: identifier }],
      };
  const { resources: userRows } = await users.items.query(userQ).fetchAll();
  if (userRows.length === 0) {
    console.error(`no user found for ${identifier}`);
    process.exit(1);
  }
  const { userId } = userRows[0];

  const { resource: portfolioDoc } = await portfolio.item(userId, userId).read();
  const holdings = Object.values((portfolioDoc as { holdings?: Record<string, unknown> }).holdings ?? {}) as Array<Record<string, unknown>>;

  // Find Hartshorn holding
  const h = holdings.find((x) => {
    const p = String(x.playerName ?? "").toLowerCase();
    return p.includes("hartshorn");
  });
  if (!h) {
    console.error("no Hartshorn holding found");
    process.exit(1);
  }

  console.log(`\n▸ Hartshorn holding:`);
  console.log(`  cardTitle:      ${h.cardTitle}`);
  console.log(`  playerName:     ${h.playerName}`);
  console.log(`  cardYear:       ${h.cardYear}`);
  console.log(`  product:        ${h.product}`);
  console.log(`  setName:        ${h.setName}`);
  console.log(`  parallel:       ${h.parallel}`);
  console.log(`  cardNumber:     ${h.cardNumber}`);
  console.log(`  isAuto:         ${h.isAuto}`);
  console.log(`  grade:          ${h.gradeCompany ?? "Raw"} ${h.gradeValue ?? ""}`);
  console.log(`  cardId:         ${h.cardId ?? "(null)"}`);
  console.log(`  hobbyiqCardId:  ${h.hobbyiqCardId ?? "(null)"}`);
  console.log(`  fairMarketValue:${h.fairMarketValue}`);
  console.log(`  estimatedValue: ${h.estimatedValue}`);
  console.log(`  valuationStatus:${h.valuationStatus}`);
  console.log(`  pricingSource:  ${h.pricingSource}`);
  console.log(`  pricingMeta:    ${JSON.stringify(h.pricingMeta)}`);

  // Dump every row for each variant
  const cutoffIso = new Date(Date.now() - 180 * 86400000).toISOString();
  for (const slug of SLUG_VARIANTS) {
    console.log(`\n▸ sold_comps for slug=${slug}  (last 180d)`);
    const { resources } = await soldComps.items
      .query({
        query: "SELECT * FROM c WHERE c.hobbyiqCardId = @s AND c.soldAt >= @cutoff ORDER BY c.soldAt DESC",
        parameters: [
          { name: "@s", value: slug },
          { name: "@cutoff", value: cutoffIso },
        ],
      })
      .fetchAll();
    console.log(`  count=${resources.length}`);
    if (resources.length === 0) continue;
    for (const r of resources as Row[]) {
      const grade = r.gradeCompany ? `${r.gradeCompany}-${r.gradeValue}` : "Raw";
      const flag = r.flagged ? ` [FLAGGED:${r.flagReason ?? "?"}]` : "";
      console.log(
        `  $${String(r.price).padStart(8)} | ${(r.soldAt ?? "").slice(0, 10)} | ${(r.source ?? "?").padEnd(12)} | ${grade.padEnd(8)} | par="${r.parallel ?? ""}"${flag}`,
      );
      if (r.title) console.log(`             title="${r.title}"`);
    }
    const prices = (resources as Row[])
      .map((r) => Number(r.price))
      .filter((p) => Number.isFinite(p) && p > 0)
      .sort((a, b) => a - b);
    if (prices.length > 0) {
      console.log(
        `  → prices sorted: [${prices.map((p) => "$" + p.toFixed(2)).join(", ")}]  median=$${prices[Math.floor(prices.length / 2)].toFixed(2)}`,
      );
    }
  }

  // Also dump by (year, cardNumber, isAuto) — any parallel — to find WHERE the $608 lives
  console.log(`\n▸ All sold_comps for (2025, CPA-JHA, isAuto=true) last 180d — any parallel/slug`);
  const { resources: idRows } = await soldComps.items
    .query({
      query:
        "SELECT c.hobbyiqCardId, c.parallel, c.price, c.soldAt, c.source, c.title FROM c WHERE c.cardYear = 2025 AND UPPER(c.cardNumber) = 'CPA-JHA' AND c.isAuto = true AND c.soldAt >= @cutoff ORDER BY c.soldAt DESC",
      parameters: [{ name: "@cutoff", value: cutoffIso }],
    })
    .fetchAll();
  console.log(`  count=${idRows.length}`);
  for (const r of idRows as Row[]) {
    console.log(
      `  $${String(r.price).padStart(8)} | ${(r.soldAt ?? "").slice(0, 10)} | ${(r.source ?? "?").padEnd(12)} | par="${r.parallel ?? ""}" | slug=${r.hobbyiqCardId ?? ""}`,
    );
    if (r.title) console.log(`             title="${r.title}"`);
  }
}

main().catch((err: unknown) => {
  console.error(`[diag] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
