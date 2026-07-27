import Link from "next/link";
import { PortfolioTodayCard } from "@/components/PortfolioTodayCard";

export default function TodayPage() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Today</h1>
        <p className="text-[color:var(--color-muted)]">
          Your portfolio, market, and action items at a glance.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <PortfolioTodayCard />
        <PlaceholderCard
          title="Market Today"
          body="Sector movers per sport, notable sales, hot prospects."
          href="/app/market"
          cta="Open market →"
        />
        <PlaceholderCard
          title="Search"
          body="Look up any card. Empirical FMV across the full grade ladder."
          href="/app/search"
          cta="Open search →"
        />
      </div>
    </div>
  );
}

function PlaceholderCard({
  title,
  body,
  href,
  cta,
}: {
  title: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <div className="hiq-card p-6 flex flex-col">
      <h2 className="font-bold text-lg mb-2">{title}</h2>
      <p className="text-sm text-[color:var(--color-muted)] flex-1 leading-relaxed">
        {body}
      </p>
      <Link
        href={href}
        className="mt-4 text-sm font-medium hover:underline"
        style={{ color: "var(--color-accent)" }}
      >
        {cta}
      </Link>
    </div>
  );
}
