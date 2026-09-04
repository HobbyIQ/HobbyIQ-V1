/**
 * CF-ONE-VALUATION-PATH (D16, 2026-08-30). ONE computation behind the four
 * pricing routes — `/price-by-id`, `/canonical-fmv`, `/hobbyiq-fmv` and
 * `/observed-grade-curve` — so they cannot disagree.
 *
 * The D14 probe (probe-price-routes, 200 checklist-backed slugs with >= 3
 * raw sales) found the four routes disagreeing by more than 25% on 44.2% of
 * (slug, Raw): 2018 Bowman #49 Gold priced $11,995 / $11,995 / $3,893.55 /
 * $88 off a pool of three sales. Each route ran its own engine over its own
 * pool — canonical-fmv's five-source ladder keyed by cardId, hobbyIqFmv's
 * unified call at the density window, the curve's unified overlay at a
 * fixed 180d window unioned with a vendor id — and labelled the result with
 * its own vocabulary (`direct-comp` on one wire, `unified-market-value` on
 * another, both outside the rung vocabulary).
 *
 * This module is not a fifth engine. It is the ENTRY: the identity is
 * resolved once (a catalog slug — a vendor id maps to its slug through the
 * catalog, never minted), the exact pool is priced once by the unified
 * engine (exactPoolSupremacy.priceHoldingFromExactPool: hobbyiqCardId alone
 * first, its numbered / un-numbered twin second, >= 1 sale; every tier at
 * its own density-chosen window), and the grade curve is that same result
 * mapped over the canonical tiers. The headline for any tier IS its curve
 * entry, by construction. The rung label is the engine's, in the closed
 * vocabulary (fmvRung.ts).
 *
 * CF-PLAYER-TREND-SPECULATION (Drew, 2026-09-02) inserts ONE rung into that
 * path — never a second path. The order, top to bottom:
 *
 *   1. own FRESH pool                        exact-pool-*
 *   2. own STALE pool + the card's OWN trend  exact-pool-*
 *   3. stale comp × the PLAYER's index ratio  player-index-projection  (NEW)
 *   4. family / sibling / cross-grade         grade-curve-estimate, …
 *
 * Rung 3 is reached only when 1 and 2 both decline (pool cold past
 * STALE_COMP_DAYS AND the card's own trend unmeasurable), and it declines in
 * turn — falling through to 4 — whenever its own guards fail.
 *
 * When the requested tier has no exact pool:
 *   1. the identity's OTHER tiers anchor an empirical-ratio fill
 *      (`grade-curve-estimate` — this card's own sales × GRADE_CALIBRATION;
 *      no hardcoded matrix, no clamp on anything observed);
 *   2. with no sale of this identity at any grade, the GATED fallback ladder
 *      (hobbyIqFmv with the exact pool skipped: cross-setkey inside the
 *      product family and player, sibling parallels, family baseline, the
 *      rare-card anchor …) may answer, under its own honest rung name;
 *   3. otherwise the answer is null with a stated reason — on every route.
 *
 * Doctrine: FMV is the projected next sale from the exact-identity pool,
 * never a median (the engine's thin-pool rung says "weighted-median" when
 * that is what it had); grade monotonicity is not an invariant (an observed
 * tier is never rewritten); multipliers are empirical only.
 */
import { type FmvRungLabel } from "./fmvRung.js";
import { assessPoolMigration, readSettleMarker } from "./poolMigrationGate.js";
import type { UnifiedGradeEntry, UnifiedPriceResult } from "./unifiedPricing.service.js";
import {
  applyUnifiedTierToEntry,
  blankGradeCurveEntry,
  gradeCurveEntryLabel,
  unifiedTierHasPool,
} from "./gradeCurveEntry.js";
import {
  CANONICAL_GRADES,
  calibrationScopeFor,
  capProjectedTiers,
  computeConfidence,
  fillUnavailableTiersFromAnchor,
  gradedPoolInverseAnchor,
  type GradedPoolInverseAnchor,
  type ObservedGradeEntry,
} from "./observedGradeCurve.service.js";
import { logSubRawInversionObserved } from "./marketRead.service.js";
import { attemptPlayerTrendRung } from "./playerTrendRung.service.js";
import { priceHoldingFromExactPool } from "../portfolioiq/exactPoolSupremacy.js";
import { computeHobbyIqFmv, type HobbyIqFmvResult } from "../portfolioiq/hobbyIqFmv.service.js";
import { readCatalogIdentityBySlug } from "../catalog/catalogMatcher.service.js";
import { resolveIdentityToCatalogRow, type CatalogRowResolution } from "../catalog/catalogIdentityResolver.js";
import { lookupHobbyIqCardIdForVendorCardId } from "../portfolioiq/soldCompsStore.service.js";
import { parseHobbyIqCardId } from "../portfolioiq/hobbyIqCardId.service.js";

export interface ValuationGrade {
  company: string | null;
  value: number | null;
}

