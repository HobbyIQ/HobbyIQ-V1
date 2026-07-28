#!/usr/bin/env -S npx tsx
// CF-CATALOG-BASKETBALL-SEED (Drew, 2026-07-28). Widens the catalog
// coverage from baseball-only to basketball. Same pattern as
// seedCatalogFromCH.ts but with a hard-coded basketball player list
// covering the top ~100 by current market activity (rookies +
// stars + notable prospects). Each player is searched against CH
// with basketball-oriented queries; hits become catalog entries
// with vendorIds.cardhedge + reference image.
//
// Dry-run by default. --apply to write.

import { searchCards, type CardHedgeCard } from "../src/services/compiq/cardhedge.client.js";
import { deriveCatalogEntry, upsertCatalogEntry } from "../src/services/portfolioiq/cardCatalog.service.js";

// Top NBA + prospect names — pragmatic starter list. Coverage grows
// naturally as bootstrap-from-ingest catches new SKUs post-Slice 3.
const BASKETBALL_PLAYERS: readonly string[] = [
  // Current stars
  "Victor Wembanyama", "Nikola Jokic", "Luka Doncic", "Shai Gilgeous-Alexander",
  "Jayson Tatum", "Giannis Antetokounmpo", "Stephen Curry", "LeBron James",
  "Kevin Durant", "Joel Embiid", "Anthony Edwards", "Jaylen Brown",
  "Devin Booker", "Damian Lillard", "Ja Morant", "Trae Young",
  "Zion Williamson", "Anthony Davis", "Kawhi Leonard", "James Harden",
  "Paul George", "Jimmy Butler", "Tyrese Haliburton", "Donovan Mitchell",
  "De'Aaron Fox", "Karl-Anthony Towns", "Bam Adebayo", "Domantas Sabonis",
  "Pascal Siakam", "Kyrie Irving", "DeMar DeRozan", "CJ McCollum",
  "Brandon Ingram", "Chet Holmgren", "Paolo Banchero", "Scottie Barnes",
  "Cade Cunningham", "Franz Wagner", "Alperen Sengun",
  // 2024 draft class + top prospects
  "Zaccharie Risacher", "Alex Sarr", "Reed Sheppard", "Rob Dillingham",
  "Stephon Castle", "Matas Buzelis", "Cody Williams", "Ron Holland",
  "Nikola Topic", "Zach Edey", "Devin Carter",
  // 2025 rookies + hyped prospects
  "Cooper Flagg", "Ace Bailey", "Kon Knueppel", "Dylan Harper",
  "Kasparas Jakucionis", "Khaman Maluach", "Egor Demin", "Derik Queen",
  "Nolan Traore", "Tre Johnson", "Danny Wolf", "Collin Murray-Boyles",
  // Vintage / high-value legends
  "Michael Jordan", "Kobe Bryant", "Larry Bird", "Magic Johnson",
  "Shaquille O'Neal", "Tim Duncan", "Kevin Garnett", "Allen Iverson",
  "Vince Carter", "Tracy McGrady", "Dirk Nowitzki",
];

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const maxCardsPerPlayer = Number(process.argv.find((a) => a.startsWith("--maxCards="))?.split("=")[1] ?? 25);
  if (!process.env.CARD_HEDGE_API_KEY) { console.error("CARD_HEDGE_API_KEY required"); process.exit(2); }
  console.log(`▸ Mode: ${apply ? "APPLY (upsert into card_catalog)" : "dry-run"}  ${BASKETBALL_PLAYERS.length} players × ${maxCardsPerPlayer} cards max`);

  let totalCardsFound = 0;
  let totalDerivable = 0;
  let totalUpserted = 0;
  let totalSkipped = 0;
  const flipReasons = new Map<string, number>();

  const CONCURRENCY = 4;
  const queue = [...BASKETBALL_PLAYERS];
  const workers: Promise<void>[] = [];
  let searched = 0;

  const processPlayer = async (playerName: string): Promise<void> => {
    searched += 1;
    const results = await searchCards(`${playerName} basketball`, maxCardsPerPlayer).catch(() => [] as CardHedgeCard[]);
    if (!Array.isArray(results) || results.length === 0) {
      flipReasons.set("no-search-hits", (flipReasons.get("no-search-hits") ?? 0) + 1);
      return;
    }
    if (searched <= 5 || searched % 10 === 0) {
      console.log(`  ${searched}/${BASKETBALL_PLAYERS.length} ${playerName} — ${results.length} CH cards`);
    }
    for (const c of results) {
      totalCardsFound += 1;
      const cardId = String(c.card_id ?? "").trim();
      if (!cardId) { totalSkipped += 1; continue; }

      let year: number | null = typeof c.year === "number" ? c.year
        : typeof c.year === "string" && Number.isFinite(Number(c.year)) ? Number(c.year)
        : null;
      if (year === null) {
        const yMatch = String(c.set ?? "").match(/\b(19|20)\d{2}\b/);
        if (yMatch) {
          const y = Number(yMatch[0]);
          if (Number.isFinite(y) && y >= 1950 && y <= 2030) year = y;
        }
      }
      const isAuto = /(auto|autograph)/i.test(String(c.set ?? "")) || /(auto|autograph)/i.test(String(c.variant ?? ""));

      const entry = deriveCatalogEntry({
        sport: "basketball",
        year,
        setKey: String(c.set ?? "").trim(),
        cardNumber: String(c.number ?? "").trim(),
        parallel: String(c.variant ?? "Base").trim() || "Base",
        isAuto,
        printRun: null,
        playerName: String(c.player ?? playerName).trim(),
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
        const entryWithImage = c.image
          ? { ...entry, referenceImage: { url: String(c.image), verifiedAt: new Date().toISOString() } }
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
      try { await processPlayer(p); }
      catch { flipReasons.set("worker-error", (flipReasons.get("worker-error") ?? 0) + 1); }
    }
  };
  for (let i = 0; i < CONCURRENCY; i++) workers.push(runWorker());
  await Promise.all(workers);

  console.log(`\n▸ Summary`);
  console.log(`  players searched:  ${searched}`);
  console.log(`  cards found (CH):  ${totalCardsFound}`);
  console.log(`  derivable:         ${totalDerivable}`);
  console.log(`  ${apply ? "upserted" : "would upsert"}: ${apply ? totalUpserted : totalDerivable}`);
  console.log(`  skipped:           ${totalSkipped}`);
  if (flipReasons.size > 0) {
    console.log(`\n▸ Skip reasons:`);
    for (const [k, v] of [...flipReasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(30)}  ${v}`);
    }
  }
  console.log(`\n${apply ? "✓ Wrote to card_catalog." : "Dry-run only. Pass --apply."}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
