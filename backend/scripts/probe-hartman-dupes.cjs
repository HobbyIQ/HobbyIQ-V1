#!/usr/bin/env node
/**
 * CF-HARTMAN-DEDUP-PROBE (2026-07-11).
 *
 * Read-only probe. Enumerates holdings in user-199fcbc9's portfolio
 * doc, groups them by (cardId, parallel, printRun, auto) to surface
 * the 4 Hartman BXF/150 dupes flagged in project memory.
 *
 * Runbook:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/probe-hartman-dupes.cjs
 *
 * Read-only — no writes to Cosmos.
 */

const { CosmosClient } = require("@azure/cosmos");

const USER_ID = process.argv[2] ?? "user-199fcbc9";

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("COSMOS_CONNECTION_STRING not set");
    process.exit(1);
  }
  const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client
    .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
    .container("portfolio");

  console.log(`[probe] reading portfolio for userId=${USER_ID}`);
  const { resources } = await container.items
    .query({
      query: "SELECT * FROM c WHERE c.userId = @u",
      parameters: [{ name: "@u", value: USER_ID }],
    })
    .fetchAll();

  const userDoc = resources.find((d) => d.id === USER_ID) ?? resources[0];
  if (!userDoc) {
    console.log(`  ✗ exact userId "${USER_ID}" not found; searching for partial matches`);
    const substr = USER_ID.replace(/^user-/, "").slice(0, 8);
    const { resources: partial } = await container.items
      .query({
        query:
          "SELECT c.userId, c.id FROM c WHERE CONTAINS(LOWER(c.userId), @s) OR CONTAINS(LOWER(c.id), @s)",
        parameters: [{ name: "@s", value: substr.toLowerCase() }],
      })
      .fetchAll();
    console.log(`  found ${partial.length} partial match(es):`);
    for (const p of partial.slice(0, 10)) {
      console.log(`    userId=${p.userId}  id=${p.id}`);
    }
    // Global Hartman scan — search EVERY field of every holding for "hartman"
    console.log(`\n  scanning ALL portfolios for Hartman holdings (all fields)...`);
    const { resources: all } = await container.items
      .query({
        query: "SELECT c.userId, c.id, c.holdings FROM c WHERE STARTSWITH(c.id, 'user-')",
      })
      .fetchAll();
    console.log(`  scanned ${all.length} user docs`);
    for (const d of all) {
      const hartmanKeys = Object.entries(d.holdings ?? {}).filter(([, h]) => {
        const blob = JSON.stringify(h).toLowerCase();
        return blob.includes("hartman");
      });
      const totalHoldings = Object.keys(d.holdings ?? {}).length;
      console.log(`  · ${d.userId}  — ${totalHoldings} holdings, ${hartmanKeys.length} Hartman`);
      if (hartmanKeys.length > 0) {
        console.log(`      ★ HARTMAN-BEARING USER`);
        for (const [key, h] of hartmanKeys.slice(0, 6)) {
          const summary = `${h.year ?? "?"} ${h.brand ?? h.product ?? ""} ${h.parallel ?? ""} ${h.player ?? h.playerName ?? ""}`.trim();
          console.log(`         holdingId=${key}`);
          console.log(`           summary: ${summary}`);
          console.log(`           cardId: ${h.cardHedgeCardId ?? h.cardId ?? "(none)"}`);
        }
      }
      // CF-FINANCE-AUDIT: also report ledger + trade counts for finance-side coverage
      const ledgerLen = Array.isArray(d.ledger) ? d.ledger.length : 0;
      const tradeLen = Array.isArray(d.trades) ? d.trades.length : 0;
      const pxHistKeys = Object.keys(d.priceHistoryByHolding ?? {}).length;
      const alertsLen = Array.isArray(d.alerts) ? d.alerts.length : 0;
      console.log(`      finance surface: ledger=${ledgerLen}  trades=${tradeLen}  priceHistoryKeys=${pxHistKeys}  alerts=${alertsLen}`);
      // Scan for ANY dupes in this user (same cardId, or same year+player+parallel signature)
      if (totalHoldings > 20) {
        const byCardId = new Map();
        const byBucket = new Map();
        for (const [key, h] of Object.entries(d.holdings ?? {})) {
          const cid = h.cardHedgeCardId ?? h.cardId ?? null;
          if (cid) {
            if (!byCardId.has(cid)) byCardId.set(cid, []);
            byCardId.get(cid).push({ key, h });
          }
          const bucket = [
            h.year ?? "",
            (h.player ?? h.playerName ?? "").toLowerCase(),
            (h.parallel ?? "").toLowerCase(),
            (h.brand ?? h.product ?? "").toLowerCase(),
            h.auto ? "auto" : "base",
            h.printRun ?? "",
          ].join("|");
          if (!byBucket.has(bucket)) byBucket.set(bucket, []);
          byBucket.get(bucket).push({ key, h });
        }
        const dupesByCardId = [...byCardId.entries()].filter(([, arr]) => arr.length > 1);
        const dupesByBucket = [...byBucket.entries()].filter(([, arr]) => arr.length > 1);
        console.log(`      dupe scan: ${dupesByCardId.length} cardId collisions, ${dupesByBucket.length} bucket collisions`);
        for (const [cid, arr] of dupesByCardId.slice(0, 10)) {
          console.log(`         ★ cardId=${cid.slice(0, 30)} — ${arr.length} entries`);
          for (const r of arr.slice(0, 4)) {
            const label = `${r.h.year ?? "?"} ${r.h.player ?? r.h.playerName ?? ""} ${r.h.parallel ?? ""}`.trim();
            console.log(`            · ${r.key.slice(0, 12)}...  ${label}`);
          }
        }
        for (const [bucket, arr] of dupesByBucket.slice(0, 10)) {
          if (arr.length < 2) continue;
          const [key0, h0] = [arr[0].key, arr[0].h];
          const cid0 = h0.cardHedgeCardId ?? h0.cardId ?? "(none)";
          // Only show bucket dupes that aren't already covered by cardId dupes
          const inCidGroup = dupesByCardId.some(([cid]) => arr.every((r) => (r.h.cardHedgeCardId ?? r.h.cardId) === cid));
          if (inCidGroup) continue;
          console.log(`         · bucket "${bucket}" — ${arr.length} entries (cardId=${cid0.slice(0, 20)})`);
        }
      }
    }
    process.exit(0);
  }
  const holdings = userDoc.holdings ?? {};
  const total = Object.keys(holdings).length;
  console.log(`  found doc; ${total} total holdings`);

  // Hartman-scoped
  const hartmanHoldings = Object.entries(holdings).filter(([, h]) => {
    const desc = `${h.player ?? ""} ${h.title ?? ""} ${h.cardName ?? ""}`.toLowerCase();
    return desc.includes("hartman");
  });
  console.log(`\n  ${hartmanHoldings.length} Hartman-tagged holdings:\n`);

  // Group by (cardId, parallel, printRun, auto) to surface dupes
  const groups = new Map();
  for (const [key, h] of hartmanHoldings) {
    const bucket = [
      h.cardHedgeCardId ?? h.cardId ?? "",
      h.parallel ?? "",
      h.printRun ?? "",
      h.auto ? "auto" : "base",
      h.year ?? "",
    ].join("|");
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push({ key, holding: h });
  }
  for (const [bucket, rows] of groups) {
    const marker = rows.length > 1 ? "★ DUPE" : " ";
    console.log(`  ${marker} ${bucket}  — ${rows.length} entr${rows.length === 1 ? "y" : "ies"}`);
    for (const r of rows) {
      const title = r.holding.title ?? r.holding.cardName ?? "(no title)";
      const purchasePrice = r.holding.purchasePrice ?? r.holding.acquiredPrice ?? "(no price)";
      const acquiredAt = r.holding.acquiredAt ?? r.holding.purchaseDate ?? "(no date)";
      console.log(`      · holdingId=${r.key}`);
      console.log(`         title="${title}"`);
      console.log(`         purchase=$${purchasePrice} @ ${acquiredAt}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
