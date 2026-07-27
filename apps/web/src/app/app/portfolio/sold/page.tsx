"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchLedger, type LedgerEntry, type LedgerResponse } from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct } from "@/lib/format";

type YearFilter = "all" | number;
type SourceFilter = "all" | "manual" | "ebay";

export default function SoldLedgerPage() {
  const [data, setData] = useState<LedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [yearFilter, setYearFilter] = useState<YearFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");

  useEffect(() => {
    let cancelled = false;
    fetchLedger()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as { message?: string })?.message ?? "Failed to load ledger");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const years = useMemo(() => {
    if (!data) return [] as number[];
    const s = new Set<number>();
    for (const e of data.entries) {
      const y = Number(e.soldAt.slice(0, 4));
      if (Number.isFinite(y)) s.add(y);
    }
    return Array.from(s).sort((a, b) => b - a);
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [] as LedgerEntry[];
    return data.entries.filter((e) => {
      if (yearFilter !== "all") {
        const y = Number(e.soldAt.slice(0, 4));
        if (y !== yearFilter) return false;
      }
      if (sourceFilter !== "all") {
        const src = e.source ?? "manual";
        if (src !== sourceFilter) return false;
      }
      return true;
    });
  }, [data, yearFilter, sourceFilter]);

  const filteredTotals = useMemo(() => {
    return filtered.reduce(
      (acc, e) => {
        acc.realizedPL += e.realizedProfitLoss;
        acc.gross += e.grossProceeds;
        acc.net += e.netProceeds;
        acc.cost += e.costBasisSold;
        return acc;
      },
      { realizedPL: 0, gross: 0, net: 0, cost: 0 },
    );
  }, [filtered]);

  const needsReconciliationCount = data
    ? data.entries.filter((e) => e.needsReconciliation && !e.dismissedAt).length
    : 0;

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading sold history…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link href="/app/portfolio" className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors mb-6 inline-block">
          ← Back to portfolio
        </Link>
        <div className="hiq-card p-6 text-sm mt-4" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      </div>
    );
  }

  if (!data || data.entries.length === 0) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link href="/app/portfolio" className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors mb-6 inline-block">
          ← Back to portfolio
        </Link>
        <div className="hiq-card p-8 mt-4 text-center">
          <h1 className="text-2xl font-bold mb-2">No sold history yet</h1>
          <p className="text-[color:var(--color-muted)] mb-6">
            Cards you Mark as sold on their holding page will land here — with
            realized P&amp;L, fees, and the sale record.
          </p>
          <Link href="/app/portfolio" className="hiq-btn-primary inline-block">
            Open portfolio
          </Link>
        </div>
      </div>
    );
  }

  const plColor = (n: number) =>
    n > 0 ? "var(--color-success)" : n < 0 ? "var(--color-danger)" : undefined;

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <Link href="/app/portfolio" className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors mb-6 inline-block">
        ← Back to portfolio
      </Link>
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Sold history</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          {data.count.toLocaleString()} closed sale{data.count === 1 ? "" : "s"} · realized P&amp;L{" "}
          <span style={{ color: plColor(data.totals.realizedProfitLoss) }}>
            {formatUSDCompact(data.totals.realizedProfitLoss)}
          </span>{" "}
          all-time
        </p>
      </div>

      {/* Reconciliation nudge */}
      {needsReconciliationCount > 0 && (
        <div
          className="hiq-card p-4 mb-6 text-sm flex items-center justify-between flex-wrap gap-3"
          style={{
            background: "color-mix(in oklab, var(--color-accent) 8%, transparent)",
            color: "var(--color-accent)",
          }}
        >
          <div>
            <strong>{needsReconciliationCount}</strong> eBay sale
            {needsReconciliationCount === 1 ? "" : "s"} awaiting reconciliation
            — add supply / shipping / grading costs to keep P&amp;L honest.
          </div>
          <Link href="/app/erp" className="hiq-btn-secondary text-sm">
            Open ERP
          </Link>
        </div>
      )}

      {/* Filters */}
      <div className="mt-4 flex items-center gap-3 flex-wrap mb-6">
        <select
          value={yearFilter === "all" ? "all" : String(yearFilter)}
          onChange={(e) => {
            const v = e.target.value;
            setYearFilter(v === "all" ? "all" : Number(v));
          }}
          className={filterCls}
        >
          <option value="all">All years</option>
          {years.map((y) => (
            <option key={y} value={String(y)}>{y}</option>
          ))}
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
          className={filterCls}
        >
          <option value="all">All sources</option>
          <option value="manual">Manual</option>
          <option value="ebay">eBay</option>
        </select>
      </div>

      {/* Filtered totals */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <MiniStat
          label="Realized P&L"
          value={formatUSDCompact(filteredTotals.realizedPL)}
          color={plColor(filteredTotals.realizedPL)}
        />
        <MiniStat label="Gross proceeds" value={formatUSDCompact(filteredTotals.gross)} />
        <MiniStat label="Net proceeds" value={formatUSDCompact(filteredTotals.net)} />
        <MiniStat label="Cost basis sold" value={formatUSDCompact(filteredTotals.cost)} />
      </div>

      {/* Entries */}
      {filtered.length === 0 ? (
        <div className="text-sm text-[color:var(--color-muted)] text-center py-8">
          No sales match the current filters.
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => (
            <LedgerRow key={e.id} e={e} />
          ))}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="hiq-card p-4">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-1">
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}

function LedgerRow({ e }: { e: LedgerEntry }) {
  const plColor =
    e.realizedProfitLoss > 0 ? "var(--color-success)" : e.realizedProfitLoss < 0 ? "var(--color-danger)" : undefined;
  const source = e.source ?? "manual";
  return (
    <div className="hiq-card p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <div className="font-medium text-sm truncate">{e.cardTitle}</div>
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide"
            style={{
              background: source === "ebay" ? "color-mix(in oklab, var(--color-accent) 15%, transparent)" : "var(--color-bg)",
              color: source === "ebay" ? "var(--color-accent)" : "var(--color-muted)",
            }}
          >
            {source}
          </span>
          {e.needsReconciliation && !e.dismissedAt && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide"
              style={{
                background: "color-mix(in oklab, var(--color-accent) 15%, transparent)",
                color: "var(--color-accent)",
              }}
            >
              Reconcile
            </span>
          )}
        </div>
        <div className="text-xs text-[color:var(--color-muted)] mt-1 flex items-center gap-3 flex-wrap">
          <span>{e.soldAt.slice(0, 10)}</span>
          <span>qty {e.quantitySold}</span>
          <span>
            @ {formatUSD(e.unitSalePrice, { hideCents: e.unitSalePrice >= 100 })} each
          </span>
        </div>
      </div>
      <div className="text-right flex-shrink-0 ml-3">
        <div className="text-sm font-medium tabular-nums" style={plColor ? { color: plColor } : undefined}>
          {formatUSDCompact(e.realizedProfitLoss)}
        </div>
        <div className="text-xs tabular-nums" style={plColor ? { color: plColor } : undefined}>
          {formatPct(e.realizedProfitLossPct)}
        </div>
      </div>
    </div>
  );
}

const filterCls =
  "px-3 py-2 rounded-xl border text-sm outline-none " +
  "bg-[color:var(--color-bg)] border-[color:var(--color-border)] text-white";
