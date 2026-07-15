// CF-CS-PRICING-BACKSTOP (Drew, 2026-07-15): the ULTIMATE backstop for
// pricing queries. Fires when BOTH CardHedge's identityCard bridge AND
// Cardsight's per-parallel catalog resolution have failed — the SKU is
// not in either vendor's canonical catalog.
//
// Strategy: search Cardsight's /v1/pricing/search endpoint with the raw
// query text. That endpoint fuzzy-searches SELLER TITLES on marketplace
// listings — including listings CS's own matcher couldn't bridge to a
// canonical card. For CH-catalog-gap SKUs (Blue Refractor Autos,
// Reptilian Refractor, /150 parallels) real transaction titles exist on
// eBay even when no vendor's card table has an entry.
//
// TRUST BOUNDARY: comps returned here have NO canonical cardId. Downstream
// code that needs an aggregation key (predictionCorpus, sold_comps ingest)
// must handle this defensively. We stamp variantWarning=["cs_pricing_backstop"]
// so downstream can distinguish "trusted vendor comps" from "raw title
// matches" and downweight confidence accordingly.
//
// LISTING TYPE: default listingType=auction on the client — completed
// auction sales only. Fixed/Buy-It-Now prices are ASKS not BIDS and would
// inflate the median.

import type { RoutedCard, RoutedResult, RoutedSale, QueryContext } from "./cardsight.router.js";
import {
  searchPricingByTitle,
  isCardsightConfigured,
  type CardsightPricingSearchRecord,
} from "./cardsightSlim.client.js";

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ event, source: "cardsightPricingBackstop", ...fields }));
};

/** Lookback period per grade. Original: 3m for raw / 1y for graded.
 *  Widened 2026-07-15 based on live evidence: raw Prospect Autos (Travis
 *  Sykora Blue Refractor Auto, Bobby Witt Jr 2020 Bowman Chrome Auto,
 *  Josiah Hartshorn True Blue Auto, Thomas White Auto) all landed on
 *  sibling-pool because 3m returned 0 records. These SKUs sell infrequently
 *  (weeks-to-months between sales) so 3m is too tight even for "raw"
 *  category. 1y catches the tail. If freshness matters downstream, the
 *  engine's own recency filter (applyRecencyFilter, default 21d) already
 *  trims stale comps out of FMV — the backstop just needs to find them
 *  in the first place. */
function periodForGrade(grade: string): "7d" | "14d" | "3m" | "1y" | "all" {
  return "1y";  // uniformly widened; recency filter handles staleness downstream
}

/** Cap on how many raw records survive the filter. Prevents a runaway pool
 *  where the query pulled in dozens of loosely-related titles. */
const MAX_BACKSTOP_COMPS = 25;

/**
 * Ultimate pricing backstop. Called ONLY when CH bridge + CS catalog
 * fallback both returned null. Returns a RoutedResult with source="cardsight"
 * sales and variantWarning=["cs_pricing_backstop"], or null on any failure.
 *
 * queryContext supplies the identity fields (playerName, cardYear, etc.)
 * to construct a synthetic RoutedCard so downstream UI can show the query
 * echo — but card.card_id is DELIBERATELY empty (no canonical bridge).
 */
export async function tryCardsightPricingBackstop(
  query: string,
  queryContext: QueryContext | undefined,
  grade: string,
): Promise<RoutedResult | null> {
  if (!isCardsightConfigured()) return null;
  if (!query || !query.trim()) return null;

  const start = Date.now();
  const period = periodForGrade(grade);

  let records: CardsightPricingSearchRecord[];
  try {
    records = await searchPricingByTitle(query, {
      period,
      listingType: "auction",  // completed sales only — never mix asks into FMV
      limit: 50,
    });
  } catch (err) {
    log("cs_backstop.error", {
      query,
      period,
      error: (err as Error)?.message ?? String(err),
    });
    return null;
  }

  if (records.length === 0) {
    log("cs_backstop.no_records", { query, period, latency_ms: Date.now() - start });
    return null;
  }

  // Filter: positive price + valid date + belt-and-suspenders auction-only.
  // The server should already filter by listing_type but defensive-check.
  const usable = records
    .filter((r) =>
      Number.isFinite(r.price) &&
      r.price > 0 &&
      !!r.date &&
      r.listing_type === "auction",
    )
    .slice(0, MAX_BACKSTOP_COMPS);

  if (usable.length === 0) {
    log("cs_backstop.filtered_empty", {
      query,
      rawCount: records.length,
      period,
      latency_ms: Date.now() - start,
    });
    return null;
  }

  const isRaw = grade.trim().toLowerCase() === "raw" || grade.trim() === "";
  const sales: RoutedSale[] = usable.map((r) => ({
    price: r.price,
    date: r.date,
    grade: isRaw ? "Raw" : grade,
    source: "cardsight",
    sale_type: r.listing_type,
    title: r.title,
    url: r.url,
    // Preserve CS-native fields so the routed-search RawComp mapper picks
    // them up via its defensive `{listing_type?, image_url?}` cast.
    listing_type: r.listing_type,
    image_url: r.image_url,
  }) as RoutedSale);

  // Synthetic identity from queryContext — NO card_id (deliberate).
  // Empty card_id tells downstream this is a bridge-less backstop, so
  // cardId-keyed aggregation and sold_comps ingest are skipped for these
  // rows (see augmentCompsWithUserPool / ingestVendorCompsToPool guards).
  const card: RoutedCard = {
    card_id: "",
    player: queryContext?.playerName,
    year: queryContext?.cardYear,
    variant: queryContext?.parallel,
    number: queryContext?.cardNumber,
    title: query,
  };

  log("cs_backstop.served", {
    query,
    period,
    salesCount: sales.length,
    rawCount: records.length,
    latency_ms: Date.now() - start,
  });

  return {
    card,
    sales,
    variantWarning: ["cs_pricing_backstop"],
    aiCategory: null,
  };
}
