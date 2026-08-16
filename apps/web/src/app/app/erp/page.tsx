"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchErpSummary, type ErpSummaryResponse } from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct } from "@/lib/format";

export default function ErpPage() {
  const [data, setData] = useState<ErpSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<"none" | "upsell" | "error">("none");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchErpSummary()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 402 || err.status === 403) {
          setGate("upsell");
        } else {
          setGate("error");
          setError(err.message ?? "Failed to load financials");
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading financials…</div>
      </div>
    );
  }

  if (gate === "upsell") {
    return <UpsellCard />;
  }

  if (gate === "error" || !data) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <h1 className="text-3xl font-bold mb-1">Position &amp; Holdings</h1>
        <div className="hiq-card p-6 mt-6 text-sm" style={{ color: "var(--color-danger)" }}>
          {error ?? "Failed to load."}
        </div>
      </div>
    );
  }

  const change = data.change30d;
  const changeColor =
    change?.absolute != null && change.absolute > 0
      ? "var(--color-success)"
      : change?.absolute != null && change.absolute < 0
      ? "var(--color-danger)"
      : undefined;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Position &amp; Holdings</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          What you hold and what it is worth right now. Snapshot as of{" "}
          {data.asOf.slice(0, 10)}.
        </p>
      </div>

      {/* Top numbers */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <BigStat
          label="Comp value"
          value={formatUSD(data.totals.snapshotValue, { hideCents: true })}
          sub={`${data.totals.holdingCount} cards · what comps say today`}
        />
        <BigStat
          label="All-in cost"
          value={formatUSD(data.totals.costBasis, { hideCents: true })}
          sub="what you have into them"
        />
        <BigStat
          label="Up on paper"
          value={formatUSDCompact(data.totals.unrealizedGainLoss)}
          color={
            data.totals.unrealizedGainLoss > 0
              ? "var(--color-success)"
              : data.totals.unrealizedGainLoss < 0
              ? "var(--color-danger)"
              : undefined
          }
          sub={`${formatPct(data.totals.unrealizedPct)} — not real until you sell`}
        />
        <BigStat
          label="Total profit"
          value={formatUSDCompact(data.fullPosition.total)}
          sub={`incl. ${formatUSDCompact(data.fullPosition.realizedYtd)} already flipped this year`}
        />
      </div>

      {/* 30-day change */}
      {change && (
        <div className="hiq-card p-5 mb-6 flex items-center justify-between flex-wrap gap-3">
          <div>
            {/* CF-30D-IS-NOT-PERFORMANCE (Drew, 2026-08-16). The dashboard
                showed "30-day change +141.8%" directly beside "unrealized P&L
                +4.3%" on the same portfolio. Both were right and the pair was
                nonsense: this figure is the difference between two SNAPSHOT
                TOTALS, so adding cards to the portfolio moves it exactly like
                the cards appreciating does. On a portfolio that grew from a
                handful of tracked cards to 29, it mostly measured cards ADDED.
                Labelling it honestly costs nothing and stops it being read as
                performance. Real performance lives on /app/erp/finance. */}
            <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium">
              Tracked value, last 30 days
            </div>
            <div className="text-2xl font-bold tabular-nums mt-1" style={changeColor ? { color: changeColor } : undefined}>
              {formatUSDCompact(change.absolute)}
              {change.percent != null && (
                <span className="text-base ml-2 text-[color:var(--color-muted)]">
                  {formatPct(change.percent)}
                </span>
              )}
            </div>
          </div>
          {change.rangeWeak && (
            <span className="text-xs px-2 py-1 rounded"
              style={{
                background: "color-mix(in oklab, var(--color-accent) 12%, transparent)",
                color: "var(--color-accent)",
              }}
            >
              Limited history — under 30 days
            </span>
          )}
          <Link
            href="/app/erp/finance"
            className="text-sm font-medium px-3 py-2 rounded-lg whitespace-nowrap"
            style={{
              background: "color-mix(in oklab, var(--color-accent) 12%, transparent)",
              color: "var(--color-accent)",
              border: "1px solid color-mix(in oklab, var(--color-accent) 35%, transparent)",
            }}
            title="Revenue, COGS, fees, operating expenses and true net — by year and month"
          >
            Financial Dashboard →
          </Link>
          <div className="text-xs text-[color:var(--color-muted)] basis-full">
            Counts cards you <em>added</em> as well as prices going up, so it can
            jump when you add to the collection. For money actually made, see the
            Financial Dashboard. Compared against {change.asOfDate.slice(0, 10)}
          </div>
        </div>
      )}

      {/* CF-MOVERS-LIVE-IN-INVENTORY (Drew, 2026-08-16: "top gainers and top
          losers can go. that is easy in the inventory tab"). Removed rather
          than moved — the inventory list already sorts by change, so this was
          a second, smaller copy of a view that exists in a better form, taking
          up the space where the business numbers belong. */}
      {/* Health */}
      <div className="hiq-card p-5 mb-6">
        <h2 className="font-bold text-lg mb-1">Comp freshness</h2>
        <p className="text-sm text-[color:var(--color-muted)] mb-3">How recently we saw a real sale for each card. Click a number to see them.</p>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
          <HealthPill label="Fresh comps" n={data.totals.freshCount} color="var(--color-success)" filter="fresh" />
          <HealthPill label="Stale comps" n={data.totals.staleCount} color="var(--color-accent)" filter="stale" />
          <HealthPill label="No direct comps" n={data.totals.estimatedCount} filter="estimated" />
          <HealthPill label="Still checking" n={data.totals.pendingCount} filter="pending" />
          <HealthPill label="No comps" n={data.totals.missingCount} color="var(--color-danger)" filter="missing" />
        </div>
        {(data.totals.staleCount > 0 || data.totals.missingCount > 0) && (
          <p className="text-xs text-[color:var(--color-muted)] mt-3">
            <strong>No comps</strong> usually means we could not tell which exact card
            you have — open it and pick the right one.{" "}
            <strong>No direct comps</strong> means we priced it off similar cards
            instead of real sales of that exact card, so treat it as a ballpark.
          </p>
        )}
      </div>

      {/* Trend chart */}
      {data.valueTrend30d.length > 1 && (
        <div className="hiq-card p-5 mb-6">
          <h2 className="font-bold text-lg mb-3">Value trend</h2>
          <TrendChart points={data.valueTrend30d} />
        </div>
      )}

<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
        <Link href="/app/erp/unreconciled" className="hiq-card p-5 hover:border-[color:var(--color-accent)] transition-colors md:col-span-2 lg:col-span-3">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold text-lg">Reconciliation queue</h2>
            <span className="text-xs text-[color:var(--color-accent)]">Open →</span>
          </div>
          <p className="text-sm text-[color:var(--color-muted)] mt-2 leading-relaxed">
            eBay sales waiting on user cost input (grading, supplies) before
            they land in P&amp;L totals and tax exports.
          </p>
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Link href="/app/erp/expenses" className="hiq-card p-5 hover:border-[color:var(--color-accent)] transition-colors">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold text-lg">Expenses</h2>
            <span className="text-xs text-[color:var(--color-accent)]">Open →</span>
          </div>
          <p className="text-sm text-[color:var(--color-muted)] mt-2 leading-relaxed">
            Log deductible costs — supplies, shipping, grading, subscriptions.
          </p>
        </Link>
        <Link href="/app/erp/tax" className="hiq-card p-5 hover:border-[color:var(--color-accent)] transition-colors">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold text-lg">Tax filings</h2>
            <span className="text-xs text-[color:var(--color-accent)]">Open →</span>
          </div>
          <p className="text-sm text-[color:var(--color-muted)] mt-2 leading-relaxed">
            1099-K reconciliation across eBay, PayPal, Venmo. Accounting-export
            CSV for QuickBooks / Xero.
          </p>
        </Link>
        <Link href="/app/erp/purchases" className="hiq-card p-5 hover:border-[color:var(--color-accent)] transition-colors">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold text-lg">Purchases</h2>
            <span className="text-xs text-[color:var(--color-accent)]">Open →</span>
          </div>
          <p className="text-sm text-[color:var(--color-muted)] mt-2 leading-relaxed">
            Acquisition ledger — every buy with tax, shipping, other fees.
          </p>
        </Link>
        <Link href="/app/portfolio/sold" className="hiq-card p-5 hover:border-[color:var(--color-accent)] transition-colors">
          <div className="flex items-baseline justify-between">
            <h2 className="font-bold text-lg">Sold history</h2>
            <span className="text-xs text-[color:var(--color-accent)]">Open →</span>
          </div>
          <p className="text-sm text-[color:var(--color-muted)] mt-2 leading-relaxed">
            Every closed position with realized P&amp;L and reconciliation status.
          </p>
        </Link>
      </div>

      {/* CF-UX-CLEANUP (Drew, 2026-07-27): "Tip — sold history" filler
          link removed. Sold history is now a first-class sidebar entry
          so the tip pointer is redundant. */}
    </div>
  );
}

