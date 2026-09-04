/**
 * CF-PLAYER-TREND-SPECULATION (Drew, 2026-09-02): "this is where
 * speculation comes from."
 *
 * A card whose own pool went cold two months ago is not worth what it sold
 * for two months ago. #1646 said so on the SCREEN — a chip beside the rung
 * reading "last sale N weeks ago". This module is the other half: saying it
 * in the NUMBER. When a card's own pool is stale AND its own trend is
 * unmeasurable, the price is the last real comp carried forward on the
 * PLAYER'S market:
 *
 *     value = lastRealComp × ( playerIndex(today) / playerIndex(compDate) )
 *
 * THE INDEX IS #1644's, SCOPED TO ONE PLAYER
 * ------------------------------------------
 * The math is NOT forked. `trendValue`, `computeWeights` and `indexLevel`
 * are imported from insights/marketIndex.service.ts — the fixed-liquid-
 * basket index Drew ruled on the same day — and this module only changes
 * the UNIVERSE they run over: instead of a sport's top ~100 cards by volume,
 * the basket is ONE PLAYER's liquid cards. Every property #1644 pinned
 * therefore holds here by construction:
 *
 *   - per-card v() is the projected next sale from that card's OWN pool
 *     (never a median — the golden rule);
 *   - weights are capped at MAX_CARD_WEIGHT and renormalized, so one
 *     thin-pool card cannot drive the ratio;
 *   - every term is a card's value RELATIVE TO ITSELF, which is what makes
 *     the level MIX-SHIFT IMMUNE: doubling the sale COUNT of the cheap end
 *     of the basket changes no v(c) and therefore changes no level. That
 *     property is inherited, and re-pinned here on the player basket
 *     (playerIndexSpeculationRung.test.ts) because it is the reason this
 *     rung can be trusted at all — a player index that moved when a $4
 *     common started printing sales would "prove" speculation that was
 *     really a feed change.
 *
 * NOT A NIGHTLY FLEET. Computed on demand from OUR pool (one bounded
 * sold_comps read per player, memoized briefly in-process). Nothing is
 * persisted; no container, no job, no basket doc. Drew's scope for this
 * round is explicit about that.
 *
 * WHY TWO LEVELS AND NOT A SLOPE
 * ------------------------------
 * The rung needs the market's move BETWEEN two dates, not a rate. Fitting a
 * rate and extrapolating would compound: a player up 20% over six weeks and
 * flat since would keep climbing forever. Reading the index AT the comp's
 * date and AT today asks the only question that matters — "what has this
 * player's market done since this card last traded?" — and stops there.
 *
 * THE GUARDS (each one pinned, and each one FALLS THROUGH, never clamps)
 * ---------------------------------------------------------------------
 * 1. BREADTH FLOOR (MIN_BASKET_CARDS = 5). A player needs at least five
 *    cards with FRESH sales before their "market" is a thing that exists.
 *    Below that the "index" is one or two cards wearing a player's name and
 *    the ratio is that card's noise, not a market. Fall through to the
 *    family/sibling rungs, which at least say what they are.
 *
 * 2. TIER AWARENESS (MIN_TIER_BASKET_CARDS = 3). Raw and PSA 10 markets for
 *    the same player do not move together — graded supply is fixed and
 *    slabs chase population reports, raw chases the player. So the basket is
 *    built from the TARGET'S OWN GRADE TIER when at least three of the
 *    player's liquid cards trade in it. Below three, all tiers are used and
 *    the note SAYS SO (`tierScope: "all-tiers"`), because a disclosed
 *    cross-tier read is honest and a silent one is not.
 *
 * 3. PRICE-BAND WEIGHTING (BAND_DECADES / MIN_BAND_WEIGHT). A player's $8
 *    base cards and their $4,000 1/1 do not share a beta: commons track
 *    print-run supply and the sub-$20 floor, high-end chases the player's
 *    narrative and moves several times as hard. An unweighted player index
 *    would therefore carry a 1/1 on the trend of a pile of commons.
 *
 *    So each basket member's #1644 value-weight is multiplied by a
 *    proximity factor in LOG10 PRICE space:
 *
 *        bandFactor(c) = max( MIN_BAND_WEIGHT,
 *                             1 - |log10(base(c)) - log10(target)| / BAND_DECADES )
 *
 *    Log space is the right space because price bands are multiplicative:
 *    $10 is as far from $100 as $100 is from $1,000, and a linear distance
 *    would collapse every card under $500 into "basically the same as the
 *    $4,000 one". BAND_DECADES = 1.5 means a card one and a half decades
 *    away (say $30 against a $1,000 target) has fallen to the floor;
 *    MIN_BAND_WEIGHT = 0.1 is a floor, not a cut, so a thin basket keeps its
 *    breadth — a distant card still contributes a tenth rather than
 *    vanishing and pushing the basket back under the floor of guard 1.
 *    The factor multiplies the capped value-weight and the product is
 *    renormalized, so guard 1's breadth and #1644's cap both survive it.
 *
 * 4. CONFIDENCE DECAYS WITH ANCHOR AGE, and the rung carries it. An anchor
 *    past SPECULATIVE_ANCHOR_DAYS (180d) is not a price with a correction
 *    on it, it is a guess with a method: confidence is floored to
 *    SPECULATIVE_CONFIDENCE and the basis says "speculative" in those words.
 *
 * NEVER CLAMPED. The ratio is reported as computed. If a player's market
 * tripled, the card tripled. Clamping here would be the same error as
 * clamping a grade inversion (feedback: grade monotonicity is NOT an
 * invariant — observe it, never clamp it). The guards decide WHETHER the
 * rung answers; they never edit the answer.
 */
