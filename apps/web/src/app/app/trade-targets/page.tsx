"use client";

import { useEffect, useState } from "react";
import { fetchTradeTargets, type TradeTarget, type TradeTargetsResponse } from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct } from "@/lib/format";

type Source = "watchlist" | "inventory";

export default function TradeTargetsPage() {
  const [source, setSource] = useState<Source>("watchlist");
  const [data, setData] = useState<TradeTargetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTradeTargets(source)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        setError(err.message ?? "Failed to scan trade targets");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Trade targets</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Underpriced live eBay listings from your{" "}
          {source === "watchlist" ? "watchlist" : "inventory"} — the buy side of HobbyIQ.
        </p>
      </div>

      <div className="mb-6 flex items-center gap-2 flex-wrap">
        {(["watchlist", "inventory"] as Source[]).map((s) => (
          <button
            key={s}
            onClick={() => setSource(s)}
            className="px-4 py-2 rounded-full text-sm font-medium transition-colors"
            style={{
              background: s === source ? "var(--color-accent)" : "var(--color-bg-card)",
              color: s === source ? "var(--color-bg)" : "var(--color-muted)",
            }}
          >
            {s === "watchlist" ? "From my watchlist" : "From my inventory"}
          </button>
        ))}
      </div>

      {loading && (
        <div className="text-sm text-[color:var(--color-muted)]">Scanning listings…</div>
      )}

      {error && (
        <div className="hiq-card p-4 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {!loading && !error && data && (
        <>
          <div className="text-xs text-[color:var(--color-muted)] mb-4 flex items-center gap-3 flex-wrap">
            <span>Scanned {data.cardsScanned} card{data.cardsScanned === 1 ? "" : "s"}</span>
            <span>· {data.listingsSeen} live listing{data.listingsSeen === 1 ? "" : "s"}</span>
            <span>· {data.targets.length} target{data.targets.length === 1 ? "" : "s"} match</span>
          </div>

          {data.targets.length === 0 ? (
            <div className="hiq-card p-8 text-center">
              <p className="text-sm text-[color:var(--color-muted)] max-w-md mx-auto">
                No underpriced listings on{" "}
                {source === "watchlist"
                  ? "your watchlist"
                  : "your inventory (duplicate finder)"}{" "}
                right now. Wider scans need a bigger {source === "watchlist" ? "watchlist" : "inventory"} —
                add players or cards to get more coverage.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.targets.map((t, i) => (
                <TradeTargetRow key={t.cardId + i} t={t} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TradeTargetRow({ t }: { t: TradeTarget }) {
  const confColor =
    t.confidence === "high"
      ? "var(--color-success)"
      : t.confidence === "medium"
      ? "var(--color-accent)"
      : "var(--color-muted)";

  return (
    <a
      href={t.listingUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="hiq-card p-4 flex items-center gap-4 hover:border-[color:var(--color-accent)] transition-colors"
    >
      <div className="w-16 h-16 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center" style={{ background: "var(--color-bg)" }}>
        {t.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={t.imageUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
            <path d="M4 6h16v12H4V6z" />
          </svg>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <div className="font-medium text-sm truncate">{t.cardTitle || t.playerName}</div>
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide flex-shrink-0"
            style={{
              background: `color-mix(in oklab, ${confColor} 15%, transparent)`,
              color: confColor,
            }}
          >
            {t.confidence}
          </span>
        </div>
        <div className="text-xs text-[color:var(--color-muted)] mt-1 truncate">
          {t.reason}
        </div>
        <div className="text-xs text-[color:var(--color-muted)] mt-1 flex items-center gap-3 flex-wrap">
          <span>{t.seller.username}</span>
          {t.seller.feedbackScore != null && <span>· ★ {t.seller.feedbackScore.toLocaleString()}</span>}
        </div>
      </div>

      <div className="text-right flex-shrink-0 ml-2">
        <div className="text-sm font-bold tabular-nums">
          {formatUSD(t.askPrice, { hideCents: t.askPrice >= 100 })}
        </div>
        <div className="text-xs tabular-nums" style={{ color: "var(--color-success)" }}>
          -{Math.round(t.discountPct * 100)}% vs {formatUSDCompact(t.engineValue)}
        </div>
        <div className="text-[10px] tabular-nums" style={{ color: "var(--color-success)" }}>
          save {formatUSDCompact(t.discountAbsolute)}
        </div>
      </div>
    </a>
  );
}
