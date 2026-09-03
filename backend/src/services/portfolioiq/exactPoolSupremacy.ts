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
import { poolReadIdsFor, resolveIdentityToCatalogRow, type CatalogRowResolution } from "../catalog/catalogIdentityResolver.js";

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
/**
 * The count query for one candidate. CF-A-TWIN-WITHOUT-A-PRINT-RUN (Drew,
 * 2026-08-30, holding 7a90172d — Theo Gillen 2024 Bowman Draft CPA-TG Blue
 * Refractor /150, PSA 9): the holding carried no printRun field, so the
 * candidate list never formed `…:num-150`, the gate saw 0 sales under the
 * un-numbered id, and a sibling-parallel $3.26 was persisted while the numbered
 * checklist row had 5 sales. An UN-numbered hiq id therefore counts its
 * numbered twins as well (`STARTSWITH(id + ":num-")`) — the same card, print
 * run omitted by the seller or the holding.
 *
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30). This STARTSWITH is the
 * gate's FAIL-SAFE and stays. On an un-numbered id with TWO numbered twins it
 * counts both — deliberately: the resolver (catalogIdentityResolver) refuses
 * to name that card, and a card it cannot name must not be priced from a
 * sibling either; blocking the estimate is the safe side. The readers that
 * LIST or PRICE sales union exactly the id and the ONE twin the resolver
 * names (catalogIdentityResolver.poolReadIdsFor — the pool is not re-keyed
 * until the D29/D30 fleet runs), never a STARTSWITH over every twin. A holding
 * whose cardId / hobbyiqCardId the resolver normalized to …:num-N forms its
 * attempts from that id directly: unifiedIdentityAttempts needs no printRun
 * for it.
 */
