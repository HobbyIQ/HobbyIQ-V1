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
  type SellHoldingDetail,
  type SellSalesChannel,
  type SellPaymentMethod,
} from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct, formatCardTitle, formatGrade } from "@/lib/format";
import { formatAsOf } from "@/lib/asOf";
import { EbayListModal } from "@/components/EbayListModal";
import { EditHoldingModal } from "@/components/EditHoldingModal";
import { RegradeModal } from "@/components/RegradeModal";
import { GradeCalcModal } from "@/components/GradeCalcModal";
import { GradeArbSection } from "@/components/GradeArbSection";
import { RecentCompsList } from "@/components/RecentCompsList";
import { IdentityBanner } from "@/components/IdentityBanner";
import { GradeCurveView } from "@/components/GradeCurveView";
import { HoldingMoveAlertCard } from "@/components/HoldingMoveAlertCard";
import { fetchObservedGradeCurve, type ObservedGradeEntry } from "@/lib/api";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { PricingLabelChips } from "@/components/PricingLabelChips";
import { describeRung, holdingProvenance, type RungDescription } from "@/lib/rung";
// CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05): one vocabulary for the refusal,
// shared with the list row and the DailyIQ column so they cannot drift.
import {
  withheldOf,
  withheldShort,
  withheldSentence,
  withheldUnlock,
  withheldPoolNote,
} from "@/lib/withheld";

