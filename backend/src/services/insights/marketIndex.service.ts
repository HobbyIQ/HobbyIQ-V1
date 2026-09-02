// CF-MARKET-INDEXES (Drew, 2026-09-02). Per-sport market indexes built
// on a FIXED LIQUID BASKET — the methodology Drew ruled on 2026-09-02.
//
// WHY A FIXED BASKET
// -----------------
// The pre-existing weeklyHobbyIndex (CF-WEEKLY-HOBBY-INDEX) reports
// `medianTransactionThisWeek` — a median over whatever happened to sell
// that week. That number moves when the *mix* of what sold changes even
// though no card changed value: if a vendor feed lapses (the current
// CardHedge subscription lapse) and cheap high-volume rows stop landing,
// the median jumps and the "index" prints a rally that never happened.
//
// A fixed basket removes mix from the equation. We pick the basket once,
// hold it for the quarter, and move the index ONLY when the basket's own
// member cards change value. Volume changes membership at the next
// rebalance, never today's print.
//
// THE FORMULA
// -----------
// For sport S on day D, over basket B (|B| ~= 100 cards):
//
//   1. Each member card c has a value v(c, D) — the trailing-window
//      trend value of c's OWN comp pool (see cardValueOnDay). A card
//      with no sale on D carries its last observed value forward; it
//      does NOT drop out (dropping it would be a mix change).
//   2. Each card's raw weight is its base-date value v(c, D0), fixed at
//      basket selection. Value-weighting (not equal-weighting) makes the
//      index track hobby dollars rather than treating a $4 common as the
//      equal of a $4,000 Ohtani rookie.
//   3. Weights are capped: w(c) = min(rawShare(c), MAX_CARD_WEIGHT) then
//      renormalized to sum to 1. The cap (6%) is what keeps a single
//      thin-pool card from driving the index — an illiquid card whose
//      pool prints one outlier sale can move its own value a lot, but it
//      can never contribute more than 6% of the index level.
//   4. Index level on D = 100 * SUM_c w(c) * ( v(c, D) / v(c, D0) ).
//
//      i.e. a weighted average of each member's PRICE RELATIVE to its
//      own base-date value, rebased to 100 at D0. Because every term is
//      a ratio of a card to ITSELF, a card entering or leaving the day's
//      sales cannot move the level — only a change in v(c, D) can.
//
// MIX-SHIFT IMMUNITY (the pinned property)
// ----------------------------------------
// Doubling the sale COUNT of any subset of cards, with every card's
// value unchanged, leaves every v(c, D) unchanged and therefore leaves
// the level unchanged. Pinned in tests/marketIndexMixShift.test.ts.
//
// REBALANCE RULE
// --------------
// Basket membership is recomputed quarterly (Jan 1 / Apr 1 / Jul 1 /
// Oct 1 — see rebalanceEpochFor). Between rebalances membership is
// frozen. Eligibility at a rebalance is a rolling 90d trailing window:
// the top MARKET_INDEX_BASKET_SIZE cards by distinct sale count, subject
// to MIN_SALES_FOR_ELIGIBILITY. Selection is deterministic: the ranking
// sorts by (salesCount desc, cardId asc) so ties break on a stable key
// and the same inputs always produce the same basket.
//
// STORAGE
// -------
// No new Cosmos container (container creation is a HALT-for-Drew config
// change). Index docs live in the EXISTING daily_price_series container,
// which is partitioned on /cardId, using a reserved synthetic cardId
// namespace: `index::<sport>`. Real card rows use real cardIds, so the
// namespaces cannot collide, and every index doc carries
// docType: "market_index_point" | "market_index_basket" to make the
// reserved rows trivially filterable. Point docs are keyed by
// (sport, date) so re-running a day upserts in place rather than
// appending a second point — series-append idempotence.
//
// Values come from OUR pool (sold_comps) only. No vendor index, no
// synthetic prices.

import { CosmosClient, type Container } from "@azure/cosmos";

/** Sports that get an index tile. */
export const INDEX_SPORTS = ["baseball", "basketball", "football", "hockey", "pokemon"] as const;
export type IndexSport = (typeof INDEX_SPORTS)[number];

/** Target basket size per sport. */
export const MARKET_INDEX_BASKET_SIZE = 100;

/** No single card may contribute more than this share of the index. */
export const MAX_CARD_WEIGHT = 0.06;

/** A card needs at least this many sales in the eligibility window. */
export const MIN_SALES_FOR_ELIGIBILITY = 8;

/** Eligibility lookback at rebalance time. */
export const ELIGIBILITY_WINDOW_DAYS = 90;

