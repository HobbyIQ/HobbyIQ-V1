"use client";

import { useEffect, useState } from "react";
import { fetchValueHistory, type ValueHistoryResponse } from "@/lib/api";
import { formatUSD, formatPct } from "@/lib/format";

interface PortfolioValueChartProps {
  // Headline total to display. Passed in from the parent so it stays
  // in sync with the summary bar below (which uses the same value).
  // If omitted, falls back to the value-history endpoint's own total
  // (which uses different aggregation and can disagree by thousands
  // when some holdings have inconsistent valuationStatus/fmv state).
  headlineTotal?: number;
}

// Portfolio value trail chart — line + gain/loss meta.
// Silently hides if the endpoint fails so the portfolio page keeps working.
export function PortfolioValueChart({ headlineTotal }: PortfolioValueChartProps = {}) {
  const [data, setData] = useState<ValueHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchValueHistory()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return null;
  if (!data || !data.historySeries || data.historySeries.length < 2) return null;

  // Prefer the caller-supplied headline (which is summary.totalValue and
  // matches the summary bar). Fall back to value-history's own total only
  // when the parent didn't pass one — that path is inconsistent with the
  // summary bar so should be treated as the last resort.
  const displayedTotal = headlineTotal ?? data.totalDisplayable;

  const points = data.historySeries;
  const values = points.map((p) => p.total);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const W = 800;
  const H = 160;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - ((p.total - min) / range) * H;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPath = `${path} L ${W} ${H} L 0 ${H} Z`;

  const change = data.change30d;
  const hasChange =
    change &&
    (typeof change.deltaValue === "number" || typeof change.deltaPct === "number");
  const changeColor =
    (change?.deltaValue ?? 0) > 0
      ? "var(--color-success)"
      : (change?.deltaValue ?? 0) < 0
        ? "var(--color-danger)"
        : undefined;

  return (
    <div className="hiq-card p-6 mb-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">Portfolio value</div>
          <div className="text-3xl font-bold tabular-nums">{formatUSD(displayedTotal, { hideCents: true })}</div>
        </div>
        {hasChange && (
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">30-day change</div>
            <div className="text-lg font-medium tabular-nums" style={changeColor ? { color: changeColor } : undefined}>
              {formatUSD(change.deltaValue, { hideCents: true })} · {formatPct(change.deltaPct)}
            </div>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-80" preserveAspectRatio="none" style={{ height: H }}>
          <defs>
            <linearGradient id="valueChartFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#valueChartFill)" />
          <path d={path} stroke="var(--color-accent)" strokeWidth="2" fill="none" />
        </svg>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-[color:var(--color-muted)]">
        <span>{points[0].date}</span>
        <span>{points[points.length - 1].date}</span>
      </div>
    </div>
  );
}