import {
  MAX_CARD_WEIGHT,
  computeWeights,
  indexLevel,
  trendValue,
} from "../insights/marketIndex.service.js";
import { readPlayerPoolRows, type PlayerPoolRow } from "./playerIndexRead.js";
import { asOfCutoffString } from "./asOfCutoff.js";
import { UNKNOWN_GRADER_TIER } from "./unifiedPricing.service.js";

/** A player needs this many cards with fresh sales before they have a
 *  "market" the rung is willing to speak for. */
export const MIN_BASKET_CARDS = 5;

/** Below this many same-tier liquid cards, the basket crosses tiers — and
 *  the note discloses that it did. */
export const MIN_TIER_BASKET_CARDS = 3;

/** A sale is "fresh" inside this window — the same 45d line #1646 drew for
 *  staleness, so the two halves of the ruling cannot disagree about what
 *  "cold" means. */
export const FRESH_SALE_DAYS = 45;

/** How far back the basket reads to build its per-card series. */
export const BASKET_WINDOW_DAYS = 180;

/** Trailing window used to value a basket member on a given day —
 *  #1644's VALUE_WINDOW_DAYS is 14d for a daily series; a player basket is
 *  thinner than a sport's top-100, so it reads a wider window to get a
 *  fittable series per member. */
export const MEMBER_VALUE_WINDOW_DAYS = 30;

/** Log10 decades of price distance at which a basket member's band factor
 *  reaches the floor. */
export const BAND_DECADES = 1.5;

/** Floor for the price-band factor: distant cards are damped, never cut. */
export const MIN_BAND_WEIGHT = 0.1;

/** Past this anchor age the rung is speculation, and says so. */
export const SPECULATIVE_ANCHOR_DAYS = 180;

/** Confidence ceiling for a speculative-tier answer. */
export const SPECULATIVE_CONFIDENCE = 0.2;

/** Confidence ceiling for the rung at its best — it is still a projection
 *  over a stale anchor, so it never reaches an exact-pool number. */
export const MAX_RUNG_CONFIDENCE = 0.45;

const DAY_MS = 86_400_000;

export type TierScope = "same-tier" | "all-tiers";

export interface PlayerBasketMember {
  cardId: string;
  /** Value at the anchor date — the weighting basis and the ratio's base. */
  baseValue: number;
  /** Post-cap, post-band, renormalized weight. Sums to 1 across the basket. */
  weight: number;
  /** #1644's capped value weight, before the price-band factor. */
  valueWeight: number;
  /** The price-band proximity factor applied to it. */
  bandFactor: number;
  /** Sales inside the basket window. */
  sales: number;
  /** Value today. */
  todayValue: number;
}

export interface PlayerIndexRatio {
  /** playerIndex(today) / playerIndex(anchorDate). 1.0 = flat. */
  ratio: number;
  levelToday: number;
  levelAtAnchor: number;
  basket: PlayerBasketMember[];
  basketSize: number;
  tierScope: TierScope;
  /** The tier the basket was built from, when tierScope is same-tier. */
  tierLabel: string | null;
  playerName: string;
}

/** Why the rung could not answer. Every value here is a FALL-THROUGH: the
 *  ladder continues to the family/sibling rungs below. */
export type PlayerIndexDeclineReason =
  | "no-player-name"
  | "pool-unavailable"
  | "insufficient-breadth"
  | "no-level-at-anchor"
  | "no-level-today";

export interface PlayerIndexDecline {
  ok: false;
  reason: PlayerIndexDeclineReason;
  /** Cards with fresh sales that were found, for the log. */
  freshCards: number;
}

