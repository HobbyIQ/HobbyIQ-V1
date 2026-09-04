// CF-MARKET-INDEXES (Drew, 2026-09-04). The strip's DECISIONS, split out
// of the component so they can be pinned by the node-only vitest lane
// (vitest.config.mts is `environment: "node"`, `src/**/*.test.ts` — no
// DOM, no React). The component renders; this file decides. The rules
// here are doctrine, not styling:
//
//   1. The strip disappears ONLY when the index capability is absent
//      (404/501). A 401, 402, 5xx, timeout or network failure is a
//      transient or gating condition and says so on screen. Returning
//      null for those is what made a live, working strip on /app/daily
//      look like a feature that had never been built.
//
//   2. A sport whose window is entirely levelless is WITHHELD, not
//      missing. It keeps its tile and the tile says why there is no
//      number. Dropping it made "we did not price this" indistinguishable
//      from "this sport does not exist" — pokemon was 180/180 levelless
//      on 2026-09-04 and simply vanished.
//
//   3. A partial response never blanks the strip. Three published sports
//      and two withheld ones is a five-tile strip, not an empty one.

import type { SportIndexSeries } from "./api";

/** Loading, loaded, transiently failed, or capability-absent. */
export type StripStatus = "loading" | "ok" | "error" | "absent";

/** Enough points to draw a line and quote a change. */
export function plottable(d: SportIndexSeries): boolean {
  return Array.isArray(d.series) && d.series.length >= 2;
}

/**
 * A sport we track and deliberately did not price: the backend wrote a
 * point but withheld its level, or carried a prior one. Distinct from a
 * sport that was simply never computed, which carries neither.
 */
export function isWithheld(d: SportIndexSeries): boolean {
  return d.stale === true || (d.withheldReason != null && d.withheldReason !== "");
}

/**
 * Tile copy for a withheld sport. `series_start` / `no_basket` mean the
 * basket itself could not be formed, so there is no number at all;
 * anything else means there IS a prior level and it is being carried.
 * Never invent a level for the first two.
 */
export function withheldCopy(d: SportIndexSeries): string {
  if (d.withheldReason === "series_start" || d.withheldReason === "no_basket") {
    return "Not enough sales to price";
  }
  return "Carried · basket too thin";
}

/** Sports that earn a tile: anything plottable, plus anything withheld. */
export function visibleTiles(indexes: SportIndexSeries[] | null): SportIndexSeries[] {
  return (indexes ?? []).filter((d) => plottable(d) || isWithheld(d));
}

/**
 * The strip renders nothing at all ONLY for an absent capability. Note
 * this is deliberately NOT "no tiles" — an errored fetch still renders,
 * because a strip that silently erases itself on a 500 is the failure
 * mode this whole file exists to prevent.
 */
export function stripIsHidden(args: {
  status: StripStatus;
  indexes: SportIndexSeries[] | null;
}): boolean {
  if (args.status === "absent") return true;
  if (args.status === "loading" || args.status === "error") return false;
  return visibleTiles(args.indexes).length === 0;
}

/** Maps a failed fetch to the strip's status. */
export function statusForError(err: { status?: number } | null | undefined): StripStatus {
  return err?.status === 404 || err?.status === 501 ? "absent" : "error";
}
