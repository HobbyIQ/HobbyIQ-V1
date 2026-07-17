// CF-LOCAL-COMP-FIRST (Drew, 2026-07-17). Reads ch_daily_sales as our
// primary comp source. Wired in front of CH per-query API in the price
// router — CH becomes fresh-side fallback, Cardsight tertiary.
//
// Two lookup modes:
//   1. cardId → single-partition read (fast, <30ms typical)
//   2. structured (year+set+variant+number+grade+grader) → cross-partition
//      but bounded by SKU cardinality (~30 rows typical for a hot SKU,
//      500+ for a common base card)
//
// Result includes recent sales, trend numbers, and observed grader +
// parallel premium curves. Trend + premiums are pure math — see
// localCompTrend.service and localCompPremiums.service.
//
// The router treats "empty result" as a signal to fall through to
// per-query CH — not as an error. This service never throws on empty.

import type { Container } from "@azure/cosmos";
import { CosmosClient } from "@azure/cosmos";
import { computeTrend } from "./localCompTrend.service.js";
import { computeGraderPremiums, computeParallelPremiums } from "./localCompPremiums.service.js";
import type {
  LocalCompLookupKey,
  LocalCompOptions,
  LocalCompResult,
  LocalCompSale,
} from "../../types/localComp.types.js";
import type { CHDailySaleRow } from "../../types/chDailySales.types.js";

const CONTAINER_ID = process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales";
const DB_NAME = process.env.COSMOS_DATABASE ?? "hobbyiq";
const DEFAULT_TREND_WINDOW_DAYS = 90;
const DEFAULT_RECENT_LIMIT = 20;

let sharedContainer: Container | null = null;

function getContainer(): Container {
  if (sharedContainer) return sharedContainer;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) throw new Error("COSMOS_CONNECTION_STRING not set — localCompStore cannot query");
  const client = new CosmosClient(cs);
  sharedContainer = client.database(DB_NAME).container(CONTAINER_ID);
  return sharedContainer;
}

/** Test seam — inject a mock container. */
export function _setContainerForTesting(c: Container | null): void {
  sharedContainer = c;
}

/** Primary entry point. Returns an empty-but-valid result when no
 *  matches are found so the router can cleanly fall through. */
export async function lookupLocalComps(
  key: LocalCompLookupKey,
  opts: LocalCompOptions = {},
): Promise<LocalCompResult> {
  const trendWindowDays = opts.trendWindowDays ?? DEFAULT_TREND_WINDOW_DAYS;
  const recentLimit = opts.recentSalesLimit ?? DEFAULT_RECENT_LIMIT;

  const t0 = Date.now();
  const container = getContainer();
  const { query, parameters, partition } = buildQuery(key);

  const iter = container.items.query(
    { query, parameters },
    partition === "cardId" && key.cardId
      ? { partitionKey: key.cardId, maxItemCount: 1000 }
      : { maxItemCount: 1000 },
  );

  const rows: CHDailySaleRow[] = [];
  let ruCharge = 0;
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    if (page.resources) rows.push(...(page.resources as CHDailySaleRow[]));
    ruCharge += Number(page.requestCharge ?? 0);
  }

  const sales = rows
    .map(toLocalCompSale)
    .sort((a, b) => (b.saleDate ?? "").localeCompare(a.saleDate ?? ""));

  const totalSales = sales.length;
  const windowMs = trendWindowDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;
  const windowSales = sales.filter((s) => {
    const t = Date.parse(s.saleDate);
    return Number.isFinite(t) && t >= cutoff;
  });

  const trend = totalSales > 0 ? computeTrend(sales, trendWindowDays) : null;

  const graderPremiums = opts.skipPremiums ? {} : computeGraderPremiums(sales);
  const parallelPremiums = opts.skipPremiums ? {} : computeParallelPremiums(sales);

  return {
    lookupKey: key,
    totalSales,
    windowSales: windowSales.length,
    recentSales: sales.slice(0, recentLimit),
    trend,
    graderPremiums,
    parallelPremiums,
    diagnostics: {
      ruCharge,
      queryMs: Date.now() - t0,
      partitionKey: partition,
    },
  };
}

/** Build the Cosmos SQL for a lookup key. Exposed for test coverage. */
export function buildQuery(key: LocalCompLookupKey): {
  query: string;
  parameters: { name: string; value: string | number }[];
  partition: "cardId" | "cross";
} {
  const clauses: string[] = [];
  const parameters: { name: string; value: string | number }[] = [];

  if (key.cardId) {
    clauses.push("c.card_id = @cardId");
    parameters.push({ name: "@cardId", value: key.cardId });
  }
  if (key.year !== undefined) {
    clauses.push("c.year = @year");
    parameters.push({ name: "@year", value: key.year });
  }
  if (key.cardSet) {
    clauses.push("c.card_set = @cardSet");
    parameters.push({ name: "@cardSet", value: key.cardSet });
  }
  if (key.variant && !key.allGrades) {
    clauses.push("c.variant = @variant");
    parameters.push({ name: "@variant", value: key.variant });
  }
  if (key.number) {
    clauses.push("c.number = @number");
    parameters.push({ name: "@number", value: key.number });
  }
  if (key.grade && !key.allGrades) {
    clauses.push("c.grade = @grade");
    parameters.push({ name: "@grade", value: key.grade });
  }
  if (key.grader && !key.allGrades) {
    clauses.push("c.grader = @grader");
    parameters.push({ name: "@grader", value: key.grader });
  }

  if (clauses.length === 0) {
    throw new Error("lookupLocalComps requires at least one key field");
  }

  return {
    query: `SELECT c.price_history_id, c.card_id, c.sale_date, c.price,
                   c.grade, c.grader, c.variant, c.sale_type,
                   c.image_url, c.listing_url, c.description
            FROM c WHERE ${clauses.join(" AND ")}`,
    parameters,
    partition: key.cardId ? "cardId" : "cross",
  };
}

function toLocalCompSale(row: CHDailySaleRow): LocalCompSale {
  return {
    priceHistoryId: row.price_history_id,
    cardId: row.card_id,
    saleDate: row.sale_date,
    price: Number(row.price) || 0,
    grade: row.grade,
    grader: row.grader,
    variant: row.variant,
    saleType: row.sale_type,
    imageUrl: row.image_url,
    listingUrl: row.listing_url,
    description: row.description,
  };
}