function BigStat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="hiq-card p-4">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-1">
        {label}
      </div>
      <div className="text-2xl font-bold tabular-nums" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="text-xs text-[color:var(--color-muted)] mt-1 tabular-nums">{sub}</div>}
    </div>
  );
}

function HealthPill({
  label,
  n,
  color,
  filter,
}: {
  label: string;
  n: number;
  color?: string;
  filter?: "fresh" | "stale" | "estimated" | "pending" | "missing";
}) {
  const body = (
    <>
      <div className="text-xl font-bold tabular-nums" style={color && n > 0 ? { color } : undefined}>
        {n}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted)] mt-1">
        {label}
      </div>
    </>
  );
  const base = "text-center py-2 rounded-lg block transition-colors";
  const style = { background: "var(--color-bg)" };
  if (!filter || n === 0) {
    return (
      <div className={base} style={style}>
        {body}
      </div>
    );
  }
  return (
    <Link
      href={`/app/portfolio?filter=${filter}`}
      className={`${base} hover:bg-white/5 hover:ring-1 hover:ring-[color:var(--color-border)]`}
      style={style}
    >
      {body}
    </Link>
  );
}

function TrendChart({ points }: { points: Array<{ date: string; displayableTotal: number }> }) {
  const values = points.map((p) => p.displayableTotal);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const W = 800;
  const H = 180;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - ((p.displayableTotal - min) / range) * H;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const delta = last.displayableTotal - first.displayableTotal;
  const deltaColor = delta > 0 ? "var(--color-success)" : delta < 0 ? "var(--color-danger)" : "var(--color-accent)";

  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" style={{ height: H }}>
          <path d={path} stroke={deltaColor} strokeWidth="2" fill="none" />
        </svg>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-[color:var(--color-muted)]">
        <span>
          {first.date.slice(0, 10)} · {formatUSD(first.displayableTotal, { hideCents: true })}
        </span>
        <span className="tabular-nums" style={{ color: deltaColor }}>
          {formatUSDCompact(delta)} across window
        </span>
        <span>
          {last.date.slice(0, 10)} · {formatUSD(last.displayableTotal, { hideCents: true })}
        </span>
      </div>
    </div>
  );
}

function UpsellCard() {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <div className="hiq-card p-8 text-center">
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5"
          style={{ background: "color-mix(in oklab, var(--color-accent) 15%, transparent)" }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--color-accent)" }}>
            <path d="M3 3v18h18v-2H5V3H3zm4 12h2v-6H7v6zm4 0h2V5h-2v10zm4 0h2v-4h-2v4zm4 0h2V8h-2v7z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold mb-3">Financials is a Pro Seller feature</h1>
        <p className="text-[color:var(--color-muted)] mb-6 leading-relaxed max-w-md mx-auto">
          Portfolio-wide P&amp;L, 1099-K reconciliation, tax filings, expenses,
          and accounting exports — built for people moving 100+ cards a year.
        </p>
        <Link href="/pricing" className="hiq-btn-primary inline-block">
          See Pro Seller pricing
        </Link>
      </div>
    </div>
  );
}
