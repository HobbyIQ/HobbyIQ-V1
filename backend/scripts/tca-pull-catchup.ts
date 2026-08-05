#!/usr/bin/env -S npx tsx
/**
 * CF-TCA-PULL-CATCHUP (Drew, 2026-08-05).
 *
 * One-shot catch-up for missed TCA webhook pushes. Uses TCA's
 * GET /api/v1/market/sales?limit=1000&cursor=<next_cursor> to pull
 * sales in date_desc order and persist any row soldAt > CUTOFF.
 *
 * Reads TCA_API_KEY from env. Reads sold_comps to find the latest
 * observedAt tca-ebay row as the cutoff. Persists via the same
 * persistVendorSalesToPool path the webhook uses.
 *
 * Per-page quota cost measured at 0 (2026-08-05 20:38 UTC) — pulls
 * are effectively free against the 200K/day meter.
 *
 * Env:
 *   PULL_APPLY       true = actually persist; default dry-run
 *   MAX_PAGES        default 20 (=20K rows max)
 *   TCA_API_KEY, COSMOS_CONNECTION_STRING
 */

import { CosmosClient } from "@azure/cosmos";
import { persistVendorSalesToPool } from "../src/services/portfolioiq/persistVendorSalesToPool.service.js";

const APPLY = process.env.PULL_APPLY === "true";
const MAX_PAGES = process.env.MAX_PAGES ? Number(process.env.MAX_PAGES) : 20;
const TCA_API_KEY = process.env.TCA_API_KEY;
const conn = process.env.COSMOS_CONNECTION_STRING;
if (!TCA_API_KEY) { console.error("TCA_API_KEY required"); process.exit(2); }
if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }

interface TcaSaleRow {
  id?: string; title?: string; price?: number; sold_at?: string; sale_date?: string;
  listing_url?: string; image_url?: string; player?: string; year?: number;
  sport?: string; card_set?: string; card_number?: string;
}

interface TcaPage { data: TcaSaleRow[]; pagination?: { next_cursor?: string | null } }

async function findCutoff(): Promise<string> {
  const sc = new CosmosClient(conn as string).database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");
  const { resources } = await sc.items.query<{ observedAt: string }>({
    query: "SELECT TOP 1 c.observedAt FROM c WHERE c.source = \"tca-ebay\" ORDER BY c.observedAt DESC",
  }).fetchAll();
  return resources[0]?.observedAt ?? new Date(Date.now() - 24 * 3600_000).toISOString();
}

async function main(): Promise<void> {
  const cutoff = await findCutoff();
  console.log(`▸ ${APPLY ? "APPLY" : "DRY-RUN"} — pulling TCA sales soldAt > ${cutoff}`);

  let cursor: string | null = null;
  let pageNum = 0, totalRows = 0, filtered = 0, persisted = 0, insertedTotal = 0, dedupedTotal = 0, skippedTotal = 0, errorTotal = 0;
  const startedAt = Date.now();

  while (pageNum < MAX_PAGES) {
    pageNum++;
    const url = cursor
      ? `https://thecardapi.com/api/v1/market/sales?limit=1000&cursor=${encodeURIComponent(cursor)}`
      : `https://thecardapi.com/api/v1/market/sales?limit=1000`;
    const res = await fetch(url, { headers: { "x-market-api-key": TCA_API_KEY as string }, redirect: "follow" });
    if (!res.ok) { console.error(`  ! HTTP ${res.status} on page ${pageNum}`); break; }
    const body = (await res.json()) as TcaPage;
    const rows = Array.isArray(body?.data) ? body.data : [];
    totalRows += rows.length;
    // Filter to rows AFTER the cutoff
    const fresh = rows.filter((r) => {
      const t = r.sold_at || (r.sale_date ? new Date(r.sale_date + "T12:00:00Z").toISOString() : null);
      return t && t > cutoff;
    });
    filtered += fresh.length;

    if (APPLY && fresh.length > 0) {
      // Persist via the existing webhook code path. Batch by 1 to keep
      // the identity hint targeted per-row.
      for (const t of fresh) {
        const vsRow = {
          title: t.title || null,
          price: typeof t.price === "number" ? t.price : Number(t.price ?? 0),
          soldAt: t.sold_at || (t.sale_date ? new Date(t.sale_date + "T12:00:00Z").toISOString() : null),
          url: t.listing_url || null,
          externalId: t.id || null,
          imageUrl: t.image_url || null,
        };
        if (!vsRow.soldAt || !(vsRow.price > 0)) { skippedTotal++; continue; }
        const hint: Record<string, unknown> = {};
        if (t.player) hint.playerName = String(t.player);
        if (typeof t.year === "number") hint.cardYear = t.year;
        if (t.sport) hint.sport = String(t.sport).toLowerCase();
        if (t.card_number) hint.cardNumber = String(t.card_number);
        if (t.card_set) hint.setName = String(t.card_set);
        try {
          const r = await persistVendorSalesToPool("tca-ebay", [vsRow], hint);
          insertedTotal += r.inserted;
          dedupedTotal += r.deduped;
          skippedTotal += r.skipped;
          persisted++;
        } catch (e) {
          errorTotal++;
          if (errorTotal <= 3) console.error(`  ! persist failed: ${(e as Error).message}`);
        }
      }
    }

    const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`  page ${pageNum}/${MAX_PAGES} · scanned=${totalRows} fresh=${filtered} inserted=${insertedTotal} deduped=${dedupedTotal} skipped=${skippedTotal} err=${errorTotal}  ${Math.round(totalRows / elapsed)} rows/s\r`);

    // If this page returned zero fresh rows, we're past the cutoff
    if (fresh.length === 0 && rows.length > 0) {
      console.log(`\n  cutoff reached (page ${pageNum} had ${rows.length} rows all older than cutoff)`);
      break;
    }
    cursor = body?.pagination?.next_cursor ?? null;
    if (!cursor) { console.log(`\n  no next_cursor — end of feed`); break; }
  }

  console.log(`\n\n▸ Summary`);
  console.log(`  pages fetched: ${pageNum}`);
  console.log(`  total scanned: ${totalRows.toLocaleString()}`);
  console.log(`  fresh (soldAt > cutoff): ${filtered.toLocaleString()}`);
  console.log(`  persisted attempts: ${persisted.toLocaleString()}${APPLY ? "" : " (dry-run)"}`);
  console.log(`  inserted: ${insertedTotal.toLocaleString()}`);
  console.log(`  deduped:  ${dedupedTotal.toLocaleString()}`);
  console.log(`  skipped:  ${skippedTotal.toLocaleString()}`);
  console.log(`  errors:   ${errorTotal}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
