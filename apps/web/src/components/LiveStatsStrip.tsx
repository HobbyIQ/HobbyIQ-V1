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
// Conservative seed — better to UNDER-tick and let the poll bump us
// up than OVER-tick and have to visibly drop on correction. The
// monotonic clamp in the RAF loop also guards against regressions.
const SEED_RATE = {
  sold: 0.8,      // sales/sec (nightly ingest + real-time enrichment)
  cards: 0.15,    // unique-cards/sec (net-new canonical rows)
  products: 0.005,// products/sec (rare — new set releases)
};
const RATE_MIN_MULT = 0.25;
const RATE_MAX_MULT = 4.0;

const FALLBACK: PublicStats = {
  soldCompsIndexed: 3_800_000,
  cardsWithSlug: 3_500_000,
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
  const highWaterRef = useRef<{ sold: number; cards: number; products: number } | null>(null);

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
        // Seed high-water from the first real fetch — otherwise the
        // FALLBACK constants would clamp the display upward if they
        // exceed reality (e.g. after a Cosmos re-index that reset a
        // count temporarily).
        if (!highWaterRef.current) {
          highWaterRef.current = {
            sold: s.soldCompsIndexed,
            cards: s.cardsWithSlug,
            products: s.productsIndexed ?? 0,
          };
        }
        setLoaded(true);
      } catch {
        if (!cancelled) setLoaded(true);
      }
    }

    void poll();
    const pollTimer = setInterval(() => void poll(), POLL_MS);

    // Smooth interpolation between polls — Math.floor keeps digits
    // stable within a second and produces the ticker cadence.
    //
    // CF-MONOTONIC (Drew, 2026-08-05). Counters MUST NOT go backwards.
    // Bug seen on the live page: seed rate over-predicted growth, then
    // a new poll landed with a lower true value than what we had
    // interpolated, so the number visibly dropped every 20 seconds.
    // Fix: track a high-water mark per counter and clamp display to
    // max(interpolated, highWater). New polls only reset the anchor
    // downward silently if the interpolated ceiling still exceeds them —
    // the display keeps climbing from where the eye last saw it.
    let rafId = 0;
    let lastPaintMs = 0;
    function tick(now: number) {
      // Throttle rerenders to ~10Hz — counters tick a few per second
      // at most, no need to re-render every frame.
      if (now - lastPaintMs >= 100) {
        lastPaintMs = now;
        const anchor = lastRef.current;
        const hw = highWaterRef.current;
        if (anchor && hw) {
          const dtSec = (Date.now() - anchor.fetchedAtMs) / 1000;
          const r = rateRef.current;
          const nextSold = Math.floor(anchor.stats.soldCompsIndexed + r.sold * dtSec);
          const nextCards = Math.floor(anchor.stats.cardsWithSlug + r.cards * dtSec);
          const nextProducts = Math.floor((anchor.stats.productsIndexed ?? 0) + r.products * dtSec);
          hw.sold = Math.max(hw.sold, nextSold);
          hw.cards = Math.max(hw.cards, nextCards);
          hw.products = Math.max(hw.products, nextProducts);
          setDisplay((prev) => ({
            ...anchor.stats,
            soldCompsIndexed: hw.sold,
            cardsWithSlug: hw.cards,
            productsIndexed: hw.products,
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
    <div className="hiq-card p-8 md:p-12">
      {/* CF-STATS-UPGRADED (Drew, 2026-08-11 rev). Numbers were too
          overwhelming at md:text-7xl/lg:text-8xl — dropped one step.
          LIVE pill moved from top-right float to bottom-center below
          the numbers so it reads as a footer credential, not visual
          competition with the numbers themselves. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 md:gap-12">
        <Metric value={formatCount(display.soldCompsIndexed)} label="Sales Index" loading={!loaded} />
        <Metric value={formatCount(display.cardsWithSlug)} label="Card Catalog" loading={!loaded} />
      </div>
      {isLive && (
        <div className="mt-6 md:mt-8 flex justify-center">
          <span className="hiq-live-badge">
            <span className="hiq-live-dot" aria-hidden />
            Live
          </span>
        </div>
      )}
    </div>
  );
}

function Metric({ value, label, loading }: { value: string; label: string; loading: boolean }) {
  return (
    <div className="text-center">
      {/* Sizes: mobile text-4xl → desktop md:text-6xl. Prior revision
          bumped to md:text-7xl/lg:text-8xl which Drew flagged as
          overwhelming. tabular-nums keeps ticker digits aligned as
          they change. */}
      <div
        className={`hiq-count text-4xl sm:text-5xl md:text-6xl font-bold mb-3 tracking-tight tabular-nums transition-opacity duration-300 ${loading ? "opacity-50" : "opacity-100"}`}
      >
        {value}
      </div>
      <div className="text-xs md:text-sm uppercase tracking-[0.2em] text-[color:var(--color-muted)] font-semibold">
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
  // CF-LIVE-TICKER (Drew, 2026-08-05). Show the full comma-formatted
  // integer instead of rounding to "2.8M+" — the rounded form only
  // updates every ~100K, which at ~2.4/sec means the visible digit
  // changes once every 11 hours. With full digits the trailing ones
  // tick every second and the strip actually LOOKS live.
  return Math.floor(n).toLocaleString("en-US");
}
