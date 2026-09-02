"use client";

// CF-PRO-SELLER-WORKSPACE (Drew, 2026-09-02). The Pro Seller workspace —
// the one page a person who sells cards for money opens in the morning.
//
// It composes six surfaces that already exist (or are landing) as separate
// backend capabilities:
//
//   1. Sell-window signals      per-holding sellSignal on the portfolio wire
//   2. Deal-scanner feed        GET /api/portfolio/notable-sales
//   3. Fee / P&L summary        GET /api/portfolio/erp/pnl  (D34 fee lines)
//   4. Sport index context      GET /api/compiq/market-indexes
//   5. Grade-arb opportunities  GET /api/portfolio/grade-worthy-alerts
//   6. Recent-sales velocity    GET /api/portfolio/sell-now-radar
//
// WHY THIS PAGE IS BUILT THE WAY IT IS
//
// Several of those are in open PRs today. Rather than block this page behind
// them — or block them behind this page — every section FEATURE-DETECTS its
// own endpoint through resolveSection(): a 404 hides the section entirely, a
// 402 renders the upsell, anything else is an error confined to that one box.
// So this page merges before or after any of those PRs, in any order, and is
// correct at every point in between. As each backing PR deploys, its section
// simply starts appearing. Nothing here needs to change to let that happen.
//
// The sections are deliberately INDEPENDENT requests. A single composite
// endpoint would be one round trip, but it would also mean the slowest
// surface (the grade-arb scan, which fans out over every raw holding) sets
// the latency of the fastest, and one absent capability would have to be
// modelled inside a response shape instead of just being a 404.
//
// GATING. The page is a paid surface. The gate is the EXISTING machinery,
// not a new one: every backing route already sits behind requireSession →
// requireEntitlement(...) server-side, and the free tier is turned away by
// the server on every one of them. This page adds no client-side authority
// over that — it reads /api/entitlements/me only to decide whether to render
// the upsell instead of six locked boxes, which is presentation. If that
// probe were bypassed, every section would still 402 from the server.
//
// NO PRICING IS COMPUTED HERE. Every number on this page is rendered as the
// server sent it. The one arithmetic operation in this file is a fee-rate
// percentage (fees ÷ gross), which is a ratio of two figures the P&L endpoint
// already returned — not a valuation. FMV is the projected next sale from a
// comp pool's trend and it is computed in exactly one place, server-side.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchEntitlements,
  fetchErpPnl,
  fetchGradeArbOpportunities,
  fetchMarketIndexes,
  fetchNotableSales,
  fetchPortfolio,
  fetchSellNowRadar,
  hasFeature,
  resolveSection,
  type ErpPnlResponse,
  type GradeArbResponse,
  type MarketIndexesResponse,
  type NotableSalesResponse,
  type PortfolioHolding,
  type PortfolioResponse,
  type SectionOutcome,
  type SellRadarResponse,
} from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct, formatCardTitle } from "@/lib/format";
import { Chip, Num, Section, tierLabel, type Severity } from "@/components/ProSellerSection";

/** The feature the workspace as a whole is sold under. Same key the ERP
 *  routes gate on — see backend/src/config/entitlements.ts, where
 *  erpReconciliation belongs to pro_seller. */
const WORKSPACE_FEATURE = "erpReconciliation";

type Gate =
  | { state: "checking" }
  | { state: "open" }
  | { state: "locked"; requiredTier: string | null }
  /** Could not determine entitlement. We let the page through: each section
   *  is independently gated server-side, so the worst case is a page of
   *  upsell boxes — strictly better than locking out a paying customer
   *  because one probe failed. */
  | { state: "unknown" };

