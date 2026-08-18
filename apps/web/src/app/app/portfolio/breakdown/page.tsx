"use client";

// CF-PORTFOLIO-BREAKDOWN (Drew, 2026-08-17). "Own fewer cards. Own better cards."
//
// Answers six questions in order and nothing else: what do I own · where is my
// money concentrated · how risky is it · am I overweight prospects or commodity
// modern · how much true scarcity do I own · what should I improve.
//
// ALL ARITHMETIC IS SERVER-SIDE (portfolioAnalytics.service.ts). iOS renders
// the same screen from the same endpoint, so a second copy of the scoring logic
// here would drift from the Swift one — the defect this codebase was bitten by
// three times on 2026-08-17. This file renders what it is handed.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchPortfolioBreakdown,
  type PortfolioBreakdownResponse,
  type BreakdownAllocation,
  type BreakdownRiskMetric,
} from "@/lib/api";
import { formatUSD } from "@/lib/format";

const CATEGORY_COLOR: Record<string, string> = {
  establishedGreatness: "#22c55e",
  trueScarcity: "#3b82f6",
  eliteProspects: "#60a5fa",
  speculation: "#f59e0b",
};

const TIER_COLOR: Record<string, string> = {
  cornerstone: "#22c55e",
  strongHold: "#4ade80",
  market: "#3b82f6",
  speculative: "#f59e0b",
};

function scoreColor(tier: string): string {
  if (tier === "Elite" || tier === "Strong Portfolio") return "#22c55e";
  if (tier === "Good Portfolio" || tier === "Moderate Risk") return "#f59e0b";
  return "#ef4444";
}

/** Deliberately restrained: only real drift earns a warning colour. A screen
 *  that shouts at everything teaches people to stop reading it. */
function statusColor(status: BreakdownAllocation["status"]): string {
  if (status === "onTarget") return "#22c55e";
  if (status === "underweight" || status === "overweight") return "#f59e0b";
  return "#94a3b8";
}

function riskColor(m: BreakdownRiskMetric): string {
  if (m.isConcerning) return "#ef4444";
  const good = m.polarity === "strengthIsGood" ? m.level === "high" : m.level === "low";
  return good ? "#22c55e" : "#f59e0b";
}

/** Donut built from plain SVG arcs — no chart dependency for four slices. */
function Donut({ allocations }: { allocations: BreakdownAllocation[] }) {
  const size = 200, stroke = 30, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {allocations.map((a) => {
          const len = a.currentShare * c;
          const el = (
            <circle
              key={a.category}
              cx={size / 2} cy={size / 2} r={r}
              fill="none"
              stroke={CATEGORY_COLOR[a.category] ?? "#64748b"}
              strokeWidth={stroke}
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return el;
        })}
      </g>
    </svg>
  );
}

