"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  fetchPlayerByName,
  fetchPlayerHistory,
  addWatchlist,
  type PlayerScore,
  type PlayerHistoryResponse,
  type PlayerHistoryPoint,
} from "@/lib/api";
import { formatPct } from "@/lib/format";

export default function PlayerDetailPage() {
  const params = useParams<{ name: string }>();
  const router = useRouter();
  const rawName = String(params?.name ?? "");
  const playerName = decodeURIComponent(rawName);

  const [player, setPlayer] = useState<PlayerScore | null>(null);
  const [history, setHistory] = useState<PlayerHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [watching, setWatching] = useState(false);
  const [watched, setWatched] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);

  useEffect(() => {
    if (!playerName) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchPlayerByName(playerName),
      fetchPlayerHistory(playerName, 60).catch(() => null),
    ])
      .then(([p, h]) => {
        if (cancelled) return;
        setPlayer(p);
        setHistory(h);
        setLoading(false);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 404) setError("Player not found in PlayerIQ pool.");
        else setError(err.message ?? "Failed to load player detail");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [playerName]);

  async function onWatchlist() {
    if (!player) return;
    setWatching(true);
    setWatchError(null);
    try {
      const res = await addWatchlist({ playerName: player.playerName, league: player.league === "MLB" ? "MLB" : player.league === "MiLB" ? "MiLB" : "All" });
      if (res.success) setWatched(true);
      else setWatchError("Failed to add");
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 402) setWatchError("Watchlist is Collector+.");
      else if (e.status === 404) setWatchError("Player not in DailyIQ pool.");
      else setWatchError(e.message ?? "Failed to add");
    } finally {
      setWatching(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading player…</div>
      </div>
    );
  }
  if (error || !player) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link
          href="/app/players"
          className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors"
        >
          ← Back to leaderboard
        </Link>
        <div className="hiq-card p-8 mt-6 text-center">
          <div className="text-sm mb-4" style={{ color: "var(--color-danger)" }}>
            {error ?? "Not found"}
          </div>
          <Link href="/app/players" className="hiq-btn-primary inline-block">
            Back to leaderboard
          </Link>
        </div>
      </div>
    );
  }

  const dirColor =
    player.playerIQDirection === "rising"
      ? "var(--color-success)"
      : player.playerIQDirection === "falling"
        ? "var(--color-danger)"
        : "var(--color-muted)";

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link
        href="/app/players"
        className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors mb-6 inline-block"
      >
        ← Back to leaderboard
      </Link>

      {/* Header */}
      <div className="hiq-card p-6 mb-6">
        <div className="flex items-start gap-6 flex-wrap">
          <div className="flex-1 min-w-0">
            <h1 className="text-3xl font-bold mb-1">{player.playerName}</h1>
            <div className="text-sm text-[color:var(--color-muted)] flex items-center gap-2 flex-wrap mt-2">
              {player.team && <span>{player.team}</span>}
              {player.position && <span>· {player.position}</span>}
              {player.league && <span>· {player.league}</span>}
              {player.level && <span>· {player.level}</span>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">
              PlayerIQ score
            </div>
            <div className="text-5xl font-bold tabular-nums leading-none">{player.playerIQScore}</div>
            <div className="text-sm font-medium mt-2" style={{ color: dirColor }}>
              {player.playerIQLabel}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-6">
          {watched ? (
            <Link
              href="/app/watchlist"
              className="hiq-btn-secondary text-sm"
              style={{ borderColor: "var(--color-success)", color: "var(--color-success)" }}
            >
              ★ On watchlist
            </Link>
          ) : (
            <button
              onClick={onWatchlist}
              disabled={watching}
              className="hiq-btn-primary text-sm disabled:opacity-60"
            >
              {watching ? "Adding…" : "★ Watchlist player"}
            </button>
          )}
          <button
            onClick={() => router.push(`/app/search?q=${encodeURIComponent(player.playerName)}`)}
            className="hiq-btn-secondary text-sm"
          >
            🔍 Search cards
          </button>
          {watchError && (
            <div className="text-xs" style={{ color: "var(--color-danger)" }}>
              {watchError}
            </div>
          )}
        </div>
      </div>

      {/* Score breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <ScoreCard
          title="Market signal"
          score={player.market.marketScore}
          direction={player.market.marketDirection}
          confidence={player.market.confidence}
        >
          <MetaLine label="Avg trend" value={formatPct(player.market.avgTrendPct)} />
          <MetaLine label="Cards tracked" value={String(player.market.cardCount)} />
          <MetaLine label="Sample size" value={player.market.totalSamples.toLocaleString()} />
          {player.market.topCardName && (
            <MetaLine label="Top mover" value={player.market.topCardName} />
          )}
        </ScoreCard>

        <ScoreCard
          title="Performance signal"
          score={player.performance.performanceScore}
          direction={player.performance.performanceDirection}
          confidence={player.performance.confidence}
        >
          {player.performance.statLine && (
            <MetaLine label="Recent line" value={player.performance.statLine} />
          )}
          {player.performance.momentumRatio != null && (
            <MetaLine
              label="Momentum ratio"
              value={player.performance.momentumRatio.toFixed(2)}
            />
          )}
          {player.performance.statGroup && (
            <MetaLine label="Discipline" value={player.performance.statGroup} />
          )}
          {player.performance.milestone && (
            <MetaLine label="Milestone" value={player.performance.milestone} />
          )}
        </ScoreCard>
      </div>

      {/* History chart */}
      {history && history.points.length >= 2 && (
        <div className="hiq-card p-6 mb-6">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-bold text-lg">Score history</h2>
            <span className="text-xs text-[color:var(--color-muted)]">
              Last {history.count} snapshots
            </span>
          </div>
          <HistoryChart points={history.points} />
        </div>
      )}

      {/* Provenance footer */}
      <div className="hiq-card p-4 text-xs text-[color:var(--color-muted)]">
        Updated {player.updatedAt.slice(0, 10)} · Source: {player.dataSource} · Overall
        confidence: {player.confidence}
      </div>
    </div>
  );
}

