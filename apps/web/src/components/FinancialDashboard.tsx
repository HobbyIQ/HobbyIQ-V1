"use client";

// CF-ONE-BUSINESS-PAGE (Drew, 2026-08-16: "put the financial dashboard on
// financials are the first screen then put the positions and holdings on the
// same page under the sales portion"). Extracted from its own route into a
// component so /app/erp can lead with it and carry position underneath.
//
// CF-CEO-DASHBOARD (Drew, 2026-08-16: "We need to redo this to show profit
// that we have made and true dashboard that shows profitability of the
// business ... drill down by year, months, purchases and all that").
//
// The old /app/erp page answers "what do I hold and what is it worth" —
// position, not profitability. A CEO reading it could not tell you what the
// business EARNED, what it cost to earn it, or whether margin is improving.
//
// Everything needed was already in the backend and unused: /erp/pnl returns
// gross proceeds, fees, shipping, net proceeds, COGS, realized P&L, operating
// expenses and true net, groupable by month / player / set / grade / source /
// sales channel / payment method. This page is that data, with a year selector
// driving the window and a group-by driving the breakdown.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  fetchErpPnl,
  type ErpPnlResponse,
  type PnlGroupBy,
  type PnlTotals,
} from "@/lib/api";
import { formatUSD } from "@/lib/format";

const GROUPINGS: Array<{ key: PnlGroupBy; label: string }> = [
  { key: "month", label: "Month" },
  { key: "player", label: "Player" },
  { key: "set", label: "Set" },
  { key: "grade", label: "Grade" },
  { key: "salesChannel", label: "Channel" },
  { key: "source", label: "Source" },
  { key: "paymentMethod", label: "Payment" },
];

/** Margin on revenue. Null rather than 0 when there is no revenue — a period
 *  with no sales has no margin, and rendering 0% would read as a bad month
 *  rather than an empty one. */
function marginPct(t: PnlTotals): number | null {
  if (!t.grossProceeds) return null;
  return (t.realizedProfitLoss / t.grossProceeds) * 100;
}

const currentYear = new Date().getFullYear();
const YEARS = Array.from({ length: 6 }, (_, i) => currentYear - i);

