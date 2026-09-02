/**
 * CF-PLAYER-TREND-SPECULATION (Drew, 2026-09-02). The one definition of
 * "this pool has gone cold", shared by the two halves of the ruling.
 *
 * #1646 drew the line first, in apps/web/src/lib/rung.ts, for the CHIP:
 * past 45 days a second chip appears beside the rung reading "last sale N
 * weeks ago — priced to today's market". That copy is a promise about the
 * NUMBER, and CF-PLAYER-TREND-SPECULATION is the rung that keeps it.
 *
 * The two must use the SAME threshold or the product contradicts itself: a
 * card at 50 days would wear the chip while the number behind it was still
 * the old comp, or the number would move on a card the UI called fresh. So
 * the value lives here, the web's constant is pinned equal to it by
 * staleCompThreshold.test.ts, and neither side may change it alone.
 *
 * WHY 45 (#1646's reasoning, unchanged): inside Drew's ~30-60d band, picked
 * off the shape of the data rather than the middle of the range. A card that
 * trades monthly has a comp inside 30 days on a normal week, so a 30d line
 * would fire on ordinary cards between sales and stop meaning anything. Past
 * ~6 weeks the pool has genuinely stopped tracking the market.
 */

/** Days past which the newest direct comp is too old to BE the price. */
export const STALE_COMP_DAYS = 45;
