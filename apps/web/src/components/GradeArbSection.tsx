"use client";

// CF-GRADE-ARB (Drew, 2026-09-02). The grade-arbitrage section on a RAW
// holding: what this card would be worth IF it graded at each tier,
// from its OWN empirical curve, minus the disclosed grading-cost
// assumption.
//
// Two rules this component exists to keep:
//
//  1. Never render a number without the condition caveat. We do not know
//     this copy's condition; every figure here is conditional. The
//     disclosure comes down the wire (`gradeArb.disclosure`) and is
//     rendered verbatim — not paraphrased locally, so it cannot drift
//     from what the API says it disclosed.
//  2. Never invent a tier. When the backend refuses, this renders the
//     refusal reason and no arithmetic. A missing tier is silence.
//
// Follows D20 ("the web says what the engine says"): each tier shows
// whether its number is an observed read of this card's own pool or an
// empirical-ratio estimate, and quotes the basis sentence.

import { useEffect, useState } from "react";
import {
  fetchGradeArb,
  type GradeArbResult,
  type GradeArbTier,
  type PortfolioHolding,
} from "@/lib/api";
import { formatUSD } from "@/lib/format";

export function GradeArbSection({ holding }: { holding: PortfolioHolding }) {
  const [data, setData] = useState<GradeArbResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchGradeArb(holding.id)
      .then((res) => {
        if (cancelled) return;
        setData(res.gradeArb);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const e = err as { message?: string; status?: number };
        setError(
          e.status === 429
            ? "Daily price-check limit reached — try again tomorrow."
            : e.message ?? "Could not load grade arbitrage.",
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [holding.id]);

  // An already-graded holding has no arb surface at all — render nothing
  // rather than an empty card.
  if (data?.refusal === "not-raw") return null;

  return (
    <div className="hiq-card p-6">
      <div className="flex items-start justify-between mb-1 gap-3">
        <h2 className="font-bold text-lg">If you graded it</h2>
        {data?.available && (
          <span
            className="text-[10px] uppercase tracking-[0.12em] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap"
            style={{
              color: "var(--hiq-muted-text)",
              background: "rgba(255,255,255,0.06)",
            }}
          >
            {formatUSD(data.gradingCostUsd, { hideCents: true })} grading cost assumed
          </span>
        )}
      </div>

      {loading && (
        <p className="text-sm" style={{ color: "var(--hiq-muted-text)" }}>
          Reading this card&rsquo;s grade curve&hellip;
        </p>
      )}

      {!loading && error && (
        <p className="text-sm" style={{ color: "var(--hiq-warning)" }}>
          {error}
        </p>
      )}

      {/* Refusal: say why, show no arithmetic. */}
      {!loading && !error && data && !data.available && (
        <p className="text-sm" style={{ color: "var(--hiq-muted-text)" }}>
          {data.refusalReason ?? "No graded outcome to show for this card."}
        </p>
      )}

      {!loading && !error && data?.available && (
        <>
          <p className="text-sm mb-4" style={{ color: "var(--hiq-muted-text)" }}>
            Raw today: <strong>{formatUSD(data.rawValue, { hideCents: true })}</strong>
          </p>

          <div className="flex flex-col gap-2 mb-4">
            {data.tiers.map((t) => (
              <TierRow key={t.tier} tier={t} />
            ))}
          </div>

          {/* The caveat. Verbatim from the wire, never paraphrased. */}
          <p
            className="text-[11px] leading-relaxed pt-3"
            style={{
              color: "var(--hiq-muted-text)",
              borderTop: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            {data.disclosure}
          </p>
        </>
      )}
    </div>
  );
}

function TierRow({ tier }: { tier: GradeArbTier }) {
  const positive = tier.netGain > 0;
  const gainColor = positive ? "var(--hiq-hobby-green)" : "var(--hiq-muted-text)";
  return (
    <div
      className="flex items-start justify-between gap-3 p-3 rounded"
      style={{ background: "rgba(255,255,255,0.03)" }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm">{tier.tier}</span>
          {/* Every tier that reaches this component is observed with at
              least 3 real graded sales — an estimated tier is refused
              server-side rather than badged. Show the count, which is
              the thing that varies and the thing worth trusting. */}
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight"
            style={{
              color: "var(--hiq-hobby-green)",
              background: "rgba(255,255,255,0.06)",
            }}
            title={tier.rungLabel ? `rung: ${tier.rungLabel}` : undefined}
          >
            {`● observed · n=${tier.sampleCount}`}
          </span>
        </div>
        <p className="text-[11px] mt-1" style={{ color: "var(--hiq-muted-text)" }}>
          {tier.basis}
        </p>
      </div>
      <div className="text-right shrink-0">
        <div className="font-bold text-sm">{formatUSD(tier.gradedValue, { hideCents: true })}</div>
        <div className="text-[11px] font-semibold" style={{ color: gainColor }}>
          {positive ? "+" : ""}
          {formatUSD(tier.netGain, { hideCents: true })} net
          {tier.netGainPct != null && (
            <span style={{ color: "var(--hiq-muted-text)" }}>
              {" "}
              ({positive ? "+" : ""}
              {Math.round(tier.netGainPct)}%)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
