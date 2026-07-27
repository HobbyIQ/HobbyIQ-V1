"use client";

import { useEffect, useState } from "react";
import {
  fetchGradeAnalysis,
  type GradeAnalysisResponse,
  type GradeWorthyTier,
  type GradeWorthyRecommendation,
  type PortfolioHolding,
} from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct } from "@/lib/format";

interface Props {
  holding: PortfolioHolding;
  onClose: () => void;
}

// "Should I grade this?" tool. Backed by
// /api/portfolio/holdings/:id/grade-analysis which returns per-tier
// expected-gain math (median graded price minus current raw minus
// grading cost). Only meaningful for raw cards.
export function GradeCalcModal({ holding, onClose }: Props) {
  const [data, setData] = useState<GradeAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGradeAnalysis(holding.id)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const e = err as { message?: string; status?: number };
        if (e.status === 429) {
          setError("Daily price-check limit reached — try again tomorrow.");
        } else {
          setError(e.message ?? "Failed to analyze.");
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [holding.id]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="hiq-card p-6 max-w-2xl w-full max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold">Should I grade this?</h2>
            <p className="text-xs text-[color:var(--color-muted)] mt-1">
              Expected outcome at each grader tier, using observed comps
              minus grading cost.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[color:var(--color-muted)] hover:text-white text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {loading && (
          <div className="text-sm text-[color:var(--color-muted)] py-8 text-center">
            Analyzing…
          </div>
        )}

        {error && (
          <div className="text-sm py-4" style={{ color: "var(--color-danger)" }}>
            {error}
          </div>
        )}

        {data && !loading && (
          <>
            <div
              className="hiq-card p-4 mb-5"
              style={{
                background:
                  data.analysis.overallRecommendation === "grade_now"
                    ? "color-mix(in oklab, var(--color-success) 12%, transparent)"
                    : data.analysis.overallRecommendation === "not_worth"
                    ? "color-mix(in oklab, var(--color-danger) 10%, transparent)"
                    : "color-mix(in oklab, var(--color-accent) 10%, transparent)",
              }}
            >
              <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
                <div className="text-lg font-bold" style={{ color: recommendationColor(data.analysis.overallRecommendation) }}>
                  {recommendationLabel(data.analysis.overallRecommendation)}
                </div>
                <div className="text-sm text-[color:var(--color-muted)]">
                  Raw anchor {formatUSD(data.analysis.rawPrice, { hideCents: true })}
                </div>
              </div>
              <p className="text-sm text-[color:var(--color-muted)] leading-relaxed">
                {data.analysis.reason}
              </p>
            </div>

            {data.failureRate && (
              <div className="hiq-card p-3 mb-5 text-xs" style={{ background: "var(--color-bg)" }}>
                <div className="text-[color:var(--color-muted)] leading-relaxed">
                  <strong style={{ color: "var(--color-accent)" }}>
                    {(data.failureRate.rate * 100).toFixed(0)}% grade below top-tier
                  </strong>{" "}
                  across {data.failureRate.nGraded} observed submissions of
                  similar cards. {data.failureRate.caveat}
                </div>
              </div>
            )}

            {data.analysis.allTiers.length === 0 ? (
              <div className="text-sm text-[color:var(--color-muted)] text-center py-6">
                No graded comps observed for this card yet — analysis needs at
                least a few paired sales to project outcomes.
              </div>
            ) : (
              <div className="space-y-2">
                {data.analysis.allTiers.map((t) => (
                  <TierRow key={t.graderTier} t={t} isBest={data.analysis.bestTier?.graderTier === t.graderTier} />
                ))}
              </div>
            )}

            <div className="mt-6 pt-4 border-t border-[color:var(--color-border)] text-xs text-[color:var(--color-muted)] leading-relaxed">
              Math: expected gain = graded median − current raw − grading cost.
              Uses the cheapest active tier price per grader from our catalog.
              Not a guarantee — grading outcomes vary card-by-card.
            </div>
          </>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button onClick={onClose} className="hiq-btn-primary text-sm">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function TierRow({ t, isBest }: { t: GradeWorthyTier; isBest: boolean }) {
  const gainColor =
    t.expectedGain > 0 ? "var(--color-success)" : t.expectedGain < 0 ? "var(--color-danger)" : undefined;
  return (
    <div
      className="hiq-card p-3 flex items-center gap-4"
      style={{ background: isBest ? "color-mix(in oklab, var(--color-accent) 6%, transparent)" : "var(--color-bg)" }}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <div className="font-medium text-sm">{t.graderTier}</div>
          {isBest && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
              style={{
                background: "color-mix(in oklab, var(--color-accent) 15%, transparent)",
                color: "var(--color-accent)",
              }}
            >
              Best
            </span>
          )}
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide"
            style={{
              background: `color-mix(in oklab, ${recommendationColor(t.recommendation)} 15%, transparent)`,
              color: recommendationColor(t.recommendation),
            }}
          >
            {recommendationShort(t.recommendation)}
          </span>
        </div>
        <div className="text-xs text-[color:var(--color-muted)] mt-1">
          {t.reason}
        </div>
        <div className="text-xs text-[color:var(--color-muted)] mt-1 tabular-nums">
          graded median {formatUSD(t.gradedMedianPrice, { hideCents: true })} (n={t.gradedSampleSize})
          · cost {formatUSD(t.gradingCostAssumed, { hideCents: false })}
        </div>
      </div>
      <div className="text-right flex-shrink-0 ml-3">
        <div className="text-sm font-bold tabular-nums" style={gainColor ? { color: gainColor } : undefined}>
          {formatUSDCompact(t.expectedGain)}
        </div>
        <div className="text-xs tabular-nums" style={gainColor ? { color: gainColor } : undefined}>
          {formatPct(t.expectedRoi * 100)}
        </div>
      </div>
    </div>
  );
}

function recommendationLabel(r: GradeWorthyRecommendation): string {
  switch (r) {
    case "grade_now": return "Grade it";
    case "grade_worthy_but_wait": return "Worth grading — but wait";
    case "not_worth": return "Not worth grading right now";
    case "insufficient_data": return "Not enough data";
  }
}

function recommendationShort(r: GradeWorthyRecommendation): string {
  switch (r) {
    case "grade_now": return "Grade";
    case "grade_worthy_but_wait": return "Wait";
    case "not_worth": return "Skip";
    case "insufficient_data": return "TBD";
  }
}

function recommendationColor(r: GradeWorthyRecommendation): string {
  switch (r) {
    case "grade_now": return "var(--color-success)";
    case "grade_worthy_but_wait": return "var(--color-accent)";
    case "not_worth": return "var(--color-danger)";
    case "insufficient_data": return "var(--color-muted)";
  }
}
