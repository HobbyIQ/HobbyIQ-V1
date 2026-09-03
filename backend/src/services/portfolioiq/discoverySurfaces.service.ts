// CF-DISCOVERY-SURFACES (Drew, 2026-07-25). Three read-only endpoints
// that let iOS render "explore" surfaces beyond typed search:
//
//   1. computeTrending()          — hot cards by 30d-vs-prior-60d momentum
//   2. computeRelatedCards(slug)  — same-player-different-parallels +
//                                   same-year-sibling-cards for the given slug
//   3. computeTrendingPlayers()   — player-level momentum aggregate
//
// All three read from sold_comps + card_catalog only (no vendor calls).
// Cached in memory 10 min because "trending" doesn't move minute-to-minute.

import { CosmosClient, type Container } from "@azure/cosmos";
import { parseHobbyIqCardId } from "./hobbyIqCardId.service.js";

// POOL-1 residue (audit, 2026-09-03). The discovery surfaces are a SIGNAL
// class -- trending, breakout, movers -- computed straight off sold_comps
// prices. An adjudicated-wrong row is exactly the kind of row that makes a
// card look like it moved, so leaving these unfiltered surfaced the pool's
// known-bad rows as discoveries. Same store-form predicate as
// exactPoolReader:84-85.
const ADJUDICATION_FILTER =
  "(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)"
  + " AND (NOT IS_DEFINED(c.excludedFromFmv) OR c.excludedFromFmv != true)";

export interface TrendingCard {
  hobbyiqCardId: string;
  player: string | null;
  cardYear: number | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean;
  imageUrl: string | null;
  recentMedian: number;
  priorMedian: number;
  momentum: number;              // recent / prior ratio
  momentumPct: number;           // (recent-prior)/prior * 100
  recentCompCount: number;
  priorCompCount: number;
  latestSoldAt: string;
}

export interface RelatedCardsResult {
  slug: string;
  samePlayerOtherParallels: TrendingCard[];
  samePlayerOtherYears: TrendingCard[];
  sameYearSiblingCards: TrendingCard[];
  computedAt: string;
}

export interface TrendingPlayer {
  player: string;
  sport: string;
  recentCompCount: number;
  priorCompCount: number;
  recentMedian: number;
  priorMedian: number;
  momentum: number;
  momentumPct: number;
  totalRecentDollars: number;
}

let cachedSold: Container | null = null;
async function getSoldCompsContainer(): Promise<Container | null> {
  if (cachedSold) return cachedSold;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    cachedSold = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("sold_comps");
    return cachedSold;
  } catch { return null; }
}

const memoCache = new Map<string, { at: number; value: unknown }>();
const MEMO_TTL_MS = 10 * 60 * 1000;

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
}

function memoize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const c = memoCache.get(key);
  if (c && Date.now() - c.at < MEMO_TTL_MS) return Promise.resolve(c.value as T);
  return fn().then((v) => {
    memoCache.set(key, { at: Date.now(), value: v });
    return v;
  });
}

/** Top-N hot cards by 30-day vs prior-60-day momentum. Same rules as the
 *  ad-hoc script we ran earlier: >= 8 recent sales, >= 3 prior, recent
 *  median >= $50, momentum > 1.20. */
