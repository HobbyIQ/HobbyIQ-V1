"use client";

// CF-DAILYIQ-WEB-PARITY (Drew, 2026-08-05).
//
// Dedicated web page for DailyIQ — mirrors HobbyIQ/DailyIQView.swift.
// The dashboard's DailyIQCard component only shows the top 5 risers;
// this page renders the full brief: risers, fallers, breakouts, MLB,
// MiLB, and the user's watchlist.
//
// Same /api/dailyiq/brief endpoint the iOS view + the card use.
// 402 → locked (renders upgrade CTA); other errors → retry hint.

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchDailyBrief, type DailyBriefResponse, type DailyPlayer } from "@/lib/api";
import { formatPct } from "@/lib/format";
import { MarketIndexes } from "@/components/MarketIndexes";

type Phase = "loading" | "locked" | "empty" | "error" | "ready";

export default function DailyIQPage() {
  const [data, setData] = useState<DailyBriefResponse | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchDailyBrief()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        const totalPlayers = (res.risers?.length ?? 0) + (res.fallers?.length ?? 0) + (res.breakouts?.length ?? 0) + (res.mlb?.length ?? 0) + (res.milb?.length ?? 0) + (res.watchlist?.length ?? 0);
        setPhase(totalPlayers === 0 ? "empty" : "ready");
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 402) { setPhase("locked"); return; }
        setErrorMsg(err.message ?? "Failed to load brief");
        setPhase("error");
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold mb-1">DailyIQ</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          {data?.date
            ? <>Brief for <span className="text-white">{data.date}</span>. Top movers across MLB and MiLB, plus your watchlist.</>
            : "Top movers across MLB and MiLB, plus your watchlist."}
        </p>
      </header>

      {/* CF-MARKET-INDEXES: mounted OUTSIDE the phase gate on purpose —
          it fetches alongside fetchDailyBrief and renders whether the
          brief is loading, locked (402), errored, or empty. */}
      <MarketIndexes className="mb-8" />

      {phase === "loading" && (
        <div className="hiq-card p-8 text-sm text-[color:var(--color-muted)]">Loading brief…</div>
      )}

      {phase === "locked" && (
        <div className="hiq-card p-8">
          <h2 className="font-bold text-lg mb-2">DailyIQ is on Collector +</h2>
          <p className="text-sm text-[color:var(--color-muted)] mb-4 leading-relaxed">
            The daily brief covers risers, fallers, and breakouts across the league every morning. Available on Collector, Investor, and Pro Seller.
          </p>
          <Link href="/pricing" className="hiq-btn-primary inline-block">See plans</Link>
        </div>
      )}

      {phase === "error" && (
        <div className="hiq-card p-6 text-sm" style={{ color: "var(--color-danger)" }}>
          {errorMsg ?? "Brief unavailable right now."}
        </div>
      )}

      {phase === "empty" && (
        <div className="hiq-card p-8 text-sm text-[color:var(--color-muted)]">
          No standout movers in today's brief. Check back tomorrow.
        </div>
      )}

      {phase === "ready" && data && (
        <div className="grid gap-6 md:grid-cols-2">
          <BriefSection title="Top risers"    subtitle="Biggest gainers today"      accent="positive" players={data.risers} />
          <BriefSection title="Top fallers"   subtitle="Biggest declines today"     accent="negative" players={data.fallers} />
          <BriefSection title="Breakouts"     subtitle="New standouts on the radar" accent="brand"    players={data.breakouts} />
          <BriefSection title="Your watchlist" subtitle="Players you follow"        accent="brand"    players={data.watchlist} />
          <BriefSection title="MLB"           subtitle="Majors movers"              accent="neutral"  players={data.mlb} />
          <BriefSection title="MiLB"          subtitle="Minors movers"              accent="neutral"  players={data.milb} />
        </div>
      )}
    </div>
  );
}

function BriefSection({
  title,
  subtitle,
  accent,
  players,
}: {
  title: string;
  subtitle: string;
  accent: "positive" | "negative" | "brand" | "neutral";
  players?: DailyPlayer[];
}) {
  if (!players || players.length === 0) return null;
  return (
    <section className="hiq-card p-5">
      <header className="flex items-baseline justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="text-xs text-[color:var(--color-muted)] mt-0.5">{subtitle}</p>
        </div>
        <span className={`hiq-badge hiq-badge--${accent}`}>{players.length}</span>
      </header>
      <ul className="divide-y divide-[color:var(--color-border)]">
        {players.slice(0, 10).map((p) => (
          <PlayerRow key={`${title}:${p.playerId}`} p={p} />
        ))}
      </ul>
      {players.length > 10 && (
        <p className="text-xs text-[color:var(--color-muted)] mt-3">
          + {players.length - 10} more
        </p>
      )}
    </section>
  );
}

function PlayerRow({ p }: { p: DailyPlayer }) {
  const pct = p.movement?.performanceDelta ?? null;
  const color = pct != null && pct > 0 ? "var(--color-success)" : pct != null && pct < 0 ? "var(--color-danger)" : undefined;
  const href = `/app/players/${encodeURIComponent(p.playerName)}`;
  return (
    <li className="py-2">
      <Link href={href} className="flex items-center justify-between text-sm hover:underline">
        <span className="min-w-0">
          <span className="truncate">{p.playerName}</span>
          {p.team && <span className="text-xs text-[color:var(--color-muted)] ml-2">{p.team}</span>}
          {p.headline && <span className="block text-xs text-[color:var(--color-muted)] truncate mt-0.5">{p.headline}</span>}
        </span>
        {pct != null && (
          <span className="tabular-nums flex-shrink-0 ml-3" style={color ? { color } : undefined}>
            {formatPct(pct)}
          </span>
        )}
      </Link>
    </li>
  );
}