export interface ValuationRequest {
  /** An hiq slug, or a vendor id the catalog can map to one. */
  id: string;
  /** D17: a holding's second identity (its `cardId` — a vendor id, or a
   *  second slug) beside the slug in `id`. The exact pool is then asked in
   *  the persist site's order (#1462): the slug alone, its twin, then
   *  `cardId` ∪ slug, then cardId's twin. Routes, which know only a slug,
   *  leave it unset. */
  cardId?: string | null;
  /** undefined / null / no company → the Raw tier. */
  grade?: ValuationGrade | null;
  /** The caller's print run, when it knows one the slug does not carry. */
  printRun?: number | null;
  /** The caller's player name (a holding's), for the cross-setkey rule. */
  playerName?: string | null;
  /** Portfolio callers: keep the user's own purchases out of the pool. */
  excludeContributorUserId?: string | null;
  /**
   * CF-AS-OF-IS-AN-UPPER-BOUND (#1651, the engine backtest, 2026-09-02).
   * Price this identity AS OF a past instant, reading ONLY data that existed
   * before it. Undefined in production — every route leaves it unset and the
   * engine behaves exactly as it always has.
   *
   * This single field is the backtest's whole no-lookahead guarantee, and it
   * is a REQUEST field rather than a script-local convention on purpose: the
   * evaluator cannot price a card except by going through this entry, so it
   * cannot forget to pass the cutoff and quietly read the future. From here it
   * reaches every rung on the ladder —
   *
   *   • the exact pool          unifiedPricing.asOfMs -> exactPoolReader
   *   • the player's index      playerTrendRung -> playerIndex -> playerIndexRead
   *   • the fallback ladder     computeHobbyIqFmv.asOfMs -> queryPool (all 11 rungs)
   *
   * — as both the CLOCK the rung reasons with and the CEILING on what it may
   * read. Pinned by asOfLookaheadIsolation.test.ts, which inserts a
   * future-dated sale into the fixture pool and requires every rung's answer
   * to be byte-identical to the run without it.
   */
  asOfMs?: number | null;
}

/** Why there is no number, when there is none. */
export type ValuationReason =
  /** An hiq slug the catalog does not hold — no identity, no pool. */
  | "identity-not-in-catalog"
  /** A vendor id no catalog slug maps to. */
  | "no-catalog-identity"
  /** No sale of this identity in 180d at any grade, and the gated fallback
   *  ladder found nothing either. */
  | "no-exact-pool"
  /** This identity has sales at other grades, but none at the requested
   *  tier, no empirical ratio to project it, and the ladder found nothing. */
  | "no-exact-pool-at-tier"
  /** CF-A-MIGRATING-POOL-IS-NOT-A-THIN-POOL (Drew, 2026-09-04). The identity's
   *  catalog row is newer than the settle window and no rematch marker says
   *  its pool is done, so what the pool currently holds is a partial view. No
   *  number is published — not even a fallback — and the caller retains the
   *  prior value. This is the ONE reason that is not a statement about
   *  evidence being absent; it is a statement about evidence being INCOMPLETE,
   *  which is why it withholds instead of falling through the ladder. */
  | "pool-migrating"
  | null;

export interface ValuationIdentity {
  /** The catalog's form of the slug (a numbered slug may resolve to its
   *  un-numbered twin). Null when unresolved. */
  slug: string | null;
  /** The id the caller sent. */
  requestedId: string;
  /** The identity the unified engine actually read (the slug or its twin). */
  pooledAs: string | null;
  /** Which attempt of the #1462 order read it (exactPoolSupremacy's label). */
  pooledVia: string | null;
  sport: string | null;
  year: number | null;
  setKey: string | null;
  setName: string | null;
  cardNumber: string | null;
  /** Pretty parallel name ("Gold Refractor"), "Base" for the base card. */
  parallel: string;
  parallelSlug: string | null;
  isAuto: boolean;
  printRun: number | null;
  playerName: string | null;
  imageUrl: string | null;
  /**
   * CF-A-MIGRATING-POOL-IS-NOT-A-THIN-POOL (Drew, 2026-09-04). The catalog
   * row's immutable mint instant (`observedAt`). Carried on the identity
   * because the question "is this pool still migrating onto a freshly minted
   * row?" is asked at PRICING time, after the catalog read is long done —
   * and the read used to project every timestamp away, which is why the
   * engine could not tell a settled empty tier from a half-migrated one.
   * Null for a row minted before the field existed, or an unresolved read.
   */
  observedAt: string | null;
}

