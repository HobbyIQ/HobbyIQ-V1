"use client";

// CF-PORTFOLIO-DASHBOARD (Drew, 2026-08-17: "we want to see the breakdown as a
// dashboard like a car. everything you need for your portfolio is right there").
//
// A car dashboard works because of what it does NOT show. It has one big gauge
// you read constantly, a few permanent readouts, and warning lights that stay
// dark until something is actually wrong. It does not show you the engine
// telemetry unless you go looking.
//
// So: the score is the speedometer, value / P&L / ROI are the permanent
// readouts, allocation is the fuel gauge, and the risk metrics are idiot
// lights — rendered ONLY when they are concerning. A dashboard where every
// light is always on is a christmas tree, and people stop reading it.
//
// Everything comes from /api/portfolioiq/breakdown, the same endpoint the full
// breakdown page and iOS use, so no surface can disagree with another.

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchPortfolioBreakdown, type PortfolioBreakdownResponse } from "@/lib/api";
import { formatUSD } from "@/lib/format";

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

/** The speedometer. A 240° arc, because a full circle reads as a pie chart and
 *  a half circle wastes the width. */
function ScoreGauge({ value, tier }: { value: number; tier: string }) {
  const size = 168, stroke = 13, r = (size - stroke) / 2 - 6;
  const cx = size / 2, cy = size / 2;
  const sweep = 240, start = 150;                 // leaves a 120° gap at the bottom
  const toXY = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)] as const;
  };
  const arc = (fromDeg: number, toDeg: number) => {
    const [x1, y1] = toXY(fromDeg);
    const [x2, y2] = toXY(toDeg);
    const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`;
  };
  const color = scoreColor(tier);

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <path d={arc(start, start + sweep)} fill="none" stroke="#1e293b" strokeWidth={stroke} strokeLinecap="round" />
        <path
          d={arc(start, start + sweep * Math.max(0.01, value / 100))}
          fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-bold leading-none text-white">{value}</span>
        <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          PortfolioIQ
        </span>
        <span className="mt-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold"
              style={{ color, background: `${color}22` }}>
          {tier}
        </span>
      </div>
    </div>
  );
}

export function PortfolioDashboard() {
  const [data, setData] = useState<PortfolioBreakdownResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetchPortfolioBreakdown();
        if (!cancelled) setData(r);
      } catch {
        // Additive surface: never put an error banner on the portfolio page.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (failed || !data || data.cardCount === 0) return null;

  // Idiot lights: only what is actually wrong. Everything healthy stays dark.
  const warnings = [
    ...data.risk.filter((m) => m.isConcerning).map((m) => ({
      key: m.name, label: m.name, detail: m.detail,
    })),
    ...data.concentrations.filter((c) => c.isWarning).map((c) => ({
      key: c.dimension,
      label: c.displayName,
      detail: `${Math.round(c.share * 100)}% of value is tied to ${c.label}.`,
    })),
  ];

  const topRec = data.recommendations[0];

  return (
    <div className="hiq-card mt-4 p-5">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
        <ScoreGauge value={data.score.value} tier={data.score.tier} />

        <div className="min-w-0 flex-1">
          {/* permanent readouts */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Readout label="Value" value={formatUSD(data.totalValue, { hideCents: true })} />
            <Readout label="Cost" value={formatUSD(data.totalCost, { hideCents: true })} muted />
            <Readout
              label="Gain / Loss"
              value={`${data.totalProfitLoss >= 0 ? "+" : ""}${formatUSD(data.totalProfitLoss, { hideCents: true })}`}
              color={data.totalProfitLoss >= 0 ? "#22c55e" : "#ef4444"}
            />
            <Readout
              label="ROI"
              value={`${data.roi >= 0 ? "+" : ""}${data.roi.toFixed(1)}%`}
              color={data.roi >= 0 ? "#22c55e" : "#ef4444"}
            />
          </div>

          {/* allocation — the fuel gauge. White ticks are the HobbyIQ targets,
              so over/under is visible without reading two numbers. */}
          <div className="mt-5">
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Allocation
              </span>
              <Link href="/app/portfolio/breakdown" className="text-xs text-sky-400 hover:underline">
                Full breakdown →
              </Link>
            </div>
            <div className="relative flex h-3 w-full overflow-hidden rounded-full bg-slate-700/50">
              {data.allocations.map((a) => (
                <div
                  key={a.category}
                  style={{ width: `${a.currentShare * 100}%`, background: CATEGORY_COLOR[a.category] }}
                  title={`${a.label} — ${Math.round(a.currentShare * 100)}% vs ${Math.round(a.targetShare * 100)}% target`}
                />
              ))}
              {data.allocations.reduce<{ acc: number; els: React.ReactNode[] }>(
                (state, a) => {
                  state.acc += a.targetShare;
                  if (state.acc < 0.999) {
                    state.els.push(
                      <div key={`t-${a.category}`}
                           className="absolute inset-y-0 w-px bg-white/60"
                           style={{ left: `${state.acc * 100}%` }} />,
                    );
                  }
                  return state;
                },
                { acc: 0, els: [] },
              ).els}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {data.allocations.map((a) => (
                <span key={a.category} className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <span className="inline-block h-2 w-2 rounded-full"
                        style={{ background: CATEGORY_COLOR[a.category] }} />
                  {a.label}
                  <span className="tabular-nums text-slate-300">{Math.round(a.currentShare * 100)}%</span>
                  <span className="tabular-nums text-slate-600">/{Math.round(a.targetShare * 100)}%</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* idiot lights — dark unless something is genuinely wrong */}
      {warnings.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-700/50 pt-4">
          {warnings.map((w) => (
            <span
              key={w.key}
              title={w.detail}
              className="rounded-lg bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-300"
            >
              ⚠ {w.label}
            </span>
          ))}
        </div>
      )}

      {/* the one thing to do next */}
      {topRec && (
        <div className="mt-4 border-t border-slate-700/50 pt-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            Next move
          </p>
          <p className="mt-1 text-sm font-semibold text-white">{topRec.title}</p>
          <p className="text-xs text-slate-400">{topRec.detail}</p>
        </div>
      )}
    </div>
  );
}

function Readout({ label, value, color, muted }: {
  label: string; value: string; color?: string; muted?: boolean;
}) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-0.5 text-lg font-bold tabular-nums"
         style={{ color: color ?? (muted ? "#94a3b8" : "#ffffff") }}>
        {value}
      </p>
    </div>
  );
}