/** Trailing window used to value a basket member on a given day. */
export const VALUE_WINDOW_DAYS = 14;

/** Series length the UI renders. */
export const SERIES_DAYS = 180;

/** Index level at the basket's base date. */
export const BASE_LEVEL = 100;

/** Reserved synthetic partition key for a sport's index docs. */
export function indexPartitionKey(sport: string): string {
  return `index::${sport}`;
}

export interface BasketMember {
  cardId: string;
  /** Value at the basket base date — the weighting basis. */
  baseValue: number;
  /** Post-cap, renormalized weight. Sums to 1 across the basket. */
  weight: number;
  /** Sales in the eligibility window at selection time. */
  eligibilitySales: number;
}

export interface IndexBasketDoc {
  id: string;
  cardId: string;                  // partition key: index::<sport>
  docType: "market_index_basket";
  sport: string;
  /** Rebalance epoch this basket is in force for, e.g. "2026-Q3". */
  epoch: string;
  baseDate: string;                // YYYY-MM-DD
  members: BasketMember[];
  computedAt: string;
}

export interface IndexPointDoc {
  id: string;
  cardId: string;                  // partition key: index::<sport>
  docType: "market_index_point";
  sport: string;
  date: string;                    // YYYY-MM-DD
  level: number;
  epoch: string;
  /** Members that had a fresh (non-carried) value on this date. */
  freshMembers: number;
  basketSize: number;
  computedAt: string;
}

interface CompRow {
  cardId: string;
  price: number;
  soldAt: string;
}

let sharedSoldComps: Container | null = null;
export async function getSoldCompsContainer(): Promise<Container | null> {
  if (sharedSoldComps) return sharedSoldComps;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  try {
    const client = new CosmosClient(cs);
    sharedSoldComps = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return sharedSoldComps;
  } catch { return null; }
}

let sharedSeries: Container | null = null;
/** The EXISTING daily_price_series container. Uses .container() — a
 *  local handle with no round trip and no provisioning. We deliberately
 *  do NOT go through vendorPersistenceCommon.getContainer, which would
 *  create the container on demand: provisioning a container is a
 *  HALT-for-Drew config change, never a job side effect. */
export async function getSeriesContainer(): Promise<Container | null> {
  if (sharedSeries) return sharedSeries;
  const cs = process.env.COSMOS_CONNECTION_STRING;
  if (!cs) return null;
  try {
    const client = new CosmosClient(cs);
    sharedSeries = client
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container("daily_price_series");
    return sharedSeries;
  } catch { return null; }
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDay(d);
}

/** Quarterly rebalance epoch for a date, e.g. "2026-Q3". Membership is
 *  frozen within an epoch; a new epoch triggers reselection. */
export function rebalanceEpochFor(day: string): string {
  const year = day.slice(0, 4);
  const month = Number(day.slice(5, 7));
  const quarter = Math.floor((month - 1) / 3) + 1;
  return `${year}-Q${quarter}`;
}

