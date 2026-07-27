"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchTopPlayers, type PlayerScore, type PlayerIQDirection } from "@/lib/api";
import { formatPct } from "@/lib/format";

type Filter = "all" | PlayerIQDirection;

export default function PlayersPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const [players, setPlayers] = useState<PlayerScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTopPlayers({ limit: 30, direction: filter === "all" ? undefined : filter })
      .then((res) => {
        if (cancelled) return;
        setPlayers(res.players);
        setLoading(false);
      })
      .catch((err: { message?: string }) => {
        if (cancelled) return;
        setError(err.message ?? "Failed to load leaderboard");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filter]);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-1">Players</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          PlayerIQ leaderboard — combined market + performance signal, top 30. Click any
          player for full detail.
        </p>
      </div>

      <div className="mb-6 flex items-center gap-2">
        {(["all", "rising", "falling", "stable"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="px-4 py-2 rounded-full text-sm font-medium transition-colors capitalize"
            style={
              filter === f
                ? { background: "var(--color-accent)", color: "var(--color-bg)" }
                : { background: "var(--color-bg-card)", color: "var(--color-muted)", border: "1px solid var(--color-border)" }
            }
          >
            {f}
          </button>
        ))}
      </div>

      {loading && <div className="text-sm text-[color:var(--color-muted)]">Loading leaderboard…</div>}
      {error && (
        <div className="hiq-card p-4 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {!loading && !error && players.length === 0 && (
        <div className="hiq-card p-8 text-center text-sm text-[color:var(--color-muted)]">
          No players match the selected filter.
        </div>
      )}

      {!loading && !error && players.length > 0 && (
        <div className="hiq-card overflow-hidden">
          <div className="grid grid-cols-12 px-5 py-3 text-xs uppercase tracking-wide text-[color:var(--color-muted)] border-b border-[color:var(--color-border)]">
            <div className="col-span-1">#</div>
            <div className="col-span-6">Player</div>
            <div className="col-span-2 text-right">Score</div>
            <div className="col-span-3 text-right">Signal</div>
          </div>
          {players.map((p, idx) => (
            <PlayerRow key={p.playerId} p={p} rank={idx + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function PlayerRow({ p, rank }: { p: PlayerScore; rank: number }) {
  const dirColor =
    p.playerIQDirection === "rising"
      ? "var(--color-success)"
      : p.playerIQDirection === "falling"
        ? "var(--color-danger)"
        : "var(--color-muted)";
  const arrow = p.playerIQDirection === "rising" ? "↑" : p.playerIQDirection === "falling" ? "↓" : "→";
  return (
    <Link
      href={`/app/players/${encodeURIComponent(p.playerName)}`}
      className="grid grid-cols-12 items-center px-5 py-3 border-b border-[color:var(--color-border)] last:border-0 hover:bg-white/[0.02] transition-colors"
    >
      <div className="col-span-1 text-sm text-[color:var(--color-muted)] tabular-nums">{rank}</div>
      <div className="col-span-6 min-w-0">
        <div className="font-medium text-sm truncate">{p.playerName}</div>
        <div className="text-xs text-[color:var(--color-muted)] mt-0.5 flex items-center gap-2 flex-wrap">
          {p.team && <span>{p.team}</span>}
          {p.position && <span>· {p.position}</span>}
          {p.league && <span>· {p.league}</span>}
          {p.level && <span>· {p.level}</span>}
        </div>
      </div>
      <div className="col-span-2 text-right">
        <div className="text-lg font-bold tabular-nums">{p.playerIQScore}</div>
      </div>
      <div className="col-span-3 text-right">
        <div className="text-sm font-medium truncate" style={{ color: dirColor }}>
          {arrow} {p.playerIQLabel}
        </div>
        <div className="text-xs text-[color:var(--color-muted)] tabular-nums mt-0.5">
          {formatPct(p.market.avgTrendPct)}
        </div>
      </div>
    </Link>
  );
}