export interface Valuation {
  /** The projected next sale for the requested tier; null with `reason`. */
  fairMarketValue: number | null;
  /** The rung that produced it, in the closed vocabulary; "no-basis" when null. */
  rungLabel: FmvRungLabel;
  valueSource: "observed" | "estimated" | "unavailable";
  reason: ValuationReason;
  /** Sales that priced the number: the tier's pool size on an exact-pool
   *  rung, the ladder's comp count on a fallback rung, 0 on a fill. */
  compsUsed: number;
  /** The engine's confidence for the rung (its own scale). */
  confidence: number;
  /** Prose for the transparency sheet. Never the label. */
  basis: string;
  identity: ValuationIdentity;
  /** "Raw" | "PSA 10" — the tier the headline describes. */
  requestedTier: string;
  /** The requested tier's window when the exact pool priced it. */
  windowDays: number | null;
  trend: { direction: "up" | "down" | "flat"; pctPerWeek: number | null };
  /** The same fit read at +7d (the observed band's centre). */
  predictedPrice: number | null;
  /** DIAGNOSTIC: the pool's recency-weighted median. Never the headline. */
  weightedMedian: number | null;
  /** The sales behind the headline, newest first (exact-pool rungs only).
   *  CF-SELF-COMP-LABEL-REACHES-THE-RESULT (Drew, 2026-09-03):
   *  `contributorUserId` rides with each sale so a caller that passed
   *  `excludeContributorUserId` can tell which of the KEPT rows are the
   *  owner's own — the reprieve publishes those, and the doctrine says a
   *  published self-comp must be labeled. */
  sales: Array<{ price: number; soldAt: string; source: string | null; contributorUserId: string | null }>;
  /** The owner this valuation was computed for, when the caller named one
   *  (portfolio/reprice/sell-draft paths). Null on the public routes, which
   *  pass no user and so can never call a comp "yours". */
  ownerUserId: string | null;
  /** Every canonical tier (plus any tier the pool has that the canonical
   *  list does not), each from the same engine result; the requested tier's
   *  entry IS the headline. */
  gradeCurve: ObservedGradeEntry[];
  totalSampleCount: number;
  /** The engine's result, when the identity had a pool. */
  unified: UnifiedPriceResult | null;
  /** The gated ladder's answer, when it was asked. */
  fallback: HobbyIqFmvResult | null;
  computedAt: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

const prettySeg = (v: string | null | undefined): string => String(v ?? "")
  .split("-").filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** The engine's tier label for a grade: "Raw", or "PSA 10". */
export function tierLabelFor(grade: ValuationGrade | null | undefined): string {
  const company = String(grade?.company ?? "").trim();
  if (!company) return "Raw";
  return `${company.toUpperCase()} ${grade?.value ?? "?"}`;
}

/** Normalize a caller's grade: no company → Raw (null). */
export function normalizeGrade(grade: ValuationGrade | null | undefined): ValuationGrade | null {
  const company = String(grade?.company ?? "").trim();
  if (!company) return null;
  const v = grade?.value;
  return { company: company.toUpperCase(), value: typeof v === "number" && Number.isFinite(v) ? v : null };
}

function blankIdentity(requestedId: string): ValuationIdentity {
  return {
    slug: null, requestedId, pooledAs: null, pooledVia: null,
    sport: null, year: null, setKey: null, setName: null, cardNumber: null, observedAt: null,
    parallel: "Base", parallelSlug: null, isAuto: false, printRun: null,
    playerName: null, imageUrl: null,
  };
}

/** Resolve the caller's id to the catalog's slug and the identity block.
 *  A vendor id maps through sold_comps (the rows carry both ids) and then
 *  the catalog must hold the slug — nothing is minted here.
 *
 *  CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30): the catalog is asked
 *  through the one resolver (catalogIdentityResolver), whose answer is
 *  returned beside the identity so the exact-pool read unions the id with
 *  its one numbered twin (the pool is keyed both ways until D29). It fails
 *  OPEN: when the catalog could not be asked (a throttle, a non-404 read
 *  error — kind "unresolved"), the id is priced AS GIVEN and logged, never
 *  refused as identity-not-in-catalog; a genuine miss (kind "none" /
 *  "ambiguous") is still the refusal it always was. */
export async function resolveValuationIdentity(
  requestedId: string,
  printRunHint: number | null,
): Promise<{ identity: ValuationIdentity; reason: ValuationReason; resolution: CatalogRowResolution | null }> {
  const id = String(requestedId ?? "").trim();
  const identity = blankIdentity(id);
  if (!id) return { identity, reason: "no-catalog-identity", resolution: null };

  let candidate: string | null = null;
  let missReason: ValuationReason = "no-catalog-identity";
  if (id.startsWith("hiq:")) {
    candidate = id;
    missReason = "identity-not-in-catalog";
  } else {
    try { candidate = await lookupHobbyIqCardIdForVendorCardId(id); } catch { candidate = null; }
  }
  let resolution: CatalogRowResolution | null = null;
  if (candidate) {
    try {
      resolution = await resolveIdentityToCatalogRow(candidate, { printRun: printRunHint });
    } catch (err) {
      resolution = { requested: candidate, id: null, kind: "unresolved", twins: [], error: (err as Error)?.message ?? String(err) };
    }
  }
  let slug: string | null = resolution?.id ?? null;
  if (!slug && resolution && resolution.kind === "unresolved") {
    slug = resolution.requested;
    console.warn(JSON.stringify({
      event: "valuation_identity_unresolved_read_as_given",
      source: "oneValuationPath.resolveValuationIdentity",
      requestedId: id,
      slug,
      error: resolution.error ?? null,
      detail: "the catalog could not be asked (not a 404); the id is priced as given, not refused as identity-not-in-catalog",
    }));
  }
  if (!slug) return { identity, reason: missReason, resolution };

  const parsed = parseHobbyIqCardId(slug);
  const seg = slug.split(":");
  const row = await readCatalogIdentityBySlug(slug).catch(() => null);
  identity.slug = slug;
  identity.sport = row?.sport ?? parsed?.sport ?? seg[1] ?? null;
  identity.year = row?.year ?? parsed?.year ?? (Number(seg[2]) || null);
  identity.setKey = parsed?.setKey ?? seg[3] ?? row?.setKey ?? null;
  identity.setName = row?.setName ?? null;
  identity.cardNumber = String(row?.cardNumber ?? parsed?.cardNumber ?? seg[4] ?? "").toUpperCase() || null;
  identity.parallelSlug = seg[5] ?? null;
  identity.parallel = row?.parallel
    ?? (parsed?.parallel && parsed.parallel.toLowerCase() !== "base" ? parsed.parallel : null)
    ?? (seg[5] && seg[5] !== "base" ? prettySeg(seg[5]) : "Base");
  identity.isAuto = row?.isAuto ?? parsed?.isAuto ?? seg[6] === "auto";
  identity.printRun = printRunHint ?? parsed?.printRun ?? row?.printRun ?? null;
  identity.playerName = row?.playerName ?? null;
  identity.imageUrl = row?.imageUrl ?? null;
  identity.observedAt = row?.observedAt ?? null;
  return { identity, reason: null, resolution };
}

/** Every canonical tier as a blank entry, in canonical order. */
function blankCurve(): ObservedGradeEntry[] {
  return CANONICAL_GRADES.map((g) => blankGradeCurveEntry(g.label, g.grader));
}

/** Map the engine's tiers onto the canonical entries (and append any tier the
 *  pool has that the canonical list does not), through the ONE writer of a
 *  tier's numbers (gradeCurveEntry.applyUnifiedTierToEntry). */
export function curveFromUnified(u: UnifiedPriceResult, nowMs: number): ObservedGradeEntry[] {
  const entries = blankCurve();
  const byLabel = new Map<string, UnifiedGradeEntry>(u.gradeCurve.map((e) => [e.grade, e]));
  const seen = new Set<string>();
  const stampSales = (entry: ObservedGradeEntry, um: UnifiedGradeEntry) => {
    const sales = um.sales ?? [];
    entry.salesHistory = sales.map((s) => ({ price: s.price, date: s.soldAt, saleType: null }));
    entry.newestSalePrice = sales.length > 0 ? sales[0].price : null;
    let oldest: string | null = null;
    for (const s of sales) if (oldest === null || s.soldAt < oldest) oldest = s.soldAt;
    entry.oldestSaleDate = oldest;
  };
  for (const entry of entries) {
    const label = gradeCurveEntryLabel(entry);
    seen.add(label);
    const um = byLabel.get(label);
    if (um && unifiedTierHasPool(um)) {
      applyUnifiedTierToEntry(entry, um, { confidenceScore: computeConfidence(um.sampleCount, um.newestSaleDate), nowMs });
      stampSales(entry, um);
    }
  }
  for (const um of u.gradeCurve) {
    if (seen.has(um.grade) || !unifiedTierHasPool(um)) continue;
    if (/\?/.test(um.grade)) continue;   // a grader with no numeric grade is not a tier
    const grader = um.gradeCompany ? String(um.gradeCompany).toUpperCase() : "Raw";
    const extra = applyUnifiedTierToEntry(blankGradeCurveEntry(um.grade, grader), um, {
      confidenceScore: computeConfidence(um.sampleCount, um.newestSaleDate), nowMs,
    });
    stampSales(extra, um);
    let insertAt = entries.length;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].grader === grader) { insertAt = i + 1; break; }
    }
    entries.splice(insertAt, 0, extra);
    seen.add(um.grade);
  }
  return entries;
}