/** First day of the epoch — the basket's base date. */
export function epochBaseDate(epoch: string): string {
  const [year, q] = epoch.split("-Q");
  const month = (Number(q) - 1) * 3 + 1;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/**
 * Deterministic basket selection. Ranks by (salesCount desc, cardId asc)
 * — the cardId tiebreak is what makes "same inputs -> same basket" true
 * regardless of the order Cosmos hands us rows.
 */
export function selectBasket(
  salesByCard: Map<string, { sales: number; values: number[] }>,
  basketSize = MARKET_INDEX_BASKET_SIZE,
): { cardId: string; sales: number; baseValue: number }[] {
  const eligible: { cardId: string; sales: number; baseValue: number }[] = [];
  for (const [cardId, agg] of salesByCard) {
    if (agg.sales < MIN_SALES_FOR_ELIGIBILITY) continue;
    const baseValue = trendValue(agg.values);
    if (!(baseValue > 0)) continue;
    eligible.push({ cardId, sales: agg.sales, baseValue });
  }
  eligible.sort((a, b) =>
    b.sales !== a.sales ? b.sales - a.sales : (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0),
  );
  return eligible.slice(0, basketSize);
}

/**
 * Cap-and-renormalize. Raw value shares are capped at MAX_CARD_WEIGHT
 * and the excess is redistributed across uncapped members, iterating
 * until no member exceeds the cap (redistribution can push a member
 * over it). This is what makes one thin-pool card unable to dominate.
 */
export function computeWeights(baseValues: number[], cap = MAX_CARD_WEIGHT): number[] {
  const n = baseValues.length;
  if (n === 0) return [];
  // A cap below 1/n is unsatisfiable; fall back to equal weights.
  if (cap <= 1 / n) return new Array(n).fill(1 / n);

  const total = baseValues.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return new Array(n).fill(1 / n);
  let weights = baseValues.map((v) => v / total);

  for (let iter = 0; iter < 100; iter++) {
    const overIdx: number[] = [];
    let overflow = 0;
    let freeMass = 0;
    weights.forEach((w, i) => {
      if (w > cap + 1e-12) { overIdx.push(i); overflow += w - cap; }
      else freeMass += w;
    });
    if (overIdx.length === 0) break;
    if (!(freeMass > 0)) return new Array(n).fill(1 / n);
    const scale = (freeMass + overflow) / freeMass;
    weights = weights.map((w, i) => (overIdx.includes(i) ? cap : w * scale));
  }
  const sum = weights.reduce((s, w) => s + w, 0);
  return weights.map((w) => w / sum);
}

/**
 * A card's value from its own pool of recent prices. Per Drew's golden
 * rule FMV is never a median or mean — this is the projected next sale:
 * a least-squares fit over the window's prices, evaluated one step past
 * the last observation, clamped into the observed range so a steep fit
 * on a short pool cannot project an absurd value.
 */
export function trendValue(pricesChronological: number[]): number {
  const p = pricesChronological.filter((v) => Number.isFinite(v) && v > 0);
  if (p.length === 0) return 0;
  if (p.length === 1) return p[0];
  if (p.length === 2) return p[1];

  const n = p.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += p[i]; sxx += i * i; sxy += i * p[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return p[n - 1];
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const projected = intercept + slope * n;

  const lo = Math.min(...p);
  const hi = Math.max(...p);
  return Math.min(hi, Math.max(lo, projected));
}

/**
 * Index level for one day. Every term is a card's value RELATIVE to its
 * own base value, so the level is immune to which cards happened to sell.
 */
export function indexLevel(
  members: { weight: number; baseValue: number }[],
  valuesToday: number[],
): number {
  let acc = 0;
  let usedWeight = 0;
  members.forEach((m, i) => {
    const v = valuesToday[i];
    if (!(v > 0) || !(m.baseValue > 0)) return;
    acc += m.weight * (v / m.baseValue);
    usedWeight += m.weight;
  });
  if (!(usedWeight > 0)) return 0;
  // Renormalize by the weight actually used so a member with no value
  // history at all doesn't drag the level toward zero.
  return (acc / usedWeight) * BASE_LEVEL;
}

/** Fetch every qualifying sale for a sport in [from, to). */
export async function fetchSales(
  container: Container,
  sport: string,
  from: string,
  to: string,
): Promise<CompRow[]> {
  const iter = container.items.query<CompRow>({
    query: `SELECT c.cardId, c.price, c.soldAt
            FROM c
            WHERE c.sport = @sport
              AND c.soldAt >= @from
              AND c.soldAt < @to
              AND c.price > 0
              AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
    parameters: [
      { name: "@sport", value: sport },
      { name: "@from", value: from },
      { name: "@to", value: to },
    ],
  });
  const rows: CompRow[] = [];
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    rows.push(...resources);
  }
  return rows;
}

/** Group sales into per-card chronological price lists. */
export function groupByCard(rows: CompRow[]): Map<string, { sales: number; values: number[] }> {
  const sorted = rows.slice().sort((a, b) => (a.soldAt < b.soldAt ? -1 : a.soldAt > b.soldAt ? 1 : 0));
  const out = new Map<string, { sales: number; values: number[] }>();
  for (const r of sorted) {
    if (!r.cardId) continue;
    let g = out.get(r.cardId);
    if (!g) { g = { sales: 0, values: [] }; out.set(r.cardId, g); }
    g.sales++;
    g.values.push(r.price);
  }
  return out;
}

/**
 * Value each basket member on `day` from sales in the trailing
 * VALUE_WINDOW_DAYS. A member with no sale in the window carries its
 * previous value forward (carryForward) — never drops out, because
 * dropping it would be exactly the mix change the basket exists to
 * eliminate.
 */
export function valueMembersOnDay(
  memberIds: string[],
  salesInWindow: Map<string, { sales: number; values: number[] }>,
  carryForward: Map<string, number>,
): { values: number[]; fresh: number } {
  let fresh = 0;
  const values = memberIds.map((cardId) => {
    const agg = salesInWindow.get(cardId);
    if (agg && agg.values.length > 0) {
      const v = trendValue(agg.values);
      if (v > 0) { carryForward.set(cardId, v); fresh++; return v; }
    }
    return carryForward.get(cardId) ?? 0;
  });
  return { values, fresh };
}
