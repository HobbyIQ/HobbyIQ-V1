"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchMarketMovers, type MarketMoversResponse } from "@/lib/api";
import { formatPct } from "@/lib/format";

// 7-day top movers, top 5 shown on the Today landing.
// Degrades gracefully if the fetch fails or the caller lacks the
// marketTrendIndexes entitlement (402).
export function MarketTodayCard() {
  const [data, setData] = useState<MarketMoversResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchMarketMovers("7d", 5)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: { status?: number }) => {
        if (cancelled) return;
        if (err.status === 402) {
          setLocked(true);
        } else {
          setFailed(true);
        }
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
          Market Today
        </div>
        <div className="text-sm text-[color:var(--color-muted)] flex-1">Loading…</div>
      </div>
    );
  }

  if (locked) {
    return (
      <div className="hiq-card p-6 flex flex-col">
        <h2 className="font-bold text-lg mb-2">Market Today</h2>
        <p className="text-sm text-[color:var(--color-muted)] flex-1 leading-relaxed">
          Sector movers per sport are part of the Investor plan and above. Upgrade to
          unlock the full market feed.
        </p>
        <Link
          href="/pricing"
          className="mt-4 text-sm font-medium hover:underline"
          style={{ color: "var(--color-accent)" }}
        >
          See plans →
        </Link>
      </div>
    );
  }

  if (failed || !data || data.movers.length === 0) {
    return (
      <div className="hiq-card p-6 flex flex-col">
        <h2 className="font-bold text-lg mb-2">Market Today</h2>
        <p className="text-sm text-[color:var(--color-muted)] flex-1 leading-relaxed">
          {failed
            ? "Market feed unavailable right now. Try the full view."
            : "No significant movement in the last 7 days."}
        </p>
        <Link
          href="/app/market"
          className="mt-4 text-sm font-medium hover:underline"
          style={{ color: "var(--color-accent)" }}
        >
          Open market →
        </Link>
      </div>
    );
  }

  return (
    <div className="hiq-card p-6 flex flex-col">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-bold text-lg">Market Today</h2>
        <span className="text-xs text-[color:var(--color-muted)]">7-day movers</span>
      </div>
      <div className="space-y-2 flex-1">
        {data.movers.map((m) => (
          <MoverRow key={m.playerName} m={m} />
        ))}
      </div>
      <Link
        href="/app/market"
        className="mt-5 text-sm font-medium hover:underline"
        style={{ color: "var(--color-accent)" }}
      >
        Open market →
      </Link>
    </div>
  );
}

function MoverRow({ m }: { m: MarketMoversResponse["movers"][number] }) {
  const pct = m.delta?.pct ?? null;
  const color =
    (pct ?? 0) > 0
      ? "var(--color-success)"
      : (pct ?? 0) < 0
        ? "var(--color-danger)"
        : undefined;
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="truncate mr-3">{m.playerName}</span>
      <span className="tabular-nums flex-shrink-0" style={color ? { color } : undefined}>
        {formatPct(pct)}
      </span>
    </div>
  );
}