export default function HoldingDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const holdingId = String(params?.id ?? "");
  const [h, setH] = useState<PortfolioHolding | null>(null);
  // CF-WEB-MARKET-VALUE-FROM-CURVE (2026-08-22). The grade curve is the best
  // pricing we have, so the headline reads from it directly instead of from
  // the stored holding value. Fetched here (not inside GradeCurveView) so the
  // number at the top and the tiles below are the SAME data, and a stale or
  // starved stored value cannot make them disagree.
  const [curve, setCurve] = useState<ObservedGradeEntry[] | null>(null);
  const [curveLoading, setCurveLoading] = useState(false);
  const [curveError, setCurveError] = useState<string | null>(null);
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

  // Fetch the grade curve once the holding's card id is known. This is the
  // same request GradeCurveView used to make for itself; it is lifted here so
  // the headline and the tiles are one source.
  const curveCardId = h ? (h.hobbyiqCardId || h.cardId || "") : "";
  useEffect(() => {
    if (!curveCardId) return;
    let cancelled = false;
    setCurveLoading(true);
    setCurveError(null);
    fetchObservedGradeCurve(curveCardId)
      .then((res) => {
        if (cancelled) return;
        setCurve(res.entries ?? []);
        setCurveLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        const e = err as { status?: number; message?: string };
        setCurveError(e.status === 429
          ? "Daily price-check limit reached — try again tomorrow."
          : (e.message ?? "Failed to load grade curve"));
        setCurve([]);
        setCurveLoading(false);
      });
    return () => { cancelled = true; };
  }, [curveCardId]);


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
  // CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03): the envelope
  // carries them for the detail surface, the flat wire for the list row; read
  // the envelope first and fall back, exactly as every other price field here.
  const pricingLabels = h.pricing?.provenance?.pricingLabels ?? h.pricingLabels ?? [];
  const selfAnchored = h.pricing?.provenance?.selfAnchored ?? h.selfAnchored ?? null;
  const fmv = h.pricing?.observed?.fairMarketValue ?? h.fairMarketValue;
  const vs = valuationStatusOf(h);
  const estValue = h.pricing?.estimate?.value ?? h.estimatedValue;
  const estLow = h.pricing?.estimate?.low ?? h.estimateLow;
  const estHigh = h.pricing?.estimate?.high ?? h.estimateHigh;
  const estConfidence = h.pricing?.estimate?.confidence ?? h.estimateConfidence;
  const estBasis = h.pricing?.estimate?.basisNote ?? h.estimateBasis;
  const storedValue = holdingDisplayValue(h);

  // CF-WEB-MARKET-VALUE-FROM-CURVE (2026-08-22). The grade curve is the best
  // pricing we have, so the headline reads the curve's tile for THIS card's
  // grade rather than the stored holding value. They are supposed to be the
  // same number — CF-GRADE-CURVE-IS-SOURCE-OF-TRUTH makes the backend write
  // exactly this — but the stored copy can drift (a reprice during a Cosmos
  // throttling event blanked one and the page then disagreed with its own
  // curve). Reading the curve makes that class of drift impossible to display.
  //
  // Grade match parses the numeric part out of the LABEL. entry.grade is
  // "PSA 9" / "BGS 9.5", so Number(entry.grade) is NaN — the exact trap that
  // made the backend tile lookup silently miss every graded card.
  const wantGrader = (h.gradeCompany ?? "").trim() ? String(h.gradeCompany).toUpperCase() : "Raw";
  const wantGradeNum = typeof h.gradeValue === "number"
    ? h.gradeValue
    : (h.gradeValue ? Number(h.gradeValue) : null);
  const curveTile = (curve ?? []).find((e) => {
    if ((e.grader ?? "").toUpperCase() !== wantGrader.toUpperCase()) return false;
    if (wantGrader === "Raw") return true;
    const n = Number(String(e.grade).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n === wantGradeNum;
  });
  const curvePerUnit = curveTile?.trendAdjustedValue ?? curveTile?.value ?? null;
  const qty = Math.max(1, h.quantity ?? 1);
  const curveValue = curvePerUnit != null && curvePerUnit > 0 ? curvePerUnit * qty : null;
  // Curve first; stored value only when the curve has nothing for this grade.
  const value = curveValue ?? storedValue;
  const valueFromCurve = curveValue != null;
  // CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05): why the engine refused, if it did.
  const withheld = withheldOf(h);
  const poolNote = withheld ? withheldPoolNote(withheld) : null;
  // CF-SHOW-WHAT-BACKS-THE-PRICE (Drew, 2026-09-05, audit item 12). These
  // ride on the envelope and were never rendered anywhere. They are the two
  // facts that most cheaply justify a number: how many sales it rests on, and
  // how recent the last one was. A price with 14 comps and a sale yesterday
  // reads very differently from one with 2 comps and a sale in March, and the
  // page was showing them identically.
  const compsUsed = h.pricing?.method?.compsUsed ?? null;
  const lastSale = h.pricing?.provenance?.lastSaleSurface ?? null;
  const pricingConfidence = h.pricing?.confidence?.pricing ?? null;
  // `formatAsOf` returns null for an absent or unparseable date, which is the
  // "say nothing" case — a malformed date must not print as "Last sale null".
  const lastSaleAgo = formatAsOf(lastSale?.date ?? null);
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
  // CF-WEB-ONE-NUMBER (2026-08-22). When the grade curve priced this card, the
  // headline above IS that number and the estimate block is a SECOND number
  // from a different path — it can only agree by luck, and a card showing two
  // values disagrees with itself.
  //
  // Not deleted, which was the other option considered: the estimate is the
  // real source when the curve has no tile for this grade, and hiding it then
  // would drop the only thing we know about the card. Precedence, not removal
  // — the reasoning recorded on 2026-08-14 was that removing values "deletes
  // the signal, not the defect".
  const showEstimateBadge = !valueFromCurve && fmv == null && estValue != null;
  // The estimate DETAILS block follows the same rule: it appears only when the
  // estimate is doing the work.
  const showEstimateDetails = !valueFromCurve && showEstimateBadge;
  // D20 — the web says what the engine says. The rung beside the number:
  // when the curve priced this grade, the tile's own rung and the size of
  // the pool it read; otherwise the persisted holding's (envelope
  // `method.ladderRung` / `pricingSourceMeta.method`). A number with no
  // rung says so — it is never dressed as an observed one.
  const storedProvenance = holdingProvenance(h);
  const headlineRung: RungDescription = valueFromCurve
    ? describeRung(curveTile?.rungLabel, { compsUsed: curveTile?.sampleCount })
    : value != null
      ? storedProvenance
      : { kind: "unpriced", text: "no price yet", label: storedProvenance.label };
  const headlineRungSource = valueFromCurve ? "observed-grade-curve" : storedProvenance.source;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <Link href="/app/portfolio" className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors mb-6 inline-block">
        ← Back to portfolio
      </Link>

      {/* CF-SURFACE-THE-PARKED-MATCH: above the header on purpose. An
          unidentified holding has no value to show, so the first thing on the
          page should be the one action that changes that. Renders nothing when
          the card is already identified. */}
      <IdentityBanner
        holding={h}
        onResolved={async () => {
          // The accept route kicks the reprice fire-and-forget, so the first
          // read can beat the new value home. Read once for the identity
          // (which is already committed), then once more for the price rather
          // than leaving the user looking at a blank value they just fixed.
          setH(await fetchHolding(holdingId));
          setTimeout(() => { void fetchHolding(holdingId).then(setH).catch(() => {}); }, 2500);
        }}
      />

      {/* Header */}
      <div className="hiq-card p-6 mb-6">
        <div className="flex items-start gap-5 mb-6">
          <div
            className="w-28 h-40 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center"
            style={{ background: "var(--color-bg)" }}
          >
            {h.photos && h.photos[0] ? (
              // eslint-disable-next-line @next/next/no-img-element
              // CF-PHOTO-DISPLAY (Drew, 2026-08-10). Slab-ratio container +
              // object-contain so the whole slab (grade label, cert #,
              // corners) is visible. Tap opens full-size in new tab.
              <a href={h.photos[0]} target="_blank" rel="noopener noreferrer" className="block w-full h-full" title="Open full size">
                <img src={h.photos[0]} alt="" className="w-full h-full object-contain" />
              </a>
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

        {/* Value / cost / P&L — centered symmetric 4-col KPI row */}
        {/* CF-MOBILE-390-DETAIL (Drew, 2026-09-05): `gap-6` spent 24px of a
            390px viewport on the gutter between two columns that needed the
            width for their numbers. Tighter below `sm`, unchanged above. */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 sm:gap-6 md:gap-8 pt-6 border-t border-[color:var(--color-border)]">
          <Stat
            label="Market value"
            value={formatUSD(value, { hideCents: true })}
            badge={showEstimateBadge ? "EST" : undefined}
            sub={<ProvenanceChip rung={headlineRung} source={headlineRungSource} />}
          />
          <Stat label="Total paid" value={formatUSD(cost, { hideCents: true })} />
          <Stat label="Gain/loss" value={formatUSDCompact(gain)} color={gainColor} />
          <Stat label="Return" value={formatPct(gainPct)} color={gainColor} />
        </div>

        {/* CF-SHOW-WHAT-BACKS-THE-PRICE (Drew, 2026-09-05, audit item 12).
            What the number rests on, for a PUBLISHED price. Suppressed when
            the price was withheld — the panel below is the explanation then,
            and a comp count beside a refusal invites reading the refused
            read as a value.

            Every part renders only if the wire sent it: these fields are
            optional on the envelope, and an absent comp count must not print
            as "0 sales". */}
        {value != null && (compsUsed != null || lastSaleAgo || pricingConfidence != null) && (
          <div
            className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[color:var(--color-muted)]"
            data-price-backing="true"
          >
            {compsUsed != null && compsUsed > 0 && (
              <span>{compsUsed === 1 ? "1 sale" : `${compsUsed} sales`} in this pool</span>
            )}
            {lastSaleAgo && <span>Last sale {lastSaleAgo}</span>}
            {pricingConfidence != null && (
              <span title="How much the engine trusts this price, from the size and consistency of the pool behind it.">
                Confidence {Math.round(pricingConfidence * 100)}%
              </span>
            )}
          </div>
        )}

        {/* CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05).

            The detail page is where an owner comes to ask "why is this card
            showing a dash?" — and it was the emptiest of the three surfaces:
            the list at least had a MISSING pill, this had nothing but the
            dash in the Market value stat above.

            So this is the one place that answers the question in full: the
            cause in plain words, the number we refused and what we measured
            it against, how many sales stood behind that read, and what would
            unlock a price. The refused number lives ONLY inside the sentence
            that says it was refused — see lib/withheld.ts Rule 3. */}
        {withheld && (
          <div
            className="mt-4 pt-4 border-t border-[color:var(--color-border)] space-y-2"
            data-withheld-panel={withheld.reason}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="px-2 py-0.5 rounded text-[11px] font-medium"
                style={{
                  background: "color-mix(in oklab, var(--hiq-warning) 15%, transparent)",
                  color: "var(--hiq-warning)",
                }}
              >
                {withheldShort(withheld.reason).toUpperCase()}
              </span>
              {poolNote && (
                <span className="text-xs text-[color:var(--color-muted)]">{poolNote}</span>
              )}
            </div>
            <p className="text-sm leading-snug">
              {withheldSentence(withheld, { costBasis: cost })}
            </p>
            <p className="text-xs leading-snug text-[color:var(--color-muted)]">
              {withheldUnlock(withheld.reason)}
            </p>
          </div>
        )}

        {/* CF-A-PERSISTED-PRICE-CARRIES-ITS-LABELS (Drew, 2026-09-03).
            PUBLISH + LABEL. The detail sheet has room for the whole sentence,
            so it shows the sentence — the same words the sell draft puts in
            front of a buyer, served from the wire rather than restated here.
            The value above is unchanged; this says what is behind it. */}
        {pricingLabels.length > 0 && (
          <div className="mt-4 pt-4 border-t border-[color:var(--color-border)] space-y-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <PricingLabelChips labels={pricingLabels} selfAnchored={selfAnchored} />
            </div>
            <ul className="space-y-1">
              {pricingLabels.map((l) => (
                <li
                  key={l.code}
                  className="text-xs leading-snug text-[color:var(--color-muted)]"
                  data-pricing-label-text={l.code}
                >
                  {l.text}
                </li>
              ))}
            </ul>
          </div>
        )}

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

        {/* Estimate details — only when the estimate IS the headline, never
            alongside a curve-priced number. */}
        {showEstimateDetails && (
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
          <GradeCurveView cardId={h.hobbyiqCardId || h.cardId!} entries={curve} loading={curveLoading} error={curveError} />
        </div>
      )}

      {/* CF-USER-PRICE-ALERTS (Drew, 2026-09-02): manage the move alert on
          this card. Sits under the evidence (comps + curve) it will quote. */}
      <div className="mb-6">
        <HoldingMoveAlertCard holdingId={holdingId} />
      </div>

      {/* CF-GRADE-ARB (Drew, 2026-09-02): conditional value at each
          graded tier, for raw holdings only. The section refuses on its
          own when the card has no empirical basis. */}
      {!h.gradeCompany && (
        <div className="mb-6">
          <GradeArbSection holding={h} />
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
          onConfirm={async (detail) => {
            await sellHolding(h.id, detail);
            router.push("/app/portfolio");
          }}
        />
      )}
      {deleteOpen && (
        <DeleteModal
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => {
            // CF-DELETE-OPTIMISTIC (Drew, 2026-08-11). Fire the delete
            // in the background and navigate away immediately, so the
            // user never sits on a spinning "Deleting…" button when
            // the backend is throttled. If the delete fails, the
            // holding will resurface on the portfolio list next
            // refresh — safe to retry.
            deleteHolding(h.id).catch((err) => {
              console.error("deleteHolding failed:", err);
            });
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

function Stat({ label, value, color, badge, sub }: { label: string; value: string; color?: string; badge?: string; sub?: React.ReactNode }) {
  // CF-STAT-CENTERED (Drew, 2026-08-11). Center-aligned so the 4-col
  // stat row on the holding-detail page reads as a symmetric row of
  // KPIs instead of left-justified table cells.
  return (
    <div className="text-center">
      <div className="text-[11px] uppercase tracking-[0.15em] text-[color:var(--color-muted)] mb-2 font-semibold flex items-center justify-center gap-2">
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
      {/* CF-MOBILE-390-DETAIL (Drew, 2026-09-05), audit item 10. At 390px this
          grid is two columns ~163px wide, and `text-2xl` tabular digits put a
          six-figure value (or "-$12,345 · -38.9%") past the column edge —
          the detail page was never measured at this width. The type steps
          down below `sm` and `break-words` gives a long value somewhere to
          break instead of forcing the page to scroll sideways. */}
      <div
        className="text-xl sm:text-2xl font-bold tabular-nums tracking-tight break-words"
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      {/* D20: the provenance chip sits under the number it describes. */}
      {sub && <div className="mt-1.5 flex justify-center">{sub}</div>}
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

// CF-WEB-SELL-EXPENSES (Drew, 2026-08-10). Full expense-
// reconciliation form. Backend accepts fees / tax / shipping /
// gradingCost / suppliesCost / salesChannel / paymentMethod /
// saleLocation / notes — the prior 2-field form was throwing all of
// that away so P&L per sale was inflated (net = gross, no cost
// subtraction). Groups fields into scannable sections; shows live
// Net Proceeds calc so user can sanity-check before Confirm.
const SALES_CHANNELS: ReadonlyArray<{ value: SellSalesChannel; label: string }> = [
  { value: "ebay", label: "eBay" },
  { value: "whatnot", label: "Whatnot" },
  { value: "comc", label: "COMC" },
  { value: "myslabs", label: "mySlabs" },
  { value: "goldin", label: "Goldin" },
  { value: "pwcc", label: "PWCC" },
  { value: "instagram", label: "Instagram" },
  { value: "facebook", label: "Facebook" },
  { value: "card_show", label: "Card show" },
  { value: "in_person", label: "In person" },
  { value: "other", label: "Other" },
];
const PAYMENT_METHODS: ReadonlyArray<{ value: SellPaymentMethod; label: string }> = [
  { value: "ebay_managed", label: "eBay Managed" },
  { value: "paypal", label: "PayPal" },
  { value: "venmo", label: "Venmo" },
  { value: "zelle", label: "Zelle" },
  { value: "cashapp", label: "Cash App" },
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "trade", label: "Trade" },
  { value: "other", label: "Other" },
];

function SellModal({
  suggestedPrice,
  onCancel,
  onConfirm,
}: {
  suggestedPrice?: number;
  onCancel: () => void;
  onConfirm: (detail: SellHoldingDetail) => Promise<void>;
}) {
  const [price, setPrice] = useState<string>(suggestedPrice ? suggestedPrice.toFixed(2) : "");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [fees, setFees] = useState("");
  const [tax, setTax] = useState("");
  const [shipping, setShipping] = useState("");
  const [gradingCost, setGradingCost] = useState("");
  const [suppliesCost, setSuppliesCost] = useState("");
  const [salesChannel, setSalesChannel] = useState<SellSalesChannel | "">("");
  const [channelNote, setChannelNote] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<SellPaymentMethod | "">("");
  const [paymentNote, setPaymentNote] = useState("");
  const [venue, setVenue] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputCls =
    "w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)] transition-colors";
  const inputStyle = {
    background: "var(--color-bg)",
    borderColor: "var(--color-border)",
    color: "white",
  } as const;
  const labelCls = "text-[11px] uppercase tracking-wide text-[color:var(--color-muted)] mb-1.5 block font-medium";
  const sectionHeadCls = "text-xs uppercase tracking-wider text-[color:var(--color-accent)] mt-6 mb-3 font-semibold";

  const priceNum = Number(price) || 0;
  const feesNum = Number(fees) || 0;
  const taxNum = Number(tax) || 0;
  const shippingNum = Number(shipping) || 0;
  const gradingNum = Number(gradingCost) || 0;
  const suppliesNum = Number(suppliesCost) || 0;
  // Net proceeds = sale - fees - shipping. Tax passes through (collected on
  // behalf of buyer). Grading/supplies are cost basis adjustments, not
  // deductions from proceeds.
  const netProceeds = Math.max(0, priceNum - feesNum - shippingNum);

  return (
    <Modal onClose={onCancel}>
      <h2 className="text-xl font-bold mb-2">Mark as sold</h2>
      <p className="text-sm text-[color:var(--color-muted)] mb-4">
        Closes the position, adds the sale to your comp pool, and records the
        expense breakdown so P&amp;L per sale reconciles.
      </p>

      {/* Essentials */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Sale price (USD)</label>
          <input
            type="number" min={0} step="0.01" autoFocus
            value={price} onChange={(e) => setPrice(e.target.value)}
            className={inputCls} style={inputStyle}
          />
        </div>
        <div>
          <label className={labelCls}>Sale date</label>
          <input
            type="date"
            value={date} onChange={(e) => setDate(e.target.value)}
            className={inputCls} style={inputStyle}
          />
        </div>
      </div>

      {/* Fees & costs */}
      <div className={sectionHeadCls}>Fees &amp; costs</div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className={labelCls}>Fees ($)</label>
          <input
            type="number" min={0} step="0.01"
            placeholder="eBay + processing"
            value={fees} onChange={(e) => setFees(e.target.value)}
            className={inputCls} style={inputStyle}
          />
        </div>
        <div>
          <label className={labelCls}>Shipping ($)</label>
          <input
            type="number" min={0} step="0.01"
            placeholder="what you paid"
            value={shipping} onChange={(e) => setShipping(e.target.value)}
            className={inputCls} style={inputStyle}
          />
        </div>
        <div>
          <label className={labelCls}>Tax collected ($)</label>
          <input
            type="number" min={0} step="0.01"
            placeholder="pass-through"
            value={tax} onChange={(e) => setTax(e.target.value)}
            className={inputCls} style={inputStyle}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 mt-3">
        <div>
          <label className={labelCls}>Grading cost ($)</label>
          <input
            type="number" min={0} step="0.01"
            placeholder="PSA/BGS/SGC fee"
            value={gradingCost} onChange={(e) => setGradingCost(e.target.value)}
            className={inputCls} style={inputStyle}
          />
        </div>
        <div>
          <label className={labelCls}>Supplies ($)</label>
          <input
            type="number" min={0} step="0.01"
            placeholder="packaging, sleeves"
            value={suppliesCost} onChange={(e) => setSuppliesCost(e.target.value)}
            className={inputCls} style={inputStyle}
          />
        </div>
      </div>

      {/* Channel + payment */}
      <div className={sectionHeadCls}>Where &amp; how</div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Sales channel</label>
          <select
            value={salesChannel}
            onChange={(e) => setSalesChannel(e.target.value as SellSalesChannel | "")}
            className={inputCls} style={inputStyle}
          >
            <option value="">— select —</option>
            {SALES_CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Payment method</label>
          <select
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value as SellPaymentMethod | "")}
            className={inputCls} style={inputStyle}
          >
            <option value="">— select —</option>
            {PAYMENT_METHODS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>
      {(salesChannel === "other" || channelNote) && (
        <div className="mt-3">
          <label className={labelCls}>
            Channel detail
            {salesChannel === "other" && <span className="text-[color:var(--color-danger)]"> (required)</span>}
          </label>
          <input
            type="text" maxLength={100}
            placeholder="e.g. Discord group, private buyer"
            value={channelNote} onChange={(e) => setChannelNote(e.target.value)}
            className={inputCls} style={inputStyle}
          />
        </div>
      )}
      {(paymentMethod === "other" || paymentNote) && (
        <div className="mt-3">
          <label className={labelCls}>Payment detail</label>
          <input
            type="text" maxLength={100}
            placeholder="e.g. wire transfer, gift card"
            value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)}
            className={inputCls} style={inputStyle}
          />
        </div>
      )}

      {/* Sale location (useful for shows / cash sales) */}
      <div className={sectionHeadCls}>Sale location (optional)</div>
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className={labelCls}>Venue</label>
          <input
            type="text" maxLength={80}
            placeholder="National 2026, local card shop, etc."
            value={venue} onChange={(e) => setVenue(e.target.value)}
            className={inputCls} style={inputStyle}
          />
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2">
            <label className={labelCls}>City</label>
            <input
              type="text" maxLength={60}
              value={city} onChange={(e) => setCity(e.target.value)}
              className={inputCls} style={inputStyle}
            />
          </div>
          <div>
            <label className={labelCls}>State</label>
            <input
              type="text" maxLength={2}
              placeholder="GA"
              value={state} onChange={(e) => setState(e.target.value.toUpperCase())}
              className={inputCls} style={inputStyle}
            />
          </div>
        </div>
      </div>

      {/* Notes */}
      <div className={sectionHeadCls}>Notes (optional)</div>
      <textarea
        rows={2}
        placeholder="Anything worth remembering about this sale"
        value={notes} onChange={(e) => setNotes(e.target.value)}
        className={`${inputCls} resize-y`} style={inputStyle}
      />

      {/* Live net proceeds summary */}
      <div className="mt-5 p-3 rounded-lg" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
        <div className="flex items-center justify-between text-sm">
          <span className="text-[color:var(--color-muted)]">Gross</span>
          <span className="tabular-nums">${priceNum.toFixed(2)}</span>
        </div>
        {feesNum > 0 && (
          <div className="flex items-center justify-between text-xs mt-1 text-[color:var(--color-muted)]">
            <span>− Fees</span>
            <span className="tabular-nums">−${feesNum.toFixed(2)}</span>
          </div>
        )}
        {shippingNum > 0 && (
          <div className="flex items-center justify-between text-xs mt-1 text-[color:var(--color-muted)]">
            <span>− Shipping (out)</span>
            <span className="tabular-nums">−${shippingNum.toFixed(2)}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-base mt-2 pt-2 border-t" style={{ borderColor: "var(--color-border)" }}>
          <span className="font-semibold">Net proceeds</span>
          <span className="tabular-nums font-bold text-[color:var(--color-accent)]">${netProceeds.toFixed(2)}</span>
        </div>
        {(gradingNum > 0 || suppliesNum > 0 || taxNum > 0) && (
          <div className="text-[10px] text-[color:var(--color-muted)] mt-2 leading-relaxed">
            {taxNum > 0 && `Tax $${taxNum.toFixed(2)} passes through (buyer collected).`}
            {(gradingNum > 0 || suppliesNum > 0) && ` Grading + supplies (${(gradingNum + suppliesNum).toFixed(2)}) reduce cost basis, not net.`}
          </div>
        )}
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
            if (salesChannel === "other" && !channelNote.trim()) {
              setError("Channel detail is required when Sales channel = Other.");
              return;
            }
            setSubmitting(true);
            setError(null);
            try {
              await onConfirm({
                salePrice: n,
                saleDate: date,
                fees: feesNum,
                tax: taxNum,
                shipping: shippingNum,
                gradingCost: gradingNum > 0 ? gradingNum : undefined,
                suppliesCost: suppliesNum > 0 ? suppliesNum : undefined,
                salesChannel: (salesChannel || undefined) as SellSalesChannel | undefined,
                channelNote: channelNote.trim() || undefined,
                paymentMethod: (paymentMethod || undefined) as SellPaymentMethod | undefined,
                paymentNote: paymentNote.trim() || undefined,
                saleLocation:
                  venue.trim() || city.trim() || state.trim()
                    ? { venue: venue.trim() || undefined, city: city.trim() || undefined, state: state.trim() || undefined }
                    : undefined,
                notes: notes.trim() || undefined,
              });
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

// CF-DELETE-OPTIMISTIC (Drew, 2026-08-11). Delete fires in the
// background — modal closes and the caller navigates away immediately.
// No "Deleting…" spinner because the user should not sit on a spinning
// button when the backend is throttled. onConfirm is called for its
// side effect (kicking off the delete + navigate); the modal doesn't
// await it.
function DeleteModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal onClose={onCancel}>
      <h2 className="text-xl font-bold mb-2" style={{ color: "var(--color-danger)" }}>
        Delete this holding?
      </h2>
      <p className="text-sm text-[color:var(--color-muted)] mb-6">
        This removes the card from your portfolio and its price history. Cannot be undone.
        (Use &quot;Mark as sold&quot; if you actually sold it — that keeps the sale for the comp pool.)
      </p>
      <div className="flex items-center justify-end gap-3">
        <button onClick={onCancel} className="hiq-btn-secondary">Cancel</button>
        <button
          onClick={() => {
            onConfirm();
            onCancel();
          }}
          className="px-4 py-2.5 rounded-xl text-sm font-medium"
          style={{ background: "var(--color-danger)", color: "white" }}
        >
          Delete permanently
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
