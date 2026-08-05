"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchDailyBrief, type DailyBriefResponse } from "@/lib/api";
import { formatPct } from "@/lib/format";

// DailyIQ brief highlights — top risers or headline players for the day.
// Requires the dailyIQBriefs entitlement (collector+); 402 renders locked state.
export function DailyIQCard() {
  const [data, setData] = useState<DailyBriefResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchDailyBrief()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: { status?: number }) => {
        if (cancelled) return;
        if (err.status === 402) setLocked(true);
        else setFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="hiq-card p-6 flex flex-col">
        <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">DailyIQ</div>
        <div className="text-sm text-[color:var(--color-muted)]">Loading brief…</div>
      </div>
    );
  }

  if (locked) {
    return (
      <div className="hiq-card p-6 flex flex-col">
        <h2 className="font-bold text-lg mb-2">DailyIQ</h2>
        <p className="text-sm text-[color:var(--color-muted)] flex-1 leading-relaxed">
          The daily brief covers top risers, fallers, and breakouts across the league. Available on Collector and above.
        </p>
        <Link href="/pricing" className="mt-4 text-sm font-medium hover:underline" style={{ color: "var(--color-accent)" }}>
          See plans →
        </Link>
      </div>
    );
  }

  const risers = data?.risers ?? [];
  if (failed || !data || risers.length === 0) {
    return (
      <div className="hiq-card p-6 flex flex-col">
        <h2 className="font-bold text-lg mb-2">DailyIQ</h2>
        <p className="text-sm text-[color:var(--color-muted)] flex-1 leading-relaxed">
          {failed
            ? "Brief unavailable right now."
            : "No standout movers in today's brief."}
        </p>
      </div>
    );
  }

  return (
    <div className="hiq-card p-6 flex flex-col">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="font-bold text-lg">DailyIQ</h2>
        <span className="text-xs text-[color:var(--color-muted)]">Top risers</span>
      </div>
      <div className="space-y-2 flex-1">
        {risers.slice(0, 5).map((p) => {
          const pct = p.movement?.performanceDelta ?? null;
          const color = (pct ?? 0) > 0 ? "var(--color-success)" : (pct ?? 0) < 0 ? "var(--color-danger)" : undefined;
          return (
            <div key={p.playerId} className="flex items-center justify-between text-sm">
              <span className="truncate mr-3">{p.playerName}</span>
              {pct != null && (
                <span className="tabular-nums flex-shrink-0" style={color ? { color } : undefined}>
                  {formatPct(pct)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <Link
        href="/app/daily"
        className="mt-4 text-sm font-medium hover:underline self-start"
        style={{ color: "var(--color-accent)" }}
      >
        Open full brief →
      </Link>
    </div>
  );
}
