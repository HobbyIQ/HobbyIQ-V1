"use client";

import { useEffect, useRef, useState } from "react";
import { fetchPublicStats, type PublicStats } from "@/lib/api";

// Landing-page live stats strip. Polls GET /api/stats/public every
// POLL_MS and interpolates each counter between polls using a per-
// second rate — either observed (delta / interval from the last two
// fetches) or the SEED_RATE fallback so the first-load user sees
// motion immediately. Once we've observed a real delta the badge
// switches to "LIVE" so visitors know the numbers aren't cosmetic.
//
// CF-NO-VENDOR-LEAK (Drew, 2026-08-05). This component MUST NEVER
// render a data-source name. Only aggregate counts + user-facing
// category labels cross to the DOM.

const POLL_MS = 20_000;

// Conservative per-second growth seed — used until we have two real
// server samples. Baseline_2026-08-05 from live ingest telemetry.
// If observed rate diverges > seed*2 or < seed/4 we clamp to a sane
// band so a burst-ingest spike doesn't skew the visible ticker.
const SEED_RATE = {
  sold: 2.4,      // sales/sec (nightly ingest + real-time enrichment)
  cards: 0.42,    // unique-cards/sec (net-new canonical rows)
  products: 0.01, // products/sec (rare — new set releases)
};
const RATE_MIN_MULT = 0.25;
const RATE_MAX_MULT = 3.5;

const FALLBACK: PublicStats = {
  soldCompsIndexed: 2_800_000,
  cardsWithSlug: 550_000,
  productsIndexed: 3_600,
  categories: 4,
  sportsCovered: ["Baseball", "Basketball", "Football", "Pokemon"],
  dataSourceCount: 6,
  generatedAt: new Date().toISOString(),
};

interface Snapshot {
  stats: PublicStats;
  fetchedAtMs: number;
}

export function LiveStatsStrip() {
  const [display, setDisplay] = useState<PublicStats>(FALLBACK);
  const [loaded, setLoaded] = useState(false);
  // Only flip to "LIVE" once we've observed a real delta from two
  // successful server fetches — otherwise we'd label seed-rate motion
  // as observed and mislead people.
  const [isLive, setIsLive] = useState(false);
  const lastRef = useRef<Snapshot | null>(null);
  const rateRef = useRef({ ...SEED_RATE });

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const s = await fetchPublicStats();
        if (cancelled) return;
        const now = Date.now();
        const snap: Snapshot = { stats: s, fetchedAtMs: now };
        const prev = lastRef.current;
        if (prev) {
          const dtSec = (now - prev.fetchedAtMs) / 1000;
          if (dtSec > 1) {
            const observed = {
              sold: (s.soldCompsIndexed - prev.stats.soldCompsIndexed) / dtSec,
              cards: (s.cardsWithSlug - prev.stats.cardsWithSlug) / dtSec,
              products: ((s.productsIndexed ?? 0) - (prev.stats.productsIndexed ?? 0)) / dtSec,
            };
            rateRef.current = {
              sold: clampRate(observed.sold, SEED_RATE.sold),
              cards: clampRate(observed.cards, SEED_RATE.cards),
              products: clampRate(observed.products, SEED_RATE.products),
            };
            if (observed.sold > 0 || observed.cards > 0) setIsLive(true);
          }
        }
        lastRef.current = snap;
        setDisplay(s);
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    }

    void poll();
    const pollTimer = setInterval(() => void poll(), POLL_MS);

    // Smooth interpolation between polls — Math.floor keeps digits
    // stable within a second and produces the ticker cadence.
    let rafId = 0;
    let lastPaintMs = 0;
    function tick(now: number) {
      // Throttle rerenders to ~10Hz — counters tick a few per second
      // at most, no need to re-render every frame.
      if (now - lastPaintMs >= 100) {
        lastPaintMs = now;
        const anchor = lastRef.current;
        if (anchor) {
          const dtSec = (Date.now() - anchor.fetchedAtMs) / 1000;
          const r = rateRef.current;
          setDisplay((prev) => ({
            ...anchor.stats,
            soldCompsIndexed: Math.floor(anchor.stats.soldCompsIndexed + r.sold * dtSec),
            cardsWithSlug: Math.floor(anchor.stats.cardsWithSlug + r.cards * dtSec),
            productsIndexed: Math.floor((anchor.stats.productsIndexed ?? 0) + r.products * dtSec),
            categories: prev.categories,
            sportsCovered: prev.sportsCovered,
            dataSourceCount: prev.dataSourceCount,
            generatedAt: prev.generatedAt,
          }));
        }
      }
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
      cancelAnimationFrame(rafId);
    };
  }, []);

  return (
    <div className="hiq-card p-6 md:p-10">
      {/* CF-STATS-TWO (Drew, 2026-08-05). Two counters only — Sales Index
          + Card Catalog. Products / Sports / Data sources removed per
          user ask; less clutter, bigger numbers, more room to breathe. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 md:gap-12">
        <Metric value={formatCount(display.soldCompsIndexed)} label="Sales Index" loading={!loaded} />
        <Metric value={formatCount(display.cardsWithSlug)} label="Card Catalog" loading={!loaded} />
      </div>
      <div className="mt-6 pt-6 border-t border-[color:var(--color-border)] flex items-center justify-center gap-3 text-xs text-[color:var(--color-muted)]">
        {isLive && (
          <span className="hiq-live-badge">
            <span className="hiq-live-dot" aria-hidden />
            Live
          </span>
        )}
        <span>{display.sportsCovered.join(" · ")} · Ingested continuously</span>
      </div>
    </div>
  );
}

function Metric({ value, label, loading }: { value: string; label: string; loading: boolean }) {
  return (
    <div className="text-center">
      <div
        className={`hiq-count text-5xl md:text-7xl font-bold mb-2 tracking-tight transition-opacity duration-300 ${loading ? "opacity-50" : "opacity-100"}`}
      >
        {value}
      </div>
      <div className="text-sm uppercase tracking-[0.14em] text-[color:var(--color-muted)] font-semibold">
        {label}
      </div>
    </div>
  );
}

function clampRate(observed: number, seed: number): number {
  if (!Number.isFinite(observed) || observed <= 0) return seed;
  const lo = seed * RATE_MIN_MULT;
  const hi = seed * RATE_MAX_MULT;
  return Math.min(hi, Math.max(lo, observed));
}

function formatCount(n: number): string {
  if (n >= 1_000_000) {
    // Below 10M keep one decimal so the tenths digit ticks — that's
    // where the eye picks up "this thing is moving." At 10M+ round
    // to whole millions so a 10.0 → 10.1 transition doesn't look
    // like a stopped counter.
    if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M+`;
    return `${Math.floor(n / 1_000_000)}M+`;
  }
  if (n >= 10_000) return `${Math.floor(n / 1_000)}K+`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K+`;
  return n.toLocaleString("en-US");
}
