/**
 * H-13 (audit 2026-09-03). The player side of the sell-window signal, measured
 * with the real #1644/#1647 machinery.
 *
 * `deriveSellWindowSignal` is pure and synchronous on purpose — the portfolio
 * envelope derives a signal for every holding it renders and has never
 * computed a price. So the index, which costs one bounded pool read, is
 * measured HERE by the callers that can afford it and handed in.
 *
 * The ratio is `playerIndex(today) / playerIndex(anchor)` over a fixed liquid
 * basket of the player's OTHER cards, each valued as the projected next sale
 * from its own pool. It is unclamped, and the basket's own guards (breadth
 * floor, tier awareness, price-band weighting) all FALL THROUGH rather than
 * clamp: below the breadth floor this returns null and the signal refuses,
 * which is the honest answer.
 *
 * The anchor is the trend's own measurement window — the same ~30 days the
 * card-trajectory side compares against — so the two sides of the divergence
 * are read over comparable spans. Reading the player over a different horizon
 * than the card would manufacture divergence out of the mismatch alone.
 */
import { playerIndexRatio } from "../compiq/playerIndex.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The window the card-trajectory side compares across, in days. */
export const SELL_WINDOW_INDEX_ANCHOR_DAYS = 30;

export interface SellWindowPlayerIndexInput {
  playerName: string | null | undefined;
  sport?: string | null;
  /** The holding's own value — the price band the basket weights toward. */
  targetValue: number | null | undefined;
  /** "Raw" | "PSA 10" — the tier the basket prefers. */
  tierLabel?: string | null;
  /** The card itself is never a member of its own basket. */
  excludeCardIds?: ReadonlySet<string>;
  nowMs?: number;
}

/**
 * The index ratio for a holding, or null when the player's market cannot be
 * measured. Never throws: every failure is a null, and a null is a refusal the
 * signal states in words.
 */
export async function sellWindowPlayerIndex(
  input: SellWindowPlayerIndexInput,
): Promise<{ ratio: number; basketSize: number; tierScope: string | null } | null> {
  const playerName = String(input.playerName ?? "").trim();
  const targetValue = typeof input.targetValue === "number" && Number.isFinite(input.targetValue)
    ? input.targetValue
    : 0;
  if (!playerName || !(targetValue > 0)) return null;
  const nowMs = input.nowMs ?? Date.now();
  try {
    const res = await playerIndexRatio({
      playerName,
      sport: input.sport ?? null,
      nowMs,
      anchorMs: nowMs - SELL_WINDOW_INDEX_ANCHOR_DAYS * DAY_MS,
      targetValue,
      tierLabel: input.tierLabel ?? null,
      excludeCardIds: input.excludeCardIds,
    });
    if (!res.ok) return null;
    return { ratio: res.ratio, basketSize: res.basketSize, tierScope: res.tierScope };
  } catch { return null; }
}
