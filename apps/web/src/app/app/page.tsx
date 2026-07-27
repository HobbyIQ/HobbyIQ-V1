import { PortfolioTodayCard } from "@/components/PortfolioTodayCard";
import { MarketTodayCard } from "@/components/MarketTodayCard";
import { DailyIQCard } from "@/components/DailyIQCard";
import { OnboardingBanner } from "@/components/OnboardingBanner";

export default function DailyIQPage() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">DailyIQ</h1>
        <p className="text-[color:var(--color-muted)]">
          Your portfolio, market, and action items at a glance.
        </p>
      </div>

      <OnboardingBanner />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <PortfolioTodayCard />
        <MarketTodayCard />
        <DailyIQCard />
      </div>
    </div>
  );
}
