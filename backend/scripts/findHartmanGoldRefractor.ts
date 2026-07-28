#!/usr/bin/env -S npx tsx
// One-off — target CH catalog search for Hartman Gold Refractor Auto
// (Drew's cost-basis $2325 card is a Cardsight UUID; CH's own cardId
// for this SKU may exist and unlock more sales).
import { searchCards, getCardSales } from "../src/services/compiq/cardhedge.client.js";

async function main(): Promise<void> {
  const queries = [
    "Eric Hartman Gold Refractor",
    "Eric Hartman Gold CPA-EHA",
    "Eric Hartman Chrome Gold Auto",
    "Eric Hartman 2026 Bowman Gold",
    "Hartman #CPA-EHA Gold",
    "Eric Hartman Gold Auto /50",
    "CPA-EHA Gold Refractor",
  ];
  const seen = new Map<string, { title: string; variant: string | null }>();
  for (const q of queries) {
    const results = await searchCards(q, 25);
    console.log(`  q="${q}"  → ${results.length} cards`);
    for (const c of results) {
      const variant = (c as { variant?: string | null }).variant ?? "?";
      const title = String((c as { title?: string }).title ?? (c as { name?: string }).name ?? "?");
      if (!c.card_id) continue;
      if (String(variant).toLowerCase().includes("gold") || String(title).toLowerCase().includes("gold")) {
        seen.set(c.card_id, { title, variant });
      }
    }
  }
  console.log(`\n▸ Gold-tagged Hartman cards from CH: ${seen.size}`);
  for (const [cardId, meta] of seen.entries()) {
    console.log(`\n──── ${meta.title} (variant=${meta.variant}) — cardId=${cardId}`);
    for (const grade of ["Raw", "PSA 10", "PSA 9", "BGS 9.5"]) {
      const sales = await getCardSales(cardId, grade, 50);
      if (sales.length > 0) {
        const prices = sales.map((s) => s.price).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
        const median = prices[Math.floor(prices.length / 2)];
        console.log(`  ${grade.padEnd(8)}  n=${sales.length.toString().padStart(3)}  median=$${median.toFixed(2)}  range=$${prices[0].toFixed(0)}-$${prices[prices.length - 1].toFixed(0)}`);
      } else {
        console.log(`  ${grade.padEnd(8)}  n=  0`);
      }
    }
  }
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
