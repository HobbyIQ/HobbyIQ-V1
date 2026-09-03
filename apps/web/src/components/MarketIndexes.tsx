"use client";

// CF-MARKET-INDEXES (Drew, 2026-09-02).
//
// ONE shared tile strip, mounted on both the market screen and the
// DailyIQ screen. Both mounts render this same component against the
// same /api/compiq/market-indexes call — there is deliberately no
// second copy of the tile markup, so the two screens cannot drift.
//
// Each tile: sport name, period change, a 180d sparkline with a soft
// area fill, and an "Index: N · 180d" footer. Sparkline follows the
// inline-SVG convention already used by PortfolioValueChart (viewBox +
// preserveAspectRatio + a linearGradient area fill), not a chart lib.
//
// FRESHNESS (H-12, 2026-09-03): the tile shows "n of N fresh" whenever
// the newest point was computed from less than the full basket. A level
// off 1 member used to render identically to one off 94, which is how a
// 36x fabricated hockey print stayed invisible. A carried (stale) level
// says so outright.

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchMarketIndexes, type SportIndexSeries } from "@/lib/api";

const SPORT_LABEL: Record<string, string> = {
  baseball: "Baseball",
  basketball: "Basketball",
  football: "Football",
  hockey: "Hockey",
  pokemon: "Pokémon",
};

interface MarketIndexesProps {
  /** Heading above the strip. Hidden when false. */
  showHeading?: boolean;
  /** Renders the "Explore indexes →" affordance. Off on the market
   *  screen itself, where the link would point at the current page. */
  showExploreLink?: boolean;
  className?: string;
}

export function MarketIndexes({
  showHeading = true,
  showExploreLink = true,
  className,
}: MarketIndexesProps = {}) {
  const [data, setData] = useState<SportIndexSeries[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchMarketIndexes(180)
      .then((res) => {
        if (cancelled) return;
        setData(res.indexes ?? []);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Indexes are a secondary surface on both screens — a failure
        // here must never take down the brief or the movers feed.
        setFailed(true);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  if (failed) return null;

  // Sports with no points yet come back with an empty series; drop them
  // from the strip rather than rendering a dead tile.
  const tiles = (data ?? []).filter((d) => d.series && d.series.length >= 2);
  if (!loading && tiles.length === 0) return null;

  return (
    <section className={className}>
      {(showHeading || showExploreLink) && (
        <div className="flex items-baseline justify-between mb-3 gap-4">
          {showHeading ? (
            <div>
              <h2 className="text-base font-semibold">Market indexes</h2>
              <p className="text-xs text-[color:var(--color-muted)] mt-0.5">
                Fixed liquid basket per sport · rebalanced quarterly
              </p>
            </div>
          ) : <span />}
          {showExploreLink && (
            <Link
              href="/app/market"
              className="text-xs font-medium whitespace-nowrap hover:underline"
              style={{ color: "var(--color-accent)" }}
            >
              Explore indexes →
            </Link>
          )}
        </div>
      )}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {loading
          ? Array.from({ length: 5 }).map((_, i) => <IndexTileSkeleton key={i} />)
          : tiles.map((t) => <IndexTile key={t.sport} data={t} />)}
      </div>
    </section>
  );
}

function IndexTile({ data }: { data: SportIndexSeries }) {
  const label = SPORT_LABEL[data.sport] ?? data.sport;
  const pct = data.changePct;
  const up = (pct ?? 0) >= 0;
  const color = up ? "var(--color-positive)" : "var(--color-danger)";

  return (
    <div
      className="rounded-2xl p-4 flex flex-col justify-between"
      style={{
        background: "var(--hiq-card-navy)",
        border: "1px solid var(--color-border-soft)",
      }}
    >
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <span className="text-sm font-semibold truncate">{label}</span>
        {pct != null && (
          <span className="text-sm font-semibold tabular-nums flex-shrink-0" style={{ color }}>
            {up ? "+" : ""}{pct.toFixed(1)}%
          </span>
        )}
      </div>

      <Sparkline points={data.series.map((p) => p.level)} color={color} id={data.sport} />

      <div className="mt-3 text-[11px] text-[color:var(--color-muted)] tabular-nums">
        Index: {data.latestLevel != null ? data.latestLevel.toFixed(1) : "—"} · {data.windowDays}d
      </div>
      <FreshnessNote data={data} />
    </div>
  );
}

/**
 * "n of N fresh" — shown only when the newest point was computed from
 * less than the whole basket, so a full-basket tile stays uncluttered.
 * A stale tile (the point was withheld and the prior level carried) says
 * that instead, because the number on screen is not today's.
 */
function FreshnessNote({ data }: { data: SportIndexSeries }) {
  const fresh = data.freshMembers;
  const basket = data.basketSize;
  if (data.stale) {
    return (
      <div className="mt-1 text-[11px]" style={{ color: "var(--color-muted)" }}>
        Carried · basket too thin to price
      </div>
    );
  }
  if (fresh == null || basket == null || fresh >= basket) return null;
  return (
    <div className="mt-1 text-[11px] tabular-nums" style={{ color: "var(--color-muted)" }}>
      {fresh} of {basket} fresh
    </div>
  );
}

/** Inline-SVG sparkline with a soft area fill. preserveAspectRatio="none"
 *  lets the path stretch to the tile width the way PortfolioValueChart
 *  does; strokes stay visually even because the viewBox aspect is close
 *  to the rendered one. */
function Sparkline({ points, color, id }: { points: number[]; color: string; id: string }) {
  const W = 120;
  const H = 36;
  if (points.length < 2) return <div style={{ height: H }} />;

  const min = Math.min(...points);
  const max = Math.max(...points);
  // A dead-flat series would divide by zero; render it on the midline.
  const range = max - min;
  const flat = range < 1e-9;
  const path = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = flat ? H / 2 : H - ((v - min) / range) * H;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPath = `${path} L ${W} ${H} L 0 ${H} Z`;
  const gradId = `mktIdxFill-${id}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="w-full"
      style={{ height: H }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={path} stroke={color} strokeWidth="1.5" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function IndexTileSkeleton() {
  return (
    <div
      className="rounded-2xl p-4 animate-pulse"
      style={{
        background: "var(--hiq-card-navy)",
        border: "1px solid var(--color-border-soft)",
      }}
    >
      <div className="flex items-baseline justify-between gap-2 mb-3">
        <span className="h-4 w-16 rounded" style={{ background: "var(--color-border)" }} />
        <span className="h-4 w-10 rounded" style={{ background: "var(--color-border)" }} />
      </div>
      <div className="rounded" style={{ height: 36, background: "var(--color-border)", opacity: 0.5 }} />
      <div className="mt-3 h-3 w-24 rounded" style={{ background: "var(--color-border)" }} />
    </div>
  );
}
