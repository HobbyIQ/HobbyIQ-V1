// CF-PERSIST-VENDOR-LOOKUPS (Drew, 2026-07-23, issue #722). Every
// external vendor query grows sold_comps. Wraps a batch of vendor
// pricing results, parses each title via parseTitleIdentity, computes
// hobbyiqCardId, and upserts into sold_comps with contentHash dedup.
//
// Fire-and-forget by design — this service NEVER fails the caller.
// A persistence error becomes a warning log. The vendor's response
// still returns to whoever called it.
//
// Feature-flagged: PERSIST_VENDOR_LOOKUPS_ENABLED (default OFF at
// launch — flip after verification). When OFF, this is a no-op.
//
// This is the runtime instance of Drew's "we set the market" moat:
// user traffic itself grows the data pool without any explicit ingest
// scripts.

import { createHash } from "crypto";
import { CosmosClient, type Container } from "@azure/cosmos";
import {
  parseListingIdentity,
  inferSetKeyFromTitle,
  inferSportFromTitle,
} from "./parseTitleIdentity.service.js";
import { computeHobbyIqCardId } from "./hobbyIqCardId.service.js";

export interface VendorSaleRow {
  title: string | null;
  price: number | null | undefined;
  soldAt: string | null | undefined;       // ISO date
  url?: string | null;
  externalId?: string | null;              // vendor's ID if available; falls back to hash of url/title/price
}

export interface VendorPersistIdentityHint {
  playerName?: string | null;
  cardYear?: number | null;
  sport?: string | null;
  cardNumberRe?: RegExp;
}

export interface VendorPersistResult {
  inserted: number;
  deduped: number;
  skipped: number;                          // rows that couldn't be parsed to identity
}

export function isPersistVendorLookupsEnabled(): boolean {
  return process.env.PERSIST_VENDOR_LOOKUPS_ENABLED === "true";
}

let cachedContainer: Container | null = null;
async function getSoldCompsContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    cachedContainer = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return cachedContainer;
  } catch {
    return null;
  }
}

/** Persist a batch of vendor pricing rows into sold_comps with
 *  hobbyiqCardId + contentHash dedup. Never throws — errors become
 *  warning logs and the function returns partial results. */
export async function persistVendorSalesToPool(
  source: "cardsight" | "cardhedge",
  rows: VendorSaleRow[],
  identity: VendorPersistIdentityHint = {},
): Promise<VendorPersistResult> {
  const result: VendorPersistResult = { inserted: 0, deduped: 0, skipped: 0 };
  if (!isPersistVendorLookupsEnabled()) return result;
  if (!Array.isArray(rows) || rows.length === 0) return result;
  const container = await getSoldCompsContainer();
  if (!container) return result;

  for (const row of rows) {
    const title = String(row.title ?? "").trim();
    const price = Number(row.price);
    const soldAt = String(row.soldAt ?? "").trim();
    if (!title || !Number.isFinite(price) || price <= 0 || !soldAt) {
      result.skipped++;
      continue;
    }
    const parsed = parseListingIdentity(title, identity.cardNumberRe);
    if (!parsed.cardNumber) { result.skipped++; continue; }
    const cardYear = identity.cardYear ?? guessCardYearFromTitle(title);
    if (!cardYear) { result.skipped++; continue; }
    const playerName = identity.playerName ?? guessPlayerFromTitle(title);
    if (!playerName) { result.skipped++; continue; }
    const setKey = inferSetKeyFromTitle(title);
    const sport = identity.sport ?? inferSportFromTitle(title);
    let slug: string;
    try {
      slug = computeHobbyIqCardId({
        sport,
        year: cardYear,
        setKey,
        cardNumber: parsed.cardNumber,
        parallel: parsed.parallel,
        isAuto: parsed.isAuto,
        printRun: parsed.printRun,
      });
    } catch {
      result.skipped++;
      continue;
    }
    const contentHash = createHash("sha256").update(
      `${slug}|${price.toFixed(2)}|${soldAt.slice(0, 10)}|${source}|${row.url ?? ""}`,
    ).digest("hex").slice(0, 32);
    try {
      const { resources: existing } = await container.items.query({
        query: "SELECT c.id FROM c WHERE c.hobbyiqCardId = @hiq AND c.contentHash = @ch",
        parameters: [{ name: "@hiq", value: slug }, { name: "@ch", value: contentHash }],
      }).fetchAll();
      if (existing.length > 0) { result.deduped++; continue; }
      const sourceExternalId = row.externalId
        ?? (row.url ? createHash("sha256").update(source + ":" + row.url).digest("hex").slice(0, 24)
                    : createHash("sha256").update(source + ":" + title + price + soldAt).digest("hex").slice(0, 24));
      const doc = {
        id: `${source}::${sourceExternalId}`,
        cardId: `hiq:${slug.slice(4)}`,     // canonical pseudo-cardId matching the slug
        hobbyiqCardId: slug,
        contentHash,
        playerName,
        cardYear,
        setName: setKey,
        cardNumber: parsed.cardNumber,
        parallel: parsed.parallel,
        isAuto: parsed.isAuto,
        printRun: parsed.printRun,
        price,
        soldAt: new Date(soldAt).toISOString(),
        source,
        sourceExternalId,
        title,
        url: row.url ?? null,
        observedAt: new Date().toISOString(),
        sport,
      };
      await container.items.upsert(doc);
      result.inserted++;
    } catch (err) {
      console.warn(JSON.stringify({
        event: "persist_vendor_sales_error",
        source: "persistVendorSalesToPool",
        vendorSource: source,
        slug,
        error: (err as Error)?.message ?? String(err),
      }));
      result.skipped++;
    }
  }
  if (result.inserted > 0 || result.deduped > 0) {
    console.log(JSON.stringify({
      event: "persist_vendor_sales",
      source: "persistVendorSalesToPool",
      vendorSource: source,
      inserted: result.inserted,
      deduped: result.deduped,
      skipped: result.skipped,
    }));
  }
  return result;
}

/** Fire-and-forget wrapper. Use this from vendor client wrappers so
 *  callers don't have to await persistence. Silences errors internally. */
export function persistVendorSalesInBackground(
  source: "cardsight" | "cardhedge",
  rows: VendorSaleRow[],
  identity: VendorPersistIdentityHint = {},
): void {
  persistVendorSalesToPool(source, rows, identity).catch((err) => {
    console.warn(JSON.stringify({
      event: "persist_vendor_sales_background_error",
      source: "persistVendorSalesInBackground",
      error: (err as Error)?.message ?? String(err),
    }));
  });
}

/** Best-effort year extraction from a title. Recognizes leading 4-digit
 *  year (2015-2027 range). Returns null when nothing plausible found. */
function guessCardYearFromTitle(title: string): number | null {
  const m = title.match(/\b(20\d{2})\b/);
  if (m) {
    const y = Number(m[1]);
    if (y >= 2000 && y <= 2030) return y;
  }
  return null;
}

/** Best-effort player-name guess: strip year, set words, common noise,
 *  return the first sequence that looks like a name. Returns null when
 *  no confident match. Callers should prefer passing playerName in the
 *  identity hint. */
function guessPlayerFromTitle(_title: string): string | null {
  // Defensive default — the ingest paths that use this will always pass
  // playerName via identity hint (they're driven by known player queries).
  // Free-form guessing is out of scope for this PR; return null so we
  // skip the row rather than write bad identity.
  return null;
}
