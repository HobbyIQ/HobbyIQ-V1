"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchPortfolio, holdingDisplayValue, type PortfolioResponse, type PortfolioHolding } from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct, formatCardTitle, formatGrade } from "@/lib/format";
import { PortfolioValueChart } from "@/components/PortfolioValueChart";

type SortKey = "value" | "cost" | "gainPct" | "gain" | "title";
type SortDir = "asc" | "desc";

export default function PortfolioPage() {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchPortfolio()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? "Failed to load portfolio");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading portfolio…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div
          className="hiq-card p-6 text-sm"
          style={{ color: "var(--color-danger)" }}
        >
          Couldn&apos;t load your portfolio: {error}
        </div>
      </div>
    );
  }

  if (!data || data.items.length === 0) {
    return <EmptyState />;
  }

  const sorted = sortHoldings(filterHoldings(data.items, query), sortKey, sortDir);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="mb-8 flex items-baseline justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-1">Portfolio</h1>
          <p className="text-sm text-[color:var(--color-muted)]">
            {data.summary.cardCount.toLocaleString()} cards ·{" "}
            {Math.max(0, data.summary.cardCount - data.summary.estimatedCount - data.summary.pendingCount)}
            {" "}with observed FMV · {data.summary.estimatedCount} estimated · {data.summary.pendingCount} pending
          </p>
        </div>
        <Link href="/app/portfolio/add" className="hiq-btn-primary text-sm">
          + Add card
        </Link>
      </div>

      <PortfolioValueChart headlineTotal={data.summary.totalValue} />
      <SummaryBar summary={data.summary} />

      <div className="mt-8 flex items-center gap-3 flex-wrap">
        <input
          type="search"
          placeholder="Filter by player, product, or card #"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 min-w-64 px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
          style={{
            background: "var(--color-bg)",
            borderColor: "var(--color-border)",
            color: "white",
          }}
        />
        <SortSelect value={sortKey} onChange={setSortKey} />
        <SortDirBtn value={sortDir} onChange={setSortDir} />
      </div>

      <div className="mt-6 space-y-3">
        {sorted.map((h) => (
          <Link key={h.id} href={`/app/portfolio/${encodeURIComponent(h.id)}`} className="block">
            <HoldingRow h={h} />
          </Link>
        ))}
      </div>

      {sorted.length === 0 && query && (
        <div className="mt-8 text-center text-sm text-[color:var(--color-muted)]">
          No holdings match &ldquo;{query}&rdquo;.
        </div>
      )}
    </div>
  );
}

function SummaryBar({ summary }: { summary: PortfolioResponse["summary"] }) {
  const gainColor =
    summary.totalGainLoss > 0
      ? "var(--color-success)"
      : summary.totalGainLoss < 0
        ? "var(--color-danger)"
        : "var(--color-muted)";
  return (
    <div className="hiq-card p-6 grid grid-cols-2 md:grid-cols-4 gap-6">
      <Stat label="Total value" value={formatUSD(summary.totalValue, { hideCents: true })} />
      <Stat label="Cost basis" value={formatUSD(summary.totalCost, { hideCents: true })} />
      <Stat
        label="Total gain/loss"
        value={formatUSD(summary.totalGainLoss, { hideCents: true })}
        color={gainColor}
      />
      <Stat label="Return" value={formatPct(summary.totalGainLossPct)} color={gainColor} />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">
        {label}
      </div>
      <div className="text-2xl font-bold" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}

function SortSelect({ value, onChange }: { value: SortKey; onChange: (k: SortKey) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as SortKey)}
      className="px-3 py-2.5 rounded-xl border text-sm outline-none"
      style={{
        background: "var(--color-bg)",
        borderColor: "var(--color-border)",
        color: "white",
      }}
    >
      <option value="value">Sort: current value</option>
      <option value="cost">Sort: cost basis</option>
      <option value="gainPct">Sort: return %</option>
      <option value="gain">Sort: gain $</option>
      <option value="title">Sort: card title</option>
    </select>
  );
}

function SortDirBtn({ value, onChange }: { value: SortDir; onChange: (d: SortDir) => void }) {
  return (
    <button
      onClick={() => onChange(value === "asc" ? "desc" : "asc")}
      className="px-3 py-2.5 rounded-xl border text-sm"
      style={{
        background: "var(--color-bg)",
        borderColor: "var(--color-border)",
        color: "white",
      }}
      aria-label={value === "asc" ? "Ascending" : "Descending"}
    >
      {value === "asc" ? "↑" : "↓"}
    </button>
  );
}