/**
 * THE entry. One identity, one engine call, one curve; the headline for the
 * requested tier is that tier's curve entry.
 */
export async function valueIdentity(req: ValuationRequest): Promise<Valuation> {
  // CF-AS-OF-IS-AN-UPPER-BOUND (#1651). The entry's single clock. In a
  // backtest it is the evaluation instant; in production it is the wall clock
  // and `asOfMs` is undefined, so nothing below can tell the difference.
  const asOfMs = typeof req.asOfMs === "number" && Number.isFinite(req.asOfMs) ? req.asOfMs : null;
  const nowMs = asOfMs ?? Date.now();
  const grade = normalizeGrade(req.grade);
  const requestedTier = tierLabelFor(grade);
  const printRunHint = typeof req.printRun === "number" && Number.isFinite(req.printRun) && req.printRun > 0
    ? Math.trunc(req.printRun) : null;

  const base = (identity: ValuationIdentity): Valuation => ({
    fairMarketValue: null,
    rungLabel: "no-basis",
    valueSource: "unavailable",
    reason: null,
    compsUsed: 0,
    confidence: 0,
    basis: "",
    identity,
    requestedTier,
    windowDays: null,
    trend: { direction: "flat", pctPerWeek: null },
    predictedPrice: null,
    weightedMedian: null,
    sales: [],
    ownerUserId: req.excludeContributorUserId ?? null,
    gradeCurve: blankCurve(),
    totalSampleCount: 0,
    unified: null,
    fallback: null,
    computedAt: new Date(nowMs).toISOString(),
  });

  const { identity, reason: idReason, resolution } = await resolveValuationIdentity(req.id, printRunHint);
  if (!identity.slug || idReason) {
    const v = base(identity);
    v.reason = idReason ?? "no-catalog-identity";
    v.basis = v.reason === "identity-not-in-catalog"
      ? `${identity.requestedId} is not a catalog row — no identity, no pool`
      : `${identity.requestedId} maps to no catalog identity — no pool`;
    return v;
  }
  const slug = identity.slug;
  const playerName = req.playerName ?? identity.playerName ?? null;

  // ── 1. The exact pool, priced once ─────────────────────────────────────
  //
  // A holding's second identity (req.cardId) joins the attempts after the
  // slug and its twin — the persist site's order since #1462, so a wrong
  // cardId's comps cannot dilute the checklist identity's own pool.
  // CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW: the resolver's answer rides along
  // (resolved ONCE above), so a numbered-twin identity's first attempt reads
  // the id and its twin in one query — the union recent-sales lists.
  const secondId = String(req.cardId ?? "").trim();
  const exact = await priceHoldingFromExactPool(
    { hobbyiqCardId: slug, cardId: secondId && secondId !== slug ? secondId : null, printRun: identity.printRun },
    {
      grade,
      playerName,
      cardYear: identity.year,
      excludeContributorUserId: req.excludeContributorUserId ?? null,
      perTierWindows: true,
      resolution,
      asOfMs,
    },
  );
  const v = base(identity);
  const u = exact?.u ?? null;
  v.unified = u;
  if (exact) {
    v.identity.pooledAs = exact.attempt.cardId;
    v.identity.pooledVia = exact.attempt.label;
  }
  if (u) {
    v.gradeCurve = curveFromUnified(u, nowMs);
    v.totalSampleCount = u.totalSampleCount;
  }

  const findTier = (): ObservedGradeEntry => {
    let entry = v.gradeCurve.find((e) => gradeCurveEntryLabel(e) === requestedTier);
    if (!entry) {
      entry = blankGradeCurveEntry(requestedTier, grade?.company ?? "Raw");
      v.gradeCurve.push(entry);
    }
    return entry;
  };
  let tier = findTier();

  // ── 1a. CF-A-MIGRATING-POOL-IS-NOT-A-THIN-POOL (Drew, 2026-09-04) ──────
  //
  // Before ANY rung reads the shape of this pool, ask whether the pool is
  // finished arriving. A newly minted identity is repriceable the moment its
  // catalog row exists, but its sales are re-keyed onto it by the GREAT
  // REMATCH over the following hours — so between mint and settle, "this tier
  // has no sales" and "this tier's sales are still in flight" look identical
  // to every rung below.
  //
  // The 1987 Topps Traded Tiffany Maddux row was minted at 14:37Z. At 18:56Z,
  // with 17 of 350 sales migrated, a reprice found the PSA 10 tier empty and
  // published a grade-curve estimate off the PSA 8/9 rows that had arrived:
  // $240 for a ~$1,500 card. Every step was correct given what the engine
  // could see, which is exactly why the gate has to be here — above the
  // branches, not inside one.
  //
  // This is deliberately the ONE choke point, for the reason `asOfMs` is a
  // request field rather than a convention: section 1 and section 2 have five
  // returns between them, and a gate repeated at each is a gate that will be
  // forgotten at the sixth. Placed here it covers the exact rung, the player
  // rung's exact-pool anchor, and the graded-to-raw curve alike.
  //
  // It refuses rather than substituting. No fallback number is reached for a
  // migrating identity — a fallback is precisely what produced the $240 — so
  // the valuation returns `no-basis` with reason `pool-migrating`, and the
  // persist layer retains the prior value and labels it.
  const migration = assessPoolMigration({
    observedAt: identity.observedAt,
    marker: await readSettleMarker(slug, identity.year, identity.setKey).catch(() => null),
    nowMs,
  });
  if (migration.migrating) {
    v.reason = "pool-migrating";
    v.rungLabel = "no-basis";
    v.valueSource = "unavailable";
    v.fairMarketValue = null;
    v.compsUsed = tier.sampleCount;
    v.confidence = 0;
    v.basis = `This card's identity was created ${migration.ageHours?.toFixed(1) ?? "?"}h ago and its sales are still being re-keyed onto it`
      + ` (${tier.sampleCount} ${requestedTier} sale${tier.sampleCount === 1 ? "" : "s"} arrived so far). No price is published from a pool that is still migrating`
      + ` — a partially migrated pool prices a card off whichever sales happened to arrive first.`;
    console.warn(JSON.stringify({
      event: "valuation_withheld_pool_migrating",
      source: "oneValuationPath.valueIdentity",
      slug,
      tier: requestedTier,
      observedAt: identity.observedAt,
      ageHours: migration.ageHours,
      because: migration.because,
      tierSampleCount: tier.sampleCount,
      totalSampleCount: v.totalSampleCount,
    }));
    return v;
  }

  // The requested tier has its own pool: the exact-pool rung, the engine's
  // number, the engine's label. Nothing else touches it.
  if (tier.valueSource === "observed" && tier.trendAdjustedValue != null && tier.trendAdjustedValue > 0 && u) {
    const um = u.gradeCurve.find((e) => e.grade === requestedTier);

    // ── 1b. CF-PLAYER-TREND-SPECULATION (Drew, 2026-09-02) ───────────────
    //
    // "This is where speculation comes from." The tier HAS a pool, so the
    // exact-pool rungs above own this branch — but only while that pool is
    // still saying something about today. When it has gone cold (newest comp
    // past STALE_COMP_DAYS, the same 45d line #1646's chip uses) AND the
    // card's own trend is unmeasurable (the engine read no trendPctPerWeek —
    // neither a leading edge nor a 14d-vs-prior ratio), the honest exact-pool
    // number is a two-month-old quote wearing a fresh label.
    //
    // So between "own stale pool + OWN trend" and the family/sibling rungs
    // below, this card's last REAL sale is carried forward on the PLAYER's
    // market. Both rungs above still win outright: a fresh pool never reaches
    // this block's guard, and a stale pool whose OWN trend is measurable is
    // rejected by isPlayerTrendRungEligible. The rung DECLINES (returns null)
    // on every guard — no player, no pool, too few liquid cards — and the
    // exact-pool number below stands exactly as it did before this rung.
    const playerRung = await attemptPlayerTrendRung({
      slug,
      alsoExclude: [v.identity.pooledAs, secondId || null],
      playerName,
      sport: identity.sport,
      tierLabel: requestedTier,
      lastRealComp: um?.sales?.[0] ?? (um?.newestSaleDate != null && tier.newestSalePrice != null
        ? { price: tier.newestSalePrice, soldAt: um.newestSaleDate }
        : { price: NaN, soldAt: "" }),
      ownTrendPctPerWeek: um?.trendPctPerWeek ?? null,
      sampleCount: tier.sampleCount,
      nowMs,
      asOfMs,
    }).catch(() => null);

    if (playerRung) {
      v.fairMarketValue = playerRung.fairMarketValue;
      v.rungLabel = playerRung.rungLabel;
      // Estimated, not observed: the ANCHOR is this card's real sale, but the
      // number served is that anchor moved by OTHER cards' sales.
      v.valueSource = "estimated";
      v.compsUsed = tier.sampleCount;
      v.confidence = playerRung.confidence;
      v.windowDays = u.windowDays;
      v.predictedPrice = playerRung.fairMarketValue;
      v.weightedMedian = tier.weightedMedianPrice;
      v.sales = (um?.sales ?? []).slice();
      v.basis = playerRung.basis;
      v.trend = {
        direction: playerRung.ratio > 1.01 ? "up" : playerRung.ratio < 0.99 ? "down" : "flat",
        pctPerWeek: null,
      };
      // The tier entry carries the same rung, so the curve and the headline
      // cannot disagree about where this number came from (D16).
      tier.value = playerRung.fairMarketValue;
      tier.trendAdjustedValue = playerRung.fairMarketValue;
      tier.valueSource = "estimated";
      tier.rungLabel = playerRung.rungLabel;
      tier.confidenceScore = playerRung.confidence;
      await fillUnavailableTiersFromAnchor(v.gradeCurve, {
        anchorFallback: null, setName: identity.setName, sport: identity.sport, slug,
      });
      capProjectedTiers(v.gradeCurve);
      labelEstimates(v.gradeCurve);
      return v;
    }

    v.fairMarketValue = tier.trendAdjustedValue;
    v.rungLabel = tier.rungLabel ?? "exact-pool-projection";
    v.valueSource = "observed";
    v.compsUsed = tier.sampleCount;
    v.confidence = um?.confidence ?? tier.confidenceScore;
    v.windowDays = u.windowDays;
    v.trend = { direction: um?.trendDirection ?? "flat", pctPerWeek: um?.trendPctPerWeek ?? null };
    v.predictedPrice = tier.predictedPriceAt30d;
    v.weightedMedian = tier.weightedMedianPrice;
    v.sales = (um?.sales ?? []).slice();
    // D22: the basis states the window choice (the cascade's path), the
    // anchor the projection started from, and what the rung did — the
    // projectionNote — beside the numbers. Still prefixed `unified:` (the
    // digest gate's secondary read).
    v.basis = `unified: ${requestedTier} window=${u.windowDays}d${um?.windowNote ? ` [${um.windowNote}]` : ""} n=${tier.sampleCount} anchor=$${tier.weightedMedianPrice?.toFixed(0) ?? "?"} marketValue=$${v.fairMarketValue.toFixed(0)} predicted=$${v.predictedPrice?.toFixed(0) ?? "?"} trend=${v.trend.direction} ${v.trend.pctPerWeek?.toFixed(1) ?? "?"}%/wk rung=${v.rungLabel}${um?.projectionNote ? ` — ${um.projectionNote}` : ""}`;
    // Tiers with no pool of their own are filled from this identity's
    // observed tiers × the empirical ratio (estimated, labelled), never
    // touching an observed tier.
    await fillUnavailableTiersFromAnchor(v.gradeCurve, {
      anchorFallback: null, setName: identity.setName, sport: identity.sport, slug,
    });
    capProjectedTiers(v.gradeCurve);
    labelEstimates(v.gradeCurve);
    return v;
  }

  // ── 2. No pool at this tier, but this identity has sales at others ──────
  if (u) {
    // CF-GRADED-POOL-INVERSE (Drew, 2026-08-31). Measured BEFORE the fill,
    // while the curve still shows which tiers are genuinely observed: when
    // the RAW/parent tier is the one with no pool, this identity's own graded
    // children price it — the best-evidenced graded tier's projection ÷ that
    // tier's empirical multiplier. The fill below performs the same division
    // to seed its anchor; this read only recovers the provenance so the rung
    // can be named and shown. Same identity, same tables, one computation.
    const inverse = requestedIsRawTier(requestedTier)
      ? gradedPoolInverseAnchor(
          v.gradeCurve,
          await empiricalRatioFor({ setName: identity.setName, sport: identity.sport, slug }),
        )
      : null;

    await fillUnavailableTiersFromAnchor(v.gradeCurve, {
      anchorFallback: null, setName: identity.setName, sport: identity.sport, slug,
    });
    capProjectedTiers(v.gradeCurve);
    labelEstimates(v.gradeCurve);
    tier = findTier();
    if (tier.valueSource === "estimated" && tier.value != null && tier.value > 0) {
      const anchor = v.gradeCurve.find((e) => e.valueSource === "observed" && (e.value ?? 0) > 0);
      v.fairMarketValue = tier.value;
      v.valueSource = "estimated";
      v.compsUsed = 0;
      v.confidence = tier.confidenceScore;
      v.windowDays = u.windowDays;
      v.predictedPrice = tier.predictedPriceAt30d ?? null;
      if (inverse) {
        // The graded→raw rung: name it distinctly so the UI and telemetry can
        // show where the number came from, and state the tier that anchored
        // it (with its pool size — the evidence that won it the role).
        v.rungLabel = "graded-pool-inverse";
        tier.rungLabel = "graded-pool-inverse";
        (tier as { estimatedFrom: string | null }).estimatedFrom = "graded-pool-inverse";
        (tier as { estimatedMultiplier: number | null }).estimatedMultiplier = inverse.multiplier;
        v.basis = `Priced from this card's own ${inverse.fromGrade} sales (n=${inverse.fromSampleCount}, projected $${inverse.fromValue.toFixed(2)}) ÷ the empirical ${inverse.fromGrade} multiplier (${inverse.multiplier.toFixed(2)}×); no ${requestedTier} sale of this card in ${u.windowDays}d`;
        logGradedPoolInverse(slug, requestedTier, playerName, inverse, v.fairMarketValue, u.windowDays);
      } else {
        v.rungLabel = "grade-curve-estimate";
        v.basis = `Estimated from this card's own ${anchor ? gradeCurveEntryLabel(anchor) : "observed"} sales × the empirical ${requestedTier} ratio${tier.estimatedMultiplier != null ? ` (${tier.estimatedMultiplier.toFixed(2)}×)` : ""}; no ${requestedTier} sale of this card in ${u.windowDays}d`;
      }
      return v;
    }
  }

  // ── 3. No sale of this identity at any grade: the gated ladder ─────────
  //
  // Only when the exact pool is empty may another identity price this one
  // (exact-pool supremacy). The ladder names its rung honestly.
  let fb: HobbyIqFmvResult | null = null;
  try {
    fb = await computeHobbyIqFmv({
      hobbyiqCardId: slug,
      gradeCompany: grade?.company ?? null,
      gradeValue: grade?.value ?? null,
      playerName,
      skipExactPool: true,
      asOfMs,
    });
  } catch { fb = null; }
  v.fallback = fb;
  if (fb && fb.method !== "no-basis" && fb.fmv !== null && fb.fmv > 0) {
    v.fairMarketValue = round2(fb.fmv);
    v.rungLabel = fb.rungLabel;
    v.valueSource = "estimated";
    v.compsUsed = fb.compCount;
    v.confidence = fb.confidence;
    v.trend = {
      direction: fb.trend.direction,
      pctPerWeek: Number.isFinite(fb.trend.slopePerMonthPct) ? round2(fb.trend.slopePerMonthPct / (30 / 7)) : null,
    };
    v.basis = fb.basisNote;
    // A fallback rung prices off a family / sibling pool, not the owner's own
    // tier, and HobbyIqFmvComp carries no contributor — so these are honestly
    // nobody's own sale. A self-anchored label cannot fire here, which is
    // right: the number is not anchored on the owner's purchase.
    v.sales = fb.recentComps.map((c) => ({ price: c.price, soldAt: c.soldAt, source: c.source ?? null, contributorUserId: null }));
    tier = findTier();
    tier.value = v.fairMarketValue;
    tier.trendAdjustedValue = v.fairMarketValue;
    tier.valueSource = "estimated";
    tier.rungLabel = fb.rungLabel;
    (tier as { estimatedFrom: string | null }).estimatedFrom = fb.rungLabel;
    tier.confidenceScore = fb.confidence;
    // A Raw estimate anchors the graded tiers × the empirical ratio, exactly
    // as the curve always cascaded a sibling-derived Raw.
    if (requestedTier === "Raw") {
      await fillUnavailableTiersFromAnchor(v.gradeCurve, {
        anchorFallback: v.fairMarketValue, setName: identity.setName, sport: identity.sport, slug,
      });
      capProjectedTiers(v.gradeCurve);
      labelEstimates(v.gradeCurve);
    }
    return v;
  }

  // ── 4. Nothing — and every route says so the same way ──────────────────
  if (u) {
    v.reason = "no-exact-pool-at-tier";
    v.basis = `${slug} has sales at other grades but none at ${requestedTier} in 180d, no empirical ratio projects it, and no gated fallback rung could price it`;
  } else {
    v.reason = "no-exact-pool";
    v.basis = `No sale of ${slug} in 180d at any grade, and no gated fallback rung could price it`;
  }
  return v;
}

