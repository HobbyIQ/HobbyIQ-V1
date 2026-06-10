/**
 * CF-PLAYER-IN-SET-MOMENTUM (2026-06-09): TrendIQ Layer 1 source.
 *
 * Replaces fetchPlayerSignals (player-wide compsMomentum.json blob) with
 * a LIVE per-(player, set) momentum signal computed from the
 * fetchCompsByPlayer pool. The blob is being retired as too coarse —
 * "Trout 2024 Topps Chrome" and "Trout 2024 Topps Update" share zero
 * driving forces but the blob blended them into one number.
 *
 * CF-PLAYER-IN-SET-PER-CARD-DIRECTION (2026-06-10): the aggregation is
 * NOW per-card direction, not pooled recent-vs-prior average. The prior
 * pooled implementation read 0.85 floor-falling for Griffin 2024 Bowman
 * Draft because the recent window happened to be cheap-base-skewed
 * vs the prior window's mix — that's MIX, not direction. Under per-
 * card semantics:
 *   - Each card's own recent-7 vs prior-7 MEDIAN ratio is computed.
 *   - The release signal is the MEDIAN of those per-card ratios.
 *   - Cards without ≥MIN_PER_WINDOW samples in BOTH windows are
 *     EXCLUDED — never fabricate direction from one window.
 *   - Need ≥MIN_QUALIFYING_CARDS qualifying cards to emit a signal;
 *     fewer → honest null (WEIGHT_TABLE renormalize).
 *
 * Pool source: fetchCompsByPlayer({ playerName, product, cardYear })
 *   - Same enumeration fetchSiblingSales uses (catalog + top-K
 *     getPricing fan-out, 6h compsByPlayer:v1 cache)
 *   - Does NOT exclude the exact card_id — siblings + the card itself
 *     are all "the player-in-set pool"
 *   - Grade-agnostic (broad set direction; raw + every graded tier)
 *
 * WEIGHT STAYS 0.30. The compsmomentum-weight-lock protects the WEIGHT,
 * not the input — this is an approved methodology / input change.
 */

import type { PlayerMomentumComponent } from "./trendIQ.types.js";
import { fetchCompsByPlayer, type CompByPlayer } from "./compsByPlayer.service.js";

export interface FetchPlayerInSetMomentumInput {
  playerName: string;
  product: string;
  cardYear?: number;
}

// Per-card window split.
const WINDOW_SIZE = 7;
const MIN_PER_WINDOW = 3;
// Minimum number of cards that must qualify (have ≥MIN_PER_WINDOW in
// BOTH recent and prior windows) before we emit a release signal. One
// card's ratio is too concentrated to call the release direction —
// better to omit honestly and let WEIGHT_TABLE renormalize.
const MIN_QUALIFYING_CARDS = 2;
const MULTIPLIER_LO = 0.85;
const MULTIPLIER_HI = 1.20;
const RISING_THRESHOLD = 1.08;
const FALLING_THRESHOLD = 0.93;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface PerCardRatio {
  cardId: string;
  ratio: number;
  recentMedian: number;
  priorMedian: number;
  recentN: number;
  priorN: number;
}

/** For a single card's sales (sorted desc by date upstream), split into
 *  recent-7 + prior-7, require ≥MIN_PER_WINDOW each side, return the
 *  card's recent-median / prior-median ratio. Null = card disqualified. */
function perCardRatio(
  cardId: string,
  salesDescByDate: readonly CompByPlayer[],
): PerCardRatio | null {
  const prices = salesDescByDate
    .filter((c) => Number.isFinite(c.price) && c.price > 0)
    .map((c) => c.price);
  const recent = prices.slice(0, Math.min(WINDOW_SIZE, prices.length));
  const prior = prices.slice(
    recent.length,
    recent.length + Math.min(WINDOW_SIZE, Math.max(0, prices.length - recent.length)),
  );
  if (recent.length < MIN_PER_WINDOW || prior.length < MIN_PER_WINDOW) return null;
  const recentMedian = median(recent);
  const priorMedian = median(prior);
  if (priorMedian <= 0) return null;
  return {
    cardId,
    ratio: recentMedian / priorMedian,
    recentMedian,
    priorMedian,
    recentN: recent.length,
    priorN: prior.length,
  };
}