export async function computeTrending(opts: {
  sport?: string;
  limit?: number;
  minRecentMedian?: number;
  minMomentum?: number;
}): Promise<{ sport: string; hits: TrendingCard[]; totalCandidates: number; computedAt: string }> {
  const sport = String(opts.sport ?? "baseball").toLowerCase();
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
  const minRecentMedian = opts.minRecentMedian ?? 50;
  const minMomentum = opts.minMomentum ?? 1.20;
  const cacheK = `trending::${sport}::${limit}::${minRecentMedian}::${minMomentum}`;
  return memoize(cacheK, async () => {
    const container = await getSoldCompsContainer();
    const empty = { sport, hits: [], totalCandidates: 0, computedAt: new Date().toISOString() };
    if (!container) return empty;
    const now = Date.now();
    const cutoff30 = new Date(now - 30 * 86_400_000).toISOString();
    const cutoff90 = new Date(now - 90 * 86_400_000).toISOString();
    const query = `SELECT c.hobbyiqCardId, c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.printRun, c.price, c.soldAt, c.imageUrl, c.gradeCompany, c.gradeValue
                   FROM c WHERE c.sport = @sp AND c.soldAt >= @from AND c.price >= 20 AND ${ADJUDICATION_FILTER}`;
    const params = [{ name: "@sp", value: sport }, { name: "@from", value: cutoff90 }];
    let rows: Array<Record<string, unknown>> = [];
    try {
      const it = container.items.query({ query, parameters: params }, { maxItemCount: 5000 });
      while (it.hasMoreResults()) {
        const page = await it.fetchNext();
        if (Array.isArray(page?.resources)) rows.push(...page.resources);
      }
    } catch { rows = []; }
    if (rows.length === 0) return empty;

    const groups = new Map<string, { sample: Record<string, unknown>; sales: Array<{ price: number; soldAt: string; imageUrl?: string | null }> }>();
    for (const r of rows) {
      const slug = String(r.hobbyiqCardId ?? "");
      if (!slug) continue;
      if (!groups.has(slug)) groups.set(slug, { sample: r, sales: [] });
      groups.get(slug)!.sales.push({
        price: Number(r.price),
        soldAt: String(r.soldAt),
        imageUrl: (r.imageUrl as string | undefined) ?? null,
      });
    }

    const hits: TrendingCard[] = [];
    for (const [slug, g] of groups.entries()) {
      const recent = g.sales.filter((s) => s.soldAt >= cutoff30);
      const prior = g.sales.filter((s) => s.soldAt < cutoff30);
      if (recent.length < 8 || prior.length < 3) continue;
      const recentMedian = median(recent.map((s) => s.price));
      const priorMedian = median(prior.map((s) => s.price));
      if (recentMedian < minRecentMedian || priorMedian <= 0) continue;
      const momentum = recentMedian / priorMedian;
      if (momentum < minMomentum) continue;
      const parsed = parseHobbyIqCardId(slug);
      const imageUrl = recent.find((s) => s.imageUrl)?.imageUrl ?? prior.find((s) => s.imageUrl)?.imageUrl ?? null;
      const latestSoldAt = recent.slice().sort((a, b) => b.soldAt.localeCompare(a.soldAt))[0]?.soldAt;
      hits.push({
        hobbyiqCardId: slug,
        player: (g.sample.playerName as string) ?? null,
        cardYear: (g.sample.cardYear as number) ?? parsed?.year ?? null,
        setName: (g.sample.setName as string) ?? null,
        cardNumber: (g.sample.cardNumber as string) ?? parsed?.cardNumber ?? null,
        parallel: (g.sample.parallel as string) ?? null,
        isAuto: !!g.sample.isAuto || parsed?.isAuto || false,
        imageUrl,
        recentMedian, priorMedian, momentum, momentumPct: (momentum - 1) * 100,
        recentCompCount: recent.length, priorCompCount: prior.length,
        latestSoldAt: latestSoldAt || "",
      });
    }
    hits.sort((a, b) => (b.momentum * Math.log(b.recentCompCount)) - (a.momentum * Math.log(a.recentCompCount)));
    return { sport, hits: hits.slice(0, limit), totalCandidates: hits.length, computedAt: new Date().toISOString() };
  });
}

/** Given a slug, find related cards: same player other parallels, same
 *  player other years, same year sibling cards (adjacent cardNumbers or
 *  same release+different players). */
export async function computeRelatedCards(slug: string, limit = 8): Promise<RelatedCardsResult> {
  const cacheK = `related::${slug}::${limit}`;
  return memoize(cacheK, async () => {
    const container = await getSoldCompsContainer();
    const empty: RelatedCardsResult = {
      slug,
      samePlayerOtherParallels: [],
      samePlayerOtherYears: [],
      sameYearSiblingCards: [],
      computedAt: new Date().toISOString(),
    };
    if (!container) return empty;
    const parsed = parseHobbyIqCardId(slug);
    if (!parsed) return empty;
    const cutoff90 = new Date(Date.now() - 90 * 86_400_000).toISOString();

    async function group(where: string, params: Array<{ name: string; value: string | number | boolean | null }>): Promise<TrendingCard[]> {
      try {
        const q = `SELECT TOP 200 c.hobbyiqCardId, c.playerName, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.price, c.soldAt, c.imageUrl
                   FROM c WHERE ${where} AND c.soldAt >= @from AND ${ADJUDICATION_FILTER} ORDER BY c.soldAt DESC`;
        const it = container!.items.query({ query: q, parameters: [...params, { name: "@from", value: cutoff90 }] }, { maxItemCount: 500 });
        const rows: Array<Record<string, unknown>> = [];
        while (it.hasMoreResults()) {
          const page = await it.fetchNext();
          if (Array.isArray(page?.resources)) rows.push(...page.resources);
        }
        const bySlug = new Map<string, Array<Record<string, unknown>>>();
        for (const r of rows) {
          const s = String(r.hobbyiqCardId ?? "");
          if (!s || s === slug) continue;
          if (!bySlug.has(s)) bySlug.set(s, []);
          bySlug.get(s)!.push(r);
        }
        const out: TrendingCard[] = [];
        for (const [s, rs] of bySlug.entries()) {
          const prices = rs.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0);
          if (prices.length === 0) continue;
          const sample = rs[0];
          const imageUrl = rs.find((r) => r.imageUrl)?.imageUrl as string ?? null;
          out.push({
            hobbyiqCardId: s,
            player: (sample.playerName as string) ?? null,
            cardYear: (sample.cardYear as number) ?? null,
            setName: (sample.setName as string) ?? null,
            cardNumber: (sample.cardNumber as string) ?? null,
            parallel: (sample.parallel as string) ?? null,
            isAuto: !!sample.isAuto,
            imageUrl,
            recentMedian: median(prices),
            priorMedian: median(prices), momentum: 1, momentumPct: 0,
            recentCompCount: prices.length, priorCompCount: 0,
            latestSoldAt: String(sample.soldAt ?? ""),
          });
        }
        return out.sort((a, b) => b.recentCompCount - a.recentCompCount).slice(0, limit);
      } catch { return []; }
    }

    const cardNum = String(parsed.cardNumber ?? "").toUpperCase();
    const [otherParallels, otherYears, siblingCards] = await Promise.all([
      group(
        "c.sport = @sp AND c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto",
        [{ name: "@sp", value: parsed.sport }, { name: "@y", value: parsed.year }, { name: "@cn", value: cardNum }, { name: "@auto", value: parsed.isAuto }],
      ),
      group(
        "c.sport = @sp AND UPPER(c.cardNumber) = @cn AND c.cardYear != @y",
        [{ name: "@sp", value: parsed.sport }, { name: "@cn", value: cardNum }, { name: "@y", value: parsed.year }],
      ),
      group(
        "c.sport = @sp AND c.cardYear = @y AND c.setName = @sn AND UPPER(c.cardNumber) != @cn",
        [{ name: "@sp", value: parsed.sport }, { name: "@y", value: parsed.year }, { name: "@sn", value: parsed.setKey }, { name: "@cn", value: cardNum }],
      ),
    ]);
    return {
      slug,
      samePlayerOtherParallels: otherParallels,
      samePlayerOtherYears: otherYears,
      sameYearSiblingCards: siblingCards,
      computedAt: new Date().toISOString(),
    };
  });
}

