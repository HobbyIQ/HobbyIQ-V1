/**
 * CF-PLAYER-TREND-SPECULATION (Drew, 2026-09-02) — the RUNG.
 *
 * "This is where speculation comes from."
 *
 * #1646 put the staleness on the SCREEN: past 45 days a chip appears beside
 * the rung saying "last sale N weeks ago — priced to today's market". But
 * the NUMBER behind that chip was still the old comp. This rung makes the
 * copy true:
 *
 *     value = lastRealComp × playerIndexRatio(anchorDate → today)
 *
 * WHEN IT FIRES — exactly one gap in the existing ladder
 * -----------------------------------------------------
 * The ladder is ONE path with rungs in order (oneValuationPath.service.ts):
 *
 *     1. own FRESH pool                              (exact-pool-*)
 *     2. own STALE pool + the card's OWN trend       (exact-pool-*)
 *  →  3. stale comp + the PLAYER's trend             (THIS RUNG)
 *     4. family / sibling / cross-grade              (grade-curve-estimate,
 *                                                     sibling-estimate, …)
 *
 * Rungs 1 and 2 are the same code — the exact-pool read — and this rung is
 * reached only when BOTH of their conditions fail together:
 *
 *   - the pool is STALE: newest comp older than STALE_COMP_DAYS (45d, the
 *     #1646 line, imported so the two halves cannot drift apart); AND
 *   - the card's OWN trend is UNMEASURABLE: the engine returned no
 *     `trendPctPerWeek` for the tier, which is precisely the branch where
 *     it could read neither a leading edge nor a 14d-vs-prior ratio.
 *
 * OPERATING RANGE: 45d – 180d of anchor age. The top end is not this rung's
 * choice — the unified engine's widest read is a 180d window (unifiedPricing's
 * 30 → 60 → 90 → 180 cascade), so past 180 days there is no exact pool, no
 * anchor, and the ladder falls all the way to the family rung. That is the
 * correct outcome: this rung's claim is "this card really sold for $X", and
 * past the read window there is no $X to point at. The speculative tier
 * (SPECULATIVE_ANCHOR_DAYS = 180) therefore bites in the band just under the
 * ceiling, where the anchor is still readable but old enough that the number
 * is a guess with a method rather than a price with a correction on it.
 *
 * A card with a fresh pool NEVER reaches here (rung 1 answered). A stale
 * card whose own trend IS measurable NEVER reaches here either (rung 2
 * answered) — the card's own market beats its player's, always: a player
 * index is a proxy, and a proxy never outranks the thing it proxies for.
 * That is the same doctrine that keeps sibling-estimate from outranking the
 * exact pool, one rung further down.
 *
 * AND IT DECLINES. Every guard in playerIndex.service.ts is a FALL-THROUGH,
 * not a clamp: no player name, no pool, too few liquid cards, no level at
 * either end — the ladder continues to rung 4 and that rung names itself
 * honestly. `attemptPlayerTrendRung` returns null and the caller carries on
 * exactly as it did before this rung existed.
 *
 * WHAT IT NEVER DOES
 * ------------------
 * It never clamps. A player whose market doubled carries the card to double.
 * Bounding the ratio "for safety" would be the grade-monotonicity error in
 * another costume — the data can genuinely say a card is worth twice what it
 * last sold for, and a valuation engine that refuses to say so is lying by
 * omission. The guards decide whether we speak; they never edit what we say.
 *
 * It never invents an anchor. The anchor is a REAL sale of THIS card at THIS
 * tier — `lastRealComp` — not a family baseline, not a sibling, not a model.
 * The rung's whole claim is "this card really sold for $X, and this player's
 * market has moved R× since", and both halves have to be real for the
 * sentence to be true.
 */
import { STALE_COMP_DAYS } from "./staleComp.js";
import {
  MAX_RUNG_CONFIDENCE,
  SPECULATIVE_ANCHOR_DAYS,
  SPECULATIVE_CONFIDENCE,
  playerIndexRatio,
  type PlayerIndexResult,
} from "./playerIndex.service.js";

const DAY_MS = 86_400_000;

