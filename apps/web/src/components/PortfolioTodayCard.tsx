"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchPortfolio, type PortfolioResponse } from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct } from "@/lib/format";

// Compact portfolio summary + top 3 movers, for the Today landing.
// Silently degrades to a friendly card if the fetch fails (Today page
// has three of these — one dying shouldn't kill the whole surface).
export function PortfolioTodayCard() {
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPortfolio()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="hiq-card p-6 flex flex-col">
        <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">
          Portfolio Today
        </div>
        <div className="text-sm text-[color:var(--color-muted)] flex-1">Loading…</div>
      </div>
    );
  }

  if (failed || !data) {
    return (
      <div className="hiq-card p-6 flex flex-col">
        <h2 className="font-bold text-lg mb-2">Portfolio Today</h2>
        <p className="text-sm text-[color:var(--color-muted)] flex-1 leading-relaxed">
          Couldn&apos;t load your portfolio right now. Try opening the full view.
        </p>
        <Link
          href="/app/portfolio"
          className="mt-4 text-sm font-medium hover:underline"
          style={{ color: "var(--color-accent)" }}
        >
          Open portfolio →
        </Link>
      </div>
    );
  }

  if (data.items.length === 0) {
    return (
      <div className="hiq-card p-6 flex flex-col">
        <h2 className="font-bold text-lg mb-2">Portfolio Today</h2>
        <p className="text-sm text-[color:var(--color-muted)] flex-1 leading-relaxed">
          You haven&apos;t added any holdings yet. Import your inventory or add a card via
          iOS to see live FMV and gain/loss here.
        </p>
      </div>
    );
  }

  const gainColor =
    data.summary.totalGainLoss > 0
      ? "var(--color-success)"
      : data.summary.totalGainLoss < 0
        ? "var(--color-danger)"
        : "var(--color-muted)";

  // Top 3 by absolute $ gain, filtering nulls
  const movers = [...data.items]
    .filter((h) => h.totalProfitLoss != null)
    .sort((a, b) => Math.abs(b.totalProfitLoss ?? 0) - Math.abs(a.totalProfitLoss ?? 0))
    .slice(0, 3);

  return (
    <div className="hiq-card p-6 flex flex-col">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-bold text-lg">Portfolio Today</h2>
        <span className="text-xs text-[color:var(--color-muted)]">
          {data.summary.cardCount} cards
        </span>
      </div>

      <div className="mb-5">
        <div className="text-3xl font-bold tabular-nums">
          {formatUSD(data.summary.totalValue, { hideCents: true })}
        </div>
        <div className="mt-1 text-sm tabular-nums" style={{ color: gainColor }}>
          {formatUSDCompact(data.summary.totalGainLoss)} · {formatPct(data.summary.totalGainLossPct)}
        </div>
      </div>

      {movers.length > 0 && (
        <div className="border-t border-[color:var(--color-border)] pt-4 flex-1">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">
            Top movers
          </div>
          <div className="space-y-2">
            {movers.map((h) => (
              <MoverRow key={h.id} h={h} />
            ))}
          </div>
        </div>
      )}

      <Link
        href="/app/portfolio"
        className="mt-5 text-sm font-medium hover:underline"
        style={{ color: "var(--color-accent)" }}
      >
        Open portfolio →
      </Link>
    </div>
  );
}

function MoverRow({ h }: { h: PortfolioResponse["items"][number] }) {
  const label = h.playerName ?? h.cardTitle ?? "Untitled";
  const gain = h.totalProfitLoss ?? 0;
  const color =
    gain > 0 ? "var(--color-success)" : gain < 0 ? "var(--color-danger)" : undefined;
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="truncate mr-3">{label}</span>
      <span className="tabular-nums flex-shrink-0" style={color ? { color } : undefined}>
        {formatUSDCompact(gain)}
      </span>
    </div>
  );
}