export function exactSalesCountQuery(id: string, cutoff: string): { query: string; parameters: Array<{ name: string; value: string }> } {
  const column = isHiqSlug(id) ? "c.hobbyiqCardId" : "c.cardId";
  const unnumberedHiq = isHiqSlug(id) && !NUM_SUFFIX.test(id);
  const idClause = unnumberedHiq
    ? `(${column} = @id OR STARTSWITH(${column}, @idNum))`
    : `${column} = @id`;
  const parameters = [{ name: "@id", value: id }, { name: "@cutoff", value: cutoff }];
  if (unnumberedHiq) parameters.push({ name: "@idNum", value: `${id}:num-` });
  return {
    query: `SELECT VALUE COUNT(1) FROM c
                WHERE ${idClause} AND c.soldAt >= @cutoff AND c.price > 0
                  AND (NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true)
                  AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)`,
    parameters,
  };
}

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
    try {
      const { resources } = await container.items.query<number>(exactSalesCountQuery(id, cutoff)).fetchAll();
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

/**
 * CF-A-UNION-IS-ONE-CARD (2026-09-01, holdings 9b971b03 RA-JC and ca820b08
 * Gonzalez). The product a slug names: `sport:year:setKey`, the first three
 * segments after `hiq:`. Null for anything that is not an hiq slug (a vendor
 * id names no product and is never compared).
 *
 * Two slugs that agree here are the same product and may share a pool — the
 * print-run suffix, the parallel and the grade are all WITHIN one product, so
 * a `…:num-499` / bare-stem twin still unions (that is the twin's purpose).
 * Two slugs that disagree are two cards, and a pool built from both is a
 * fiction: whichever half the window happens to reach decides the price, so
 * the projection alternates run to run on the 6h cron.
 */
export function productIdentityOf(slug: string | null | undefined): string | null {
  if (!isHiqSlug(slug)) return null;
  const seg = slug.trim().split(":");
  // hiq : sport : year : setKey — anything shorter names no product.
  return seg.length >= 4 ? `${seg[1]}:${seg[2]}:${seg[3]}` : null;
}

/**
 * May these two identities be read as ONE pool? Yes when they name the same
 * product, and yes when either names no product at all (a vendor id whose
 * rows carry the slug — the cross-vendor storage the union exists for).
 * Pure.
 */
export function mayUnionIdentities(a: string | null | undefined, b: string | null | undefined): boolean {
  const pa = productIdentityOf(a);
  const pb = productIdentityOf(b);
  if (pa === null || pb === null) return true;
  return pa === pb;
}

export interface ExactPoolAttempt {
  /** The id handed to computeUnifiedPrice as `cardId`. */
  cardId: string;
  /** The slug handed as the union partner, when any. */
  hobbyiqCardId: string | null;
  /** CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW: the slug keys the pool is read
   *  under in ONE query — EXACTLY catalogIdentityResolver.poolReadIdsFor, the
   *  same list recent-sales lists, in whichever direction the identity splits
   *  (one card, two keys until D29 re-keys the pool). Absent = hobbyiqCardId
   *  alone. */
  hobbyiqCardIds?: string[];
  label: "hobbyiqCardId" | "hobbyiqCardId+pool-twin" | "hobbyiqCardId-twin" | "cardId+hobbyiqCardId" | "cardId" | "cardId-twin";
  /** CF-A-UNION-IS-ONE-CARD: set when a union this attempt would have made
   *  was refused because the halves name different products — carried onto
   *  estimateBasis / pricingSourceMeta so the single-sided price is
   *  auditable rather than silently narrower. */
  unionRefusedReason?: string;
}

/**
 * The order the unified engine is asked, per identity:
 *   1. hobbyiqCardId alone — the checklist identity's own pool, with no
 *      union that could let a wrong cardId's comps dilute it;
 *      CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW: when the resolver names a pool
 *      twin for the slug — an un-numbered id whose one catalog row is
 *      `<id>:num-N`, OR a numbered id whose stem has no row of its own (the
 *      round-2 refutation: the writers leave the NUMBERED form on holdings
 *      while the sales stay under the stem) — the first attempt reads BOTH
 *      keys in one query, and it is literally poolReadIdsFor's list, the
 *      same union recent-sales lists. The two halves are never re-tried
 *      alone (each is a subset of the union);
 *   2. its numbered / un-numbered twin alone;
 *   3. cardId ∪ hobbyiqCardId — today's shape, for holdings whose cardId
 *      is a vendor id whose rows never got a slug;
 *   4. cardId's twin, when cardId is itself a slug.
 * Pure.
 */
export function unifiedIdentityAttempts(h: HoldingIdentityFields, resolution?: CatalogRowResolution | null): ExactPoolAttempt[] {
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
  // The pool keys for THIS slug, from the ONE function every reader uses.
  // The resolution may have been taken on either half (the valuation entry
  // resolves the catalog row; a holding still carrying the un-numbered id
  // resolves that), so it is accepted when it is about either half of this
  // slug's stem; poolReadIdsFor itself refuses anything that is not.
  const poolIds = hiq && resolution && (resolution.requested === hiq || resolution.id === hiq || resolution.poolTwin === hiq)
    ? poolReadIdsFor(hiq, resolution.requested === hiq
      ? resolution
      // The resolution was taken on the OTHER half: this slug's twin is the
      // half the resolution names that is not this slug.
      : { ...resolution, requested: hiq, poolTwin: resolution.requested })
    : [hiq ?? ""];
  if (hiq && poolIds.length > 1) {
    // The attempt is REPORTED as the catalog row (pooledAs / the identity the
    // valuation names), while it READS poolReadIdsFor's whole union. When the
    // catalog names no row — a numbered id whose stem is not a row either
    // (kind "none") — the id as given stands.
    const named = resolution && resolution.id && poolIds.includes(resolution.id) ? resolution.id : poolIds[0];
    // The union is ORDER-CANONICAL — the named row first — so the two halves
    // of one card produce the IDENTICAL attempt whichever half the caller
    // held. The query ORs the keys, so order never changed the rows; making
    // it canonical is what makes "same card, same pool" checkable.
    const union = [named, ...poolIds.filter((k) => k !== named)];
    add({
      cardId: named,
      hobbyiqCardId: named,
      hobbyiqCardIds: union,
      label: "hobbyiqCardId+pool-twin",
    });
    // Each half alone is a subset of the union — never re-tried.
    for (const k of poolIds) seen.add(`${k}|${k}`);
  } else if (hiq) {
    add({ cardId: hiq, hobbyiqCardId: hiq, label: "hobbyiqCardId" });
    const twin = twinOf(hiq);
    if (twin) add({ cardId: twin, hobbyiqCardId: twin, label: "hobbyiqCardId-twin" });
  }
  if (cid && cid !== hiq) {
    // CF-A-UNION-IS-ONE-CARD (2026-09-01). This attempt is the ONE place two
    // freely-chosen identities meet: readExactPoolRows ORs `c.cardId = @cid`
    // with `c.hobbyiqCardId = @hiq` in a single query, with no stem check
    // (poolReadIdsFor guards the twin union above; nothing guarded this one).
    // Holding 9b971b03 carried cardId …2024:bowman-draft:ra-jc… beside
    // hobbyiqCardId …2026:topps-chrome:ra-jc…:num-499 (catalogVerified=false):
    // two products in one pool, and the 6h cron alternated 21.25 / 212.95 /
    // 20.625 / 213.8 as the window reached one half or the other. When the
    // halves name different products the union is refused and the holding is
    // priced from its own slug half alone.
    const unionOk = !hiq || mayUnionIdentities(cid, hiq);
    if (unionOk) {
      add({ cardId: cid, hobbyiqCardId: hiq, label: hiq ? "cardId+hobbyiqCardId" : "cardId" });
    } else {
      const reason = `union-refused: cardId ${productIdentityOf(cid)} != hobbyiqCardId ${productIdentityOf(hiq)} — different products, priced single-sided`;
      console.warn(JSON.stringify({
        event: "pool_twin_union_refused_cross_product",
        source: "exactPoolSupremacy.unifiedIdentityAttempts",
        cardId: cid,
        hobbyiqCardId: hiq,
        cardIdProduct: productIdentityOf(cid),
        hobbyiqCardIdProduct: productIdentityOf(hiq),
        detail: "the halves of the pool-twin union name different products; the holding is priced from its own slug half only",
      }));
      // The refusal is recorded on every attempt formed from the holding's own
      // slug — the ones it IS priced from — so the narrower pool is auditable
      // at the write. (The pool-twin attempt reports the resolved catalog row,
      // which need not equal `hiq`; every attempt so far came from that slug.)
      for (const a of attempts) {
        if (a.unionRefusedReason === undefined) a.unionRefusedReason = reason;
      }
    }
    if (unionOk && isHiqSlug(cid)) {
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
    /** CF-ONE-VALUATION-PATH (D16): every tier of the returned curve at its
     *  own density-chosen window, so the curve IS the headline per tier. */
    perTierWindows?: boolean;
    /** CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW: the resolver's answer for the
     *  holding's slug, when the caller already has it (the valuation entry
     *  resolves once). Omitted (undefined) = resolve here, memoized, so the
     *  portfolio callers (autoPriceHolding, the reprice job) read the same
     *  union the routes read. `null` = resolved to nothing, do not resolve. */
    resolution?: CatalogRowResolution | null;
    /** CF-AS-OF-IS-AN-UPPER-BOUND (#1651). Backtest only: price as of a past
     *  instant, reading no sale at or after it. Passed straight to the unified
     *  engine, which owns both the clock and the read ceiling. Null in
     *  production. */
    asOfMs?: number | null;
  },
): Promise<ExactPoolPrice | null> {
  let resolution = opts.resolution;
  if (resolution === undefined) {
    resolution = null;
    // CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW, SYMMETRIC (round-2 refutation):
    // resolve for a NUMBERED slug too. Round 2 skipped it, so a holding the
    // branch's own writers had rewritten to `<stem>:num-N` read that key
    // alone while its sales still sat under `<stem>` — the mirror of the bug
    // this whole change fixes. Two point reads (2 RU) settle it.
    const hiq = isHiqSlug(h.hobbyiqCardId) ? h.hobbyiqCardId.trim() : null;
    if (hiq) {
      try {
        resolution = await resolveIdentityToCatalogRow(hiq, { printRun: positiveInt(h.printRun) });
      } catch {
        resolution = null;
      }
    }
  }
  const attempts = unifiedIdentityAttempts(h, resolution);
  if (attempts.length === 0) return null;
  const { computeUnifiedPrice } = await import("../compiq/unifiedPricing.service.js");
  for (const attempt of attempts) {
    const u = await computeUnifiedPrice(attempt.cardId, {
      hobbyiqCardId: attempt.hobbyiqCardId,
      hobbyiqCardIds: attempt.hobbyiqCardIds ?? null,
      grade: opts.grade,
      excludeContributorUserId: opts.excludeContributorUserId ?? null,
      playerName: opts.playerName ?? null,
      cardYear: opts.cardYear ?? null,
      perTierWindows: opts.perTierWindows === true,
      asOfMs: opts.asOfMs ?? null,
    });
    const canonical = u.marketValue ?? u.predictedPrice ?? u.fmv;
    if (canonical !== null && canonical > 0 && u.totalSampleCount >= 1) {
      return { u, canonical, attempt };
    }
  }
  return null;
}
