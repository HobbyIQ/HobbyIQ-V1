"use client";

import { useEffect, useState } from "react";
import { fetchObservedGradeCurve, type ObservedGradeEntry } from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct } from "@/lib/format";

interface Props {
  cardId: string;
}

// Per-grade breakdown of a card's market. Renders every canonical grade
// (Raw → PSA 8/9/10 + BGS/SGC/CGC equivalents) with:
//   - Weighted median value + sample count
//   - valueSource pill (observed / estimated / unavailable)
//   - Momentum sparkline built from salesHistory
//   - Trend-adjusted "market value today" + predicted 7d/30d
//   - Confidence bar
//
// Skips entries where valueSource === "unavailable" AND sampleCount === 0
// unless the user opens "Show all grades".
export function GradeCurveView({ cardId }: Props) {
  const [entries, setEntries] = useState<ObservedGradeEntry[]>([]);
  const [totalSamples, setTotalSamples] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchObservedGradeCurve(cardId)
      .then((res) => {
        if (cancelled) return;
        setEntries(res.entries ?? []);
        setTotalSamples(res.totalSampleCount ?? 0);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const e = err as { status?: number; message?: string };
        if (e.status === 429) setError("Daily price-check limit reached — try again tomorrow.");
        else setError(e.message ?? "Failed to load grade curve");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  const visibleEntries = showAll
    ? entries
    : entries.filter((e) => e.valueSource !== "unavailable" || e.sampleCount > 0);

  const hiddenCount = entries.length - visibleEntries.length;

  return (
    <div className="hiq-card p-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="font-bold text-lg">Grade curve</h2>
          <p className="text-xs text-[color:var(--color-muted)] mt-1">
            Every canonical grade for this card. Values are HobbyIQ&apos;s own —
            computed from real sales, not read from a vendor model.
          </p>
        </div>
        {totalSamples > 0 && (
          <span className="text-xs text-[color:var(--color-muted)]">
            {totalSamples.toLocaleString()} total sale{totalSamples === 1 ? "" : "s"} across grades
          </span>
        )}
      </div>

      {loading && (
        <div className="text-sm text-[color:var(--color-muted)] py-6 text-center">
          Loading grade breakdown…
        </div>
      )}
      {error && (
        <div className="text-sm py-4" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {!loading && !error && visibleEntries.length === 0 && (
        <div className="text-sm text-[color:var(--color-muted)] text-center py-6">
          No graded activity observed for this card yet.
        </div>
      )}

      {!loading && !error && visibleEntries.length > 0 && (
        <>
          <div className="space-y-2">
            {visibleEntries.map((e) => (
              <GradeRow key={`${e.grader}-${e.grade}`} e={e} />
            ))}
          </div>

          {hiddenCount > 0 && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="mt-4 w-full text-xs text-[color:var(--color-accent)] hover:underline py-2"
            >
              + Show {hiddenCount} more grade{hiddenCount === 1 ? "" : "s"} with no data
            </button>
          )}
        </>
      )}
    </div>
  );
}

function GradeRow({ e }: { e: ObservedGradeEntry }) {
  const value = e.trendAdjustedValue ?? e.value;
  const predicted = e.predictedPriceAt30d;
  const trendPct = e.trendAdjustmentPct;
  const trendColor =
    trendPct != null && trendPct > 0.5
      ? "var(--hiq-hobby-green)"
      : trendPct != null && trendPct < -0.5
      ? "var(--hiq-danger)"
      : "var(--hiq-muted-text)";
  const predictColor =
    e.predictedPricePct != null && e.predictedPricePct > 0.5
      ? "var(--hiq-hobby-green)"
      : e.predictedPricePct != null && e.predictedPricePct < -0.5
      ? "var(--hiq-danger)"
      : "var(--hiq-muted-text)";
  // CF-GRADE-LABEL-DEDUP (Drew, 2026-08-02). Backend's `grade` field
  // sometimes already includes the grader ("PSA 10"), sometimes just
  // the value ("10"). Prior code always concatenated → "PSA PSA 10".
  // Detect and de-duplicate.
  const gradeStr = String(e.grade ?? "");
  const graderStr = String(e.grader ?? "");
  const label = gradeStr === "Raw" || graderStr === "Raw"
    ? "Raw"
    : gradeStr.toLowerCase().startsWith(graderStr.toLowerCase() + " ")
      ? gradeStr
      : `${graderStr} ${gradeStr}`.trim();

  return (
    <div className="hiq-tile-flat">
      <div className="flex items-start gap-4">
        <div className="w-20 flex-shrink-0">
          <div className="text-sm font-bold">{label === "Raw Raw" ? "Raw" : label}</div>
          <div className="text-[10px] text-[color:var(--color-muted)] uppercase tracking-wide mt-0.5">
            n={e.sampleCount}
          </div>
          <SourceBadge source={e.valueSource} />
        </div>

        <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-[1fr_120px_1fr] gap-4">
          {/* Value */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted)] font-medium">
              Market value
            </div>
            <div className="text-lg font-bold tabular-nums mt-0.5">
              {value != null ? formatUSD(value, { hideCents: value >= 100 }) : "—"}
            </div>
            {trendPct != null && Math.abs(trendPct) > 0.5 && (
              <div className="text-[10px] tabular-nums mt-0.5" style={{ color: trendColor }}>
                {trendPct > 0 ? "↑" : "↓"} {formatPct(trendPct)}
              </div>
            )}
            {e.priceRangeLow != null && e.priceRangeHigh != null && (
              <div className="text-[10px] text-[color:var(--color-muted)] mt-0.5 tabular-nums">
                p10 {formatUSDCompact(e.priceRangeLow)} · p90 {formatUSDCompact(e.priceRangeHigh)}
              </div>
            )}
          </div>

          {/* Sparkline */}
          <div className="hidden md:block">
            {e.salesHistory && e.salesHistory.length >= 2 ? (
              <Sparkline history={e.salesHistory} color={trendColor} />
            ) : (
              <div className="h-full flex items-center text-[10px] text-[color:var(--color-muted)]">
                Not enough sales
              </div>
            )}
          </div>

          {/* Predicted */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted)] font-medium">
              Predicted ({e.predictedHorizonDays}d)
            </div>
            <div className="text-lg font-bold tabular-nums mt-0.5" style={predicted != null ? { color: predictColor } : undefined}>
              {predicted != null ? formatUSD(predicted, { hideCents: predicted >= 100 }) : "—"}
            </div>
            {e.predictedPricePct != null && (
              <div className="text-[10px] tabular-nums mt-0.5" style={{ color: predictColor }}>
                {formatPct(e.predictedPricePct)}
              </div>
            )}
            {e.predictedPriceRangeLow != null && e.predictedPriceRangeHigh != null && (
              <div className="text-[10px] text-[color:var(--color-muted)] mt-0.5 tabular-nums">
                range {formatUSDCompact(e.predictedPriceRangeLow)} – {formatUSDCompact(e.predictedPriceRangeHigh)}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confidence bar */}
      <div className="mt-3 flex items-center gap-2 text-[10px] text-[color:var(--color-muted)]">
        <span className="w-16 flex-shrink-0">Confidence</span>
        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${Math.round((e.confidenceScore ?? 0) * 100)}%`,
              background:
                (e.confidenceScore ?? 0) >= 0.7
                  ? "var(--hiq-hobby-green)"
                  : (e.confidenceScore ?? 0) >= 0.4
                  ? "var(--hiq-electric-blue)"
                  : "var(--hiq-warning)",
            }}
          />
        </div>
        <span className="tabular-nums w-8 text-right">{Math.round((e.confidenceScore ?? 0) * 100)}%</span>
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: ObservedGradeEntry["valueSource"] }) {
  const label = source === "observed" ? "Observed" : source === "estimated" ? "Est." : "n/a";
  const color =
    source === "observed"
      ? "var(--hiq-hobby-green)"
      : source === "estimated"
      ? "var(--hiq-electric-blue)"
      : "var(--hiq-muted-text)";
  return (
    <span
      className="inline-block mt-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide"
      style={{
        background: `color-mix(in oklab, ${color} 15%, transparent)`,
        color,
      }}
    >
      {label}
    </span>
  );
}

function Sparkline({
  history,
  color,
}: {
  history: Array<{ price: number; date: string | null }>;
  color: string;
}) {
  const points = history
    .filter((h) => h.date && h.price > 0)
    .map((h) => ({ x: Date.parse(h.date as string), y: h.price }))
    .filter((p) => Number.isFinite(p.x))
    .sort((a, b) => a.x - b.x);

  if (points.length < 2) {
    return null;
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = Math.max(1, maxX - minX);
  const rangeY = Math.max(1, maxY - minY);

  const W = 100;
  const H = 40;
  const path = points
    .map((p, i) => {
      const x = ((p.x - minX) / rangeX) * W;
      const y = H - ((p.y - minY) / rangeY) * H;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 40 }}>
      <path d={path} stroke={color} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
