#!/usr/bin/env -S npx tsx
/**
 * CF-BACKFILL-PORTFOLIO-SLUGS (Drew, 2026-08-05).
 *
 * Portfolio holdings added before the hobbyiqCardId slug started being
 * emitted on write are sitting with `hobbyiqCardId: null` or missing.
 * Every downstream lookup (grade curve, price refresh, catalog match)
 * silently misses these holdings.
 *
 * Script:
 *   1. Reads every portfolio doc
 *   2. Iterates the holdings map
 *   3. For each holding with a null/missing hobbyiqCardId, computes it
 *      from (year, product/setName, cardNumber, parallel, isAuto,
 *      printRun) using the same helper the ingest path uses
 *   4. Writes back to the holding via bulk patch (idempotent)
 *
 * Env:
 *   COSMOS_CONNECTION_STRING   required
 *   BACKFILL_APPLY             true|false (default false = dry-run)
 *   USER_ID                    only touch this user's portfolio (default: all)
 */

import { CosmosClient } from "@azure/cosmos";
import { computeHobbyIqCardId, normalizeSetKey } from "../src/services/portfolioiq/hobbyIqCardId.service.js";

const APPLY = process.env.BACKFILL_APPLY === "true";
const USER_ID = process.env.USER_ID || null;

const conn = process.env.COSMOS_CONNECTION_STRING;
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
const client = new CosmosClient(conn);
const p = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("portfolio");

interface Holding {
  id: string;
  cardYear?: number | null;
  product?: string | null;
  setName?: string | null;
  cardNumber?: string | null;
  parallel?: string | null;
  isAuto?: boolean | null;
  printRun?: number | null;
  hobbyiqCardId?: string | null;
  playerName?: string | null;
}

function slugFor(h: Holding): string | null {
  const year = h.cardYear;
  const set = h.product ?? h.setName ?? "";
  if (!year || !set || !h.cardNumber) return null;
  const setKey = normalizeSetKey(String(set));
  return computeHobbyIqCardId({
    sport: "baseball", // TODO: read from holding when multi-sport lands
    year: Number(year),
    setKey,
    cardNumber: String(h.cardNumber).trim(),
    parallel: h.parallel ?? "Base",
    isAuto: h.isAuto === true,
    printRun: h.printRun ?? null,
  });
}

async function main(): Promise<void> {
  const query = USER_ID
    ? "SELECT c.id, c.userId, c.holdings FROM c WHERE c.userId = @uid"
    : "SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)";
  const params = USER_ID ? [{ name: "@uid", value: USER_ID }] : [];

  const it = p.items.query<{ id: string; userId: string; holdings: Record<string, Holding> }>({ query, parameters: params }, { maxItemCount: 50 });
  let usersScanned = 0;
  let holdingsScanned = 0;
  let holdingsNeedingSlug = 0;
  let holdingsFixable = 0;
  let holdingsWritten = 0;
  let usersPatched = 0;

  while (it.hasMoreResults()) {
    const { resources } = await it.fetchNext();
    for (const doc of resources) {
      usersScanned++;
      const holdings = doc.holdings || {};
      const patches: Array<{ op: "set"; path: string; value: string }> = [];
      for (const [key, h] of Object.entries(holdings)) {
        holdingsScanned++;
        const slug = slugFor(h);
        if (!slug) continue;
        // Also replace stale slugs that were year-prefixed under the old
        // normalizer ("hiq:baseball:1997:1997-skybox-metal-universe:...").
        // The new pattern for the same setName produces a clean slug,
        // so if they don't match, refresh.
        if (h.hobbyiqCardId && h.hobbyiqCardId === slug) continue;
        holdingsNeedingSlug++;
        holdingsFixable++;
        patches.push({ op: "set", path: `/holdings/${key}/hobbyiqCardId`, value: slug });
        if (usersPatched < 5) {
          console.log(`  ${doc.userId?.slice(0, 24)}...  ${h.cardYear} ${h.product ?? h.setName} #${h.cardNumber} ${h.parallel ?? "Base"} ${h.playerName ?? ""} → ${slug}`);
        }
      }
      if (patches.length === 0) continue;
      if (!APPLY) continue;
      // Cosmos patch supports up to 10 ops per call.
      for (let i = 0; i < patches.length; i += 10) {
        const chunk = patches.slice(i, i + 10);
        try {
          await p.item(doc.id, doc.userId).patch({ operations: chunk } as never);
          holdingsWritten += chunk.length;
        } catch (e) {
          console.error(`  ! patch failed for ${doc.userId}: ${(e as Error).message}`);
        }
      }
      usersPatched++;
    }
  }

  console.log(`\n▸ Summary`);
  console.log(`  users scanned:         ${usersScanned}`);
  console.log(`  holdings scanned:      ${holdingsScanned}`);
  console.log(`  holdings needing slug: ${holdingsNeedingSlug}`);
  console.log(`  holdings fixable:      ${holdingsFixable}`);
  if (APPLY) {
    console.log(`  users patched:         ${usersPatched}`);
    console.log(`  holdings written:      ${holdingsWritten}`);
  } else {
    console.log(`  (dry run — set BACKFILL_APPLY=true to write)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
