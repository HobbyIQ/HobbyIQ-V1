#!/usr/bin/env -S npx tsx
// CF-CATALOG-SEED-FROM-CH (Drew, 2026-07-28). The FIRST source-of-truth
// pass at building card_catalog. Not from sold_comps (polluted) —
// from CardHedge's authoritative catalog.
//
// Strategy:
//   1. Take the top N players from sold_comps ranked by comp count
//      (bounded so we can iterate the target volume without exhausting
//      CH's rate limit in one run).
//   2. For each player: searchCards(query="<player>") → collect the
//      cardIds CH returns.
//   3. For each cardId: getCardDetailsById → get the canonical
//      (year, set, number, variant, image, player) from CH.
//   4. Derive our hobbyiqCardId slug from those fields and upsertCatalogEntry
//      with source="ch-catalog", vendorIds.cardhedge=<CH_id>, referenceImage.url=<CH image>.
//
// Idempotent: same slug → same upsert; re-runs merge vendorIds without dup.
//
// Dry-run by default. Pass --apply to write to card_catalog.
//
// Usage:
//   export COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query \"[?name=='COSMOS_CONNECTION_STRING'].value\" -o tsv)"
//   export CARD_HEDGE_API_KEY="$(az webapp config appsettings list --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query \"[?name=='CARD_HEDGE_API_KEY'].value\" -o tsv)"
//   npx tsx backend/scripts/seedCatalogFromCH.ts --topN=100          # dry-run
//   npx tsx backend/scripts/seedCatalogFromCH.ts --topN=100 --apply   # writes

import { CosmosClient } from "@azure/cosmos";
import { searchCards, type CardHedgeCard } from "../src/services/compiq/cardhedge.client.js";
import { deriveCatalogEntry, upsertCatalogEntry } from "../src/services/portfolioiq/cardCatalog.service.js";

