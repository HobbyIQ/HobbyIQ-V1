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
// TRUST BOUNDARY: comps returned here have no canonical VENDOR cardId
// but DO have a synthetic `backstop:{player|year|number|parallel}`
// aggregation key (CF-BACKSTOP-SYNTHETIC-CARDID, PR #493). That key is
// stable across queries for the same physical card, so sold_comps ingest
// + user-pool merge now include backstop rows in the corpus. Downstream
// consumers filter by the `backstop:` prefix or by per-comp
// `source: "cs_pricing_backstop"` (PR #492) when they need to distinguish
// backstop transactions from catalog-anchored comps. variantWarning=
// ["cs_pricing_backstop"] stays on the response so top-level filters can
// downweight confidence for the whole result.
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

  // CF-CS-BACKSTOP-ALL-TYPES (Drew, 2026-07-15): request BOTH auction +
  // fixed listings and return every record. Rationale from Drew:
  // "ensure we are grabbing ALL types of purchases — that is important
  // data." Live evidence: Travis Sykora Blue Refractor Auto (a card
  // Drew confirmed CS catalogs) returned 0 records at
  // listing_type=auction but sellers list it Buy-It-Now only.
  //
  // Downstream engine already discounts fixed vs auction via
  // getSaleTypeWeightMultiplier (fixed gets a lower FMV weight), and
  // iOS's recentComps display benefits from seeing ALL sales including
  // BIN listings for context. The narrow auction-only filter that
  // shipped in PR #458 discarded valid signal.
  // CF-PERSIST-VENDOR-LOOKUPS (Drew, 2026-07-23, issue #722 phase 3):
  // pass persistIdentity so the CS records ship to sold_comps in the
  // background. Gated by PERSIST_VENDOR_LOOKUPS_ENABLED — no-op when off.
  const persistIdentity = queryContext?.playerName
    ? {
        playerName: queryContext.playerName,
        cardYear: queryContext.cardYear != null ? Number(queryContext.cardYear) || null : null,
        sport: null,     // persist service infers from title when null
      }
    : undefined;

  let records: CardsightPricingSearchRecord[];
  let effectivePeriod: string = period;
  try {
    records = await searchPricingByTitle(query, {
      period,
      listingType: "both",   // include auction + fixed
      limit: 100,             // wider headroom for both types
      persistIdentity,
    });
    // CF-CS-BACKSTOP-VINTAGE-FALLBACK (Drew, 2026-07-15): if the primary
    // period returned 0 records, try "all" for vintage / long-tail SKUs
    // (e.g. Bobby Witt Jr 2020 Bowman Chrome Auto — 5 years old, CS's
    // 1y window misses it). "all" pulls the entire indexed history.
    // Engine's own recency filter downweights ancient comps in FMV so
    // this is safe additive coverage.
    if (records.length === 0 && period !== "all") {
      const allRecords = await searchPricingByTitle(query, {
        period: "all",
        listingType: "both",
        limit: 100,
        persistIdentity,
      });
      if (allRecords.length > 0) {
        records = allRecords;
        effectivePeriod = "all";
        log("cs_backstop.period_widened", {
          query,
          originalPeriod: period,
          widenedTo: "all",
          rawCount: records.length,
        });
      }
    }
  } catch (err) {
    log("cs_backstop.error", {
      query,
      period,
      error: (err as Error)?.message ?? String(err),
    });
    return null;
  }

  if (records.length === 0) {
    log("cs_backstop.no_records", { query, period: effectivePeriod, latency_ms: Date.now() - start });
    return null;
  }

  // Filter: positive price + valid date. Both auction and fixed pass
  // through — engine downstream handles the weighting distinction.
  const usable = records
    .filter((r) => Number.isFinite(r.price) && r.price > 0 && !!r.date)
    .slice(0, MAX_BACKSTOP_COMPS);

  if (usable.length === 0) {
    log("cs_backstop.filtered_empty", {
      query,
      rawCount: records.length,
      period: effectivePeriod,
      latency_ms: Date.now() - start,
    });
    return null;
  }

  const auctionCount = usable.filter((r) => r.listing_type === "auction").length;
  const fixedCount = usable.filter((r) => r.listing_type === "fixed").length;

  const isRaw = grade.trim().toLowerCase() === "raw" || grade.trim() === "";
  const sales: RoutedSale[] = usable.map((r) => ({
    price: r.price,
    date: r.date,
    grade: isRaw ? "Raw" : grade,
    // CF-CARDSIGHT-PROVENANCE-DISTINCT (audit PR #492, 2026-07-15):
    // stamp "cs_pricing_backstop" per-comp so iOS provenance chips can
    // render "N marketplace backstop comps" separate from "N Cardsight
    // catalog comps". Matches the source enum documented at
    // compiqEstimate.service.ts:293. Fallback + structured branches keep
    // "cardsight" (catalog-anchored, higher provenance tier).
    source: "cs_pricing_backstop",
    sale_type: r.listing_type,
    title: r.title,
    url: r.url,
    // Preserve CS-native fields so the routed-search RawComp mapper picks
    // them up via its defensive `{listing_type?, image_url?}` cast.
    listing_type: r.listing_type,
    image_url: r.image_url,
  }) as RoutedSale);

  // CF-BACKSTOP-SYNTHETIC-CARDID (PR #493, 2026-07-15): backstop
  // previously returned `card_id: ""` which suppressed sold_comps ingest
  // + user-pool merge. Now synthesize a deterministic id from the query
  // context so those valuable transaction rows enter the corpus. The
  // `backstop:` prefix keeps them distinguishable from real CH/CS
  // catalog IDs (which use bare uuids or `cardsight:{uuid}::{parallel}`
  // format). Downstream queries can filter by prefix or by the per-comp
  // `source: "cs_pricing_backstop"` label (PR #492).
  //
  // Uniqueness: (playerName + cardYear + cardNumber + parallel) is the
  // finest-grained identity we have on this path. Collisions can happen
  // when two queries land on the same physical card (which is what we
  // WANT — same synthetic id aggregates the transaction history).
  const synthKeyPartsArray = [
    queryContext?.playerName ?? "",
    queryContext?.cardYear != null ? String(queryContext.cardYear) : "",
    queryContext?.cardNumber ?? "",
    queryContext?.parallel ?? "",
  ].map((s) => s.trim().toLowerCase());
  // Only emit the synthetic id when at least ONE identity part is
  // populated. Degenerate `backstop:|||` (all empty) collapses to ""
  // so downstream ingest guards still skip — matches pre-fix behavior
  // for the "no identity at all" edge case.
  const synthKeyParts = synthKeyPartsArray.some((s) => s.length > 0)
    ? synthKeyPartsArray.join("|")
    : "";
  const syntheticCardId = synthKeyParts.length > 0
    ? `backstop:${synthKeyParts}`
    : "";
  const card: RoutedCard = {
    card_id: syntheticCardId,
    player: queryContext?.playerName,
    year: queryContext?.cardYear,
    variant: queryContext?.parallel,
    number: queryContext?.cardNumber,
    title: query,
  };

  log("cs_backstop.served", {
    query,
    period: effectivePeriod,
    salesCount: sales.length,
    auctionCount,
    fixedCount,
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
