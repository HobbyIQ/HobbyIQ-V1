"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchWeeklyBrief,
  fetchSellNowRadar,
  fetchNotableSales,
  type WeeklyBriefResponse,
  type SellRadarResponse,
  type NotableSalesResponse,
  type SellRadarCandidate,
  type NotableSale,
} from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct } from "@/lib/format";

export default function InsightsPage() {
  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="mb-8 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold mb-1">Insights</h1>
          <p className="text-sm text-[color:var(--color-muted)]">
            Weekly brief, sell-now radar, and the market&apos;s biggest recent sales.
          </p>
        </div>
        {/* CF-WEEKLY-DIGEST (Drew, 2026-09-02). The sidebar is deliberately
            capped at 10 items (CF-SIDEBAR-TRIM), so the digest is reached
            from here — the surface it most belongs beside. */}
        <Link
          href="/app/digest"
          className="text-sm font-medium hover:underline flex-shrink-0"
          style={{ color: "var(--color-accent)" }}
        >
          Your week in cards →
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <WeeklyBriefSection />
        <SellRadarSection />
      </div>

      <NotableSalesSection />
    </div>
  );
}

// ─── Weekly brief ───────────────────────────────────────────────────

function WeeklyBriefSection() {
  const [data, setData] = useState<WeeklyBriefResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "locked" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchWeeklyBrief()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setState("ready");
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 402) setState("locked");
        else {
          setState("error");
          setError(err.message ?? "Failed to load weekly brief");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") return <SectionCard title="Weekly brief"><Loading /></SectionCard>;
  if (state === "locked") return <SectionCard title="Weekly brief"><LockedPrompt tier="Investor" /></SectionCard>;
  if (state === "error") return <SectionCard title="Weekly brief"><ErrorBox msg={error ?? ""} /></SectionCard>;
  if (!data) return null;

  return (
    <SectionCard title="Weekly brief">
      <div className="text-sm mb-4 text-white leading-relaxed">{data.headline}</div>

      <div className="grid grid-cols-3 gap-3 mb-5">
        <StatMini label="Holdings" value={String(data.summary.holdings)} />
        <StatMini label="Alerts" value={String(data.summary.alerts)} color={data.summary.criticalAlerts > 0 ? "var(--color-danger)" : undefined} />
        <StatMini
          label="Critical"
          value={String(data.summary.criticalAlerts)}
          color={data.summary.criticalAlerts > 0 ? "var(--color-danger)" : undefined}
        />
      </div>

      {(data.topWinners?.length ?? 0) > 0 && (
        <div className="mb-4">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">Top winners</div>
          <div className="space-y-1.5">
            {(data.topWinners ?? []).slice(0, 3).map((w) => (
              <div key={w.holdingId} className="flex items-center justify-between text-sm">
                <span className="truncate mr-3">{w.playerName}</span>
                <span className="tabular-nums font-medium" style={{ color: "var(--color-success)" }}>
                  {formatPct(w.movePct)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(data.topLosers?.length ?? 0) > 0 && (
        <div className="mb-4">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">Top losers</div>
          <div className="space-y-1.5">
            {(data.topLosers ?? []).slice(0, 3).map((l) => (
              <div key={l.holdingId} className="flex items-center justify-between text-sm">
                <span className="truncate mr-3">{l.playerName}</span>
                <span className="tabular-nums font-medium" style={{ color: "var(--color-danger)" }}>
                  {formatPct(l.movePct)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(data.recommendations?.length ?? 0) > 0 && (
        <div className="mt-5 pt-4 border-t border-[color:var(--color-border)]">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">Recommended</div>
          <ul className="space-y-1.5 text-sm text-[color:var(--color-muted)] leading-relaxed">
            {(data.recommendations ?? []).map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                <span style={{ color: "var(--color-accent)" }}>→</span>
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

// ─── Sell-now radar ─────────────────────────────────────────────────

function SellRadarSection() {
  const [data, setData] = useState<SellRadarResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "locked" | "error" | "empty">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSellNowRadar()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setState(res.candidates.length === 0 ? "empty" : "ready");
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 402) setState("locked");
        else {
          setState("error");
          setError(err.message ?? "Failed to load sell radar");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "loading") return <SectionCard title="Sell-now radar"><Loading /></SectionCard>;
  if (state === "locked") return <SectionCard title="Sell-now radar"><LockedPrompt tier="Investor" /></SectionCard>;
  if (state === "error") return <SectionCard title="Sell-now radar"><ErrorBox msg={error ?? ""} /></SectionCard>;
  if (state === "empty") return (
    <SectionCard title="Sell-now radar">
      <div className="text-sm text-[color:var(--color-muted)] leading-relaxed">
        No holdings currently trigger the sell-now gate (2× baseline velocity + up-momentum player).
        Cards you own will surface here when the market is coming to meet them.
      </div>
    </SectionCard>
  );
  if (!data) return null;

  return (
    <SectionCard title={`Sell-now radar — ${data.count}`}>
      <div className="space-y-3">
        {data.candidates.slice(0, 6).map((c) => (
          <SellRadarRow key={c.holdingId} c={c} />
        ))}
      </div>
      {data.candidates.length > 6 && (
        <div className="text-xs text-[color:var(--color-muted)] mt-4">
          + {data.candidates.length - 6} more candidates
        </div>
      )}
    </SectionCard>
  );
}

function SellRadarRow({ c }: { c: SellRadarCandidate }) {
  const gainColor = (c.unrealizedGainUsd ?? 0) > 0 ? "var(--color-success)" : (c.unrealizedGainUsd ?? 0) < 0 ? "var(--color-danger)" : undefined;
  return (
    <Link
      href={`/app/portfolio/${encodeURIComponent(c.holdingId)}`}
      className="block hiq-card p-3 hover:bg-white/[0.02] transition-colors"
      style={{ background: "var(--color-bg)" }}
    >
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <div className="font-medium text-sm truncate">{c.player}</div>
        <div className="flex items-center gap-2 text-xs flex-shrink-0">
          <span
            className="px-1.5 py-0.5 rounded font-bold uppercase tracking-wide text-[10px]"
            style={{
              background: "color-mix(in oklab, var(--color-accent) 15%, transparent)",
              color: "var(--color-accent)",
            }}
          >
            {c.velocityMultiple.toFixed(1)}× velocity
          </span>
          {c.playerDirection === "up" && (
            <span style={{ color: "var(--color-success)" }}>↑ {formatPct(c.playerMomentum)}</span>
          )}
        </div>
      </div>
      <div className="text-xs text-[color:var(--color-muted)] truncate mb-2">{c.cardTitle} · {c.graderTier}</div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-[color:var(--color-muted)]">Now: {formatUSD(c.currentMarketValue, { hideCents: true })}</span>
        {c.unrealizedGainUsd != null && (
          <span className="tabular-nums font-medium" style={gainColor ? { color: gainColor } : undefined}>
            {formatUSDCompact(c.unrealizedGainUsd)} unrealized
          </span>
        )}
      </div>
      <div className="text-xs text-[color:var(--color-muted)] mt-2 italic">{c.reason}</div>
    </Link>
  );
}

// ─── Notable sales ──────────────────────────────────────────────────

function NotableSalesSection() {
  const [data, setData] = useState<NotableSalesResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "locked" | "error" | "empty">("loading");
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(30);
  const [minPrice, setMinPrice] = useState(100_000);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    fetchNotableSales({ days, minPrice, limit: 20 })
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setState(res.sales.length === 0 ? "empty" : "ready");
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 402) setState("locked");
        else {
          setState("error");
          setError(err.message ?? "Failed to load notable sales");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [days, minPrice]);

  return (
    <div className="hiq-card p-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-4">
        <h2 className="font-bold text-lg">Notable sales</h2>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="px-3 py-1.5 rounded-lg border text-xs outline-none"
            style={{
              background: "var(--color-bg)",
              borderColor: "var(--color-border)",
              color: "white",
            }}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
          <select
            value={minPrice}
            onChange={(e) => setMinPrice(Number(e.target.value))}
            className="px-3 py-1.5 rounded-lg border text-xs outline-none"
            style={{
              background: "var(--color-bg)",
              borderColor: "var(--color-border)",
              color: "white",
            }}
          >
            <option value={10_000}>$10K+</option>
            <option value={50_000}>$50K+</option>
            <option value={100_000}>$100K+</option>
            <option value={250_000}>$250K+</option>
            <option value={1_000_000}>$1M+</option>
          </select>
        </div>
      </div>

      {state === "loading" && <Loading />}
      {state === "locked" && <LockedPrompt tier="Investor" />}
      {state === "error" && <ErrorBox msg={error ?? ""} />}
      {state === "empty" && (
        <div className="text-sm text-[color:var(--color-muted)] text-center py-6">
          No sales above ${minPrice.toLocaleString()} in the last {days} days.
        </div>
      )}
      {state === "ready" && data && (
        <div className="space-y-2">
          {data.sales.map((s) => (
            <NotableSaleRow key={`${s.cardId}-${s.saleDate}`} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function NotableSaleRow({ s }: { s: NotableSale }) {
  return (
    <div className="hiq-card p-3 flex items-center gap-4" style={{ background: "var(--color-bg)" }}>
      {/* CF-PHOTO-DISPLAY (Drew, 2026-08-10). Slab-ratio + object-contain. */}
      <div
        className="w-12 h-16 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center"
        style={{ background: "var(--color-bg-card)" }}
      >
        {s.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={s.imageUrl} alt="" className="w-full h-full object-contain" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
            <path d="M4 6h16v12H4V6zm2 2v8h12V8H6zm2 2h4v4H8v-4z" />
          </svg>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">
          {s.year} {s.cardSet} {s.player} {s.number ? `#${s.number}` : ""}
        </div>
        <div className="text-xs text-[color:var(--color-muted)] truncate mt-0.5 flex items-center gap-2 flex-wrap">
          {s.variant && <span>{s.variant}</span>}
          {s.grader && <span>· {s.grader} {s.grade}</span>}
          {s.sourceLabel && <span>· {s.sourceLabel}</span>}
          <span>· {s.saleDate.slice(0, 10)}</span>
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-lg font-bold tabular-nums">{formatUSD(s.price, { hideCents: true })}</div>
        {s.listingUrl && (
          <a
            href={s.listingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs hover:underline"
            style={{ color: "var(--color-accent)" }}
          >
            View listing ↗
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Shared ─────────────────────────────────────────────────────────

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="hiq-card p-6">
      <h2 className="font-bold text-lg mb-4">{title}</h2>
      {children}
    </div>
  );
}

function StatMini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">{label}</div>
      <div className="text-xl font-bold tabular-nums" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}

function Loading() {
  return <div className="text-sm text-[color:var(--color-muted)]">Loading…</div>;
}

function ErrorBox({ msg }: { msg: string }) {
  return <div className="text-sm" style={{ color: "var(--color-danger)" }}>{msg}</div>;
}

function LockedPrompt({ tier }: { tier: string }) {
  return (
    <div className="text-sm">
      <div
        className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide mb-3"
        style={{
          background: "color-mix(in oklab, var(--color-accent) 15%, transparent)",
          color: "var(--color-accent)",
        }}
      >
        {tier}+ feature
      </div>
      <p className="text-[color:var(--color-muted)] mb-3 leading-relaxed">
        Available on the {tier} plan and above.
      </p>
      <Link
        href="/pricing"
        className="text-xs font-medium hover:underline"
        style={{ color: "var(--color-accent)" }}
      >
        See plans →
      </Link>
    </div>
  );
}