export default function PortfolioBreakdownPage() {
  const [data, setData] = useState<PortfolioBreakdownResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showComponents, setShowComponents] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchPortfolioBreakdown();
        if (!cancelled) setData(r);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load breakdown");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div className="p-6 text-slate-400">Analyzing portfolio…</div>;
  }
  if (error) {
    return (
      <div className="p-6">
        <p className="text-red-400">{error}</p>
        <Link href="/app/portfolio" className="mt-3 inline-block text-sky-400 hover:underline">
          ← Back to Portfolio
        </Link>
      </div>
    );
  }
  if (!data || data.cardCount === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-white">Portfolio Breakdown</h1>
        <p className="mt-2 text-slate-400">
          No holdings to analyze yet. Add cards and the breakdown builds itself from what you own.
        </p>
        <Link href="/app/portfolio" className="mt-4 inline-block text-sky-400 hover:underline">
          ← Back to Portfolio
        </Link>
      </div>
    );
  }

  const card = "rounded-2xl border border-slate-700/60 bg-slate-900/60 p-5";

  return (
    <div className="mx-auto max-w-5xl p-6">
      <Link href="/app/portfolio" className="text-sm text-sky-400 hover:underline">
        ← Portfolio
      </Link>
      <h1 className="mt-2 text-3xl font-bold text-white">Portfolio Breakdown</h1>
      <p className="mt-1 text-sm text-slate-400">
        {data.cardCount} cards · analyzed {new Date(data.analyzedAt).toLocaleString()}
      </p>

      {/* headline numbers */}
      <div className={`mt-6 grid grid-cols-2 gap-4 md:grid-cols-4 ${card}`}>
        <Stat label="Total Value" value={formatUSD(data.totalValue)} />
        <Stat label="Cost Basis" value={formatUSD(data.totalCost)} muted />
        <Stat
          label="Profit / Loss"
          value={`${data.totalProfitLoss >= 0 ? "+" : ""}${formatUSD(data.totalProfitLoss)}`}
          color={data.totalProfitLoss >= 0 ? "#22c55e" : "#ef4444"}
        />
        <Stat
          label="ROI"
          value={`${data.roi >= 0 ? "+" : ""}${data.roi.toFixed(1)}%`}
          color={data.roi >= 0 ? "#22c55e" : "#ef4444"}
        />
      </div>

      {/* score */}
      <div className={`mt-4 ${card}`}>
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              PortfolioIQ Score
            </p>
            <p className="mt-1 text-5xl font-bold" style={{ color: scoreColor(data.score.tier) }}>
              {data.score.value}
              <span className="ml-2 text-lg font-medium text-slate-500">/ 100</span>
            </p>
          </div>
          <span
            className="rounded-full px-3 py-1 text-sm font-bold"
            style={{ color: scoreColor(data.score.tier), background: `${scoreColor(data.score.tier)}22` }}
          >
            {data.score.tier}
          </span>
        </div>
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-700/50">
          <div
            className="h-full rounded-full"
            style={{ width: `${data.score.value}%`, background: scoreColor(data.score.tier) }}
          />
        </div>
        {/* A score the owner cannot interrogate is a horoscope. */}
        <button
          onClick={() => setShowComponents((v) => !v)}
          className="mt-3 text-xs font-semibold text-sky-400 hover:underline"
        >
          {showComponents ? "Hide" : "What's behind this score"}
        </button>
        {showComponents && (
          <div className="mt-3 space-y-1">
            {data.score.components.map((c) => (
              <div key={c.name} className="flex items-center justify-between text-xs">
                <span className="text-slate-400">{c.name}</span>
                <span className="tabular-nums text-slate-200">
                  {Math.round(c.score * 100)}
                  <span className="ml-2 text-slate-500">×{c.weight.toFixed(2)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* allocation */}
      <div className={`mt-4 ${card}`}>
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Allocation</h2>
            <p className="text-xs text-slate-400">Current vs target</p>
          </div>
          <Link href="/app/portfolio/breakdown/tiers" className="text-xs text-sky-400 hover:underline">
            Edit tiers →
          </Link>
        </div>
        <div className="mt-4 flex flex-col items-center gap-6 md:flex-row md:items-start">
          <Donut allocations={data.allocations} />
          <div className="w-full space-y-4">
            {data.allocations.map((a) => (
              <div key={a.category}>
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ background: CATEGORY_COLOR[a.category] }}
                  />
                  <span className="font-semibold text-white">{a.label}</span>
                  <span className="ml-auto text-xs font-bold" style={{ color: statusColor(a.status) }}>
                    {a.status.replace(/([A-Z])/g, " $1").toUpperCase()}
                  </span>
                </div>
                {/* Self-describing, so the category needs no legend — and so
                    the names read for Pokemon and Yu-Gi-Oh! as well as sports. */}
                <p className="mt-0.5 text-[11px] text-slate-500">{a.blurb}</p>
                <div className="mt-1 flex items-center gap-2 text-xs tabular-nums">
                  <span className="text-slate-200">Current {Math.round(a.currentShare * 100)}%</span>
                  <span className="text-slate-500">· Target {Math.round(a.targetShare * 100)}%</span>
                  <span className="ml-auto text-slate-400">{formatUSD(a.value)}</span>
                </div>
                {/* current bar with the target marked on it, so the gap is
                    visible without reading two numbers and subtracting */}
                <div className="relative mt-1 h-1.5 w-full rounded-full bg-slate-700/50">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{
                      width: `${Math.min(100, a.currentShare * 100)}%`,
                      background: CATEGORY_COLOR[a.category],
                    }}
                  />
                  <div
                    className="absolute inset-y-0 w-0.5 bg-white/75"
                    style={{ left: `${a.targetShare * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* risk */}
      <div className={`mt-4 ${card}`}>
        <h2 className="text-lg font-semibold text-white">Portfolio Risk</h2>
        <div className="mt-3 space-y-3">
          {data.risk.map((m) => (
            <div key={m.name} className="flex items-start gap-3">
              <div className="min-w-0">
                <p className="text-sm text-white">{m.name}</p>
                <p className="text-xs text-slate-400">{m.detail}</p>
              </div>
              <span
                className="ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold"
                style={{ color: riskColor(m), background: `${riskColor(m)}22` }}
              >
                {m.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* concentration */}
      {data.concentrations.some((c) => c.isWarning) && (
        <div className={`mt-4 ${card}`}>
          <h2 className="text-lg font-semibold text-white">Concentration</h2>
          <div className="mt-3 space-y-3">
            {data.concentrations.filter((c) => c.isWarning).map((c) => (
              <div key={c.dimension} className="rounded-xl bg-amber-500/10 p-3">
                <p className="text-sm font-semibold text-amber-300">{c.displayName} Risk</p>
                <p className="mt-1 text-sm text-white">
                  {Math.round(c.share * 100)}% of your portfolio value is tied to {c.label}.
                </p>
                <p className="mt-1 text-xs text-slate-400">{c.guidance}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* quality */}
      <div className={`mt-4 ${card}`}>
        <h2 className="text-lg font-semibold text-white">Card Quality</h2>
        <p className="text-xs text-slate-400">By portfolio value</p>
        <div className="mt-3 space-y-4">
          {data.qualityBuckets.map((b) => (
            <div key={b.tier}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white">{b.label}</span>
                <span className="font-bold tabular-nums" style={{ color: TIER_COLOR[b.tier] }}>
                  {Math.round(b.valueShare * 100)}%
                </span>
              </div>
              <p className="text-xs text-slate-500">{b.blurb}</p>
              <p className="text-xs tabular-nums text-slate-400">
                {b.cardCount} {b.cardCount === 1 ? "card" : "cards"} · {formatUSD(b.value)}
              </p>
              <div className="mt-1 h-1.5 w-full rounded-full bg-slate-700/50">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, b.valueShare * 100)}%`, background: TIER_COLOR[b.tier] }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* recommendations */}
      {data.recommendations.length > 0 && (
        <div className={`mt-4 ${card}`}>
          <h2 className="text-lg font-semibold text-white">HobbyIQ Recommendations</h2>
          <div className="mt-3 space-y-3">
            {data.recommendations.map((r) => (
              <div key={r.title}>
                <p
                  className="text-sm font-semibold"
                  style={{ color: r.kind === "strength" ? "#22c55e" : "#e2e8f0" }}
                >
                  {r.title}
                </p>
                <p className="text-xs text-slate-400">{r.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* upgrades */}
      {data.upgradeOpportunities[0] && (
        <div className={`mt-4 ${card}`}>
          <h2 className="text-lg font-semibold text-white">Upgrade Opportunities</h2>
          <p className="mt-2 text-sm text-white">
            You own {data.upgradeOpportunities[0].cardCount} cards between{" "}
            {formatUSD(data.upgradeOpportunities[0].lowValue)} and{" "}
            {formatUSD(data.upgradeOpportunities[0].highValue)}.
          </p>
          <p className="mt-1 text-sm font-semibold text-emerald-400">
            Combined value: {formatUSD(data.upgradeOpportunities[0].combinedValue)}
          </p>
          <p className="mt-2 text-xs text-slate-400">{data.upgradeOpportunities[0].insight}</p>
          <p className="mt-2 text-xs font-semibold text-emerald-500/90">
            Own fewer cards. Own better cards.
          </p>
        </div>
      )}

      {/* honesty rail — a confident donut must not imply data we do not have */}
      {data.unknownScarcityValueShare > 0.2 && (
        <p className="mt-4 px-1 text-xs text-slate-500">
          {Math.round(data.unknownScarcityValueShare * 100)}% of portfolio value has no readable
          print run on the card record, so its scarcity is estimated from era, grade and product
          rather than a serial number.
        </p>
      )}
    </div>
  );
}

function Stat({ label, value, color, muted }: {
  label: string; value: string; color?: string; muted?: boolean;
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p
        className="mt-0.5 text-xl font-bold tabular-nums"
        style={{ color: color ?? (muted ? "#94a3b8" : "#ffffff") }}
      >
        {value}
      </p>
    </div>
  );
}