export type PlayerIndexResult = ({ ok: true } & PlayerIndexRatio) | PlayerIndexDecline;

interface MemberSeries {
  cardId: string;
  rows: Array<{ price: number; soldAt: string; ms: number }>;
  freshSales: number;
}

/** The grade tier a row trades in, in the engine's vocabulary ("Raw", "PSA 10").
 *
 *  CF-A-GRADED-SALE-NEVER-ENTERS-THE-RAW-TIER (Drew, 2026-09-04): the same
 *  defect `unifiedPricing.gradeLabel` carried, in the index's own copy of the
 *  predicate. A missing `gradeCompany` is an ABSENCE, not a claim of rawness;
 *  a row that carries a grade VALUE is a graded sale whose grader was never
 *  recorded, and it must not join a raw basket — the index's liquid-Raw
 *  baskets are exactly where a stray graded sale distorts the ratio. It gets
 *  the unmatchable tier instead, so it is excluded rather than deleted. */
export function rowTierLabel(row: { gradeCompany: string | null; gradeValue: number | null }): string {
  const company = String(row.gradeCompany ?? "").trim();
  // `Number(null)` is 0 and `Number("")` is 0 — both finite — so an ABSENT
  // grade must be rejected before the numeric parse, or a genuinely raw row
  // reads as "graded 0" and is evicted from its own tier. Absence first,
  // parse second.
  const raw = row.gradeValue as unknown;
  const value = raw === null || raw === undefined || raw === ""
    ? NaN
    : (typeof raw === "number" ? raw : Number(raw));
  const hasValue = Number.isFinite(value);
  if (!company) return hasValue ? UNKNOWN_GRADER_TIER : "Raw";
  return `${company.toUpperCase()} ${hasValue ? String(value) : "?"}`;
}

/**
 * The price-band proximity factor for a basket member, in log10 price space.
 * See guard 3 in the header for why log space and why a floor, not a cut.
 */
export function priceBandFactor(
  memberValue: number,
  targetValue: number,
  opts: { decades?: number; floor?: number } = {},
): number {
  const decades = opts.decades ?? BAND_DECADES;
  const floor = opts.floor ?? MIN_BAND_WEIGHT;
  if (!(memberValue > 0) || !(targetValue > 0) || !(decades > 0)) return floor;
  const distance = Math.abs(Math.log10(memberValue) - Math.log10(targetValue));
  return Math.max(floor, 1 - distance / decades);
}

/**
 * Group a player's rows into per-card series, keeping only cards with at
 * least one FRESH sale — a card whose own pool is as cold as the target's
 * cannot testify to today's market.
 */