export async function fetchPlayerInSetMomentum(
  input: FetchPlayerInSetMomentumInput,
): Promise<PlayerMomentumComponent | null> {
  const player = (input.playerName ?? "").trim();
  const product = (input.product ?? "").trim();
  if (!player || !product) {
    // Insufficient identity — omit honestly. WEIGHT_TABLE renormalize.
    return null;
  }

  let aggregate;
  try {
    aggregate = await fetchCompsByPlayer({
      playerName: player,
      product,
      cardYear: input.cardYear,
      // Grade-agnostic: broad set direction includes raw + every graded
      // tier. iOS sees a SINGLE Layer 1 across grade switches; that
      // matches the brief's "broad set direction" framing.
      gradeCompany: undefined,
      gradeValue: undefined,
    });
  } catch (err) {
    console.warn(
      `[playerInSetMomentum] fetchCompsByPlayer threw — omitting Layer 1: ${(err as Error)?.message ?? err}`,
    );
    return null;
  }

  const comps: CompByPlayer[] = aggregate.comps ?? [];
  if (comps.length === 0) {
    // TRUE MISS — honest no-momentum. Renormalize remaining weights.
    return null;
  }

  // Group by cardId, then sort each card's sales desc by date so the
  // newest land in the recent window.
  const byCard = new Map<string, CompByPlayer[]>();
  for (const c of comps) {
    if (!c.cardId) continue;
    if (!Number.isFinite(c.price) || c.price <= 0) continue;
    if (!c.date) continue;
    const arr = byCard.get(c.cardId) ?? [];
    arr.push(c);
    byCard.set(c.cardId, arr);
  }
  if (byCard.size === 0) return null;

  const perCard: PerCardRatio[] = [];
  for (const [cardId, sales] of byCard) {
    const sorted = sales.slice().sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    const r = perCardRatio(cardId, sorted);
    if (r) perCard.push(r);
  }

  if (perCard.length < MIN_QUALIFYING_CARDS) {
    // Not enough cards with both windows populated to call the release
    // direction. Honest omit; WEIGHT_TABLE renormalize.
    return null;
  }

  // Median of per-card ratios → robust to one card dominating volume
  // and immune to mix-skew (a cheap-base-skewed recent window can't
  // pull the release signal without each card's OWN sales moving).
  const aggregatedRatio = median(perCard.map((p) => p.ratio));
  const multiplier = clamp(aggregatedRatio, MULTIPLIER_LO, MULTIPLIER_HI);

  const direction =
    multiplier > RISING_THRESHOLD ? "rising"
    : multiplier < FALLING_THRESHOLD ? "falling"
    : "stable";

  return {
    multiplier: Math.round(multiplier * 1000) / 1000,
    flags: ["player_in_set", direction],
    componentSignals: {
      pool_size: comps.length,
      cards_in_pool: byCard.size,
      qualifying_cards: perCard.length,
      aggregated_ratio: Math.round(aggregatedRatio * 1000) / 1000,
      // Surface the per-card breakdown so the iOS / advisor surface can
      // show "3 of 5 cards down, 1 up, 1 stable" rather than just one
      // pooled number — the whole point of this CF.
      per_card_ratios: perCard.map((p) => ({
        cardId: p.cardId,
        ratio: Math.round(p.ratio * 1000) / 1000,
        recentMedian: Math.round(p.recentMedian * 100) / 100,
        priorMedian: Math.round(p.priorMedian * 100) / 100,
        recentN: p.recentN,
        priorN: p.priorN,
      })),
      sibling_card_ids_scanned: aggregate.cardIds.length,
    },
    lastUpdated: new Date().toISOString(),
    sourceUrl: null,
  };
}