function HoldingRow({ h }: { h: PortfolioHolding }) {
  const title = formatCardTitle(h);
  const grade = formatGrade(h);
  const value = holdingDisplayValue(h);
  const cost = h.totalCostBasis;
  // Recompute P&L against the display value we're actually rendering so the row
  // never shows a P&L that doesn't match its Value column. If the backend
  // sent a null FMV but we're displaying an estimate, its totalProfitLoss
  // will be null/cost-proxy — override with our own math.
  let gain: number | null = h.totalProfitLoss ?? null;
  let gainPct: number | null = h.totalProfitLossPct ?? null;
  if (value != null && cost != null) {
    gain = value - cost;
    gainPct = cost > 0 ? (gain / cost) * 100 : 0;
  }
  const gainColor =
    (gain ?? 0) > 0 ? "var(--color-success)" : (gain ?? 0) < 0 ? "var(--color-danger)" : undefined;

  return (
    <div className="hiq-card p-4 md:p-5 flex items-center gap-4">
      {/* Photo thumbnail */}
      <div
        className="w-14 h-14 md:w-16 md:h-16 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center"
        style={{ background: "var(--color-bg)" }}
      >
        {h.photos && h.photos[0] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={h.photos[0]}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
            <path d="M4 6h16v12H4V6zm2 2v8h12V8H6zm2 2h4v4H8v-4z" />
          </svg>
        )}
      </div>

      {/* Title + grade */}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{title}</div>
        <div className="text-xs text-[color:var(--color-muted)] mt-0.5 flex items-center gap-2">
          <span>{grade}</span>
          {h.quantity > 1 && <span>· qty {h.quantity}</span>}
          {h.valuationStatus === "estimated" && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{
                background: "color-mix(in oklab, var(--color-accent) 12%, transparent)",
                color: "var(--color-accent)",
              }}
            >
              EST
            </span>
          )}
          {h.valuationStatus === "pending" && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium text-[color:var(--color-muted)]" style={{ background: "var(--color-bg)" }}>
              PENDING
            </span>
          )}
        </div>
      </div>

      {/* Value */}
      <div className="text-right hidden md:block">
        <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">Value</div>
        <div className="text-sm font-medium tabular-nums">{formatUSD(value, { hideCents: true })}</div>
      </div>

      {/* Cost */}
      <div className="text-right hidden md:block">
        <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">Cost</div>
        <div className="text-sm font-medium tabular-nums">{formatUSD(cost, { hideCents: true })}</div>
      </div>

      {/* Gain */}
      <div className="text-right min-w-20">
        <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">P&amp;L</div>
        <div className="text-sm font-medium tabular-nums" style={gainColor ? { color: gainColor } : undefined}>
          {formatUSDCompact(gain)}
        </div>
        {gainPct != null && (
          <div className="text-xs tabular-nums" style={gainColor ? { color: gainColor } : undefined}>
            {formatPct(gainPct)}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <div className="hiq-card p-10 text-center">
        <h1 className="text-2xl font-bold mb-3">Your portfolio is empty</h1>
        <p className="text-[color:var(--color-muted)] mb-6 leading-relaxed">
          Add your first card to start tracking FMV, gain/loss, and market movement.
        </p>
        <Link href="/app/portfolio/add" className="hiq-btn-primary inline-block">
          + Add card
        </Link>
      </div>
    </div>
  );
}

// ─── Sort / filter helpers ─────────────────────────────────────────

function filterHoldings(items: PortfolioHolding[], query: string): PortfolioHolding[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((h) => {
    return (
      h.playerName?.toLowerCase().includes(q) ||
      h.product?.toLowerCase().includes(q) ||
      h.parallel?.toLowerCase().includes(q) ||
      h.cardNumber?.toLowerCase().includes(q) ||
      h.cardTitle?.toLowerCase().includes(q)
    );
  });
}

function sortHoldings(items: PortfolioHolding[], key: SortKey, dir: SortDir): PortfolioHolding[] {
  const mult = dir === "asc" ? 1 : -1;
  const sorted = [...items];
  sorted.sort((a, b) => {
    let av: number | string;
    let bv: number | string;
    switch (key) {
      case "value":
        av = holdingDisplayValue(a) ?? -Infinity;
        bv = holdingDisplayValue(b) ?? -Infinity;
        break;
      case "cost":
        av = a.totalCostBasis ?? -Infinity;
        bv = b.totalCostBasis ?? -Infinity;
        break;
      case "gainPct": {
        const av0 = holdingDisplayValue(a);
        const bv0 = holdingDisplayValue(b);
        const acost = a.totalCostBasis ?? 0;
        const bcost = b.totalCostBasis ?? 0;
        av = av0 != null && acost > 0 ? ((av0 - acost) / acost) * 100 : -Infinity;
        bv = bv0 != null && bcost > 0 ? ((bv0 - bcost) / bcost) * 100 : -Infinity;
        break;
      }
      case "gain": {
        const av0 = holdingDisplayValue(a);
        const bv0 = holdingDisplayValue(b);
        av = av0 != null && a.totalCostBasis != null ? av0 - a.totalCostBasis : -Infinity;
        bv = bv0 != null && b.totalCostBasis != null ? bv0 - b.totalCostBasis : -Infinity;
        break;
      }
      case "title":
        av = formatCardTitle(a).toLowerCase();
        bv = formatCardTitle(b).toLowerCase();
        break;
    }
    if (typeof av === "string" && typeof bv === "string") {
      return av.localeCompare(bv) * mult;
    }
    return ((av as number) - (bv as number)) * mult;
  });
  return sorted;
}