function ScoreCard({
  title,
  score,
  direction,
  confidence,
  children,
}: {
  title: string;
  score: number;
  direction: string;
  confidence: string;
  children: React.ReactNode;
}) {
  const color =
    direction === "rising"
      ? "var(--color-success)"
      : direction === "falling"
        ? "var(--color-danger)"
        : "var(--color-muted)";
  return (
    <div className="hiq-card p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-bold text-lg">{title}</h2>
        <span
          className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
          style={{
            background: `color-mix(in oklab, ${color} 15%, transparent)`,
            color,
          }}
        >
          {confidence}
        </span>
      </div>
      <div className="flex items-baseline gap-2 mb-4">
        <div className="text-4xl font-bold tabular-nums">{score}</div>
        <div className="text-sm font-medium capitalize" style={{ color }}>
          {direction}
        </div>
      </div>
      <div className="space-y-1.5 pt-3 border-t border-[color:var(--color-border)]">
        {children}
      </div>
    </div>
  );
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm py-1">
      <span className="text-[color:var(--color-muted)]">{label}</span>
      <span className="tabular-nums text-white truncate ml-3 max-w-[60%] text-right">{value}</span>
    </div>
  );
}

function HistoryChart({ points }: { points: PlayerHistoryPoint[] }) {
  // Sort oldest → newest for left-to-right time axis
  const sorted = [...points].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const scores = sorted.map((p) => p.playerIQScore);
  const min = Math.max(0, Math.min(...scores) - 5);
  const max = Math.min(100, Math.max(...scores) + 5);
  const range = Math.max(1, max - min);
  const W = 800;
  const H = 180;
  const path = sorted
    .map((p, i) => {
      const x = (i / (sorted.length - 1)) * W;
      const y = H - ((p.playerIQScore - min) / range) * H;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPath = `${path} L ${W} ${H} L 0 ${H} Z`;

  return (
    <div>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full min-w-72"
          preserveAspectRatio="none"
          style={{ height: H }}
        >
          <defs>
            <linearGradient id="playerScoreFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.3" />
              <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#playerScoreFill)" />
          <path d={path} stroke="var(--color-accent)" strokeWidth="2" fill="none" />
        </svg>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-[color:var(--color-muted)]">
        <span>{sorted[0].updatedAt.slice(0, 10)}</span>
        <span>
          {min}–{max}
        </span>
        <span>{sorted[sorted.length - 1].updatedAt.slice(0, 10)}</span>
      </div>
    </div>
  );
}