export function FinancialDashboard() {
  const [year, setYear] = useState<number | "all">(currentYear);
  const [groupBy, setGroupBy] = useState<PnlGroupBy>("month");
  const [data, setData] = useState<ErpPnlResponse | null>(null);
  const [prior, setPrior] = useState<ErpPnlResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const window = year === "all"
        ? {}
        : { from: `${year}-01-01`, to: `${year}-12-31` };
      // Prior year is fetched alongside so every headline can be stated as a
      // CHANGE. A number with nothing to compare it to is not a dashboard.
      const [cur, prev] = await Promise.all([
        fetchErpPnl({ ...window, groupBy }),
        year === "all"
          ? Promise.resolve(null)
          : fetchErpPnl({ from: `${year - 1}-01-01`, to: `${year - 1}-12-31`, groupBy: "month" })
            .catch(() => null),
      ]);
      setData(cur);
      setPrior(prev);
    } catch (err) {
      setError((err as { message?: string })?.message ?? "Couldn't load P&L");
    } finally {
      setLoading(false);
    }
  }, [year, groupBy]);

  useEffect(() => { load(); }, [load]);

  const t = data?.totals;
  const margin = t ? marginPct(t) : null;
  const priorMargin = prior?.totals ? marginPct(prior.totals) : null;
  const opex = data?.operatingExpenses ?? null;

  const yoy = useMemo(() => {
    if (!t || !prior?.totals?.grossProceeds) return null;
    return ((t.grossProceeds - prior.totals.grossProceeds) / prior.totals.grossProceeds) * 100;
  }, [t, prior]);

  return (
    <div>
      <div className="mb-6 text-center">
        <h1 className="text-3xl font-bold mb-1">Financials</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Revenue, costs, and what the business earned.
          {data?.window.from && ` ${data.window.from} → ${data.window.to}`}
        </p>
      </div>

      <div className="flex gap-2 flex-wrap mb-6 justify-center">
        {(["all", ...YEARS] as Array<number | "all">).map((y) => (
          <button
            key={String(y)}
            onClick={() => setYear(y)}
            className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            style={y === year
              ? { background: "var(--color-accent)", color: "white" }
              : { background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
          >
            {y === "all" ? "All time" : y}
          </button>
        ))}
      </div>

      {error && (
        <div className="hiq-card p-4 mb-4 text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>
      )}
      {loading && !data && (
        <div className="text-sm text-[color:var(--color-muted)]">Loading…</div>
      )}

      {t && (
        <>
          <p className="text-sm text-[color:var(--color-muted)] mb-3 text-center">
            Revenue less what the cards cost you, fees, shipping, grading and
            supplies is your net profit. Operating costs sit alongside it.
          </p>
          {/* CF-TILES-READ-AS-A-P&L (Drew, 2026-08-16: "change Profit on Flips
              to Net Profit and reorgaize the tile to make more sense. Maybe
              update the tiles titles to be slight more business like and not
              childish").
              Row one is the walk itself, top to bottom, each line a deduction
              from the one before it and Net Profit as the result. Row two is
              performance ABOUT that result rather than part of it — which is
              why Overhead sat awkwardly beside a total it is not inside. */}
          <div className="grid gap-4 mb-6" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))" }}>
            <Stat label="Revenue" value={formatUSD(t.grossProceeds)}
              sub={yoy != null ? `${yoy >= 0 ? "+" : ""}${yoy.toFixed(1)}% vs ${year === "all" ? "prior" : Number(year) - 1}` : `${t.entryCount} sales`} />
            <Stat label="All-In Cost" value={formatUSD(t.costBasisSold)}
              sub="cost basis of cards sold" />
            <Stat label="Fees & Shipping" value={formatUSD(t.feesTotal + t.shipping)}
              sub={`${formatUSD(t.feesTotal)} fees · ${formatUSD(t.shipping)} shipping`} />
            {/* CF-PNL-SHOW-GRADING (Drew, 2026-08-16). Deducted from profit but
                previously shown nowhere, so the walk lost money between revenue
                and profit. */}
            <Stat label="Grading & Supplies" value={formatUSD((t.gradingCost ?? 0) + (t.suppliesCost ?? 0))}
              sub={`${formatUSD(t.gradingCost ?? 0)} grading · ${formatUSD(t.suppliesCost ?? 0)} supplies`} />
            <Stat label="Net Profit" value={formatUSD(t.realizedProfitLoss)}
              tone={t.realizedProfitLoss >= 0 ? "good" : "bad"}
              sub={margin != null ? `${margin.toFixed(1)}% margin` : "no sales yet"} />
          </div>

          <div className="grid gap-4 mb-8" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))" }}>
            <Stat label="Margin" value={margin != null ? `${margin.toFixed(1)}%` : "—"}
              sub={priorMargin != null && margin != null
                ? `${(margin - priorMargin) >= 0 ? "up" : "down"} ${Math.abs(margin - priorMargin).toFixed(1)} pts on last year`
                : "share of revenue retained"} />
            <Stat label="Average Sale" value={t.entryCount ? formatUSD(t.grossProceeds / t.entryCount) : "—"}
              sub={`${t.entryCount} sales`} />
            <Stat label="Operating Costs" value={opex != null ? formatUSD(opex) : "—"}
              sub="shows, supplies, software" />
          </div>

          {/* CF-ERP-PNL-EXCLUSIONS. Unreconciled sales are NOT in these numbers.
              Saying so on the page is the difference between a P&L and a guess —
              an operator needs to know the figure is partial before acting. */}
          {data.excluded.unreconciledCount > 0 && (
            <div className="hiq-card p-4 mb-8 text-sm">
              <strong>{data.excluded.unreconciledCount}</strong> sale
              {data.excluded.unreconciledCount === 1 ? " is" : "s are"} missing what you
              were all-in for, so {data.excluded.unreconciledCount === 1 ? "it is" : "they are"}
              left out of every number above
              {data.excluded.unreconciledOldestSoldAt
                ? ` (oldest ${data.excluded.unreconciledOldestSoldAt.slice(0, 10)})`
                : ""}.{" "}
              <Link href="/app/erp" className="underline" style={{ color: "var(--color-accent)" }}>
                Fill them in
              </Link>{" "}
              and these numbers become complete.
            </div>
          )}

          <div className="flex items-center justify-between gap-4 flex-wrap mb-3">
            <h2 className="text-xl font-bold">Sales</h2>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-[color:var(--color-muted)] mr-1">break down by</span>
              {GROUPINGS.map((g) => (
                <button
                  key={g.key}
                  onClick={() => setGroupBy(g.key)}
                  className="px-3 py-1.5 rounded-lg text-sm transition-colors"
                  style={g.key === groupBy
                    ? { background: "var(--color-accent)", color: "white" }
                    : { background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          <div className="hiq-card overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 720 }}>
              <thead>
                <tr className="text-left text-[color:var(--color-muted)]">
                  <Th>{GROUPINGS.find((g) => g.key === groupBy)?.label}</Th>
                  <Th right>Flips</Th>
                  <Th right>Sold for</Th>
                  <Th right>All-in</Th>
                  <Th right>Fees + ship</Th>
                  <Th right>Profit</Th>
                  <Th right>Margin</Th>
                </tr>
              </thead>
              <tbody>
                {data.groups.length === 0 && (
                  <tr><td colSpan={7} className="p-4 text-[color:var(--color-muted)]">
                    Nothing sold in this period yet.
                  </td></tr>
                )}
                {data.groups.map((g) => {
                  const m = marginPct(g.totals);
                  return (
                    <tr key={g.key} className="border-t" style={{ borderColor: "var(--color-border)" }}>
                      <Td>{g.label}</Td>
                      <Td right muted>{g.totals.entryCount}</Td>
                      <Td right>{formatUSD(g.totals.grossProceeds)}</Td>
                      <Td right muted>{formatUSD(g.totals.costBasisSold)}</Td>
                      <Td right muted>{formatUSD(g.totals.feesTotal + g.totals.shipping)}</Td>
                      <Td right tone={g.totals.realizedProfitLoss >= 0 ? "good" : "bad"}>
                        {formatUSD(g.totals.realizedProfitLoss)}
                      </Td>
                      <Td right muted>{m != null ? `${m.toFixed(1)}%` : "—"}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, tone }: {
  label: string; value: string; sub?: string; tone?: "good" | "bad";
}) {
  const color = tone === "good" ? "var(--color-success)"
    : tone === "bad" ? "var(--color-danger)" : undefined;
  return (
    <div className="hiq-card p-4 text-center">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">{label}</div>
      <div className="text-2xl font-bold mt-1 tabular-nums" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-xs text-[color:var(--color-muted)] mt-1">{sub}</div>}
    </div>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={`px-4 py-3 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}

function Td({ children, right, muted, tone }: {
  children?: React.ReactNode; right?: boolean; muted?: boolean; tone?: "good" | "bad";
}) {
  const color = tone === "good" ? "var(--color-success)"
    : tone === "bad" ? "var(--color-danger)" : undefined;
  return (
    <td
      className={`px-4 py-3 tabular-nums ${right ? "text-right" : ""} ${muted ? "text-[color:var(--color-muted)]" : ""}`}
      style={color ? { color } : undefined}
    >
      {children}
    </td>
  );
}
