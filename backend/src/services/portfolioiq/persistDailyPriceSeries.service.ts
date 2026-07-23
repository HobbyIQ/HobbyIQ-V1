// CF-PERSIST-DAILY-PRICE-SERIES (Drew, 2026-07-23, issue #722 series).
// Every daily closing price CH returns → our daily_price_series
// container. Owns our own price-history graph independent of vendors.
//
// Flag: PERSIST_DAILY_PRICE_SERIES_ENABLED (default OFF).
// Container: daily_price_series (partition /cardId).

import {
  getContainer,
  contentHashOf,
  runInBackground,
  logPersistEvent,
  isDomainEnabled,
} from "./vendorPersistenceCommon.service.js";

export interface DailyPriceRow {
  closingDate: string;             // ISO date (YYYY-MM-DD)
  price: number;
}

export interface DailyPricePersistResult {
  inserted: number;
  deduped: number;
  skipped: number;
}

export function isPersistDailyPriceSeriesEnabled(): boolean {
  return isDomainEnabled("PERSIST_DAILY_PRICE_SERIES_ENABLED");
}

/** Persist a series of daily closing prices for one card.
 *  One doc per (cardId, grade, closingDate) — dedup by contentHash. */
export async function persistDailyPriceSeries(
  source: "cardhedge",
  cardId: string,
  grade: string,
  rows: DailyPriceRow[],
): Promise<DailyPricePersistResult> {
  const result: DailyPricePersistResult = { inserted: 0, deduped: 0, skipped: 0 };
  if (!isPersistDailyPriceSeriesEnabled()) return result;
  if (!cardId || !Array.isArray(rows) || rows.length === 0) return result;
  const container = await getContainer("daily_price_series");
  if (!container) return result;

  for (const r of rows) {
    const closingDate = String(r.closingDate ?? "").slice(0, 10);
    const price = Number(r.price);
    if (!closingDate || !Number.isFinite(price) || price <= 0) {
      result.skipped++;
      continue;
    }
    const contentHash = contentHashOf(source, cardId, grade, closingDate, price.toFixed(2));
    try {
      const { resources: existing } = await container.items.query({
        query: "SELECT c.id FROM c WHERE c.cardId = @c AND c.contentHash = @h",
        parameters: [{ name: "@c", value: cardId }, { name: "@h", value: contentHash }],
      }).fetchAll();
      if (existing.length > 0) { result.deduped++; continue; }
      const doc = {
        id: `${source}::${cardId}::${grade.toLowerCase()}::${closingDate}`,
        cardId,
        source,
        contentHash,
        grade,
        closingDate,
        price,
        observedAt: new Date().toISOString(),
      };
      await container.items.upsert(doc);
      result.inserted++;
    } catch {
      result.skipped++;
    }
  }
  logPersistEvent("daily_price_series", source, result);
  return result;
}

export function persistDailyPriceSeriesInBackground(
  source: "cardhedge",
  cardId: string,
  grade: string,
  rows: DailyPriceRow[],
): void {
  runInBackground(() => persistDailyPriceSeries(source, cardId, grade, rows).then(() => {}));
}