/** Player-level momentum: which players are seeing the most price growth
 *  right now, aggregated across all their cards. */
export async function computeTrendingPlayers(opts: {
  sport?: string;
  limit?: number;
  minRecentComps?: number;
}): Promise<{ sport: string; hits: TrendingPlayer[]; computedAt: string }> {
  const sport = String(opts.sport ?? "baseball").toLowerCase();
  const limit = Math.max(1, Math.min(50, opts.limit ?? 20));
  const minRecentComps = opts.minRecentComps ?? 15;
  const cacheK = `trending-players::${sport}::${limit}::${minRecentComps}`;
  return memoize(cacheK, async () => {
    const container = await getSoldCompsContainer();
    const empty = { sport, hits: [], computedAt: new Date().toISOString() };
    if (!container) return empty;
    const now = Date.now();
    const cutoff30 = new Date(now - 30 * 86_400_000).toISOString();
    const cutoff90 = new Date(now - 90 * 86_400_000).toISOString();
    const query = `SELECT c.playerName, c.price, c.soldAt FROM c WHERE c.sport = @sp AND c.soldAt >= @from AND IS_DEFINED(c.playerName) AND c.playerName != null AND c.playerName != '' AND c.price >= 20 AND ${ADJUDICATION_FILTER}`;
    const params = [{ name: "@sp", value: sport }, { name: "@from", value: cutoff90 }];
    const byPlayer = new Map<string, { recent: number[]; prior: number[] }>();
    try {
      const it = container.items.query({ query, parameters: params }, { maxItemCount: 5000 });
      while (it.hasMoreResults()) {
        const page = await it.fetchNext();
        if (!Array.isArray(page?.resources)) continue;
        for (const r of page.resources) {
          const pn = String(r.playerName || "").trim();
          if (!pn) continue;
          const key = pn;
          if (!byPlayer.has(key)) byPlayer.set(key, { recent: [], prior: [] });
          const p = Number(r.price);
          if (!Number.isFinite(p) || p <= 0) continue;
          const soldAt = String(r.soldAt);
          if (soldAt >= cutoff30) byPlayer.get(key)!.recent.push(p);
          else byPlayer.get(key)!.prior.push(p);
        }
      }
    } catch { return empty; }

    const hits: TrendingPlayer[] = [];
    for (const [player, { recent, prior }] of byPlayer.entries()) {
      if (recent.length < minRecentComps || prior.length < 5) continue;
      const recentMedian = median(recent);
      const priorMedian = median(prior);
      if (priorMedian <= 0) continue;
      const momentum = recentMedian / priorMedian;
      if (momentum < 1.1) continue;
      hits.push({
        player, sport,
        recentCompCount: recent.length, priorCompCount: prior.length,
        recentMedian, priorMedian, momentum, momentumPct: (momentum - 1) * 100,
        totalRecentDollars: recent.reduce((s, v) => s + v, 0),
      });
    }
    hits.sort((a, b) => b.momentum * Math.log(b.recentCompCount) - a.momentum * Math.log(a.recentCompCount));
    return { sport, hits: hits.slice(0, limit), computedAt: new Date().toISOString() };
  });
}
