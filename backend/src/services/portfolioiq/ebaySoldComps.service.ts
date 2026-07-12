// CF-EBAY-SOLD-COMPS-QUERY (2026-07-12).
//
// Cross-user query surface over the sold ledger. Every eBay sale we
// complete carries the listing's Browse aspects (year, set, parallel,
// grade, team, sport, player, cardNumber, isAuto). This service walks
// all users' portfolio docs, filters ledger entries by the caller's
// (year, set, parallel, grade, ...) query, and returns matches ranked
// by recency + aspect-match density.
//
// Foundation for market intelligence — "what does a 2020 Prizm Mookie
// Betts PSA 10 sell for" answered from our own realized-sale pool.
//
// Scale note: O(users × ledger entries) per call. At Drew-scale (1
// user, ~10 sales) this is trivially fast; at 100 users × 500 sales it
// is still <50K entries per query — fine for in-process scan. When we
// pass ~10K users, this becomes a Cosmos SQL query on the ledger sub-
// tree; the shape doesn't change.

import {
  listAllPortfolioUserIds,
  readUserDoc,
  type PortfolioLedgerEntry,
} from "./portfolioStore.service.js";

export interface SoldCompsQuery {
  /** Optional year — matches Season aspect or holding.cardYear. */
  year?: number;
  /** Optional set — matches Set aspect (case-insensitive substring). */
  set?: string;
  /** Optional parallel — matches Parallel/Variety aspect. */
  parallel?: string;
  /** Optional grade — matches Grade aspect + gradeCompany when supplied
   *  as e.g. "PSA 10" or "PSA10". */
  grade?: string;
  /** Optional player — matches Player aspect (case-insensitive substring). */
  playerName?: string;
  /** Match cardNumber. */
  cardNumber?: string;
  /** Match isAuto (yes/no on Autographed aspect). */
  isAuto?: boolean;
  /** Match cardId (exact). */
  cardId?: string;
  /** Limit results (default 50, max 200). */
  limit?: number;
}

export interface SoldComp {
  /** The user who sold it — anonymized in the response layer if needed. */
  userIdHint?: string;
  soldAt: string;
  unitSalePrice: number;
  playerName?: string;
  cardYear?: number;
  setName?: string;
  parallel?: string;
  gradeCompany?: string;
  gradeValue?: number;
  cardNumber?: string;
  isAuto?: boolean;
  /** Full aspect snapshot for downstream matching. */
  ebayItemAspects?: Record<string, string>;
  ebayImageUrl?: string | null;
  ebayShortDescription?: string | null;
  ebayCategoryPath?: string | null;
  /** Aspect-match density (0..1) — how many query fields the comp matched. */
  matchScore: number;
  /** Days between sale and now, for recency ranking. */
  daysSinceSold: number;
}

export interface SoldCompsResult {
  count: number;
  comps: SoldComp[];
  /** Query params echoed back — iOS uses to display "results for". */
  query: SoldCompsQuery;
  /** Aggregate stats over the matched set. */
  stats: {
    minPrice: number | null;
    maxPrice: number | null;
    medianPrice: number | null;
    meanPrice: number | null;
  };
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// ─── Query API ────────────────────────────────────────────────────────────

export async function querySoldComps(query: SoldCompsQuery): Promise<SoldCompsResult> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, query.limit ?? DEFAULT_LIMIT));

  const userIds = await listAllPortfolioUserIds();
  const raw: SoldComp[] = [];

  const nowMs = Date.now();
  for (const userId of userIds) {
    let doc;
    try {
      doc = await readUserDoc(userId);
    } catch {
      continue;
    }
    const ledger = Array.isArray(doc.ledger) ? doc.ledger : [];
    for (const entry of ledger) {
      if (!isEbaySoldMatch(entry, query)) continue;
      const soldAtMs = Date.parse(entry.soldAt);
      const daysSinceSold = Number.isFinite(soldAtMs)
        ? Math.max(0, Math.floor((nowMs - soldAtMs) / (1000 * 60 * 60 * 24)))
        : 0;
      raw.push({
        userIdHint: userId,
        soldAt: entry.soldAt,
        unitSalePrice: Number(entry.unitSalePrice) || 0,
        playerName: entry.playerName || undefined,
        cardYear:
          Number(entry.ebayItemAspects?.Season) ||
          Number((entry as any).cardYear) ||
          undefined,
        setName: entry.ebayItemAspects?.["Set"] ?? undefined,
        parallel: entry.ebayItemAspects?.["Parallel/Variety"] ?? undefined,
        gradeCompany: normalizeGraderFromAspect(entry.ebayItemAspects?.["Professional Grader"]),
        gradeValue: Number(entry.ebayItemAspects?.["Grade"]) || undefined,
        cardNumber: entry.ebayItemAspects?.["Card Number"] ?? undefined,
        isAuto: entry.ebayItemAspects?.["Autographed"] === "Yes",
        ebayItemAspects: entry.ebayItemAspects,
        ebayImageUrl: entry.ebayImageUrl ?? entry.ebaySoldImages?.[0] ?? null,
        ebayShortDescription: entry.ebayShortDescription ?? null,
        ebayCategoryPath: entry.ebayCategoryPath ?? null,
        matchScore: scoreMatch(entry, query),
        daysSinceSold,
      });
    }
  }

  // Ranking: matchScore desc, then recency (fewer days is better)
  raw.sort((a, b) => {
    if (a.matchScore !== b.matchScore) return b.matchScore - a.matchScore;
    return a.daysSinceSold - b.daysSinceSold;
  });

  const comps = raw.slice(0, limit);
  const prices = comps.map((c) => c.unitSalePrice).filter((p) => p > 0);
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted.length === 0
    ? null
    : sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const mean = prices.length === 0 ? null : prices.reduce((a, b) => a + b, 0) / prices.length;

  return {
    count: comps.length,
    comps,
    query,
    stats: {
      minPrice: prices.length ? prices[0] : null,
      maxPrice: prices.length ? Math.max(...prices) : null,
      medianPrice: median,
      meanPrice: mean,
    },
  };
}

