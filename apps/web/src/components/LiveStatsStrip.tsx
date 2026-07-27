"use client";

import { useEffect, useState } from "react";
import { fetchPublicStats, type PublicStats } from "@/lib/api";

// Live stats strip on the landing page. Fetches on mount from
// GET /api/stats/public (15-min server-side cache). Renders a
// hardcoded fallback set on network failure so the layout never
// collapses.

const FALLBACK: PublicStats = {
  soldCompsIndexed: 2_400_000,
  cardsWithSlug: 2_400_000,
  categories: 4,
  sportsCovered: ["Baseball", "Basketball", "Football", "Pokemon"],
  vendorsIngested: ["eBay", "PSA", "Partner data"],
  generatedAt: new Date().toISOString(),
};

export function LiveStatsStrip() {
  const [stats, setStats] = useState<PublicStats>(FALLBACK);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPublicStats()
      .then((s) => {
        if (!cancelled) {
          setStats(s);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="hiq-card p-6 md:p-8">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
        <Metric
          value={formatCount(stats.soldCompsIndexed)}
          label="Sales indexed"
          loading={!loaded}
        />
        <Metric
          value={formatCount(stats.cardsWithSlug)}
          label="Canonical cards"
          loading={!loaded}
        />
        <Metric value={String(stats.categories)} label="Categories" loading={!loaded} />
        <Metric
          value={String(stats.vendorsIngested.length)}
          label="Data sources"
          loading={!loaded}
        />
      </div>
      <div className="mt-6 pt-6 border-t border-[color:var(--color-border)] text-xs text-[color:var(--color-muted)] text-center">
        {stats.sportsCovered.join(" · ")} · Data from {stats.vendorsIngested.join(", ")}
      </div>
    </div>
  );
}

function Metric({ value, label, loading }: { value: string; label: string; loading: boolean }) {
  return (
    <div className="text-center">
      <div
        className={`text-3xl md:text-4xl font-bold tabular-nums mb-1 transition-opacity duration-300 ${loading ? "opacity-50" : "opacity-100"}`}
      >
        {value}
      </div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium">
        {label}
      </div>
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M+`;
  if (n >= 1_000) return `${Math.floor(n / 1_000)}K+`;
  return String(n);
}