/** Name the rung on every filled tier the fill did not already label. */
function labelEstimates(entries: ObservedGradeEntry[]): void {
  for (const e of entries) {
    if (e.rungLabel) continue;
    if (e.valueSource === "estimated") e.rungLabel = "grade-curve-estimate";
  }
}

/** CF-GRADED-POOL-INVERSE: the rung fires only for the RAW/parent tier —
 *  a graded tier with no pool is filled the other way (raw × ratio). */
function requestedIsRawTier(requestedTier: string): boolean {
  return requestedTier === "Raw";
}

/** The empirical (family, sport)-scoped multiplier lookup for one identity —
 *  the SAME GRADE_CALIBRATION function the raw→graded fill uses, so the two
 *  directions can never drift onto different tables. */
async function empiricalRatioFor(
  opts: { setName?: string | null; sport?: string | null; slug?: string | null },
): Promise<(grader: string, value: number | null) => number | null> {
  const { empiricalGradeMultiplier } = await import("./canonicalFmv.service.js");
  const { family, sport } = calibrationScopeFor(opts);
  return (grader: string, value: number | null) => empiricalGradeMultiplier(grader, value, family, sport);
}

/** CF-GRADED-POOL-INVERSE telemetry: the rung's provenance on the wire, so a
 *  reader can see which tier priced a raw card and by what multiplier.
 *
 *  A sub-raw inversion — the graded tier that anchored the price trading
 *  BELOW the raw it implies, which the data can genuinely say — is OBSERVED
 *  through the canonical logger and never clamped (grade monotonicity is not
 *  an invariant; the sub-raw telemetry IS the DailyIQ pipe). */
