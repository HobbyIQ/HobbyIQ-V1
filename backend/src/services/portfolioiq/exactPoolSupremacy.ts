/**
 * CF-EXACT-POOL-SUPREMACY (D4 "one valuation path", PR 5 — 2026-08-29).
 *
 * A fallback rung may never outrank an exact pool that has >= 1 sale.
 *
 * The case: holding ca7a150b — 2026 Bowman Chrome CPA-MG Marconi German
 * Gold Refractor /50 auto, raw. Three exact raw sales sat under its
 * hobbyiqCardId ($182.50, $187.49, $102.50). Its cardId was a DIFFERENT
 * card (…:cpa-mg:refractor:auto, the suggester's pick). The reprice
 * priced the wrong identity, found nothing, walked to the sibling rung
 * and persisted $1,109.44 (sibling × 8.00× floor) as the holding's
 * value. The same run's log shows the exact pool WAS computed ("method":
 * "unified-market-value", compsUsed 3, fmv 182.5) — and classified
 * "estimated" because that method was unknown to priceFromOurPool.
 *
 * This module is the persist-site guard, in three pure pieces and two
 * Cosmos-touching wrappers:
 *
 *   exactIdentityCandidates(holding)     which identities count as "exact"
 *                                         — hobbyiqCardId FIRST (the
 *                                         checklist identity), then cardId
 *                                         when they differ, and the
 *                                         numbered / un-numbered twin of
 *                                         each slug;
 *   judgeExactPoolSupremacy(ids, counts) the verdict: blocked by the first
 *                                         identity with >= 1 sale in window;
 *   isCrossIdentityRung(label)           which estimates the guard applies
 *                                         to — anything that did not read
 *                                         THIS identity's pool (a sibling,
 *                                         a neighbour, a model, an unnamed
 *                                         legacy rung). Rungs that read the
 *                                         exact identity at another grade
 *                                         or projected its own last sale
 *                                         are not gated: they ARE the pool;
 *   countExactSalesInWindow(ids)         the count, per identity;
 *   priceHoldingFromExactPool(holding)   the unified engine, tried per
 *                                         identity in the same order —
 *                                         hobbyiqCardId alone first, so a
 *                                         wrong cardId's comps cannot dilute
 *                                         the right pool in a union.
 *
 * The window is the unified engine's widest (180d): "has a sale" means
 * "has a sale the engine can price from".
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import { isExactPoolRung } from "../compiq/fmvRung.js";
import type { UnifiedPriceResult } from "../compiq/unifiedPricing.service.js";

export const EXACT_POOL_WINDOW_DAYS = 180;

export interface HoldingIdentityFields {
  cardId?: string | null;
  hobbyiqCardId?: string | null;
  /** The holding's print run when known (e.g. 50 for /50). */
  printRun?: number | string | null;
}

const NUM_SUFFIX = /:num-\d+$/;