interface PlayerAgg { playerName: string; count: number; }

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const topN = Number(process.argv.find((a) => a.startsWith("--topN="))?.split("=")[1] ?? 100);
  const maxCardsPerPlayer = Number(process.argv.find((a) => a.startsWith("--maxCards="))?.split("=")[1] ?? 25);
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  if (!process.env.CARD_HEDGE_API_KEY) { console.error("CARD_HEDGE_API_KEY required"); process.exit(2); }
  console.log(`▸ Mode: ${apply ? "APPLY (upsert into card_catalog)" : "dry-run"}  topN=${topN}  maxCardsPerPlayer=${maxCardsPerPlayer}`);

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const portfolio = db.container(process.env.COSMOS_PORTFOLIO_CONTAINER ?? "portfolio");

  // ─── Player universe: sourced from user portfolios ─────────────
  // Portfolio-first: the players Drew owns are the ones we need to
  // price correctly for HIM. GROUP BY across sold_comps (500k+ rows)
  // times out; portfolio is small + partition-friendly.
  //
  // Later passes can widen from CH's own catalog enumeration.
  console.log(`\n▸ Collecting players from user portfolios...`);
  const players = new Set<string>();
  const iter = portfolio.items.query<{ holdings?: Record<string, { playerName?: string }> }>({
    query: "SELECT c.holdings FROM c",
  });
  while (iter.hasMoreResults()) {
    const { resources: batch } = await iter.fetchNext();
    for (const doc of batch) {
      const h = doc.holdings ?? {};
      for (const holding of Object.values(h)) {
        const p = String(holding?.playerName ?? "").trim();
        if (p) players.add(p);
      }
    }
  }
  const ranked: PlayerAgg[] = [...players].sort().slice(0, topN).map((n) => ({ playerName: n, count: 0 }));
  console.log(`  distinct players in portfolios: ${players.size}  taking first ${ranked.length}`);
  console.log(`  first: ${ranked[0]?.playerName}`);
  console.log(`  last:  ${ranked[ranked.length - 1]?.playerName}`);

  // ─── For each player: search CH → get catalog entries ─────────
  let totalSearched = 0;
  let totalCardsFound = 0;
  let totalDerivable = 0;
  let totalUpserted = 0;
  let totalSkipped = 0;
  const flipReasons = new Map<string, number>();

  // Parallel worker pool — the CH client already has an in-memory
  // cache and rate-limit backoff; a bounded concurrency here avoids
  // sequencing lag without exhausting CH's 8 req/s ceiling.
  const CONCURRENCY = 4;
  const queue = [...ranked];
  const workers: Promise<void>[] = [];

  const processPlayer = async (p: PlayerAgg) => {
    totalSearched += 1;
    const results = await searchCards(p.playerName, maxCardsPerPlayer).catch(() => [] as CardHedgeCard[]);
    if (!Array.isArray(results) || results.length === 0) {
      flipReasons.set("no-search-hits", (flipReasons.get("no-search-hits") ?? 0) + 1);
      if (totalSearched <= 5) console.log(`  ${totalSearched}/${topN} ${p.playerName} — 0 CH cards`);
      return;
    }
    if (totalSearched <= 5 || totalSearched % 25 === 0) {
      console.log(`  ${totalSearched}/${topN} ${p.playerName} — ${results.length} CH cards`);
    }
    for (const c of results) {
      totalCardsFound += 1;
      const cardId = String(c.card_id ?? "").trim();
      if (!cardId) { totalSkipped += 1; continue; }

      // searchCards already returns year / set / number / variant /
      // image on the CardHedgeCard shape — skip the card-details
      // round-trip that would double the API cost.
      const merged = c;

      // Year: prefer explicit field, fall back to a 4-digit year prefix
      // in the set string ("2026 Bowman Mega Box Baseball" → 2026).
      // CH's searchCards leaves top-level `year` undefined in practice.
      let year: number | null = typeof merged.year === "number" ? merged.year
        : typeof merged.year === "string" && Number.isFinite(Number(merged.year)) ? Number(merged.year)
        : null;
      if (year === null) {
        const m = String(merged.set ?? "").match(/\b(19|20)\d{2}\b/);
        if (m) {
          const y = Number(m[0]);
          if (Number.isFinite(y) && y >= 1950 && y <= 2030) year = y;
        }
      }
      const isAuto = /(auto|autograph)/i.test(String(merged.set ?? "")) || /(auto|autograph)/i.test(String(merged.variant ?? ""));

      const entry = deriveCatalogEntry({
        sport: "baseball",  // TODO: CH doesn't return sport on card object; default to baseball for now (majority of the pool)
        year,
        setKey: String(merged.set ?? "").trim(),
        cardNumber: String(merged.number ?? "").trim(),
        parallel: String(merged.variant ?? "Base").trim() || "Base",
        isAuto,
        printRun: null,  // TODO: parse /N from variant when present
        playerName: String(merged.player ?? p.playerName).trim(),
        source: "ch-catalog",
        confidence: 0.9,
        vendorIds: { cardhedge: cardId },
      });
      if (!entry) {
        totalSkipped += 1;
        flipReasons.set("insufficient-fields", (flipReasons.get("insufficient-fields") ?? 0) + 1);
        continue;
      }
      totalDerivable += 1;
      if (apply) {
        // Add reference image if CH gave us one.
        const entryWithImage = merged.image
          ? { ...entry, referenceImage: { url: String(merged.image), verifiedAt: new Date().toISOString() } }
          : entry;
        const upserted = await upsertCatalogEntry(entryWithImage);
        if (upserted) totalUpserted += 1;
        else flipReasons.set("upsert-failed", (flipReasons.get("upsert-failed") ?? 0) + 1);
      }
    }
  };

  const runWorker = async () => {
    while (queue.length > 0) {
      const p = queue.shift();
      if (!p) return;
      try {
        await processPlayer(p);
      } catch (err) {
        flipReasons.set("worker-error", (flipReasons.get("worker-error") ?? 0) + 1);
      }
    }
  };
  for (let i = 0; i < CONCURRENCY; i++) workers.push(runWorker());
  await Promise.all(workers);

  console.log(`\n▸ Summary`);
  console.log(`  players searched:       ${totalSearched}`);
  console.log(`  cards found (CH):       ${totalCardsFound}`);
  console.log(`  derivable → catalog:    ${totalDerivable}`);
  console.log(`  ${apply ? "upserted" : "would upsert"}:    ${apply ? totalUpserted : totalDerivable}`);
  console.log(`  skipped:                ${totalSkipped}`);
  if (flipReasons.size > 0) {
    console.log(`\n▸ Skip reasons:`);
    for (const [k, v] of [...flipReasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(30)}  ${v}`);
    }
  }
  console.log(`\n${apply ? "✓ Wrote to card_catalog." : "Dry-run only. Pass --apply to write."}`);
}

main().catch((err: unknown) => {
  console.error(`fatal:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