export default function ProSellerWorkspacePage() {
  const [gate, setGate] = useState<Gate>({ state: "checking" });

  // null = still loading (renders that section's skeleton).
  const [sellWindow, setSellWindow] = useState<SectionOutcome<PortfolioResponse> | null>(null);
  const [deals, setDeals] = useState<SectionOutcome<NotableSalesResponse> | null>(null);
  const [pnl, setPnl] = useState<SectionOutcome<ErpPnlResponse> | null>(null);
  const [indexes, setIndexes] = useState<SectionOutcome<MarketIndexesResponse> | null>(null);
  const [gradeArb, setGradeArb] = useState<SectionOutcome<GradeArbResponse> | null>(null);
  const [velocity, setVelocity] = useState<SectionOutcome<SellRadarResponse> | null>(null);

  useEffect(() => {
    let cancelled = false;

    // The entitlement probe reads the SAME matrix the middleware enforces, so
    // the page's answer and the server's answer cannot disagree.
    fetchEntitlements()
      .then((res) => {
        if (cancelled) return;
        const granted = hasFeature(res.features, WORKSPACE_FEATURE);
        setGate(granted ? { state: "open" } : { state: "locked", requiredTier: "pro_seller" });
      })
      .catch((err: { status?: number; requiredTier?: string | null }) => {
        if (cancelled) return;
        if (err.status === 402 || err.status === 403) {
          setGate({ state: "locked", requiredTier: err.requiredTier ?? "pro_seller" });
        } else {
          setGate({ state: "unknown" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Sections load only once the gate is not a hard "locked" — no reason to
  // spend six requests (one of them a Cosmos fan-out) proving what the
  // entitlement probe already said.
  const gateAllowsData = gate.state === "open" || gate.state === "unknown";

  useEffect(() => {
    if (!gateAllowsData) return;
    let cancelled = false;
    const set = <T,>(fn: (v: SectionOutcome<T>) => void) => (v: SectionOutcome<T>) => {
      if (!cancelled) fn(v);
    };

    // Fired together, resolved independently. Each settles its own section.
    void resolveSection(() => fetchPortfolio()).then(set(setSellWindow));
    void resolveSection(() => fetchNotableSales({ days: 7, limit: 12 })).then(set(setDeals));
    void resolveSection(() => fetchErpPnl({ groupBy: "month" })).then(set(setPnl));
    void resolveSection(() => fetchMarketIndexes(90)).then(set(setIndexes));
    void resolveSection(() => fetchGradeArbOpportunities()).then(set(setGradeArb));
    void resolveSection(() => fetchSellNowRadar()).then(set(setVelocity));

    return () => {
      cancelled = true;
    };
  }, [gateAllowsData]);

  if (gate.state === "checking") {
    return (
      <div className="max-w-6xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading your workspace…</div>
      </div>
    );
  }

  if (gate.state === "locked") {
    return <WorkspaceUpsell requiredTier={gate.requiredTier} />;
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <header className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Seller workspace</h1>
        <p className="text-sm text-[color:var(--color-muted)] leading-relaxed max-w-2xl">
          What to sell, what to buy, and what it cost you — the six reads that
          decide a selling day, on one page. Every number here is computed
          server-side; this page only shows it.
        </p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <SellWindowSection outcome={sellWindow} />
        <VelocitySection outcome={velocity} />
        <FeePnlSection outcome={pnl} />
        <GradeArbSection outcome={gradeArb} />
        <DealFeedSection outcome={deals} />
        <SportIndexSection outcome={indexes} />
      </div>
    </div>
  );
}

// ─── 1. Sell-window signals ────────────────────────────────────────────
//
// Rides on the portfolio wire: PR #1652 adds `sellSignal` per holding. Until
// it deploys, /api/portfolio answers 200 with the field simply absent — so a
// 404 check alone would not hide this section. It detects on the DATA: no
// holding carries a signal → the capability is not live → render nothing.
// That is the honest feature-detect for a field-shaped capability, as
// opposed to a route-shaped one.

function SellWindowSection({ outcome }: { outcome: SectionOutcome<PortfolioResponse> | null }) {
  const effective: SectionOutcome<PortfolioResponse> | null =
    outcome?.state === "ready" && !outcome.data.items?.some((h) => h.sellSignal != null)
      ? { state: "absent" }
      : outcome;

  return (
    <Section
      title="Sell window"
      blurb="Cards whose player market has moved ahead of their own comp pool. A timing read, not a price."
      outcome={effective}
      href="/app/portfolio"
      hrefLabel="Portfolio"
      emptyNote="No open sell windows — nothing in your inventory is lagging its player right now."
    >
      {(data) => {
        const rows = (data.items ?? [])
          .filter((h) => h.sellSignal && h.sellSignal.signal !== "none")
          .sort((a, b) => sellRank(b) - sellRank(a))
          .slice(0, 6);
        if (rows.length === 0) return null;
        return (
          <ul className="space-y-3">
            {rows.map((h) => (
              <li key={h.id} className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm truncate">{formatCardTitle(h)}</span>
                    <SellSignalChipInline holding={h} />
                  </div>
                  {/* The basis sentence is shown verbatim: it is the evidence,
                      and paraphrasing it would drop the numbers that make it
                      checkable. */}
                  <p className="text-xs text-[color:var(--color-muted)] mt-0.5 leading-snug">
                    {h.sellSignal?.basis}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        );
      }}
    </Section>
  );
}

/** Fire before watch, and within a signal the wider divergence first. */
function sellRank(h: PortfolioHolding): number {
  const s = h.sellSignal;
  if (!s) return -1;
  const base = s.signal === "sell-window" ? 1000 : s.signal === "watch" ? 500 : 0;
  return base + Math.abs(s.measures?.divergencePct ?? 0);
}

function SellSignalChipInline({ holding }: { holding: PortfolioHolding }) {
  const s = holding.sellSignal;
  if (!s) return null;
  const horizon =
    s.horizon === "days-7-14" ? "7–14 days" : s.horizon === "days-14-30" ? "14–30 days" : null;
  if (s.signal === "sell-window") {
    return <Chip label={horizon ? `Sell window · ${horizon}` : "Sell window"} severity="opportunity" />;
  }
  if (s.signal === "watch") return <Chip label="Watch" severity="info" />;
  if (s.signal === "hold") return <Chip label="Hold" severity="neutral" />;
  return null;
}

// ─── 2. Recent-sales velocity ──────────────────────────────────────────

function VelocitySection({ outcome }: { outcome: SectionOutcome<SellRadarResponse> | null }) {
  return (
    <Section
      title="Selling fast right now"
      blurb="Your cards whose comp pool is clearing at a multiple of its normal weekly pace."
      outcome={outcome}
      emptyNote="Nothing in your inventory is moving unusually fast this week."
    >
      {(data) => {
        const rows = (data.candidates ?? []).slice(0, 6);
        if (rows.length === 0) return null;
        return (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted)] text-left">
                  <th className="font-medium pb-2">Card</th>
                  <th className="font-medium pb-2 text-right">Pace</th>
                  <th className="font-medium pb-2 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.holdingId} className="border-t" style={{ borderColor: "var(--color-border)" }}>
                    <td className="py-2 pr-3">
                      <div className="truncate max-w-[16rem]">{c.cardTitle || c.player}</div>
                      <div className="text-xs text-[color:var(--color-muted)]">
                        {c.graderTier}
                        {c.playerDirection !== "flat" && (
                          <> · player {c.playerDirection === "up" ? "up" : "down"}</>
                        )}
                      </div>
                    </td>
                    <td className="py-2 text-right">
                      <Num severity={c.velocityMultiple >= 3 ? "opportunity" : undefined}>
                        {c.velocityMultiple.toFixed(1)}×
                      </Num>
                      <div className="text-xs text-[color:var(--color-muted)] tabular-nums">
                        {c.velocityPerWeek.toFixed(1)}/wk
                      </div>
                    </td>
                    <td className="py-2 text-right">
                      <Num>{formatUSD(c.currentMarketValue, { hideCents: true })}</Num>
                      {c.unrealizedGainUsd != null && (
                        <div className="text-xs tabular-nums" style={{
                          color: c.unrealizedGainUsd >= 0 ? "var(--color-success)" : "var(--color-danger)",
                        }}>
                          {formatUSDCompact(c.unrealizedGainUsd)}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }}
    </Section>
  );
}

// ─── 3. Fee / P&L summary ──────────────────────────────────────────────
//
// The D34 reconciled fee lines, as the ERP P&L endpoint aggregates them.
// `excluded.unreconciledCount` is the load-bearing number: those sales are
// missing from every figure beside it, so showing the totals without it
// would present an incomplete P&L as a complete one.

function FeePnlSection({ outcome }: { outcome: SectionOutcome<ErpPnlResponse> | null }) {
  return (
    <Section
      title="Fees & realized P&L"
      blurb="What you sold, what the platforms took, and what actually landed — from reconciled fee lines."
      outcome={outcome}
      href="/app/erp/finance"
      hrefLabel="Financials"
      emptyNote="No reconciled sales yet. Once a sale has its costs filled in, it lands here."
    >
      {(data) => {
        const t = data.totals;
        if (!t || t.entryCount === 0) return null;
        // A ratio of two returned figures — presentation, not pricing.
        const feeRate = t.grossProceeds > 0 ? t.feesTotal / t.grossProceeds : null;
        const unreconciled = data.excluded?.unreconciledCount ?? 0;
        return (
          <div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <Stat label="Gross proceeds" value={formatUSD(t.grossProceeds, { hideCents: true })} />
              <Stat
                label="Fees"
                value={formatUSD(t.feesTotal, { hideCents: true })}
                sub={feeRate != null ? `${formatPct(feeRate * 100)} of gross` : undefined}
                severity={feeRate != null && feeRate > 0.15 ? "urgent" : undefined}
              />
              <Stat label="Cost of cards sold" value={formatUSD(t.costBasisSold, { hideCents: true })} />
              <Stat
                label="Realized P&L"
                value={formatUSDCompact(t.realizedProfitLoss)}
                severity={t.realizedProfitLoss >= 0 ? "opportunity" : "urgent"}
                sub={`${t.entryCount} sale${t.entryCount === 1 ? "" : "s"}`}
              />
            </div>
            {data.trueNet != null && (
              <div className="text-xs text-[color:var(--color-muted)] mb-2">
                After operating expenses:{" "}
                <Num severity={data.trueNet >= 0 ? "opportunity" : "urgent"}>
                  {formatUSDCompact(data.trueNet)}
                </Num>
              </div>
            )}
            {unreconciled > 0 && (
              <Link
                href="/app/erp/unreconciled"
                className="flex items-center gap-2 text-xs mt-2 p-2 rounded-lg"
                style={{
                  background: "color-mix(in oklab, var(--color-danger) 10%, transparent)",
                }}
              >
                <Chip label={String(unreconciled)} severity="urgent" />
                <span className="text-[color:var(--color-muted)]">
                  {unreconciled === 1 ? "sale is" : "sales are"} missing costs — not counted above.
                </span>
              </Link>
            )}
          </div>
        );
      }}
    </Section>
  );
}

function Stat({
  label,
  value,
  sub,
  severity,
}: {
  label: string;
  value: string;
  sub?: string;
  severity?: Severity;
}) {
  return (
    <div className="rounded-lg p-3" style={{ background: "var(--color-bg)" }}>
      <div className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-1">
        {label}
      </div>
      <div className="text-lg font-bold">
        <Num severity={severity}>{value}</Num>
      </div>
      {sub && <div className="text-[11px] text-[color:var(--color-muted)] mt-0.5">{sub}</div>}
    </div>
  );
}

// ─── 4. Grade-arb opportunities ────────────────────────────────────────

function GradeArbSection({ outcome }: { outcome: SectionOutcome<GradeArbResponse> | null }) {
  return (
    <Section
      title="Worth grading"
      blurb="Raw cards where the graded market has paid enough to cover the submission, on observed sales."
      outcome={outcome}
      skeletonRows={4}
      emptyNote="Nothing in your raw inventory clears the grading cost right now."
    >
      {(data) => {
        const rows = (data.candidates ?? []).slice(0, 6);
        if (rows.length === 0) return null;
        return (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-[color:var(--color-muted)] text-left">
                  <th className="font-medium pb-2">Card</th>
                  <th className="font-medium pb-2 text-right">Tier</th>
                  <th className="font-medium pb-2 text-right">Expected gain</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const tier = c.analysis.bestTier;
                  return (
                    <tr key={c.holdingId} className="border-t" style={{ borderColor: "var(--color-border)" }}>
                      <td className="py-2 pr-3">
                        <div className="truncate max-w-[16rem]">{c.cardTitle || c.player}</div>
                        <div className="text-xs text-[color:var(--color-muted)] tabular-nums">
                          raw {formatUSD(c.analysis.rawPrice, { hideCents: true })}
                        </div>
                      </td>
                      <td className="py-2 text-right text-xs">{tier?.graderTier ?? "—"}</td>
                      <td className="py-2 text-right">
                        <Num severity="opportunity">
                          {tier ? formatUSDCompact(tier.expectedGain) : "—"}
                        </Num>
                        {tier && (
                          <div className="text-xs text-[color:var(--color-muted)] tabular-nums">
                            n={tier.gradedSampleSize}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-xs text-[color:var(--color-muted)] mt-3">
              Scanned {data.scannedHoldings} raw card{data.scannedHoldings === 1 ? "" : "s"}.
              Expected gain is net of the assumed submission cost and is not a
              guarantee of the grade you get.
            </p>
          </div>
        );
      }}
    </Section>
  );
}

// ─── 5. Deal-scanner feed ──────────────────────────────────────────────

function DealFeedSection({ outcome }: { outcome: SectionOutcome<NotableSalesResponse> | null }) {
  return (
    <Section
      title="Notable sales"
      blurb="The big results across the market this week — what the top of the room is paying."
      outcome={outcome}
      skeletonRows={4}
      emptyNote="No notable sales crossed the threshold this week."
    >
      {(data) => {
        const rows = (data.sales ?? []).slice(0, 8);
        if (rows.length === 0) return null;
        return (
          <ul className="space-y-2">
            {rows.map((s, i) => (
              <li
                key={`${s.cardId}-${s.saleDate}-${i}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="min-w-0">
                  <div className="truncate">
                    {s.player} {s.year ? `${s.year} ` : ""}
                    <span className="text-[color:var(--color-muted)]">{s.cardSet}</span>
                  </div>
                  <div className="text-xs text-[color:var(--color-muted)]">
                    {[s.grader, s.grade].filter(Boolean).join(" ")}
                    {s.sourceLabel ? ` · ${s.sourceLabel}` : ""}
                    {s.saleDate ? ` · ${s.saleDate.slice(0, 10)}` : ""}
                  </div>
                </div>
                <Num className="font-medium shrink-0">
                  {formatUSD(s.price, { hideCents: true })}
                </Num>
              </li>
            ))}
          </ul>
        );
      }}
    </Section>
  );
}

// ─── 6. Sport index context ────────────────────────────────────────────

function SportIndexSection({ outcome }: { outcome: SectionOutcome<MarketIndexesResponse> | null }) {
  return (
    <Section
      title="Where the market is"
      blurb="Sport-level index over the last 90 days — the backdrop your cards are selling into."
      outcome={outcome}
      href="/app/market"
      hrefLabel="Market"
      emptyNote="Index data is not available for this window yet."
    >
      {(data) => {
        const rows = (data.indexes ?? []).slice(0, 6);
        if (rows.length === 0) return null;
        return (
          <ul className="space-y-2">
            {rows.map((idx) => {
              // Both figures come straight off the endpoint — the index level
              // and its change over the window are computed server-side. This
              // page does no index arithmetic of its own.
              const pct = idx.changePct;
              const sev: Severity | undefined =
                pct == null ? undefined : pct > 0 ? "opportunity" : pct < 0 ? "urgent" : undefined;
              return (
                <li key={idx.sport} className="flex items-center justify-between gap-3 text-sm">
                  <span className="capitalize">{idx.sport}</span>
                  <span className="flex items-center gap-3">
                    <Num className="text-xs text-[color:var(--color-muted)]">
                      {idx.latestLevel != null ? idx.latestLevel.toFixed(1) : "—"}
                    </Num>
                    <Num severity={sev} className="font-medium min-w-[4rem] text-right">
                      {pct != null ? formatPct(pct, { signed: true }) : "—"}
                    </Num>
                  </span>
                </li>
              );
            })}
            <li className="text-xs text-[color:var(--color-muted)] pt-1">
              Computed {data.computedAt?.slice(0, 10)} over {data.windowDays} days.
            </li>
          </ul>
        );
      }}
    </Section>
  );
}

// ─── Page-level upsell ─────────────────────────────────────────────────

function WorkspaceUpsell({ requiredTier }: { requiredTier: string | null }) {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <div className="hiq-card p-8 text-center">
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5"
          style={{ background: "color-mix(in oklab, var(--color-accent) 15%, transparent)" }}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--color-accent)" }}>
            <path d="M3 13h2v8H3v-8zm4-5h2v13H7V8zm4-6h2v19h-2V2zm4 9h2v10h-2V11zm4-4h2v14h-2V7z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold mb-3">
          The seller workspace is a {tierLabel(requiredTier)} feature
        </h1>
        <p className="text-[color:var(--color-muted)] mb-6 leading-relaxed max-w-md mx-auto">
          Sell-window timing on your own inventory, grading arbitrage, market
          velocity, notable sales, and fee-accurate P&amp;L — the six reads that
          decide a selling day, on one page.
        </p>
        <Link href="/pricing" className="hiq-btn-primary inline-block">
          See {tierLabel(requiredTier)} pricing
        </Link>
      </div>
    </div>
  );
}
