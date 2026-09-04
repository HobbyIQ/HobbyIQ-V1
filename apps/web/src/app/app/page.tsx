"use client";

import { useCallback, useState } from "react";
import { OnboardingBanner } from "@/components/OnboardingBanner";
import { MarketIndexes } from "@/components/MarketIndexes";
import { EbayReconnectBanner } from "@/components/EbayReconnectBanner";
import { PortfolioBar } from "@/components/PortfolioBar";
import { TodaysActions, ACTIONS_SECTION_ID } from "@/components/TodaysActions";
import type { PortfolioResponse } from "@/lib/api";

// CF-DAILYIQ-LAYOUT (Drew, 2026-09-04: "I love the market indexes. Portfolio
// Today should be a wide bar at the top with relevant data, then market
// indexes, and maybe something around actions below it").
//
// THE ORDER IS THE FEATURE, and it is pinned by a test
// (src/lib/dailyIqLayout.test.ts) rather than left to whoever edits this file
// next:
//
//   1. PORTFOLIO BAR   — the owner's own number, full width, first.
//   2. MARKET INDEXES  — unchanged in content (#1697); it just moved under
//                        the bar. Drew's one explicit "I love" on this page,
//                        so nothing about the strip itself is touched.
//   3. TODAY'S ACTIONS — what to do about the two above.
//
// The three-card grid that used to hold PortfolioTodayCard / MarketTodayCard /
// DailyIQCard is gone: the portfolio card became the bar, and the market and
// brief cards merged into the actions section's third column. Those two
// components remain in the tree — /app/daily and other surfaces still mount
// them — this page simply no longer does.
//
// ONE FETCH, TWO READERS. The bar fetches /api/portfolio and hands the
// response up; the actions section reads the same object for its attention
// and sell-signal columns. Two components each calling fetchPortfolio would
// double a request that returns every holding.

export default function DailyIQPage() {
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  const [portfolioFailed, setPortfolioFailed] = useState(false);

  const handleData = useCallback((data: PortfolioResponse | null, failed: boolean) => {
    setPortfolio(data);
    setPortfolioFailed(failed);
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">DailyIQ</h1>
        <p className="text-[color:var(--color-muted)]">
          Your portfolio, market, and action items at a glance.
        </p>
      </div>

      {/* CF-EBAY-RECONNECT-SURFACE (found by #1721). A broken eBay
          connection means purchases stop syncing silently — two real users
          sat that way from 2026-08-31 with no prompt anywhere. Mounted
          FIRST and outside every gate: the banner renders itself away in
          the two healthy states, so it costs nothing when there is
          nothing wrong, and it must not be able to hide behind an
          onboarding/entitlement branch when there is. */}
      <EbayReconnectBanner className="mb-6" />

      {/* CF-DAILYIQ-BANNER-ONLY-WHEN-EMPTY (Drew, 2026-09-04). Renders only
          for an actually-empty portfolio now — see OnboardingBanner and
          lib/firstRun.ts `shouldShowFirstRunBanner`. */}
      <OnboardingBanner />

      {/* 1. The bar. */}
      <PortfolioBar attentionHref={`#${ACTIONS_SECTION_ID}`} onData={handleData} />

      {/* 2. CF-MARKET-INDEXES (Drew, 2026-09-04). THIS is the page the nav
          item labelled "DailyIQ" points at — APP_NAV[0].href is "/app"
          (lib/navigation.ts). The strip shipped in #1644 was mounted on
          /app/daily, which has no nav entry at all: the only route to it
          is the small "Open full brief →" link inside DailyIQCard. So the
          surface everyone calls DailyIQ never had the tiles, and the
          strip looked missing on web while it was live on iOS.

          Mounted OUTSIDE every gate, matching MarketIndexesStrip's
          position on DailyIQView.swift (above the segment control,
          outside the locked overlay). The component fetches on its own,
          so it paints regardless of what the bar above or the actions
          below it are doing — including when the brief is 402-locked.
          Content unchanged by CF-DAILYIQ-LAYOUT; only its neighbours moved. */}
      <MarketIndexes className="mb-8" />

      {/* 3. The actions. */}
      <TodaysActions portfolio={portfolio} portfolioFailed={portfolioFailed} />
    </div>
  );
}
