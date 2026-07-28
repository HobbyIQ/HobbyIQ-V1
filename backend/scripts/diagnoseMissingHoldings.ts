#!/usr/bin/env -S node --experimental-strip-types
/**
 * CF-BASE-CARD-FALLBACK-DIAG (Drew, 2026-07-28).
 *
 * One-off diagnostic. For a given user, finds every holding where the
 * pricing engine gave up (fairMarketValue null AND not estimated /
 * pending), then for EACH one reports what data does exist across
 * every source we can query without touching new vendors:
 *
 *   sold_comps  — count of rows in OUR own pool (canonical slug lookup)
 *                 for the exact card OR the (year, set, player) shape
 *   CH 90d      — CH sales rows within the standard 90-day comp window
 *   CH 365d     — CH sales rows out to a full year (older comps)
 *   Cardsight   — best-effort call to /price-by-id via the Cardsight
 *                 vendor source (may return null quietly)
 *   Same-set peers — count of OTHER cards in the same year+product that
 *                 DO have sold_comps data (candidates for a "same-set
 *                 peer anchor" fallback)
 *
 * Output: one row per Missing holding + a summary at the bottom
 * showing which fallback path would rescue the most of them.
 *
 * Never writes. Silent-on-error per source (a source that throws is
 * reported as "err" so we don't false-positive Missing → Rescuable
 * on transient failures).
 *
 * Usage:
 *   export COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query \"[?name=='COSMOS_CONNECTION_STRING'].value\" -o tsv)"
 *   export CARD_HEDGE_API_KEY="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query \"[?name=='CARD_HEDGE_API_KEY'].value\" -o tsv)"
 *   node --experimental-strip-types backend/scripts/diagnoseMissingHoldings.ts <email-or-userId>
 *
 * Example:
 *   node --experimental-strip-types backend/scripts/diagnoseMissingHoldings.ts dvabulas@outlook.com
 */

import { CosmosClient } from "@azure/cosmos";

interface Holding {
  id: string;
  cardId?: string | null;
  hobbyiqCardId?: string | null;
  playerName?: string | null;
  cardTitle?: string | null;
  cardYear?: number | null;
  product?: string | null;
  setName?: string | null;
  parallel?: string | null;
  cardNumber?: string | null;
  isAuto?: boolean | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  fairMarketValue?: number | null;
  valuationStatus?: string | null;
}

interface DiagRow {
  cardTitle: string;
  playerName: string;
  parallel: string;
  grade: string;
  hasCardId: boolean;
  hasSlug: boolean;
  soldCompsExact: number | "err";
  ch90d: number | "err";
  ch365d: number | "err";
  sameSetPeers: number | "err";
  rescueVia: string;
}

function fmt(n: number | "err"): string {
  if (n === "err") return "err";
  return String(n);
}