function isHiqSlug(s: unknown): s is string {
  return typeof s === "string" && s.startsWith("hiq:") && s.trim().length > 4;
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The identities whose exact pools must be EMPTY before a cross-identity
 * estimate may be persisted, in the order they are consulted:
 *   1. hobbyiqCardId (the checklist identity)
 *   2. its numbered / un-numbered twin
 *   3. cardId, when it differs (a vendor id or a second slug)
 *   4. cardId's twin, when cardId is a slug
 * Pure. Empty when the holding names no identity.
 */
export function exactIdentityCandidates(h: HoldingIdentityFields): string[] {
  const out: string[] = [];
  const push = (id: string | null | undefined) => {
    if (typeof id !== "string") return;
    const t = id.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  const printRun = positiveInt(h.printRun);
  const withTwin = (slug: string) => {
    push(slug);
    if (NUM_SUFFIX.test(slug)) push(slug.replace(NUM_SUFFIX, ""));
    else if (printRun !== null) push(`${slug}:num-${printRun}`);
  };
  if (isHiqSlug(h.hobbyiqCardId)) withTwin(h.hobbyiqCardId.trim());
  const cid = typeof h.cardId === "string" ? h.cardId.trim() : "";
  if (cid) {
    if (isHiqSlug(cid)) withTwin(cid);
    else push(cid);
  }
  return out;
}

/**
 * Does the guard apply to a price from this rung? True for every rung
 * that priced ANOTHER identity (a sibling, a neighbouring parallel, a
 * family baseline, a cross-setkey pool, a vendor resolver, the sibling ×
 * premium estimate) and for a price with no rung name at all (the legacy
 * engine, a grade ladder, a rail). False for rungs that read THIS
 * identity's pool — the exact-pool rungs, the cross-grade rescales of the
 * exact pool, and the rare-card anchor on its own last sale.
 */
export function isCrossIdentityRung(label: string | null | undefined): boolean {
  if (typeof label !== "string" || label.length === 0) return true;
  if (isExactPoolRung(label)) return false;
  switch (label) {
    case "cross-grade-fallback":   // unified: another grade of THIS card
    case "grade-cross-raw":        // hobbyIqFmv: THIS card's raw × grader premium
    case "rare-card-anchor":       // hobbyIqFmv: THIS card's last sale, drift-adjusted
    case "grade-curve-estimate":   // observedGradeCurve: THIS card's observed anchor × ratio
      return false;
    default:
      return true;
  }
}

export interface ExactPoolSupremacyVerdict {
  /** True when no candidate identity has a sale in window — an estimate
   *  may be persisted. */
  allowed: boolean;
  /** The first identity (in candidate order) with a sale, when blocked. */
  blockingId: string | null;
  blockingCount: number;
  candidates: string[];
  counts: Record<string, number>;
}

/** Pure: the verdict from the candidates and their counts. */
export function judgeExactPoolSupremacy(
  candidates: ReadonlyArray<string>,
  counts: Readonly<Record<string, number>>,
): ExactPoolSupremacyVerdict {
  for (const id of candidates) {
    const n = counts[id] ?? 0;
    if (Number.isFinite(n) && n >= 1) {
      return { allowed: false, blockingId: id, blockingCount: n, candidates: [...candidates], counts: { ...counts } };
    }
  }
  return { allowed: true, blockingId: null, blockingCount: 0, candidates: [...candidates], counts: { ...counts } };
}

let _container: Container | null = null;
function soldCompsContainer(): Container | null {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn)
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return _container;
  } catch {
    return null;
  }
}

/**
 * Count the in-window sales of each candidate identity: a `hiq:` slug is
 * matched on `hobbyiqCardId`, anything else on `cardId`. Flagged-wrong and
 * price-anomaly rows are not sales. A query failure counts as 0 for that
 * identity and is logged — the guard fails OPEN to the pre-existing
 * behaviour rather than withholding every price during an outage.
 */
