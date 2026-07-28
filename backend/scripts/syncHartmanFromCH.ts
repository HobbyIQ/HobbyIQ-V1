#!/usr/bin/env -S npx tsx
// CF-CH-HARTMAN-SYNC (Drew, 2026-07-28). Pull every Hartman CPA-EHA
// card from CardHedge, list its raw + graded sales, and auto-persist
// into sold_comps via getCardSales's persistIdentity hook.
//
// Dry-run by default (prints the sales but doesn't call persistIdentity).
// Pass --apply to actually feed sold_comps.
//
// Usage:
//   export COSMOS_CONNECTION_STRING="$(az webapp config appsettings list ...)"
//   export CARD_HEDGE_API_KEY="$(az webapp config appsettings list ...)"
//   npx tsx backend/scripts/syncHartmanFromCH.ts          # dry-run
//   npx tsx backend/scripts/syncHartmanFromCH.ts --apply   # writes to sold_comps

import { searchCards, getCardSales } from "../src/services/compiq/cardhedge.client.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`\n▸ Mode: ${apply ? "APPLY (will persist to sold_comps)" : "dry-run (no writes)"}`);

  // Enumerate every Hartman card CH knows about. Try a few queries
  // because CH's tokenizer sometimes needs a wider net.
  const queries = [
    "Eric Hartman Bowman Chrome CPA-EHA",
    "Eric Hartman 2026 Bowman Chrome auto",
    "Eric Hartman CPA-EHA",
    "Hartman #CPA-EHA",
  ];
  const seen = new Map<string, { title: string; player: string; year: number | null; variant: string | null; number: string | null }>();
  for (const q of queries) {
    const results = await searchCards(q, 25);
    console.log(`  q="${q}"  → ${results.length} cards`);
    for (const c of results) {
      if (!c.card_id) continue;
      if (seen.has(c.card_id)) continue;
      seen.set(c.card_id, {
        title: String((c as { title?: string }).title ?? (c as { name?: string }).name ?? "?"),
        player: String((c as { player?: string }).player ?? "?"),
        year: (c as { year?: number | null }).year ?? null,
        variant: (c as { variant?: string | null }).variant ?? null,
        number: (c as { number?: string | null }).number ?? null,
      });
    }
  }
  console.log(`\n▸ Distinct Hartman cards from CH: ${seen.size}`);

  // For each cardId + each grade tier, fetch sales. persistIdentity
  // triggers the background write into sold_comps.
  const GRADES = ["Raw", "PSA 10", "PSA 9", "BGS 9.5", "SGC 10"];
  const totalsByGrade: Record<string, number> = {};
  const totalsByCard: Record<string, number> = {};
  for (const [cardId, meta] of seen.entries()) {
    console.log(`\n──── ${meta.year ?? "?"} ${meta.title} (${meta.variant ?? "?"}) — cardId=${cardId}`);
    for (const grade of GRADES) {
      // Call WITHOUT persistIdentity in dry-run, WITH in apply. Same
      // network call either way, so we still see the counts.
      const sales = apply
        ? await getCardSales(cardId, grade, 50, {
            persistIdentity: {
              playerName: meta.player,
              cardYear: meta.year,
              sport: "baseball",
            },
          })
        : await getCardSales(cardId, grade, 50);
      totalsByGrade[grade] = (totalsByGrade[grade] ?? 0) + sales.length;
      totalsByCard[cardId] = (totalsByCard[cardId] ?? 0) + sales.length;
      if (sales.length > 0) {
        const prices = sales.map((s) => s.price).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
        const median = prices.length > 0 ? prices[Math.floor(prices.length / 2)] : null;
        console.log(`  ${grade.padEnd(8)}  n=${sales.length.toString().padStart(3)}  median=${median !== null ? "$" + median.toFixed(2) : "?"}  range=$${prices[0]?.toFixed(0) ?? "?"}-$${prices[prices.length - 1]?.toFixed(0) ?? "?"}`);
      } else {
        console.log(`  ${grade.padEnd(8)}  n=  0`);
      }
    }
  }

  console.log(`\n▸ Grand totals`);
  for (const [grade, n] of Object.entries(totalsByGrade)) {
    console.log(`  ${grade.padEnd(8)}  ${n}`);
  }
  const total = Object.values(totalsByGrade).reduce((s, n) => s + n, 0);
  console.log(`  TOTAL     ${total}`);
  console.log(`\n${apply ? "✓ Persistence fired asynchronously; dedup + upsert happens in sold_comps store." : "Dry-run only. Pass --apply to feed sold_comps."}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
