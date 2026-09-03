// CF-FIRST-RUN (Drew, 2026-09-02). What the value moment says.
//
// The funnel's payoff screen (components/FirstValueCard.tsx) is a
// component and components are not tested here (vitest.config.mts runs
// `environment: "node"` over pure helpers only). So the part that can be
// WRONG — which number is shown, whether an unpriced card is allowed to
// look priced, and the words under the price — lives here, pure, and is
// pinned by firstValue.test.ts against fixture holdings.
//
// This module composes; it does not decide. Value comes from
// `holdingDisplayValue`, provenance from `holdingProvenance`, staleness
// from `describeStaleness` — the same three calls /app/portfolio makes on
// every row. The doctrine (observed before estimate, never cost-proxy,
// never a median, an unknown rung is never hidden, an old comp is not
// the price) is pinned in those modules, and this one must not restate
// it in different words.

import { holdingDisplayValue, type PortfolioHolding } from "./api";
import { describeStaleness, holdingProvenance, type HoldingProvenance } from "./rung";

export interface FirstValueRender {
  /** The dollar value to show, or null when the engine declined. Null is
   *  a rendering instruction ("show a dash and the decline copy"), never
   *  a reason to substitute cost basis or a zero. */
  value: number | null;
  /** True when there is no price. The screen branches on this rather
   *  than on `value == null` in two places drifting apart. */
  unpriced: boolean;
  provenance: HoldingProvenance;
  /** The single "how we price" line, or the decline copy when unpriced. */
  howWePrice: string;
  /** The staleness note, when the newest comp is past the stale line. */
  staleLong: string | null;
}

/** The decline copy. A brand-new user's first number is the worst place
 *  to invent value, so an unpriced card says exactly that and says why. */
export const UNPRICED_COPY =
  "We do not have enough sales of this exact card to price it yet. "
  + "Rather than show you a number we made up, we will leave it blank and "
  + "fill it in the moment real comps land.";

/** The one line under the price.
 *
 *  The FMV doctrine sentence, then the rung's own words for which pool
 *  the number came from, then — only when the pool has gone cold — the
 *  speculation sentence lib/rung.ts already ships. No pricing prose is
 *  written here; every clause after the first is quoted from the module
 *  that owns it. */
export function howWePriceLine(
  rungText: string,
  staleLong: string | null,
): string {
  const base =
    `HobbyIQ prices the next sale, not the average of old ones — this is ${rungText}.`;
  return staleLong ? `${base} ${staleLong}` : base;
}

export function firstValueRender(
  holding: PortfolioHolding,
  daysSinceNewestComp?: number | null,
): FirstValueRender {
  const value = holdingDisplayValue(holding);
  const provenance = holdingProvenance(holding);
  const stale = describeStaleness(daysSinceNewestComp);
  const staleLong = stale?.long ?? null;
  const unpriced = value == null;
  return {
    value,
    unpriced,
    provenance,
    staleLong,
    howWePrice: unpriced ? UNPRICED_COPY : howWePriceLine(provenance.text, staleLong),
  };
}
