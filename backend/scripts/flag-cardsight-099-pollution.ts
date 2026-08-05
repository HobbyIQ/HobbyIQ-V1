#!/usr/bin/env -S npx tsx
/**
 * CF-FLAG-CARDSIGHT-099 (Drew, 2026-08-05).
 *
 * Soft-exclude the 39,129 sold_comps rows where source=cardsight AND price=0.99.
 * These are polluted rows — Cardsight is feeding an opening-bid / sentinel
 * value ($0.99) as the sale price for cards that are clearly worth far more
 * (Skubal Bowman rookie, Anunoby Chrome Cosmic, Tatis Refractor, etc.).
 * Leaving them in the pool drags FMV medians down for exactly the popular
 * cards users search for.
 *
 * Sets on each row:
 *   flaggedWrong: true                          — honored by findNeighborComps,
 *                                                 canonicalFmv, marketMovers,
 *                                                 priceTimeSeries, etc.
 *   excludedFromFmv: true                       — Drew's requested named flag
 *   flaggedReason: "cardsight_price_099_pollution"
 *   excludedAt: <ISO now>
 *
 * Read-only unless FLAG_APPLY=true. Idempotent — skips rows already flagged.
 *
 * Env:
 *   FLAG_APPLY   true = write; default dry-run
 *   MAX_ROWS     optional cap for testing
 */

import { CosmosClient, type Container } from "@azure/cosmos";

const APPLY = process.env.FLAG_APPLY === "true";
const MAX_ROWS = process.env.MAX_ROWS ? Number(process.env.MAX_ROWS) : 0;

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

const soldComps: Container = new CosmosClient(conn)
  .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
  .container("sold_comps");

interface Row {
  id: string;
  cardId: string;
  source: string;
  price: number;
  flaggedWrong?: boolean;
  excludedFromFmv?: boolean;
}

async function main(): Promise<void> {
  const query = `SELECT c.id, c.cardId, c.source, c.price, c.flaggedWrong, c.excludedFromFmv
                 FROM c
                 WHERE c.source = "cardsight" AND c.price = 0.99`;
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — flagging cardsight rows at price=0.99`);
  const now = new Date().toISOString();

  const it = soldComps.items.query<Row>({ query }, { maxItemCount: 200 });
  let scanned = 0, alreadyFlagged = 0, patched = 0, errors = 0;
  const startedAt = Date.now();

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const r of resources) {
      scanned++;
      if (r.flaggedWrong === true && r.excludedFromFmv === true) { alreadyFlagged++; continue; }
      if (!APPLY) continue;
      try {
        await soldComps.item(r.id, r.cardId).patch({
          operations: [
            { op: "set", path: "/flaggedWrong", value: true },
            { op: "set", path: "/excludedFromFmv", value: true },
            { op: "set", path: "/flaggedReason", value: "cardsight_price_099_pollution" },
            { op: "set", path: "/excludedAt", value: now },
          ],
        } as never);
        patched++;
      } catch (e) {
        errors++;
        if (errors <= 3) console.error(`  ! patch failed id=${r.id}: ${(e as Error).message}`);
      }
      if (MAX_ROWS && scanned >= MAX_ROWS) break;
    }
    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  scanned=${scanned.toLocaleString()} alreadyFlagged=${alreadyFlagged.toLocaleString()} patched=${patched.toLocaleString()} err=${errors}  ${Math.round(scanned / elapsed)}/s\r`);
    if (MAX_ROWS && scanned >= MAX_ROWS) break;
  }

  console.log(`\n\n▸ Summary`);
  console.log(`  scanned:         ${scanned.toLocaleString()}`);
  console.log(`  already flagged: ${alreadyFlagged.toLocaleString()}`);
  console.log(`  patched:         ${patched.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  errors:          ${errors}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
