"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  fetchMarketMovers,
  fetchNotableSales,
  fetchMarketSnapshot,
  type MarketMoversResponse,
  type MarketMover,
  type NotableSale,
} from "@/lib/api";
import { formatPct, formatUSD, formatUSDCompact } from "@/lib/format";
import { MarketIndexes } from "@/components/MarketIndexes";

type Window = "1d" | "7d" | "30d";

export default function MarketPage() {
  const [win, setWin] = useState<Window>("7d");
  const [data, setData] = useState<MarketMoversResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [notable, setNotable] = useState<NotableSale[]>([]);
  const [notableLoading, setNotableLoading] = useState(true);

  // CF-DAILY-PUBLISH: pre-computed snapshot published at 5AM ET + 5PM
  // ET. When present it wins over the live fetch for both the top-
  // movers block and the notable-sales tail; the "As of" line renders
  // above the movers so users know it's editorial, not intraday.
  const [snapshotPublishedAt, setSnapshotPublishedAt] = useState<string | null>(null);
  const [snapshotSlot, setSnapshotSlot] = useState<"morning" | "evening" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLocked(false);
    setNotableLoading(true);

    // Try the snapshot first. If it lands and win === "7d" (its scope),
    // reuse it for both movers + notable sales. Otherwise fall back to
    // the live paths.
    (async () => {
      if (win === "7d") {
        try {
          const snap = await fetchMarketSnapshot();
          if (cancelled) return;
          if (snap.success && snap.snapshot) {
            setSnapshotPublishedAt(snap.snapshot.publishedAt);
            setSnapshotSlot(snap.snapshot.publishedSlot);
            setData({
              success: true,
              window: { selected: "7d", pct30dLabel: snap.snapshot.window.pct30dLabel },
              limit: snap.snapshot.topGainers.length + snap.snapshot.topLosers.length,
              movers: [...snap.snapshot.topGainers, ...snap.snapshot.topLosers],
              poolSize: snap.snapshot.poolSize,
            });
            setNotable(snap.snapshot.notableSales.slice(0, 12));
            setLoading(false);
            setNotableLoading(false);
            return;
          }
        } catch {
          // 404 (no snapshot yet) or network error — fall through to live.
        }
      }

      // Live fallback: hits the entitlement-gated top-movers endpoint.
      setSnapshotPublishedAt(null);
      setSnapshotSlot(null);
      try {
        const res = await fetchMarketMovers(win, 60);
        if (cancelled) return;
        setData(res);
        setLoading(false);
      } catch (err) {
        const e = err as { status?: number; message?: string };
        if (cancelled) return;
        if (e.status === 402) setLocked(true);
        else setError(e.message ?? "Failed to load market movers");
        setLoading(false);
      }

      try {
        const nres = await fetchNotableSales({ days: 30, minPrice: 500, limit: 12 });
        if (cancelled) return;
        setNotable(nres.sales);
      } catch {
        // Notable sales failure is non-fatal — the section just hides itself.
      } finally {
        if (!cancelled) setNotableLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [win]);

  const { gainers, losers } = useMemo(() => {
    if (!data) return { gainers: [] as MarketMover[], losers: [] as MarketMover[] };
    const sorted = [...data.movers].sort((a, b) => (b.delta.pct ?? 0) - (a.delta.pct ?? 0));
    const g = sorted.filter((m) => (m.delta.pct ?? 0) > 0).slice(0, 10);
    const l = sorted
      .filter((m) => (m.delta.pct ?? 0) < 0)
      .sort((a, b) => (a.delta.pct ?? 0) - (b.delta.pct ?? 0))
      .slice(0, 10);
    return { gainers: g, losers: l };
  }, [data]);

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Market</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Top movers across the comp pool. Click a player for their full detail.
        </p>
        {snapshotPublishedAt && (
          <p className="text-xs mt-2" style={{ color: "var(--hiq-muted-text)" }}>
            <span
              className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle"
              style={{ background: "var(--hiq-hobby-green)" }}
            />
            Published{" "}
            {new Date(snapshotPublishedAt).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZoneName: "short",
            })}{" "}
            · {snapshotSlot === "evening" ? "Evening" : "Morning"} edition · Updates 5AM &amp; 5PM ET
          </p>
        )}
      </div>

      {/* CF-MARKET-INDEXES: same shared component the DailyIQ screen
          mounts. No "Explore indexes" link here — this IS that page. */}
      <MarketIndexes className="mb-8" showExploreLink={false} />

      <div className="mb-6 flex items-center gap-2 flex-wrap">
        {(["1d", "7d", "30d"] as Window[]).map((w) => (
          <button
            key={w}
            onClick={() => setWin(w)}
            className="px-4 py-2 rounded-full text-sm font-medium transition-colors"
            style={{
              background: w === win ? "var(--color-accent)" : "var(--color-bg-card)",
              color: w === win ? "var(--color-bg)" : "var(--color-muted)",
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

      {data && !locked && (
        <>
          <div className="text-sm text-[color:var(--color-muted)] mb-4">
            Tracking {data.poolSize.toLocaleString()} players ·{" "}
            {(data.movers.length).toLocaleString()} moved in the last {winLabel(win)}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
            <MoverCard title="Top gainers" movers={gainers} tint="var(--color-success)" empty="No gainers this window." />
            <MoverCard title="Top losers" movers={losers} tint="var(--color-danger)" empty="No losers this window." />
          </div>
        </>
      )}

      {!notableLoading && notable.length > 0 && (
        <div className="hiq-card p-6">
          <div className="flex items-baseline justify-between mb-4">
            <div>
              <h2 className="font-bold text-lg">Notable recent sales</h2>
              <p className="text-xs text-[color:var(--color-muted)] mt-1">
                $500+ sold in the last 30 days across our comp pool.
              </p>
            </div>
            <Link href="/app/insights" className="text-xs text-[color:var(--color-accent)] hover:underline">
              See all →
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {notable.slice(0, 12).map((s, i) => (
              <NotableRow key={s.cardId + s.saleDate + i} s={s} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MoverCard({
  title,
  movers,
  tint,
  empty,
}: {
  title: string;
  movers: MarketMover[];
  tint: string;
  empty: string;
}) {
  return (
    <div className="hiq-card p-5">
      <h2 className="font-bold text-lg mb-3">{title}</h2>
      {movers.length === 0 ? (
        <p className="text-sm text-[color:var(--color-muted)]">{empty}</p>
      ) : (
        <div className="space-y-1">
          {movers.map((m, idx) => (
            <MoverRow key={m.playerName + idx} m={m} rank={idx + 1} tint={tint} />
          ))}
        </div>
      )}
    </div>
  );
}

function MoverRow({ m, rank, tint }: { m: MarketMover; rank: number; tint: string }) {
  const pct = m.delta.pct ?? 0;
  const abs = m.delta.absolute ?? null;
  const confColor =
    m.confidence === "high"
      ? "var(--color-success)"
      : m.confidence === "low"
      ? "var(--color-muted)"
      : "var(--color-muted)";
  return (
    <Link
      href={`/app/players/${encodeURIComponent(m.playerName)}`}
      className="flex items-center gap-3 py-2 px-2 -mx-2 rounded-lg hover:bg-white/5 transition-colors"
    >
      <div className="text-xs text-[color:var(--color-muted)] tabular-nums w-5 flex-shrink-0">
        {rank}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{m.playerName}</div>
        <div className="text-[10px] text-[color:var(--color-muted)] mt-0.5" style={{ color: confColor }}>
          {m.confidence} confidence
          {abs != null && (
            <span className="text-[color:var(--color-muted)] ml-2">
              · {abs > 0 ? "+" : ""}{formatUSD(abs, { hideCents: true })}
            </span>
          )}
        </div>
      </div>
      <div className="text-sm font-medium tabular-nums text-right flex-shrink-0" style={{ color: tint }}>
        {formatPct(pct)}
      </div>
    </Link>
  );
}

function NotableRow({ s }: { s: NotableSale }) {
  const inner = (
    <div className="flex items-center gap-3 py-2 px-2 -mx-2 rounded-lg hover:bg-white/5 transition-colors">
      {/* CF-PHOTO-DISPLAY (Drew, 2026-08-10). Slab-ratio + object-contain. */}
      <div className="w-10 h-14 rounded flex-shrink-0 overflow-hidden flex items-center justify-center" style={{ background: "var(--color-bg)" }}>
        {s.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={s.imageUrl} alt="" className="w-full h-full object-contain" />
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
            <path d="M4 6h16v12H4V6z" />
          </svg>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">
          {s.year} {s.cardSet} {s.variant} {s.player}
        </div>
        <div className="text-xs text-[color:var(--color-muted)] flex items-center gap-2 flex-wrap mt-0.5">
          <span>{s.grader} {s.grade}</span>
          <span>· {s.saleDate.slice(0, 10)}</span>
          {s.sourceLabel && <span>· {s.sourceLabel}</span>}
        </div>
      </div>
      <div className="text-sm font-medium tabular-nums flex-shrink-0" style={{ color: "var(--color-success)" }}>
        {formatUSDCompact(s.price)}
      </div>
    </div>
  );
  if (s.listingUrl) {
    return (
      <a href={s.listingUrl} target="_blank" rel="noopener noreferrer">
        {inner}
      </a>
    );
  }
  return inner;
}

function winLabel(w: Window): string {
  return w === "1d" ? "day" : w === "7d" ? "7 days" : "30 days";
}
