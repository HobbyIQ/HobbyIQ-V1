// CF-SUB-RAW-DISCOVERY (Drew, 2026-07-17). Orchestration: pull SKU-
// level raw aggregates from ch_daily_sales, load the observed
// grader-multiplier table, feed into computeSubRawDiscovery.
//
// Query strategy: read raw-only rows from ch_daily_sales, aggregate
// in-memory by cardId, then filter + rank. Cross-partition scan is
// fine — bounded by the maxRawPrice gate (default $30 caps the scan
// scope) and by the fact this endpoint isn't polled per keystroke.

import { CosmosClient, type Container } from "@azure/cosmos";
import { computeSubRawDiscovery, type SkuRawAggregate, type FamilyMultipliersByKey } from "./subRawDiscoveryCompute.service.js";
import { slugFamily } from "./observedMultipliersCompute.service.js";
import type { StoredMultiplier } from "./observedMultipliersStore.service.js";
import type { SubRawCandidate, SubRawDiscoveryOptions } from "../../types/discovery.types.js";

let sharedCHContainer: Container | null = null;
let sharedMultipliersContainer: Container | null = null;

/** Test seam. */
export function _setContainersForTesting(
  ch: Container | null,
  mult: Container | null,
): void {
  sharedCHContainer = ch;
  sharedMultipliersContainer = mult;
}

async function getContainers(): Promise<{ ch: Container; mult: Container }> {
  if (sharedCHContainer && sharedMultipliersContainer) {
    return { ch: sharedCHContainer, mult: sharedMultipliersContainer };
  }
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) throw new Error("COSMOS_CONNECTION_STRING not set — subRawDiscovery cannot run");
  const client = new CosmosClient(cs);
  const { database } = await client.databases.createIfNotExists({
    id: process.env.COSMOS_DATABASE ?? "hobbyiq",
  });
  // ch_daily_sales is guaranteed to exist (CH loader populates it); use
  // proxy handle. observed_grader_multipliers is populated by the
  // nightly compute — if that hasn't run yet the container is absent
  // and any query 404s at collection-read. createIfNotExists is
  // idempotent and mirrors the pattern in observedMultipliersStore's
  // getContainer(); it lets read-side callers succeed on an empty
  // container (loadPsa10FamilyMap returns {} → compute treats it as
  // "no family blend available", which is the correct behavior).
  sharedCHContainer = database.container(process.env.COSMOS_CH_DAILY_SALES_CONTAINER ?? "ch_daily_sales");
  const { container: multContainer } = await database.containers.createIfNotExists({
    id: process.env.COSMOS_OBSERVED_MULTIPLIERS_CONTAINER ?? "observed_grader_multipliers",
    partitionKey: { paths: ["/familyKey"] },
  });
  sharedMultipliersContainer = multContainer;
  return { ch: sharedCHContainer, mult: sharedMultipliersContainer };
}

/** Aggregate raw sales by cardId within a windowed range. Groups in-
 *  memory; returns per-SKU median + count. Filters upstream by price
 *  cap so the pool stays small. */
async function readRawAggregates(
  ch: Container,
  windowDays: number,
  maxRawPrice: number,
): Promise<SkuRawAggregate[]> {
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const iter = ch.items.query<{
    card_id: string; player: string; year: number;
    card_set: string; card_set_type: string;
    variant: string; number: string;
    price: number; image_url: string | null;
  }>({
    // NOTE: Cosmos SQL treats double-quoted strings as IDENTIFIER
    // references, not string literals. Use single quotes for the
    // 'Raw' comparison — a double-quoted "Raw" was resolving as a
    // field-not-found and 500-ing at query time.
    //
    // CF-POKEMON-INGEST-DEFENSIVE (Drew, 2026-07-22). Explicit sports
    // whitelist so Pokemon Raw sales don't flow into the sub-raw
    // discovery signal — this signal feeds the DailyIQ hot-prospects
    // pipe (memory `sub_raw_telemetry_is_dailyiq_pipe`) and Pokemon
    // Raw pricing lacks the grade calibration needed to interpret
    // inversions correctly. Widen when Pokemon calibration lands.
    query: `SELECT c.card_id, c.player, c.year, c.card_set, c.card_set_type,
                   c.variant, c.number, c.price, c.image_url
            FROM c
            WHERE c.grader = 'Raw'
              AND c.sale_date >= @cutoff
              AND c.price > 0
              AND c.price <= @maxPrice
              AND c["group"] IN ('Baseball', 'Football', 'Basketball')`,
    parameters: [
      { name: "@cutoff", value: cutoff },
      { name: "@maxPrice", value: maxRawPrice },
    ],
  }, { maxItemCount: 5000 });

  // Group by cardId → prices[] + first-row metadata
  const groups = new Map<string, {
    player: string; year: number; cardSet: string; cardSetType: string;
    variant: string; number: string; prices: number[]; imageUrl: string | null;
  }>();
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    if (!page.resources) continue;
    for (const row of page.resources) {
      if (!row.card_id) continue;
      let g = groups.get(row.card_id);
      if (!g) {
        g = {
          player: row.player ?? "",
          year: row.year ?? 0,
          cardSet: row.card_set ?? "",
          cardSetType: row.card_set_type ?? "",
          variant: row.variant ?? "",
          number: row.number ?? "",
          prices: [],
          imageUrl: row.image_url ?? null,
        };
        groups.set(row.card_id, g);
      }
      g.prices.push(row.price);
    }
  }

  const aggregates: SkuRawAggregate[] = [];
  for (const [cardId, g] of groups.entries()) {
    if (g.prices.length < 3) continue;   // need ≥3 raw sales to trust the median
    const median = medianOf(g.prices);
    aggregates.push({
      cardId,
      player: g.player,
      year: g.year,
      cardSet: g.cardSet,
      cardSetType: g.cardSetType,
      variant: g.variant,
      number: g.number,
      medianRawPrice: median,
      rawComps: g.prices.length,
      imageUrl: g.imageUrl,
    });
  }
  return aggregates;
}

/** Load ALL PSA 10 family multipliers into an in-memory map keyed by familyKey. */
async function loadPsa10FamilyMap(mult: Container): Promise<FamilyMultipliersByKey> {
  const iter = mult.items.query<StoredMultiplier>({
    query: "SELECT * FROM c WHERE c.graderTier = 'PSA 10'",
  }, { maxItemCount: 1000 });
  const rows: StoredMultiplier[] = [];
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
    if (page.resources) rows.push(...page.resources);
  }
  const m = new Map<string, { multiplier: number; confidence: "high" | "medium" | "low"; nGraded: number }>();
  for (const r of rows) {
    m.set(r.familyKey, {
      multiplier: r.multiplier,
      confidence: r.confidence,
      nGraded: r.nGraded,
    });
  }
  return { get: (k: string) => m.get(k) };
}

function medianOf(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length / 2;
  return s.length % 2 === 1 ? s[Math.floor(mid)] : (s[mid - 1] + s[mid]) / 2;
}

export async function analyzeSubRawDiscovery(
  opts: SubRawDiscoveryOptions = {},
): Promise<SubRawCandidate[]> {
  const { ch, mult } = await getContainers();
  const maxRawPrice = opts.maxRawPrice ?? 30;
  const windowDays = 90;
  const [aggregates, familyMap] = await Promise.all([
    readRawAggregates(ch, windowDays, maxRawPrice * 2),  // 2× headroom, computeSubRawDiscovery re-filters
    loadPsa10FamilyMap(mult),
  ]);
  return computeSubRawDiscovery(aggregates, familyMap, slugFamily, opts);
}
