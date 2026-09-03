// CF-FIRST-RUN (Drew, 2026-09-02). The value moment.
//
// This is the payoff the whole funnel exists to reach: a card the user
// just added, with what it is worth, where that number came from, and one
// line of how we price. Everything else in the funnel is navigation.
//
// THREE RULES:
//
// 1. IT SHOWS THE SAME NUMBER THE PORTFOLIO SHOWS. Value comes from
//    `holdingDisplayValue`, provenance from `holdingProvenance`, and the
//    chip is `ProvenanceChip` — the identical three calls
//    /app/portfolio makes on every row. A "welcome" screen that computed
//    its own headline would eventually disagree with the app, and the
//    first number a new user ever sees is the worst place to be wrong.
//
// 2. AN UNPRICED CARD SAYS SO. When the engine declined, this renders the
//    decline honestly rather than a zero, a cost basis, or a spinner that
//    never resolves. "Never invent value" is the same invariant
//    holdingDisplayValue keeps by refusing to fall back to cost-proxy.
//
// 3. THE "HOW WE PRICE" LINE IS THE SHIPPED COPY. The speculation wording
//    already exists in lib/rung.ts (describeStaleness's `long`) and the
//    rung words come from describeRung. This component composes them; it
//    writes no pricing prose of its own, so the doctrine those modules
//    pin cannot drift out of the onboarding screen.

import Link from "next/link";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import type { PortfolioHolding } from "@/lib/api";
import { firstValueRender } from "@/lib/firstValue";
import { formatCardTitle, formatGrade, formatUSD } from "@/lib/format";


export function FirstValueCard({
  holding,
  /** Age of the newest direct comp, when the caller has it — drives the
   *  speculation chip and the second half of the "how we price" line. */
  daysSinceNewestComp,
}: {
  holding: PortfolioHolding;
  daysSinceNewestComp?: number | null;
}) {
  // One call decides the number, the provenance and the words — the same
  // shape firstValue.test.ts pins against fixture holdings, so what ships
  // here is what the test proved.
  const { value, unpriced, provenance, howWePrice } = firstValueRender(
    holding,
    daysSinceNewestComp,
  );
  const title = formatCardTitle(holding);
  const grade = formatGrade(holding);

  return (
    <section className="hiq-card p-6 sm:p-8">
      <div
        className="text-xs font-semibold uppercase tracking-wide mb-4"
        style={{ color: "var(--hiq-hobby-green)" }}
      >
        Your first card is valued
      </div>

      <h2 className="text-lg sm:text-xl font-semibold leading-snug break-words">
        {title}
      </h2>
      <div className="text-sm mt-1" style={{ color: "var(--hiq-muted-text)" }}>
        {grade}
      </div>

      {!unpriced && value != null ? (
        <>
          {/* The number. Deliberately the largest thing on the screen —
              it is what the user came for. `break-words` and a fluid size
              so a five-figure value does not overflow a 360px phone. */}
          <div className="mt-5 text-4xl sm:text-5xl font-bold tabular-nums break-words">
            {formatUSD(value)}
          </div>

          <div className="mt-3">
            <ProvenanceChip
              rung={provenance}
              source={provenance.source}
              daysSinceNewestComp={daysSinceNewestComp}
            />
          </div>

          <p
            className="mt-4 text-sm leading-relaxed max-w-prose"
            style={{ color: "var(--hiq-muted-text)" }}
          >
            {howWePrice}
          </p>
        </>
      ) : (
        /* Rule 2. The engine declined, and saying so is the honest read —
           a $0 or a cost-basis stand-in here would teach a brand-new user
           that our numbers are made up. */
        <>
          <div
            className="mt-5 text-4xl sm:text-5xl font-bold"
            style={{ color: "var(--hiq-muted-text)" }}
          >
            —
          </div>
          <div className="mt-3">
            <ProvenanceChip rung={provenance} source={provenance.source} />
          </div>
          <p
            className="mt-4 text-sm leading-relaxed max-w-prose"
            style={{ color: "var(--hiq-muted-text)" }}
          >
            {howWePrice}
          </p>
        </>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href={`/app/portfolio/${encodeURIComponent(holding.id)}`}
          className="hiq-btn-secondary text-sm"
        >
          See the comps behind this
        </Link>
      </div>
    </section>
  );
}