export interface PlayerTrendRungInput {
  /** The identity being priced — never a member of its own basket. */
  slug: string;
  /** Its other pool key (the numbered/un-numbered twin), also excluded. */
  alsoExclude?: readonly (string | null | undefined)[];
  playerName: string | null | undefined;
  sport?: string | null;
  /** "Raw" | "PSA 10" — the tier the basket prefers. */
  tierLabel: string;
  /** The newest REAL sale of this card at this tier: price and when. */
  lastRealComp: { price: number; soldAt: string };
  /** The card's own trend, as the engine measured it. A non-null value means
   *  rung 2 answered and this rung must not be reached. */
  ownTrendPctPerWeek: number | null;
  /** Pool size behind the anchor, for the confidence read. */
  sampleCount: number;
  nowMs: number;
  /** Test seam / #1646 alignment. */
  staleDays?: number;
  /** CF-AS-OF-IS-AN-UPPER-BOUND (#1651). Backtest only: the player basket may
   *  read no sale at or after this instant. Null / absent in production.
   *  Distinct from `nowMs` on purpose — `nowMs` is the clock the rung reasons
   *  with (anchor age, staleness), `asOfMs` is the ceiling on what may be
   *  READ. In a backtest they hold the same value; keeping them separate
   *  means production cannot acquire a ceiling by accident. */
  asOfMs?: number | null;
}

export interface PlayerTrendRungResult {
  fairMarketValue: number;
  /** The rung label, in the closed vocabulary. */
  rungLabel: "player-index-projection";
  confidence: number;
  /** True when the anchor is past SPECULATIVE_ANCHOR_DAYS. */
  speculative: boolean;
  /** The prose for estimateBasis / the transparency sheet. */
  basis: string;
  ratio: number;
  anchorPrice: number;
  anchorSoldAt: string;
  anchorAgeDays: number;
  anchorAgeWeeks: number;
  basketSize: number;
  tierScope: "same-tier" | "all-tiers";
  playerName: string;
  index: PlayerIndexResult & { ok: true };
}

/** Whole weeks since the anchor, the way #1646's chip counts them. */
function weeksAgo(days: number): number {
  return Math.max(1, Math.round(days / 7));
}

/**
 * True when this card is in the gap the rung exists for: its pool is stale
 * AND its own trend is unmeasurable. Exported so the ladder's ordering is
 * testable as a predicate, not only as an outcome.
 */
export function isPlayerTrendRungEligible(input: {
  newestSaleMs: number | null;
  ownTrendPctPerWeek: number | null;
  nowMs: number;
  staleDays?: number;
}): boolean {
  const staleDays = input.staleDays ?? STALE_COMP_DAYS;
  if (input.newestSaleMs === null || !Number.isFinite(input.newestSaleMs)) return false;
  const ageDays = (input.nowMs - input.newestSaleMs) / DAY_MS;
  if (!(ageDays > staleDays)) return false;                 // rung 1: fresh pool
  if (input.ownTrendPctPerWeek !== null) return false;      // rung 2: own trend
  return true;
}

/**
 * Price the stale card from its player's market, or return null to fall
 * through. Never throws.
 */