export function buildMemberSeries(
  rows: readonly PlayerPoolRow[],
  opts: { nowMs: number; excludeCardIds?: ReadonlySet<string>; freshDays?: number },
): MemberSeries[] {
  const freshCutoff = opts.nowMs - (opts.freshDays ?? FRESH_SALE_DAYS) * DAY_MS;
  const exclude = opts.excludeCardIds ?? new Set<string>();
  const byCard = new Map<string, MemberSeries>();
  for (const r of rows) {
    const cardId = String(r.hobbyiqCardId ?? r.cardId ?? "").trim();
    if (!cardId || exclude.has(cardId)) continue;
    const price = Number(r.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const ms = Date.parse(String(r.soldAt));
    if (!Number.isFinite(ms)) continue;
    let s = byCard.get(cardId);
    if (!s) { s = { cardId, rows: [], freshSales: 0 }; byCard.set(cardId, s); }
    s.rows.push({ price, soldAt: String(r.soldAt), ms });
    if (ms >= freshCutoff) s.freshSales++;
  }
  const out: MemberSeries[] = [];
  for (const s of byCard.values()) {
    if (s.freshSales <= 0) continue;
    s.rows.sort((a, b) => a.ms - b.ms);
    out.push(s);
  }
  // Deterministic order: most liquid first, cardId as the stable tiebreak —
  // the same rule #1644's selectBasket uses, for the same reason.
  out.sort((a, b) => (b.rows.length !== a.rows.length
    ? b.rows.length - a.rows.length
    : (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0)));
  return out;
}

/** A member's value on a day: #1644's trendValue over its trailing window. */
function memberValueOn(series: MemberSeries, atMs: number, windowDays: number): number {
  const from = atMs - windowDays * DAY_MS;
  const prices = series.rows.filter((r) => r.ms >= from && r.ms <= atMs).map((r) => r.price);
  if (prices.length > 0) return trendValue(prices);
  // Carry forward the last value observed before the day — #1644's rule:
  // a member never drops out, because dropping it IS a mix change.
  const prior = series.rows.filter((r) => r.ms <= atMs);
  if (prior.length === 0) return 0;
  return trendValue(prior.slice(-Math.max(1, prices.length || 3)).map((r) => r.price));
}

/**
 * THE COMPUTATION. Pure: rows in, ratio out. No Cosmos, no clock of its own.
 *
 * `anchorMs` is when the stale card last really traded; `nowMs` is today.
 * The ratio is the player's index level at the second over its level at the
 * first, on ONE frozen basket — the same members, the same weights, read at
 * two times. Freezing membership across the two reads is what makes the
 * ratio a MARKET move rather than a membership change.
 */
export function computePlayerIndexRatio(
  rows: readonly PlayerPoolRow[],
  opts: {
    playerName: string;
    nowMs: number;
    anchorMs: number;
    /** The stale card's own value — the price band the basket weights toward. */
    targetValue: number;
    /** The stale card's tier; the basket prefers members trading in it. */
    tierLabel?: string | null;
    /** The stale card itself, never a member of its own basket. */
    excludeCardIds?: ReadonlySet<string>;
    minBasketCards?: number;
  },
): PlayerIndexResult {
  const minBasket = opts.minBasketCards ?? MIN_BASKET_CARDS;

  // Tier awareness (guard 2): prefer the target's own tier, and only cross
  // tiers when the same-tier basket cannot reach MIN_TIER_BASKET_CARDS.
  const wantTier = String(opts.tierLabel ?? "").trim() || null;
  const sameTierRows = wantTier ? rows.filter((r) => rowTierLabel(r) === wantTier) : [];
  const sameTierSeries = wantTier
    ? buildMemberSeries(sameTierRows, { nowMs: opts.nowMs, excludeCardIds: opts.excludeCardIds })
    : [];
  const useSameTier = wantTier !== null && sameTierSeries.length >= MIN_TIER_BASKET_CARDS;
  const tierScope: TierScope = useSameTier ? "same-tier" : "all-tiers";
  const series = useSameTier
    ? sameTierSeries
    : buildMemberSeries(rows, { nowMs: opts.nowMs, excludeCardIds: opts.excludeCardIds });

  // Breadth floor (guard 1). Below it there is no market to speak for.
  if (series.length < minBasket) {
    return { ok: false, reason: "insufficient-breadth", freshCards: series.length };
  }

  const baseValues = series.map((s) => memberValueOn(s, opts.anchorMs, MEMBER_VALUE_WINDOW_DAYS));
  const todayValues = series.map((s) => memberValueOn(s, opts.nowMs, MEMBER_VALUE_WINDOW_DAYS));

  // Drop members with no value at the anchor: they cannot contribute a
  // ratio (there is no "before" to compare a "now" against).
  const keep: number[] = [];
  for (let i = 0; i < series.length; i++) {
    if (baseValues[i] > 0 && todayValues[i] > 0) keep.push(i);
  }
  if (keep.length < minBasket) {
    return { ok: false, reason: "insufficient-breadth", freshCards: keep.length };
  }

  const kept = keep.map((i) => series[i]);
  const keptBase = keep.map((i) => baseValues[i]);
  const keptToday = keep.map((i) => todayValues[i]);

  // #1644's capped value weights, then the price-band factor (guard 3),
  // then renormalize. The cap is applied FIRST so a single expensive card
  // still cannot exceed MAX_CARD_WEIGHT of the raw value mass before the
  // band factor damps it further.
  const valueWeights = computeWeights(keptBase, MAX_CARD_WEIGHT);
  const bandFactors = keptBase.map((v) => priceBandFactor(v, opts.targetValue));
  const blended = valueWeights.map((w, i) => w * bandFactors[i]);
  const blendedSum = blended.reduce((s, w) => s + w, 0);
  const weights = blendedSum > 0
    ? blended.map((w) => w / blendedSum)
    : valueWeights;

  const members = kept.map((s, i) => ({ weight: weights[i], baseValue: keptBase[i] }));

  // #1644's indexLevel, read at two times over the SAME frozen basket. By
  // construction levelAtAnchor is BASE_LEVEL (every term is base/base = 1);
  // it is computed rather than assumed so the ratio stays honest if the
  // upstream formula ever changes.
  const levelAtAnchor = indexLevel(members, keptBase);
  const levelToday = indexLevel(members, keptToday);
  if (!(levelAtAnchor > 0)) return { ok: false, reason: "no-level-at-anchor", freshCards: kept.length };
  if (!(levelToday > 0)) return { ok: false, reason: "no-level-today", freshCards: kept.length };

  return {
    ok: true,
    ratio: levelToday / levelAtAnchor,
    levelToday,
    levelAtAnchor,
    basketSize: kept.length,
    tierScope,
    tierLabel: useSameTier ? wantTier : null,
    playerName: opts.playerName,
    basket: kept.map((s, i) => ({
      cardId: s.cardId,
      baseValue: Math.round(keptBase[i] * 100) / 100,
      weight: weights[i],
      valueWeight: valueWeights[i],
      bandFactor: bandFactors[i],
      sales: s.rows.length,
      todayValue: Math.round(keptToday[i] * 100) / 100,
    })),
  };
}

// ─── On-demand read + a short in-process memo ───────────────────────────
//
// Not a nightly fleet (Drew's scope). One bounded sold_comps read per
// (player, sport), memoized for MEMO_TTL_MS so a portfolio page that prices
// twenty cards of the same player does one read, not twenty. The memo is
// process-local and expires; nothing is persisted.

const MEMO_TTL_MS = 5 * 60_000;
const memo = new Map<string, { at: number; rows: PlayerPoolRow[] | null }>();

/** Test seam: drop the memo between cases. */
export function _clearPlayerIndexMemo(): void { memo.clear(); }

async function readPlayerRowsMemoized(
  playerName: string,
  sport: string | null,
  nowMs: number,
  asOfMs: number | null,
): Promise<PlayerPoolRow[] | null> {
  // CF-AS-OF-IS-AN-UPPER-BOUND (#1651). The as-of instant is part of the KEY,
  // not just of the query. A backtest prices many evaluation points for the
  // same player at different past instants, and they arrive milliseconds apart
  // in wall-clock time — so a memo keyed on (player, sport) alone would serve
  // the FIRST point's basket to every later one. Whether that leaks the future
  // then depends on the order the sample happens to be walked in, which is the
  // worst possible property for a correctness guarantee to have: it would pass
  // a test, pass a canary, and silently inflate a published number.
  //
  // Keying on asOfMs makes each evaluation point's basket its own cache entry.
  // In production asOfMs is null, the key is what it always was, and the
  // portfolio page still does one read for twenty cards of the same player.
  const key = `${playerName.toLowerCase()}::${(sport ?? "").toLowerCase()}::${asOfMs ?? "live"}`;
  const hit = memo.get(key);
  // The TTL is a wall-clock freshness rule, so it applies only to the live
  // entry. An as-of basket is immutable by construction — the window it reads
  // is closed at both ends and cannot acquire new rows — so it never expires
  // within a run.
  if (hit && (asOfMs !== null || nowMs - hit.at < MEMO_TTL_MS)) return hit.rows;
  const fromIso = new Date(nowMs - BASKET_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = await readPlayerPoolRows({
    playerName,
    sport,
    fromIso,
    // asOfCutoffString, not toISOString: `soldAt` is compared as a string and
    // the pool stores one instant three ways. See asOfCutoff.ts.
    asOfIso: asOfMs !== null ? asOfCutoffString(asOfMs) : null,
  });
  memo.set(key, { at: nowMs, rows });
  return rows;
}

/**
 * The player's index ratio between the anchor sale and today, read on
 * demand from our pool. Declines (never throws) on every guard.
 */
export async function playerIndexRatio(input: {
  playerName: string | null | undefined;
  sport?: string | null;
  nowMs: number;
  anchorMs: number;
  targetValue: number;
  tierLabel?: string | null;
  excludeCardIds?: ReadonlySet<string>;
  /** CF-AS-OF-IS-AN-UPPER-BOUND (#1651). Backtest only: the basket may read
   *  no sale at or after this instant. Null / absent in production. */
  asOfMs?: number | null;
}): Promise<PlayerIndexResult> {
  const playerName = String(input.playerName ?? "").trim();
  if (!playerName) return { ok: false, reason: "no-player-name", freshCards: 0 };
  let rows: PlayerPoolRow[] | null;
  try {
    rows = await readPlayerRowsMemoized(
      playerName,
      input.sport ?? null,
      input.nowMs,
      input.asOfMs ?? null,
    );
  } catch { rows = null; }
  if (rows === null) return { ok: false, reason: "pool-unavailable", freshCards: 0 };
  return computePlayerIndexRatio(rows, {
    playerName,
    nowMs: input.nowMs,
    anchorMs: input.anchorMs,
    targetValue: input.targetValue,
    tierLabel: input.tierLabel ?? null,
    excludeCardIds: input.excludeCardIds,
  });
}
