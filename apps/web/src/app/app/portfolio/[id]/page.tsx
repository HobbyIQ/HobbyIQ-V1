"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  fetchHolding,
  fetchHoldingHistory,
  deleteHolding,
  sellHolding,
  refreshHolding,
  holdingDisplayValue,
  updateHolding,
  valuationStatusOf,
  type PortfolioHolding,
  type HoldingPricePoint,
} from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct, formatCardTitle, formatGrade } from "@/lib/format";
import { EbayListModal } from "@/components/EbayListModal";
import { EditHoldingModal } from "@/components/EditHoldingModal";
import { RegradeModal } from "@/components/RegradeModal";
import { GradeCalcModal } from "@/components/GradeCalcModal";
import { RecentCompsList } from "@/components/RecentCompsList";
import { GradeCurveView } from "@/components/GradeCurveView";

export default function HoldingDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const holdingId = String(params?.id ?? "");
  const [h, setH] = useState<PortfolioHolding | null>(null);
  const [history, setHistory] = useState<HoldingPricePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sellOpen, setSellOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [ebayOpen, setEbayOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [regradeOpen, setRegradeOpen] = useState(false);
  const [gradeCalcOpen, setGradeCalcOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    if (!holdingId) return;
    let cancelled = false;
    Promise.all([fetchHolding(holdingId), fetchHoldingHistory(holdingId).catch(() => ({ points: [] as HoldingPricePoint[] }))])
      .then(([holding, hist]) => {
        if (cancelled) return;
        setH(holding);
        setHistory(hist.points ?? []);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const e = err as { status?: number; message?: string };
        if (e.status === 404) setError("Holding not found");
        else setError(e.message ?? "Failed to load");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [holdingId]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading holding…</div>
      </div>
    );
  }
  if (error || !h) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link href="/app/portfolio" className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors">
          ← Back to portfolio
        </Link>
        <div className="hiq-card p-8 mt-6 text-center">
          <div className="text-sm mb-4" style={{ color: "var(--color-danger)" }}>{error ?? "Not found"}</div>
          <Link href="/app/portfolio" className="hiq-btn-primary inline-block">Back to portfolio</Link>
        </div>
      </div>
    );
  }

  const title = formatCardTitle(h);
  const grade = formatGrade(h);
  // CF-PRICING-ENVELOPE (2026-07-31). Envelope-first with legacy fallback
  // during migration; every subsequent field read below prefers pricing.*.
  const fmv = h.pricing?.observed?.fairMarketValue ?? h.fairMarketValue;
  const vs = valuationStatusOf(h);
  const estValue = h.pricing?.estimate?.value ?? h.estimatedValue;
  const estLow = h.pricing?.estimate?.low ?? h.estimateLow;
  const estHigh = h.pricing?.estimate?.high ?? h.estimateHigh;
  const estConfidence = h.pricing?.estimate?.confidence ?? h.estimateConfidence;
  const estBasis = h.pricing?.estimate?.basisNote ?? h.estimateBasis;
  const value = holdingDisplayValue(h);
  const paidPrice = h.purchasePrice;
  const totalPaid = paidPrice != null ? paidPrice * h.quantity : null;
  // CF-COST-FALLBACK (Drew, 2026-08-03). Show purchasePrice as
  // "Total paid" when totalCostBasis is missing — a holding with no
  // added fees/grading legitimately has cost === purchasePrice.
  // Previously "Total paid" showed "—" whenever totalCostBasis was
  // null, hiding the purchase price the user actually entered.
  const cost = h.totalCostBasis ?? totalPaid;
  const feesAdded = h.totalCostBasis != null && totalPaid != null ? h.totalCostBasis - totalPaid : null;
  // Recompute P&L against what we're actually displaying so the number matches
  // the Value column instead of any stale server-side cost-proxy math.
  let gain: number | null = h.totalProfitLoss ?? null;
  let gainPct: number | null = h.totalProfitLossPct ?? null;
  if (value != null && cost != null) {
    gain = value - cost;
    gainPct = cost > 0 ? (gain / cost) * 100 : 0;
  }
  const gainColor = (gain ?? 0) > 0 ? "var(--color-success)" : (gain ?? 0) < 0 ? "var(--color-danger)" : undefined;
  const showEstimateBadge = fmv == null && estValue != null;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link href="/app/portfolio" className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors mb-6 inline-block">
        ← Back to portfolio
      </Link>

      {/* Header */}
      <div className="hiq-card p-6 mb-6">
        <div className="flex items-start gap-5 mb-6">
          <div
            className="w-24 h-24 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center"
            style={{ background: "var(--color-bg)" }}
          >
            {h.photos && h.photos[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={h.photos[0]} alt="" className="w-full h-full object-cover" />
            ) : (
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
                <path d="M4 6h16v12H4V6zm2 2v8h12V8H6zm2 2h4v4H8v-4z" />
              </svg>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold mb-1">{title}</h1>
            <div className="text-sm text-[color:var(--color-muted)] flex items-center gap-2 flex-wrap">
              <span>{grade}</span>
              {h.quantity > 1 && <span>· qty {h.quantity}</span>}
              {vs === "estimated" && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                      style={{ background: "color-mix(in oklab, var(--color-accent) 15%, transparent)", color: "var(--color-accent)" }}>
                  EST
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Value / cost / P&L */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-5 pt-4 border-t border-[color:var(--color-border)]">
          <Stat label="Current value" value={formatUSD(value, { hideCents: true })} badge={showEstimateBadge ? "EST" : undefined} />
          <Stat label="Total paid" value={formatUSD(cost, { hideCents: true })} />
          <Stat label="Gain/loss" value={formatUSDCompact(gain)} color={gainColor} />
          <Stat label="Return" value={formatPct(gainPct)} color={gainColor} />
        </div>

        {/* Cost breakdown — matters when totalCostBasis != purchasePrice (fees) */}
        {feesAdded != null && Math.abs(feesAdded) > 0.005 && (
          <div className="mt-4 pt-4 border-t border-[color:var(--color-border)] text-sm">
            <div className="flex justify-between text-[color:var(--color-muted)]">
              <span>Paid at purchase</span>
              <span className="tabular-nums text-white">{formatUSD(totalPaid, { hideCents: false })}</span>
            </div>
            <div className="flex justify-between text-[color:var(--color-muted)] mt-1">
              <span>Fees / grading added</span>
              <span className="tabular-nums text-white">{formatUSD(feesAdded, { hideCents: false })}</span>
            </div>
            <div className="flex justify-between mt-1 pt-1 border-t border-[color:var(--color-border)]">
              <span className="text-[color:var(--color-muted)]">Total paid</span>
              <span className="font-medium tabular-nums">{formatUSD(cost, { hideCents: false })}</span>
            </div>
          </div>
        )}

        {/* Estimate details — only shown when we're rendering an estimate */}
        {showEstimateBadge && (
          <div className="mt-4 pt-4 border-t border-[color:var(--color-border)]">
            <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-2">
              Estimate details
            </div>
            <div className="text-sm space-y-1">
              {estLow != null && estHigh != null && (
                <div className="flex justify-between">
                  <span className="text-[color:var(--color-muted)]">Range</span>
                  <span className="tabular-nums">
                    {formatUSD(estLow, { hideCents: estLow >= 100 })} – {formatUSD(estHigh, { hideCents: estHigh >= 100 })}
                  </span>
                </div>
              )}
              {estConfidence && (
                <div className="flex justify-between">
                  <span className="text-[color:var(--color-muted)]">Confidence</span>
                  <span className="capitalize">{estConfidence}</span>
                </div>
              )}
              {estBasis && (
                <div className="mt-2 text-xs text-[color:var(--color-muted)] leading-relaxed">
                  {estBasis}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* CF-UX-CLEANUP (Drew, 2026-07-27): action row collapsed 9→3
          primary. Mark sold + Edit + Refresh are the daily-use actions
          and stay visible. Everything else (grade decisions, eBay list,
          storefront toggle, delete) tucks into a ⋯ menu so the row
          isn't a 9-button wall. */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <button onClick={() => setSellOpen(true)} className="hiq-btn-primary">
          Mark as sold
        </button>
        <button onClick={() => setEditOpen(true)} className="hiq-btn-secondary">
          Edit card
        </button>
        <button
          onClick={async () => {
            if (refreshing) return;
            setRefreshing(true);
            setRefreshError(null);
            try {
              const res = await refreshHolding(h.id);
              if (res.success && res.holding) {
                setH(res.holding);
              } else {
                setRefreshError(res.message ?? "Refresh failed");
              }
            } catch (err) {
              const e = err as { message?: string; status?: number };
              if (e.status === 429) {
                setRefreshError("Daily price-check limit reached — try again tomorrow.");
              } else {
                setRefreshError(e.message ?? "Refresh failed");
              }
            } finally {
              setRefreshing(false);
            }
          }}
          disabled={refreshing}
          className="hiq-btn-secondary disabled:opacity-60"
        >
          {refreshing ? "Refreshing…" : "Refresh price"}
        </button>
        <MoreMenu>
          <button onClick={() => setEbayOpen(true)} className={MENU_ITEM_CLS}>
            List on eBay
          </button>
          {!h.gradeCompany && (
            <>
              <button onClick={() => setGradeCalcOpen(true)} className={MENU_ITEM_CLS}>
                Should I grade?
              </button>
              <button onClick={() => setRegradeOpen(true)} className={MENU_ITEM_CLS}>
                Mark as graded
              </button>
            </>
          )}
          <StorefrontVisibilityMenuItem
            holding={h}
            onChange={(next) => setH(next)}
          />
          <button
            onClick={() => setDeleteOpen(true)}
            className={MENU_ITEM_DANGER_CLS}
          >
            Delete holding
          </button>
        </MoreMenu>
      </div>

      {refreshError && (
        <div
          className="hiq-card p-3 mb-6 text-sm"
          style={{ color: "var(--color-danger)" }}
        >
          {refreshError}
        </div>
      )}

      {/* CF-UX-CLEANUP (Drew, 2026-07-27): section order rethought so
          the "how has THIS card done?" answer is above the fold.
          Order:
            Value history (this card's trend) →
            Recent comps (sales that back the current FMV) →
            Grade curve (deeper: what other grades are worth) →
            Details.
          Previous order buried the chart under Grade curve + Recent
          comps, forcing a heavy scroll for the most-asked question. */}

      {/* Price history — this card's trend */}
      {history.length > 0 && (
        <div className="hiq-card p-6 mb-6">
          <h2 className="font-bold text-lg mb-4">Value history</h2>
          <MiniChart points={history} />
        </div>
      )}

      {/* Recent comps + grade curve — prefer hobbyiqCardId as the pricing
          identity. Old holdings can have a diverged legacy cardId (e.g.
          BDP129 stripped to 129 → points at wrong flagship card).
          hobbyiqCardId is the canonical hiq: slug and is the source of
          truth for every downstream lookup. Falls back to cardId only
          when hobbyiqCardId is missing (pre-slug-backfill legacy). */}
      {(h.hobbyiqCardId || h.cardId) && (
        <div className="mb-6">
          <RecentCompsList
            cardId={h.hobbyiqCardId || h.cardId!}
            parallel={h.parallel ?? ""}
            gradeCompany={h.gradeCompany ?? undefined}
            gradeValue={h.gradeValue ?? undefined}
            subtitle="Sales that back the value shown above."
          />
        </div>
      )}

      {(h.hobbyiqCardId || h.cardId) && (
        <div className="mb-6">
          <GradeCurveView cardId={h.hobbyiqCardId || h.cardId!} />
        </div>
      )}

      {/* Meta */}
      <div className="hiq-card p-6">
        <h2 className="font-bold text-lg mb-4">Details</h2>
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
          {h.purchasePrice != null && <Row label="Purchase price" value={formatUSD(h.purchasePrice, { hideCents: false })} />}
          {h.purchaseDate && <Row label="Purchase date" value={h.purchaseDate.slice(0, 10)} />}
          {h.playerName && <Row label="Player" value={h.playerName} />}
          {h.cardYear && <Row label="Year" value={String(h.cardYear)} />}
          {h.product && <Row label="Product" value={h.product} />}
          {h.parallel && <Row label="Parallel" value={h.parallel} />}
          {h.cardNumber && <Row label="Card #" value={h.cardNumber} />}
          {h.serialNumber && <Row label="Serial #" value={h.serialNumber} />}
          <Row label="Auto" value={h.isAuto ? "Yes" : "No"} />
          {h.lastUpdated && <Row label="Last priced" value={h.lastUpdated.slice(0, 10)} />}
        </dl>
      </div>

      {sellOpen && (
        <SellModal
          suggestedPrice={fmv ?? undefined}
          onCancel={() => setSellOpen(false)}
          onConfirm={async (price, date) => {
            await sellHolding(h.id, price, date);
            router.push("/app/portfolio");
          }}
        />
      )}
      {deleteOpen && (
        <DeleteModal
          onCancel={() => setDeleteOpen(false)}
          onConfirm={async () => {
            await deleteHolding(h.id);
            router.push("/app/portfolio");
          }}
        />
      )}
      {ebayOpen && (
        <EbayListModal
          holdingId={h.id}
          onClose={() => setEbayOpen(false)}
        />
      )}
      {editOpen && (
        <EditHoldingModal
          holding={h}
          onCancel={() => setEditOpen(false)}
          onSaved={(next) => {
            setH(next);
            setEditOpen(false);
          }}
        />
      )}
      {regradeOpen && (
        <RegradeModal
          holding={h}
          onCancel={() => setRegradeOpen(false)}
          onSaved={(next) => {
            setH(next);
            setRegradeOpen(false);
          }}
        />
      )}
      {gradeCalcOpen && (
        <GradeCalcModal
          holding={h}
          onClose={() => setGradeCalcOpen(false)}
        />
      )}
    </div>
  );
}

function Stat({ label, value, color, badge }: { label: string; value: string; color?: string; badge?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1 flex items-center gap-2">
        {label}
        {badge && (
          <span
            className="px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide"
            style={{
              background: "color-mix(in oklab, var(--color-accent) 15%, transparent)",
              color: "var(--color-accent)",
            }}
          >
            {badge}
          </span>
        )}
      </div>
      <div className="text-xl font-bold tabular-nums" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-2 border-b border-[color:var(--color-border)] last:border-0">
      <dt className="text-[color:var(--color-muted)]">{label}</dt>
      <dd className="font-medium text-right ml-4 break-all">{value}</dd>
    </div>
  );
}

// Tiny inline SVG chart for a per-holding value trail.
function MiniChart({ points }: { points: HoldingPricePoint[] }) {
  if (points.length < 2) {
    return <div className="text-sm text-[color:var(--color-muted)]">Not enough data yet.</div>;
  }
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const W = 600;
  const H = 140;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * W;
      const y = H - ((p.value - min) / range) * H;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-72" preserveAspectRatio="none" style={{ height: H }}>
          <path d={path} stroke="var(--color-accent)" strokeWidth="2" fill="none" />
        </svg>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-[color:var(--color-muted)]">
        <span>{points[0].at.slice(0, 10)}</span>
        <span>{formatUSD(max, { hideCents: true })} high</span>
        <span>{points[points.length - 1].at.slice(0, 10)}</span>
      </div>
    </div>
  );
}

function SellModal({
  suggestedPrice,
  onCancel,
  onConfirm,
}: {
  suggestedPrice?: number;
  onCancel: () => void;
  onConfirm: (price: number, date: string) => Promise<void>;
}) {
  const [price, setPrice] = useState<string>(suggestedPrice ? suggestedPrice.toFixed(2) : "");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal onClose={onCancel}>
      <h2 className="text-xl font-bold mb-2">Mark as sold</h2>
      <p className="text-sm text-[color:var(--color-muted)] mb-6">
        This closes the position and adds the sale to your comp pool. FMV stays learned from the sale.
      </p>
      <div className="space-y-4">
        <div>
          <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2 block font-medium">
            Sale price (USD)
          </label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
            autoFocus
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2 block font-medium">
            Sale date
          </label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
          />
        </div>
      </div>
      {error && <div className="mt-4 text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>}
      <div className="mt-6 flex items-center justify-end gap-3">
        <button onClick={onCancel} className="hiq-btn-secondary" disabled={submitting}>Cancel</button>
        <button
          onClick={async () => {
            const n = Number(price);
            if (!(n > 0)) {
              setError("Enter a positive sale price.");
              return;
            }
            setSubmitting(true);
            setError(null);
            try {
              await onConfirm(n, date);
            } catch (err) {
              const e = err as { message?: string };
              setError(e.message ?? "Failed to mark sold");
              setSubmitting(false);
            }
          }}
          disabled={submitting}
          className="hiq-btn-primary disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Confirm sale"}
        </button>
      </div>
    </Modal>
  );
}

function DeleteModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal onClose={onCancel}>
      <h2 className="text-xl font-bold mb-2" style={{ color: "var(--color-danger)" }}>
        Delete this holding?
      </h2>
      <p className="text-sm text-[color:var(--color-muted)] mb-6">
        This removes the card from your portfolio and its price history. Cannot be undone.
        (Use &quot;Mark as sold&quot; if you actually sold it — that keeps the sale for the comp pool.)
      </p>
      {error && <div className="mb-4 text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>}
      <div className="flex items-center justify-end gap-3">
        <button onClick={onCancel} className="hiq-btn-secondary" disabled={submitting}>Cancel</button>
        <button
          onClick={async () => {
            setSubmitting(true);
            try {
              await onConfirm();
            } catch (err) {
              const e = err as { message?: string };
              setError(e.message ?? "Failed to delete");
              setSubmitting(false);
            }
          }}
          disabled={submitting}
          className="px-4 py-2.5 rounded-xl text-sm font-medium disabled:opacity-30"
          style={{ background: "var(--color-danger)", color: "white" }}
        >
          {submitting ? "Deleting…" : "Delete permanently"}
        </button>
      </div>
    </Modal>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="hiq-card p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

// CF-UX-CLEANUP (Drew, 2026-07-27): MoreMenu is a lightweight dropdown
// used by the action row to hide low-frequency actions behind a ⋯ so
// the row shows 3 primary buttons instead of 9. Closes on outside
// click and after any child button click.
function MoreMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="hiq-btn-secondary"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯ More
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 min-w-[220px] rounded-lg shadow-2xl border overflow-hidden z-10"
          style={{
            background: "var(--color-bg-card)",
            borderColor: "var(--color-border)",
          }}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// Shared Tailwind classes for MoreMenu children. Kept close to the
// MoreMenu component (not a global CSS class) so the styling stays
// scoped and there's no worry about accidental reuse elsewhere.
export const MENU_ITEM_CLS =
  "block w-full text-left px-4 py-2.5 text-sm hover:bg-white/5 disabled:opacity-50 disabled:cursor-default transition-colors";
export const MENU_ITEM_DANGER_CLS = MENU_ITEM_CLS + " text-[color:var(--color-danger)]";

// CF-STOREFRONT-OPT-IN (Drew, 2026-07-27 rev 2). Opt-IN toggle: the
// button is off by default; click to add this card to the public
// storefront. Server enforces tier caps via /app/storefront's bulk
// selector; here we just fire the write and reflect the new state.
// Now a menu item (was a full button) after the CF-UX-CLEANUP row
// compression.
function StorefrontVisibilityMenuItem({
  holding,
  onChange,
}: {
  holding: PortfolioHolding;
  onChange: (next: PortfolioHolding) => void;
}) {
  const [saving, setSaving] = useState(false);
  const shown = holding.showOnStorefront === true;

  async function toggle() {
    if (saving) return;
    const nextShown = !shown;
    onChange({ ...holding, showOnStorefront: nextShown });
    setSaving(true);
    try {
      const res = await updateHolding(holding.id, { showOnStorefront: nextShown });
      if (res.holding) onChange(res.holding);
    } catch {
      onChange({ ...holding, showOnStorefront: shown });
    } finally {
      setSaving(false);
    }
  }

  return (
    <button onClick={toggle} disabled={saving} className={MENU_ITEM_CLS}>
      {saving ? "…" : shown ? "Remove from storefront" : "Add to storefront"}
    </button>
  );
}