export async function countExactSalesInWindow(
  candidates: ReadonlyArray<string>,
  opts: { windowDays?: number; container?: Container | null } = {},
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (candidates.length === 0) return counts;
  const container = opts.container ?? soldCompsContainer();
  if (!container) {
    for (const id of candidates) counts[id] = 0;
    return counts;
  }
  const windowDays = opts.windowDays ?? EXACT_POOL_WINDOW_DAYS;
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  for (const id of candidates) {
    const column = isHiqSlug(id) ? "c.hobbyiqCardId" : "c.cardId";
    try {
      const { resources } = await container.items.query<number>({
        query: `SELECT VALUE COUNT(1) FROM c
                WHERE ${column} = @id AND c.soldAt >= @cutoff AND c.price > 0
                  AND (NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true)
                  AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
        parameters: [
          { name: "@id", value: id },
          { name: "@cutoff", value: cutoff },
        ],
      }).fetchAll();
      const n = Number(resources?.[0] ?? 0);
      counts[id] = Number.isFinite(n) ? n : 0;
    } catch (err) {
      counts[id] = 0;
      console.warn(JSON.stringify({
        event: "exact_pool_supremacy_count_error",
        source: "exactPoolSupremacy.countExactSalesInWindow",
        id,
        error: (err as Error)?.message ?? String(err),
      }));
    }
  }
  return counts;
}

/** The verdict for a holding: candidates, counts, judgement. */
export async function judgeExactPoolSupremacyForHolding(
  h: HoldingIdentityFields,
  opts: { windowDays?: number; container?: Container | null } = {},
): Promise<ExactPoolSupremacyVerdict> {
  const candidates = exactIdentityCandidates(h);
  const counts = await countExactSalesInWindow(candidates, opts);
  return judgeExactPoolSupremacy(candidates, counts);
}

export interface ExactPoolAttempt {
  /** The id handed to computeUnifiedPrice as `cardId`. */
  cardId: string;
  /** The slug handed as the union partner, when any. */
  hobbyiqCardId: string | null;
  label: "hobbyiqCardId" | "hobbyiqCardId-twin" | "cardId+hobbyiqCardId" | "cardId" | "cardId-twin";
}

/**
 * The order the unified engine is asked, per identity:
 *   1. hobbyiqCardId alone — the checklist identity's own pool, with no
 *      union that could let a wrong cardId's comps dilute it;
 *   2. its numbered / un-numbered twin alone;
 *   3. cardId ∪ hobbyiqCardId — today's shape, for holdings whose cardId
 *      is a vendor id whose rows never got a slug;
 *   4. cardId's twin, when cardId is itself a slug.
 * Pure.
 */
export function unifiedIdentityAttempts(h: HoldingIdentityFields): ExactPoolAttempt[] {
  const attempts: ExactPoolAttempt[] = [];
  const seen = new Set<string>();
  const add = (a: ExactPoolAttempt) => {
    const key = `${a.cardId}|${a.hobbyiqCardId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(a);
  };
  const hiq = isHiqSlug(h.hobbyiqCardId) ? h.hobbyiqCardId.trim() : null;
  const cid = typeof h.cardId === "string" && h.cardId.trim() ? h.cardId.trim() : null;
  const printRun = positiveInt(h.printRun);
  const twinOf = (slug: string): string | null => {
    if (NUM_SUFFIX.test(slug)) return slug.replace(NUM_SUFFIX, "");
    if (printRun !== null) return `${slug}:num-${printRun}`;
    return null;
  };
  if (hiq) {
    add({ cardId: hiq, hobbyiqCardId: hiq, label: "hobbyiqCardId" });
    const twin = twinOf(hiq);
    if (twin) add({ cardId: twin, hobbyiqCardId: twin, label: "hobbyiqCardId-twin" });
  }
  if (cid && cid !== hiq) {
    add({ cardId: cid, hobbyiqCardId: hiq, label: hiq ? "cardId+hobbyiqCardId" : "cardId" });
    if (isHiqSlug(cid)) {
      const twin = twinOf(cid);
      if (twin) add({ cardId: twin, hobbyiqCardId: twin, label: "cardId-twin" });
    }
  }
  return attempts;
}

export interface ExactPoolPrice {
  u: UnifiedPriceResult;
  /** marketValue ?? predictedPrice ?? fmv — the ONE number (CF-ONE-GRADE-CURVE). */
  canonical: number;
  attempt: ExactPoolAttempt;
}

/**
 * Price a holding from its exact pool with the unified engine, trying the
 * identities in unifiedIdentityAttempts order and accepting the first
 * attempt with a positive canonical number and >= 1 sample
 * (CF-UNIFIED-SAMPLE-FLOOR: the pool beats every rescue even when thin).
 * Null when no identity has a priceable pool.
 */
export async function priceHoldingFromExactPool(
  h: HoldingIdentityFields,
  opts: {
    grade: { company: string | null; value: number | null } | null;
    excludeContributorUserId?: string | null;
    playerName?: string | null;
    cardYear?: number | null;
  },
): Promise<ExactPoolPrice | null> {
  const attempts = unifiedIdentityAttempts(h);
  if (attempts.length === 0) return null;
  const { computeUnifiedPrice } = await import("../compiq/unifiedPricing.service.js");
  for (const attempt of attempts) {
    const u = await computeUnifiedPrice(attempt.cardId, {
      hobbyiqCardId: attempt.hobbyiqCardId,
      grade: opts.grade,
      excludeContributorUserId: opts.excludeContributorUserId ?? null,
      playerName: opts.playerName ?? null,
      cardYear: opts.cardYear ?? null,
    });
    const canonical = u.marketValue ?? u.predictedPrice ?? u.fmv;
    if (canonical !== null && canonical > 0 && u.totalSampleCount >= 1) {
      return { u, canonical, attempt };
    }
  }
  return null;
}