// ─── Matching ─────────────────────────────────────────────────────────────

function isEbaySoldMatch(entry: PortfolioLedgerEntry, q: SoldCompsQuery): boolean {
  // Only ebay-source sales with completed sale semantics.
  if (entry.source !== "ebay") return false;
  if (entry.action && entry.action !== "sale") return false;
  if (!(Number(entry.unitSalePrice) > 0)) return false;

  const aspects = entry.ebayItemAspects ?? {};

  // exact matches short-circuit false when non-match
  if (q.cardId && (entry as any).cardId && (entry as any).cardId !== q.cardId) return false;

  if (typeof q.year === "number") {
    const yearFromAspect = Number(aspects.Season);
    const yearFromEntry = Number((entry as any).cardYear);
    const match = yearFromAspect === q.year || yearFromEntry === q.year;
    if (!match) return false;
  }
  if (q.cardNumber) {
    const cn = aspects["Card Number"] ?? "";
    if (!cn.toLowerCase().includes(q.cardNumber.toLowerCase())) return false;
  }
  if (q.set) {
    const s = aspects["Set"] ?? "";
    if (!s.toLowerCase().includes(q.set.toLowerCase())) return false;
  }
  if (q.parallel) {
    const p = aspects["Parallel/Variety"] ?? "";
    if (!p.toLowerCase().includes(q.parallel.toLowerCase())) return false;
  }
  if (q.grade) {
    if (!gradeMatchesQuery(aspects, q.grade)) return false;
  }
  if (q.playerName) {
    const pn = aspects["Player"] ?? entry.playerName ?? "";
    if (!pn.toLowerCase().includes(q.playerName.toLowerCase())) return false;
  }
  if (typeof q.isAuto === "boolean") {
    const auto = aspects["Autographed"] === "Yes";
    if (auto !== q.isAuto) return false;
  }
  return true;
}

function gradeMatchesQuery(aspects: Record<string, string>, gradeQuery: string): boolean {
  // Accept "PSA 10", "PSA10", "BGS 9.5", "10", "psa 10". Normalize both
  // sides to a canonical grader-code (PSA/BGS/SGC/CGC or empty) + numeric
  // grade so long-form grader names ("Professional Sports Authenticator
  // (PSA)") match short-form queries ("PSA 10").
  const canonGrader = normalizeGraderFromAspect(aspects["Professional Grader"]) ?? "";
  const rawGrade = (aspects["Grade"] ?? "").trim();
  const canonAspect = `${canonGrader}${rawGrade}`.toUpperCase().replace(/\s+/g, "");

  const q = gradeQuery.toUpperCase().replace(/\s+/g, "");
  if (!q) return false;
  return canonAspect.includes(q) || rawGrade.toUpperCase() === q;
}

function scoreMatch(entry: PortfolioLedgerEntry, q: SoldCompsQuery): number {
  const aspects = entry.ebayItemAspects ?? {};
  let filledCriteria = 0;
  let matched = 0;

  const check = (has: boolean, matchFn: () => boolean) => {
    if (!has) return;
    filledCriteria += 1;
    if (matchFn()) matched += 1;
  };

  check(typeof q.year === "number", () => Number(aspects.Season) === q.year);
  check(!!q.set, () => (aspects["Set"] ?? "").toLowerCase().includes((q.set ?? "").toLowerCase()));
  check(!!q.parallel, () => (aspects["Parallel/Variety"] ?? "").toLowerCase().includes((q.parallel ?? "").toLowerCase()));
  check(!!q.grade, () => gradeMatchesQuery(aspects, q.grade!));
  check(!!q.playerName, () => (aspects["Player"] ?? entry.playerName ?? "").toLowerCase().includes((q.playerName ?? "").toLowerCase()));
  check(!!q.cardNumber, () => (aspects["Card Number"] ?? "").toLowerCase().includes((q.cardNumber ?? "").toLowerCase()));
  check(typeof q.isAuto === "boolean", () => (aspects["Autographed"] === "Yes") === q.isAuto);

  if (filledCriteria === 0) return 1;
  return matched / filledCriteria;
}

function normalizeGraderFromAspect(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const lower = v.toLowerCase();
  if (lower.includes("psa")) return "PSA";
  if (lower.includes("bgs") || lower.includes("beckett")) return "BGS";
  if (lower.includes("sgc")) return "SGC";
  if (lower.includes("cgc")) return "CGC";
  return v;
}
