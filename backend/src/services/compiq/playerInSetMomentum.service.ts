/**
 * CF-PLAYER-IN-SET-MOMENTUM (2026-06-09): TrendIQ Layer 1 source.
 *
 * Replaces fetchPlayerSignals (player-wide compsMomentum.json blob) with
 * a LIVE per-(player, set) momentum signal computed from the
 * fetchCompsByPlayer pool. The blob is being retired as too coarse —
 * "Trout 2024 Topps Chrome" and "Trout 2024 Topps Update" share zero
 * driving forces but the blob blended them into one number.
 *
 * Pool source: fetchCompsByPlayer({ playerName, product, cardYear })
 *   - Same enumeration fetchSiblingSales uses (catalog + top-K
 *     getPricing fan-out, 6h compsByPlayer:v1 cache)
 *   - Does NOT exclude the exact card_id — siblings + the card itself
 *     are all "the player-in-set pool"
 *   - Grade-agnostic (broad set direction; raw + every graded tier)
 *
 * Compute: faithful mirror of fn-comps-momentum/build_comps_payload —
 *   - sort sales by date desc
 *   - take first 7 as `recent`, next 7 as `prior`
 *   - ratio = recent_avg / prior_avg
 *   - clamp [0.85, 1.20]
 *   - thresholds: > 1.08 = rising, < 0.93 = falling, else stable
 *
 * WEIGHT STAYS 0.30. The compsmomentum-weight-lock protects the WEIGHT,
 * not the input — this is an approved methodology / input change.
 *
 * Honest omit (returns null) when:
 *   - playerName or product is missing on cardIdentity
 *   - fetchCompsByPlayer returns 0 sales
 *   - recent or prior window can't form ≥3 samples each
 * Existing TrendIQ WEIGHT_TABLE renormalizes when Layer 1 is null
 * (key flips from "1**" to "0**"). NEVER falls back to the deprecated
 * player-wide blob — that signal is being retired.
 */

import type { PlayerMomentumComponent } from "./trendIQ.types.js";
import { fetchCompsByPlayer, type CompByPlayer } from "./compsByPlayer.service.js";

export interface FetchPlayerInSetMomentumInput {
  playerName: string;
  product: string;
  cardYear?: number;
}

// Mirror fn-comps-momentum/build_comps_payload exactly.
const WINDOW_SIZE = 7;
const TOP_N_BY_DATE = 25;
const MULTIPLIER_LO = 0.85;
const MULTIPLIER_HI = 1.20;
const RISING_THRESHOLD = 1.08;
const FALLING_THRESHOLD = 0.93;
const MIN_PER_WINDOW = 3;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
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

  // Sort by date desc; "most recent" wins the recent window.
  const sorted = comps
    .filter((c) => Number.isFinite(c.price) && c.price > 0 && c.date)
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a.date) || 0;
      const tb = Date.parse(b.date) || 0;
      return tb - ta;
    })
    .slice(0, TOP_N_BY_DATE);

  if (sorted.length === 0) {
    return null;
  }

  const prices = sorted.map((c) => c.price);
  const recent = prices.slice(0, Math.min(WINDOW_SIZE, prices.length));
  const prior = prices.slice(
    recent.length,
    recent.length + Math.min(WINDOW_SIZE, Math.max(0, prices.length - recent.length)),
  );

  if (recent.length < MIN_PER_WINDOW || prior.length < MIN_PER_WINDOW) {
    // Not enough samples either side to form a meaningful recent-vs-
    // prior split — omit honestly. WEIGHT_TABLE renormalize.
    return null;
  }

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
  const ratio = priorAvg > 0 ? recentAvg / priorAvg : 1.0;
  const multiplier = clamp(ratio, MULTIPLIER_LO, MULTIPLIER_HI);

  const direction =
    multiplier > RISING_THRESHOLD ? "rising"
    : multiplier < FALLING_THRESHOLD ? "falling"
    : "stable";

  return {
    multiplier: Math.round(multiplier * 1000) / 1000,
    flags: ["player_in_set", direction],
    componentSignals: {
      pool_size: sorted.length,
      recent_count: recent.length,
      prior_count: prior.length,
      recent_avg: Math.round(recentAvg * 100) / 100,
      prior_avg: Math.round(priorAvg * 100) / 100,
      sibling_card_ids_scanned: aggregate.cardIds.length,
    },
    lastUpdated: new Date().toISOString(),
    sourceUrl: null,
  };
}