function logGradedPoolInverse(
  slug: string,
  requestedTier: string,
  playerName: string | null,
  inverse: GradedPoolInverseAnchor,
  rawValue: number,
  windowDays: number,
): void {
  try {
    console.log(JSON.stringify({
      event: "graded_pool_inverse_priced",
      source: "oneValuationPath.valueIdentity",
      slug,
      requestedTier,
      fromGrade: inverse.fromGrade,
      fromSampleCount: inverse.fromSampleCount,
      fromValue: Math.round(inverse.fromValue * 100) / 100,
      multiplier: inverse.multiplier,
      rawValue,
      windowDays,
    }));
    // The graded anchor sits below the raw it implies: observe, never clamp.
    if (inverse.fromValue < rawValue) {
      logSubRawInversionObserved({
        source: "oneValuationPath.gradedPoolInverse",
        player: playerName,
        cardId: slug,
        event: {
          grader: inverse.fromGrader,
          grade: inverse.fromGrade,
          gradeMedian: Math.round(inverse.fromValue * 100) / 100,
          gradeCount: inverse.fromSampleCount,
          rawMedian: rawValue,
          marginPct: rawValue > 0 ? Math.round(((rawValue - inverse.fromValue) / rawValue) * 1000) / 10 : 0,
          marginUSD: Math.round((rawValue - inverse.fromValue) * 100) / 100,
        },
      });
    }
  } catch { /* telemetry must never break a price */ }
}

/**
 * CF-ONE-VALUATION-PATH (D17, 2026-08-30). Many identities through the ONE
 * entry: each id is valued exactly once (deduped), `concurrency` at a time,
 * one exact-pool read per identity — the batched shape
 * /observed-grade-curves-bulk needs. Not a second computation: every
 * valuation is `valueIdentity`'s. An id whose valuation throws is absent
 * from the map (logged); the caller decides what a miss becomes.
 */
export async function valueIdentitiesBulk(
  ids: ReadonlyArray<string>,
  opts: { concurrency?: number; grade?: ValuationGrade | null } = {},
): Promise<Map<string, Valuation>> {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())));
  const out = new Map<string, Valuation>();
  const width = Math.max(1, Math.min(Math.trunc(opts.concurrency ?? 8), unique.length || 1));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < unique.length) {
      const id = unique[cursor++];
      try {
        out.set(id, await valueIdentity({ id, grade: opts.grade ?? null }));
      } catch (err) {
        console.warn(JSON.stringify({
          event: "one_valuation_path_bulk_id_failed",
          source: "oneValuationPath.valueIdentitiesBulk",
          id,
          error: (err as Error)?.message ?? String(err),
        }));
      }
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
}
