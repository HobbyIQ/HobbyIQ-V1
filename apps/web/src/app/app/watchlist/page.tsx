"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchWatchlist, removeWatchlist, type WatchlistItem, type WatchlistResponse } from "@/lib/api";
import { formatPct } from "@/lib/format";

export default function WatchlistPage() {
  const [data, setData] = useState<WatchlistResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function refresh() {
    try {
      const res = await fetchWatchlist();
      setData(res);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 402) setLocked(true);
      else setError(e.message ?? "Failed to load watchlist");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onRemove(playerId: string) {
    setBusy(playerId);
    try {
      await removeWatchlist(playerId);
      await refresh();
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to remove");
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading watchlist…</div>
      </div>
    );
  }

  if (locked) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <h1 className="text-3xl font-bold mb-1">Watchlist</h1>
        <p className="text-sm text-[color:var(--color-muted)] mb-8">Track players you don&apos;t own but want to buy.</p>
        <div className="hiq-card p-10 text-center">
          <div className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold mb-6"
               style={{ background: "color-mix(in oklab, var(--color-accent) 15%, transparent)", color: "var(--color-accent)" }}>
            COLLECTOR PLAN
          </div>
          <h2 className="text-2xl font-bold mb-3">Watchlist is Collector+</h2>
          <p className="text-[color:var(--color-muted)] mb-6 max-w-xl mx-auto leading-relaxed">
            Track any player, get daily performance + movement updates, wait for the right moment to buy.
          </p>
          <Link href="/pricing" className="hiq-btn-primary inline-block">See plans</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-6 flex items-baseline justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-1">Watchlist</h1>
          <p className="text-sm text-[color:var(--color-muted)]">
            Players you&apos;re tracking. Add more from any search result.
          </p>
        </div>
      </div>

      {error && (
        <div className="hiq-card p-4 mb-6 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {data && data.watchlist.length === 0 ? (
        <div className="hiq-card p-10 text-center">
          <h2 className="text-xl font-bold mb-3">Nothing on your watchlist yet</h2>
          <p className="text-[color:var(--color-muted)] mb-6">
            Use search to add players. Their movement + market signals will land here.
          </p>
          <Link href="/app/search" className="hiq-btn-primary inline-block">Open search</Link>
        </div>
      ) : (
        <div className="space-y-3">
          {data?.watchlist.map((w) => (
            <WatchlistRow
              key={w.watchlistItemId ?? w.playerId}
              w={w}
              busy={busy === w.playerId}
              onRemove={() => onRemove(w.playerId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WatchlistRow({ w, busy, onRemove }: { w: WatchlistItem; busy: boolean; onRemove: () => void }) {
  const pct = w.movement?.performanceDelta ?? null;
  const color = (pct ?? 0) > 0 ? "var(--color-success)" : (pct ?? 0) < 0 ? "var(--color-danger)" : undefined;

  return (
    <div className="hiq-card p-4 md:p-5 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{w.playerName}</div>
        <div className="text-xs text-[color:var(--color-muted)] mt-0.5 flex items-center gap-2">
          {w.team && <span>{w.team}</span>}
          {w.position && <span>· {w.position}</span>}
          {w.league && <span>· {w.league}</span>}
          {w.createdAt && <span>· added {w.createdAt.slice(0, 10)}</span>}
        </div>
      </div>
      {pct != null && (
        <div className="text-right text-sm font-medium tabular-nums" style={color ? { color } : undefined}>
          {formatPct(pct)}
        </div>
      )}
      <button
        onClick={onRemove}
        disabled={busy}
        className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors disabled:opacity-50"
        aria-label="Remove"
      >
        {busy ? "…" : "Remove"}
      </button>
    </div>
  );
}