export async function attemptPlayerTrendRung(
  input: PlayerTrendRungInput,
): Promise<PlayerTrendRungResult | null> {
  const anchorPrice = Number(input.lastRealComp?.price);
  const anchorMs = Date.parse(String(input.lastRealComp?.soldAt));
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) return null;
  if (!Number.isFinite(anchorMs)) return null;

  if (!isPlayerTrendRungEligible({
    newestSaleMs: anchorMs,
    ownTrendPctPerWeek: input.ownTrendPctPerWeek,
    nowMs: input.nowMs,
    staleDays: input.staleDays,
  })) return null;

  const exclude = new Set<string>([input.slug]);
  for (const id of input.alsoExclude ?? []) {
    const s = String(id ?? "").trim();
    if (s) exclude.add(s);
  }

  let index: PlayerIndexResult;
  try {
    index = await playerIndexRatio({
      playerName: input.playerName,
      sport: input.sport ?? null,
      nowMs: input.nowMs,
      asOfMs: input.asOfMs ?? null,
      anchorMs,
      targetValue: anchorPrice,
      tierLabel: input.tierLabel,
      excludeCardIds: exclude,
    });
  } catch { return null; }

  if (!index.ok) {
    logPlayerTrendDecline(input, index.reason, index.freshCards);
    return null;
  }

  const anchorAgeDays = Math.max(0, Math.round((input.nowMs - anchorMs) / DAY_MS));
  const anchorAgeWeeks = weeksAgo(anchorAgeDays);
  const speculative = anchorAgeDays > SPECULATIVE_ANCHOR_DAYS;

  // NEVER CLAMPED. The ratio is applied as computed.
  const fairMarketValue = Math.round(anchorPrice * index.ratio * 100) / 100;

  // Confidence decays with anchor age, and the rung's provenance carries it:
  // past SPECULATIVE_ANCHOR_DAYS the answer is floored to the speculative
  // tier no matter how broad the basket, because a six-month-old anchor is
  // a guess with a method regardless of how well we measured the method.
  const breadthTerm = Math.min(1, index.basketSize / 20);
  const ageTerm = Math.max(0, 1 - anchorAgeDays / SPECULATIVE_ANCHOR_DAYS);
  const tierTerm = index.tierScope === "same-tier" ? 1 : 0.8;
  const raw = MAX_RUNG_CONFIDENCE * (0.4 + 0.3 * breadthTerm + 0.3 * ageTerm) * tierTerm;
  const confidence = speculative
    ? Math.min(SPECULATIVE_CONFIDENCE, Math.round(raw * 100) / 100)
    : Math.round(Math.min(MAX_RUNG_CONFIDENCE, raw) * 100) / 100;

  const pct = Math.round((index.ratio - 1) * 1000) / 10;
  const move = pct === 0 ? "flat" : `${pct > 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}%`;
  const tierNote = index.tierScope === "same-tier"
    ? `${index.tierLabel} cards`
    : `cards across all grades (too few ${input.tierLabel} cards to build a same-grade basket)`;

  // The basis states, in this order and in these words: the rung, the
  // anchor's age, and the ratio that carried it. Drew's wording.
  const basis =
    `Projected from ${index.playerName}'s market trend — `
    + `last direct sale ${anchorAgeWeeks} weeks ago at $${anchorPrice.toFixed(2)}, `
    + `carried forward by the player index ratio ${index.ratio.toFixed(3)}× `
    + `(${move} since that sale) over a basket of ${index.basketSize} liquid ${tierNote}`
    + (speculative
      ? `. Speculative: the anchor is ${anchorAgeDays} days old — this is today's market applied to an old print, not a recent trade.`
      : ".");

  logPlayerTrendPriced(input, index, anchorPrice, fairMarketValue, anchorAgeDays, speculative);

  return {
    fairMarketValue,
    rungLabel: "player-index-projection",
    confidence,
    speculative,
    basis,
    ratio: index.ratio,
    anchorPrice,
    anchorSoldAt: String(input.lastRealComp.soldAt),
    anchorAgeDays,
    anchorAgeWeeks,
    basketSize: index.basketSize,
    tierScope: index.tierScope,
    playerName: index.playerName,
    index,
  };
}

function logPlayerTrendPriced(
  input: PlayerTrendRungInput,
  index: PlayerIndexResult & { ok: true },
  anchorPrice: number,
  value: number,
  anchorAgeDays: number,
  speculative: boolean,
): void {
  try {
    console.log(JSON.stringify({
      event: "player_trend_rung_priced",
      source: "playerTrendRung.attemptPlayerTrendRung",
      slug: input.slug,
      playerName: index.playerName,
      tier: input.tierLabel,
      tierScope: index.tierScope,
      basketSize: index.basketSize,
      anchorPrice,
      anchorAgeDays,
      ratio: Math.round(index.ratio * 10_000) / 10_000,
      value,
      speculative,
    }));
  } catch { /* telemetry must never break a price */ }
}

function logPlayerTrendDecline(
  input: PlayerTrendRungInput,
  reason: string,
  freshCards: number,
): void {
  try {
    console.log(JSON.stringify({
      event: "player_trend_rung_declined",
      source: "playerTrendRung.attemptPlayerTrendRung",
      slug: input.slug,
      playerName: input.playerName ?? null,
      tier: input.tierLabel,
      reason,
      freshCards,
      detail: "fell through to the family / sibling rungs below",
    }));
  } catch { /* telemetry must never break a price */ }
}
