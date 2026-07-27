"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchMarketMovers, type MarketMoversResponse } from "@/lib/api";
import { formatPct } from "@/lib/format";

type Window = "1d" | "7d" | "30d";

export default function MarketPage() {
  const [win, setWin] = useState<Window>("7d");
  const [data, setData] = useState<MarketMoversResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLocked(false);
    fetchMarketMovers(win, 30)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 402) {
          setLocked(true);
        } else {
          setError(err.message ?? "Failed to load market movers");
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [win]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Market</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Top movers across the comp pool. Signals lag from the observed sales stream.
        </p>
      </div>

      <div className="mb-6 flex items-center gap-2">
        {(["1d", "7d", "30d"] as Window[]).map((w) => (
          <button
            key={w}
            onClick={() => setWin(w)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              w === win ? "text-white" : "text-[color:var(--color-muted)] hover:text-white"
            }`}
            style={{
              background: w === win ? "var(--color-accent)" : "var(--color-bg-card)",
              color: w === win ? "var(--color-bg)" : undefined,
            }}
          >
            {w === "1d" ? "1 day" : w === "7d" ? "7 days" : "30 days"}
          </button>
        ))}
      </div>

      {loading && (
        <div className="text-sm text-[color:var(--color-muted)]">Loading market feed…</div>
      )}

      {locked && (
        <div className="hiq-card p-10 text-center">
          <div
            className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold mb-6"
            style={{
              background: "color-mix(in oklab, var(--color-accent) 15%, transparent)",
              color: "var(--color-accent)",
            }}
          >
            INVESTOR PLAN
          </div>
          <h2 className="text-2xl font-bold mb-3">Market feed is Investor+</h2>
          <p className="text-[color:var(--color-muted)] mb-6 max-w-xl mx-auto leading-relaxed">
            Top movers, sector trends, and market-wide signals come with the Investor and
            Pro Seller plans. Free and Collector tiers get portfolio-scoped movers only.
          </p>
          <Link href="/pricing" className="hiq-btn-primary inline-block">
            See plans
          </Link>
        </div>
      )}

      {error && (
        <div className="hiq-card p-6 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {data && data.movers.length > 0 && (
        <>
          <div className="text-sm text-[color:var(--color-muted)] mb-4">
            {data.movers.length} movers · pool: {data.poolSize.toLocaleString()} tracked players
          </div>
          <div className="hiq-card overflow-hidden">
            <div className="grid grid-cols-12 px-5 py-3 text-xs uppercase tracking-wide text-[color:var(--color-muted)] border-b border-[color:var(--color-border)]">
              <div className="col-span-1">#</div>
              <div className="col-span-7">Player</div>
              <div className="col-span-2 text-right">Δ {win}</div>
              <div className="col-span-2 text-right">Confidence</div>
            </div>
            {data.movers.map((m, idx) => (
              <MoverRow key={m.playerName} m={m} rank={idx + 1} />
            ))}
          </div>
        </>
      )}

      {data && data.movers.length === 0 && (
        <div className="hiq-card p-10 text-center text-sm text-[color:var(--color-muted)]">
          No significant movement in the last {win === "1d" ? "day" : win === "7d" ? "7 days" : "30 days"}.
        </div>
      )}
    </div>
  );
}

function MoverRow({ m, rank }: { m: MarketMoversResponse["movers"][number]; rank: number }) {
  const pct = m.delta?.pct ?? null;
  const color =
    (pct ?? 0) > 0
      ? "var(--color-success)"
      : (pct ?? 0) < 0
        ? "var(--color-danger)"
        : "var(--color-muted)";
  const confColor =
    m.confidence === "high" ? "var(--color-success)" : m.confidence === "low" ? "var(--color-muted)" : "var(--color-muted)";

  return (
    <div className="grid grid-cols-12 items-center px-5 py-3 border-b border-[color:var(--color-border)] last:border-0 hover:bg-white/[0.02] transition-colors">
      <div className="col-span-1 text-sm text-[color:var(--color-muted)] tabular-nums">
        {rank}
      </div>
      <div className="col-span-7 truncate font-medium text-sm">{m.playerName}</div>
      <div className="col-span-2 text-right tabular-nums font-medium text-sm" style={{ color }}>
        {formatPct(pct)}
      </div>
      <div className="col-span-2 text-right text-xs capitalize" style={{ color: confColor }}>
        {m.confidence}
      </div>
    </div>
  );
}
