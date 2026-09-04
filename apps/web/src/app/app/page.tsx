import { PortfolioTodayCard } from "@/components/PortfolioTodayCard";
import { MarketTodayCard } from "@/components/MarketTodayCard";
import { DailyIQCard } from "@/components/DailyIQCard";
import { OnboardingBanner } from "@/components/OnboardingBanner";
import { MarketIndexes } from "@/components/MarketIndexes";
import { EbayReconnectBanner } from "@/components/EbayReconnectBanner";

export default function DailyIQPage() {
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

      <OnboardingBanner />

      {/* CF-MARKET-INDEXES (Drew, 2026-09-04). THIS is the page the nav
          item labelled "DailyIQ" points at — APP_NAV[0].href is "/app"
          (lib/navigation.ts). The strip shipped in #1644 was mounted on
          /app/daily, which has no nav entry at all: the only route to it
          is the small "Open full brief →" link inside DailyIQCard. So the
          surface everyone calls DailyIQ never had the tiles, and the
          strip looked missing on web while it was live on iOS.

          Mounted above the card grid and OUTSIDE every gate, matching
          MarketIndexesStrip's position on DailyIQView.swift (above the
          segment control, outside the locked overlay). The component
          fetches on its own, so it paints regardless of what the
          portfolio/market/brief cards below it are doing — including
          when the brief is 402-locked. */}
      <MarketIndexes className="mb-8" />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <PortfolioTodayCard />
        <MarketTodayCard />
        <DailyIQCard />
      </div>
    </div>
  );
}