function padr(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + "…" : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  const identifier = (process.argv[2] ?? "").trim();
  if (!identifier) {
    console.error("Usage: diagnoseMissingHoldings.ts <email-or-userId>");
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
  const chDaily = db.container(process.env.COSMOS_CH_DAILY_CONTAINER ?? "ch_daily_sales");

  // Resolve identifier → userId.
  console.log(`\n▸ Resolving user for "${identifier}"…`);
  const isEmail = identifier.includes("@");
  const userQ = isEmail
    ? {
        query: 'SELECT c.userId, c.aliases, c.email FROM c WHERE c.docType = "user" AND c.emailLower = @v',
        parameters: [{ name: "@v", value: identifier.toLowerCase() }],
      }
    : {
        query: 'SELECT c.userId, c.aliases, c.email FROM c WHERE c.docType = "user" AND c.userId = @v',
        parameters: [{ name: "@v", value: identifier }],
      };
  const { resources: userRows } = await users.items.query(userQ).fetchAll();
  if (userRows.length === 0) {
    console.error(`  no user found for ${identifier}`);
    process.exit(1);
  }
  const { userId, aliases, email } = userRows[0];
  console.log(`  ${userId} (@${aliases?.[0] ?? "?"}, ${email})`);

  // Portfolio doc.
  console.log(`\n▸ Loading portfolio…`);
  const { resource: portfolioDoc } = await portfolio.item(userId, userId).read();
  if (!portfolioDoc) {
    console.error(`  no portfolio doc for ${userId}`);
    process.exit(1);
  }
  const holdings: Holding[] = Object.values((portfolioDoc as { holdings?: Record<string, Holding> }).holdings ?? {});
  // Matches ERP Data-health "Missing" bucket: fairMarketValue null OR
  // no lastUpdated. valuationStatus is a separate signal (estimated/
  // pending are SUBSETS of no-fmv per the backend counter comment).
  const missing = holdings.filter(
    (h) => h.fairMarketValue == null || h.fairMarketValue === 0,
  );
  console.log(`  total holdings=${holdings.length}, no-FMV=${missing.length}`);

  if (missing.length === 0) {
    console.log(`\nNothing to diagnose — no Missing holdings.`);
    return;
  }

  // For each Missing holding, check every data source.
  console.log(`\n▸ Diagnosing each Missing holding…`);
  const rows: DiagRow[] = [];
  for (const h of missing) {
    const title = h.cardTitle ?? `${h.cardYear ?? ""} ${h.product ?? h.setName ?? ""} ${h.playerName ?? ""}`.trim();
    const grade = h.gradeCompany ? `${h.gradeCompany} ${h.gradeValue ?? "?"}` : "Raw";
    const parallel = (h.parallel ?? "").trim() || "Base";

    let soldCompsExact: number | "err" = "err";
    try {
      // sold_comps is partitioned by /cardId. Try the resolved cardId first,
      // fall back to hobbyiqCardId slug if present.
      const key = h.cardId ?? h.hobbyiqCardId ?? null;
      if (key) {
        const { resources } = await soldComps.items
          .query({
            query: "SELECT VALUE COUNT(1) FROM c WHERE c.cardId = @k",
            parameters: [{ name: "@k", value: key }],
          })
          .fetchAll();
        soldCompsExact = (resources[0] as number) ?? 0;
      } else {
        soldCompsExact = 0;
      }
    } catch (e) {
      soldCompsExact = "err";
    }

    let ch90d: number | "err" = "err";
    let ch365d: number | "err" = "err";
    try {
      // ch_daily_sales is partitioned by /card_id. Count rows in date windows.
      const nowMs = Date.now();
      const iso90 = new Date(nowMs - 90 * 86400000).toISOString().slice(0, 10);
      const iso365 = new Date(nowMs - 365 * 86400000).toISOString().slice(0, 10);
      const key = h.cardId ?? null;
      if (key) {
        const q90 = {
          query: "SELECT VALUE COUNT(1) FROM c WHERE c.card_id = @k AND c.date >= @d",
          parameters: [
            { name: "@k", value: key },
            { name: "@d", value: iso90 },
          ],
        };
        const q365 = {
          query: "SELECT VALUE COUNT(1) FROM c WHERE c.card_id = @k AND c.date >= @d",
          parameters: [
            { name: "@k", value: key },
            { name: "@d", value: iso365 },
          ],
        };
        const [r90, r365] = await Promise.all([
          chDaily.items.query(q90).fetchAll(),
          chDaily.items.query(q365).fetchAll(),
        ]);
        ch90d = (r90.resources[0] as number) ?? 0;
        ch365d = (r365.resources[0] as number) ?? 0;
      } else {
        ch90d = 0;
        ch365d = 0;
      }
    } catch (e) {
      // leave as "err"
    }

    let sameSetPeers: number | "err" = "err";
    try {
      // Count cards in sold_comps that share (cardYear, product) but a
      // DIFFERENT cardId — candidates for a "same-set peer anchor" fallback.
      if (h.cardYear && h.product) {
        const { resources } = await soldComps.items
          .query({
            query:
              "SELECT VALUE COUNT(DISTINCT c.cardId) FROM c WHERE c.cardYear = @y AND c.product = @p" +
              (h.cardId ? " AND c.cardId != @k" : ""),
            parameters: h.cardId
              ? [
                  { name: "@y", value: h.cardYear },
                  { name: "@p", value: h.product },
                  { name: "@k", value: h.cardId },
                ]
              : [
                  { name: "@y", value: h.cardYear },
                  { name: "@p", value: h.product },
                ],
          })
          .fetchAll();
        sameSetPeers = (resources[0] as number) ?? 0;
      } else {
        sameSetPeers = 0;
      }
    } catch (e) {
      // leave "err"
    }

    // Choose recommendation: what would rescue this card, best → worst.
    let rescueVia = "none";
    if (soldCompsExact !== "err" && (soldCompsExact as number) > 0) rescueVia = `sold_comps:${soldCompsExact}`;
    else if (ch365d !== "err" && (ch365d as number) > 0) rescueVia = `CH-365d:${ch365d}`;
    else if (sameSetPeers !== "err" && (sameSetPeers as number) >= 3) rescueVia = `same-set-peers:${sameSetPeers}`;
    else if (parallel && parallel !== "Base") rescueVia = "sibling-fallback (already wired PR#891)";

    rows.push({
      cardTitle: title,
      playerName: h.playerName ?? "?",
      parallel,
      grade,
      hasCardId: Boolean(h.cardId),
      hasSlug: Boolean(h.hobbyiqCardId),
      soldCompsExact,
      ch90d,
      ch365d,
      sameSetPeers,
      rescueVia,
    });
  }

  // Print table.
  console.log(``);
  console.log(padr("Title", 46) + padr("Grade", 12) + padr("Parallel", 22) + padr("id", 4) + padr("slug", 6) + padr("sold_c", 8) + padr("CH90", 6) + padr("CH365", 7) + padr("peers", 7) + "rescue");
  console.log("─".repeat(140));
  for (const r of rows) {
    console.log(
      padr(r.cardTitle, 46) +
        padr(r.grade, 12) +
        padr(r.parallel, 22) +
        padr(r.hasCardId ? "y" : "n", 4) +
        padr(r.hasSlug ? "y" : "n", 6) +
        padr(fmt(r.soldCompsExact), 8) +
        padr(fmt(r.ch90d), 6) +
        padr(fmt(r.ch365d), 7) +
        padr(fmt(r.sameSetPeers), 7) +
        r.rescueVia,
    );
  }

  // Summary — which fallback would help how many.
  console.log("\n▸ Summary — rescue path breakdown");
  const buckets: Record<string, number> = {};
  for (const r of rows) {
    const kind = r.rescueVia.split(":")[0];
    buckets[kind] = (buckets[kind] ?? 0) + 1;
  }
  const total = rows.length;
  for (const [kind, n] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(30)} ${n}/${total} (${Math.round((n / total) * 100)}%)`);
  }
  console.log(`\nDone. Nothing was written.`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[diag] fatal: ${msg}`);
  process.exit(1);
});
