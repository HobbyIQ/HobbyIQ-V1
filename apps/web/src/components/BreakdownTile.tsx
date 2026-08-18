"use client";

// CF-PORTFOLIO-BREAKDOWN-TILE (Drew, 2026-08-17: "build a breakdown tile and
// make it click to that page").
//
// Shows the PortfolioIQ Score and the allocation split rather than a bare
// "Breakdown →" link, because a number the owner has not seen before is what
// makes the click worth making. Everything rendered here comes from the same
// /breakdown endpoint the full page uses, so the tile can never disagree with
// the screen it opens.
//
// Self-suppressing: renders nothing while loading, on error, or with no
// holdings. A tile that says "0 / 100" to someone with an empty portfolio
// teaches them nothing and looks broken.

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchPortfolioBreakdown, type PortfolioBreakdownResponse } from "@/lib/api";

const CATEGORY_COLOR: Record<string, string> = {
  establishedGreatness: "#22c55e",
  trueScarcity: "#3b82f6",
  eliteProspects: "#60a5fa",
  speculation: "#f59e0b",
};

function scoreColor(tier: string): string {
  if (tier === "Elite" || tier === "Strong Portfolio") return "#22c55e";
  if (tier === "Good Portfolio" || tier === "Moderate Risk") return "#f59e0b";
  return "#ef4444";
}

export function BreakdownTile() {
  const [data, setData] = useState<PortfolioBreakdownResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchPortfolioBreakdown();
        if (!cancelled) setData(r);
      } catch {
        // Silent: the tile is additive. A portfolio page must not surface an
        // error banner because an optional summary could not load.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!data || data.cardCount === 0) return null;

  const color = scoreColor(data.score.tier);
  // Lead with whatever is most actionable, so the tile says something different
  // as the portfolio moves rather than being wallpaper.
  const warning = data.concentrations.find((c) => c.isWarning);
  const worstDrift = [...data.allocations].sort(
    (a, b) => Math.abs(b.driftPoints) - Math.abs(a.driftPoints),
  )[0];
  const subtitle = warning
    ? `${Math.round(warning.share * 100)}% of value is tied to ${warning.label}`
    : worstDrift && Math.abs(worstDrift.driftPoints) > 5
      ? `${worstDrift.label} is ${Math.round(Math.abs(worstDrift.driftPoints))} points ${worstDrift.driftPoints < 0 ? "under" : "over"} target`
      : `${data.score.tier} · allocation, risk and quality`;

  return (
    <Link
      href="/app/portfolio/breakdown"
      className="group block rounded-2xl border border-slate-700/60 bg-slate-900/60 p-5 transition hover:border-slate-500"
    >
      <div className="flex items-center gap-5">
        {/* score ring */}
        <div className="relative shrink-0">
          <svg width="72" height="72" viewBox="0 0 72 72">
            <circle cx="36" cy="36" r="30" fill="none" stroke="#334155" strokeWidth="6" />
            <circle
              cx="36" cy="36" r="30" fill="none" stroke={color} strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${(data.score.value / 100) * 2 * Math.PI * 30} ${2 * Math.PI * 30}`}
              transform="rotate(-90 36 36)"
            />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-xl font-bold text-white">
            {data.score.value}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-white">Portfolio Breakdown</h3>
            <span
              className="rounded-full px-2 py-0.5 text-[11px] font-bold"
              style={{ color, background: `${color}22` }}
            >
              {data.score.tier}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-slate-400">{subtitle}</p>

          {/* allocation split — the "where is my money" answer at a glance */}
          <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-slate-700/50">
            {data.allocations.map((a) => (
              <div
                key={a.category}
                style={{
                  width: `${a.currentShare * 100}%`,
                  background: CATEGORY_COLOR[a.category] ?? "#64748b",
                }}
                title={`${a.label} ${Math.round(a.currentShare * 100)}%`}
              />
            ))}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
            {data.allocations.map((a) => (
              <span key={a.category} className="flex items-center gap-1 text-[11px] text-slate-400">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: CATEGORY_COLOR[a.category] }}
                />
                {a.label} {Math.round(a.currentShare * 100)}%
              </span>
            ))}
          </div>
        </div>

        <span className="shrink-0 text-slate-500 transition group-hover:text-slate-300">→</span>
      </div>
    </Link>
  );
}
