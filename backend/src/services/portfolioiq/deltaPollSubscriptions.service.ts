// CF-CH-DELTA-POLL-HOLDINGS-SUBSCRIBE (2026-06-30) — connects
// portfolioStore.addHolding / updateHolding to the CardHedge subscription
// pipeline shipped in PR #211. Fire-and-forget: a subscribe failure
// must NEVER block a holding save (we still serve iOS the success
// response; the worst case is the delta poll doesn't fire for that
// holding until the next migration sweep).
//
// Same env gating as the delta-poll worker:
//   CARD_HEDGE_CLIENT_ID  must be set (Drew gets this from CH)
//   subscribePriceUpdates internally checks and skips if absent.
//
// EXTERNAL_ID FORMAT
// We pass external_id = "<userId>:<holdingId>" so a future reverse-map
// CF can look up the affected portfolio when a price update arrives.
// CH echoes this string back in the subscription response (NOT the
// price-update feed — the update feed has only card-level fields, so
// reverse-mapping uses (cardId, grade) against our local subscription
// index, not external_id). The userId in external_id is still useful
// for CH-side debugging + audit.

import { subscribePriceUpdates } from "../compiq/cardhedge.client.js";
import type { PortfolioHolding } from "../../types/portfolioiq.types.js";

/**
 * Derive the CH grade string from a PortfolioHolding's structured grade
 * fields. Mirrors the convention used elsewhere in the engine: PSA 10,
 * BGS 9.5, SGC 10, CGC 9, Raw (when ungraded). Returns null when the
 * fields don't yield a usable grade — in which case we don't subscribe.
 */
export function gradeStringFromHolding(holding: PortfolioHolding): string | null {
  const company = String(holding.gradingCompany ?? "").trim().toUpperCase();
  const value = holding.gradeValue;
  if (!company || value == null) {
    // Truly raw / ungraded — subscribe as Raw so CH tracks Raw sales of
    // this card too. Useful because raw activity often LEADS graded.
    return "Raw";
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  // CH's grade convention is "PSA 10" / "BGS 9.5". Drop trailing .0 for
  // whole-number grades.
  const valStr = Number.isInteger(value) ? String(value) : String(value);
  return `${company} ${valStr}`;
}

/** Pull the (cardId, grade, externalId) tuple from a holding, or null
 *  when the holding lacks identity (no cardsightCardId / no usable
 *  grade derivation). Skipping is silent — callers don't need to
 *  branch on a missing identity, the wrapper itself short-circuits. */
export function subscriptionItemFromHolding(
  userId: string,
  holding: PortfolioHolding,
): { cardId: string; grade: string; externalId: string } | null {
  const cardId = String(holding.cardsightCardId ?? "").trim();
  if (!cardId) return null;
  const grade = gradeStringFromHolding(holding);
  if (!grade) return null;
  return {
    cardId,
    grade,
    externalId: `${userId}:${holding.id}`,
  };
}

/**
 * Fire-and-forget: subscribe a single holding to CH's delta-poll feed.
 * Returns nothing — caller doesn't need to await beyond the
 * subscribePriceUpdates call returning. Non-fatal on any failure:
 *   - Missing cardsightCardId or unparseable grade → silent skip
 *   - subscribePriceUpdates returning null (no client_id) → silent skip
 *   - HTTP / network failure inside the wrapper → already logged by the
 *     CH client; no propagation to the caller.
 */
export async function subscribeHoldingToDeltaPoll(
  userId: string,
  holding: PortfolioHolding,
): Promise<void> {
  try {
    const item = subscriptionItemFromHolding(userId, holding);
    if (!item) return;
    await subscribePriceUpdates([item]);
  } catch (err) {
    console.warn(
      `[deltaPollSubscriptions] subscribe failed for userId=${userId} holdingId=${holding.id} (non-fatal):`,
      (err as Error)?.message ?? err,
    );
  }
}

/**
 * Detect whether an update changed the subscription identity (cardId or
 * grade). When false, we skip re-subscribing — saves a CH call on edits
 * that don't affect price tracking (quantity bumps, photos, notes).
 */
export function holdingSubscriptionChanged(
  previous: PortfolioHolding | undefined,
  next: PortfolioHolding,
): boolean {
  if (!previous) return true;  // brand-new on this code path = changed
  const prevCardId = String(previous.cardsightCardId ?? "").trim();
  const nextCardId = String(next.cardsightCardId ?? "").trim();
  if (prevCardId !== nextCardId) return true;
  const prevGrade = gradeStringFromHolding(previous);
  const nextGrade = gradeStringFromHolding(next);
  return prevGrade !== nextGrade;
}

/**
 * Batch-subscribe a list of holdings (e.g., on migration of an existing
 * user's portfolio). Splits into the CH 100-item chunks via the
 * underlying wrapper. Skips holdings without identity.
 *
 * Returns the count of items actually sent + the count successfully
 * subscribed per CH. Useful for runbook-driven manual migrations.
 */
export async function batchSubscribeHoldings(
  items: Array<{ userId: string; holding: PortfolioHolding }>,
): Promise<{ submitted: number; subscribed: number }> {
  const valid = items
    .map(({ userId, holding }) => subscriptionItemFromHolding(userId, holding))
    .filter((x): x is { cardId: string; grade: string; externalId: string } => x != null);
  if (valid.length === 0) return { submitted: 0, subscribed: 0 };
  try {
    const result = await subscribePriceUpdates(valid);
    if (!result) return { submitted: valid.length, subscribed: 0 };  // dormant / no client_id
    return { submitted: valid.length, subscribed: result.total_successful };
  } catch (err) {
    console.warn(
      "[deltaPollSubscriptions] batch subscribe threw (non-fatal):",
      (err as Error)?.message ?? err,
    );
    return { submitted: valid.length, subscribed: 0 };
  }
}
