"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  fetchPriceById,
  fetchObservedGradeCurve,
  type ObservedGradeCurveResponse,
  addHolding,
  addWatchlist,
  createPriceAlert,
  candidateIdToCardsightId,
  type SearchCandidate,
  type PriceByIdResponse,
} from "@/lib/api";
import { EditHoldingModal } from "@/components/EditHoldingModal";
import type { PortfolioHolding } from "@/lib/api";
import { formatUSD, formatPct } from "@/lib/format";
import { ProvenanceChip } from "@/components/ProvenanceChip";
import { describeRung, type RungDescription } from "@/lib/rung";
import { cardIdentityTitle } from "@/lib/cardIdentityTitle";

interface Grade { company: string; value: number }

const GRADERS: Array<{ label: string; company: string; values: number[] }> = [
  { label: "PSA",  company: "PSA", values: [10, 9, 8.5, 8, 7, 6, 5, 4, 3, 2, 1] },
  { label: "BGS",  company: "BGS", values: [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5] },
  { label: "SGC",  company: "SGC", values: [10, 9.5, 9, 8.5, 8, 7, 6, 5] },
  { label: "CGC",  company: "CGC", values: [10, 9.5, 9, 8.5, 8, 7, 6, 5] },
];

interface Props {
  cardsightCardId: string;
  // Optional candidate metadata. When navigating from search, we hand
  // this over via sessionStorage so the header renders with the same
  // title/player/parallels the user just clicked. When arriving via a
  // shared URL / bookmark, we fall back to what price-by-id gives us
  // (summary + image + cardsightCardId).
  candidate?: SearchCandidate | null;
  initialGrade?: Grade | null;
  initialParallel?: string | null;
  // Called when grade/parallel change so the parent can sync the URL.
  onSelectionChange?: (grade: Grade | null, parallel: string | null) => void;
}

export function CardPriceDetail({
  cardsightCardId,
  candidate,
  initialGrade = null,
  initialParallel = null,
  onSelectionChange,
}: Props) {
  const [grade, setGrade] = useState<Grade | null>(initialGrade);
  const [parallel, setParallel] = useState<string | null>(initialParallel);
  const [detail, setDetail] = useState<PriceByIdResponse | null>(null);
  const [gradeCurve, setGradeCurve] = useState<ObservedGradeCurveResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alertOpen, setAlertOpen] = useState(false);

  const load = useCallback(async (g: Grade | null, p: string | null) => {
    setLoading(true);
    setError(null);
    try {
      // CF-CARD-PRICE-UNIFY (Drew, 2026-08-06). Fetch price-by-id (for
      // trading zones, confidence, comps used) AND the grade curve
      // (source of truth for the tile market value). Top card renders
      // FMV from the SELECTED grade tile so the top card + grade curve
      // can never disagree by construction — they read the same
      // underlying observed-grade-curve number.
      const [res, curve] = await Promise.all([
        fetchPriceById({
          cardsightCardId,
          gradeCompany: g?.company,
          gradeValue: g?.value,
          parallelName: p ?? undefined,
        }),
        fetchObservedGradeCurve(cardsightCardId).catch(() => null),
      ]);
      setDetail(res);
      setGradeCurve(curve);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 402) setError("You've hit your daily price-check limit. Upgrade for higher caps.");
      else setError(e.message ?? "Couldn't load pricing detail");
    } finally {
      setLoading(false);
    }
  }, [cardsightCardId]);

  useEffect(() => {
    load(grade, parallel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardsightCardId]);

  function updateGrade(next: Grade | null) {
    setGrade(next);
    onSelectionChange?.(next, parallel);
    load(next, parallel);
  }
  function updateParallel(next: string | null) {
    setParallel(next);
    onSelectionChange?.(grade, next);
    load(grade, next);
  }

  const image = detail?.cardImageUrl ?? candidate?.imageUrl ?? null;
  // CF-CARD-PRICE-UNIFY (Drew, 2026-08-06). Find the grade curve tile
  // matching the currently-selected grade (or Raw when no grade
  // selected). Its trendAdjustedValue → value → weightedMedianPrice
  // hierarchy IS the tile's MARKET VALUE. Use it as the top card's
  // FMV so they're guaranteed identical.
  const tile = (() => {
    if (!gradeCurve?.entries) return null;
    const wantGrader = grade?.company ?? "Raw";
    const wantValue = grade?.value ?? null;
    for (const e of gradeCurve.entries) {
      if (e.grader !== wantGrader) continue;
      if (wantGrader === "Raw") return e;
      // CF-GRADE-MATCH-BUGFIX (Drew, 2026-08-10). e.grade is a
      // label ("PSA 10", "BGS 9.5") — Number(e.grade) was NaN and
      // never matched. Hero silently fell back to detail.marketValue
      // for graded cards, so hero ≠ grade-curve tile. Extract the
      // numeric suffix and compare, matching CANONICAL_GRADES.label
      // shape "<GRADER> <N>".
      const parts = String(e.grade).trim().split(/\s+/);
      const suffix = parts[parts.length - 1];
      if (Number(suffix) === wantValue) return e;
    }
    return null;
  })();
  // CF-CARD-PANEL-EXACT-TILE-PARITY (Drew, 2026-08-10). GradeCurveView
  // tile's "Market value" is literally `trendAdjustedValue ?? value` —
  // no weightedMedianPrice fallback. Mirror that expression exactly so
  // hero ≡ tile. Prior version added ?? weightedMedianPrice, which
  // could silently diverge from the visible tile in the null-null-set
  // edge case.
  const tileFmv = tile?.trendAdjustedValue ?? tile?.value ?? null;
  const tilePredicted = tile?.predictedPriceAt30d ?? null;
  const fmv = tileFmv ?? detail?.fairMarketValueLive ?? detail?.marketValue ?? null;
  const predicted = tilePredicted ?? detail?.predictedPrice;

  // CF-BASIS-DESCRIBES-THE-NUMBER-SHOWN (2026-08-22). The headline came from
  // the grade-curve TILE while comps / confidence / source came from
  // price-by-id — two different computations — so a correct price was being
  // labelled with another path's emptiness:
  //
  //   RAW FMV $729   CONFIDENCE 0.0%
  //   0 comps used · 0 available · source: no-recent-comps
  //
  // Live on hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150.
  // The $729 is right — it is that card's last actual sale, via the
  // rare-card-anchor rung, "Last sold $729 on 2026-08-20", 1 comp, conf 0.45.
  // price-by-id separately found nothing and its zeroes were printed beside
  // the good number.
  //
  // So when the tile supplies the value, the tile supplies its provenance too.
  const usingTile = tileFmv != null;
  const shownComps = usingTile ? (tile?.sampleCount ?? null) : (detail?.compsUsed ?? null);
  const shownConfidence = usingTile ? (tile?.confidenceScore ?? null) : (detail?.confidence ?? null);
  // (shownSource — the tile's valueSource or price-by-id's `source` string —
  // used to print here as "source: observed"; D20 replaced it with the rung.)
  // D20 — the web says what the engine says. The rung beside the number,
  // from the same path that supplied the number: the tile's per-tier
  // `rungLabel` (and the tier's pool size) when the tile priced it,
  // price-by-id's `rungLabel` otherwise (`source` has carried the same
  // name since D16; a legacy value there renders as an unknown rung, never
  // as an observed one). No number → the engine's reason.
  const detailRungLabel = detail?.rungLabel ?? detail?.source ?? null;
  const shownRung: RungDescription = fmv == null
    ? { kind: "unpriced", text: detail?.fmvReason ?? "no price yet", label: usingTile ? (tile?.rungLabel ?? null) : detailRungLabel }
    : usingTile
      ? describeRung(tile?.rungLabel, { compsUsed: tile?.sampleCount })
      : describeRung(detailRungLabel, { compsUsed: detail?.compsUsed });
  const shownRungSource = usingTile ? "observed-grade-curve" : "price-by-id";
  // Speculation pricing (Drew, 2026-09-02) — how OLD the pool behind the
  // number is, which the rung alone never says. Same rule as the rung
  // above: the age comes from the path that supplied the value, never
  // from the other one. The tile prices a single grade tier off its own
  // pool and reports no age for it, so a tile-sourced number gets no
  // staleness line — borrowing price-by-id's age here would repeat the
  // exact bug the block above exists to prevent (one path's number
  // labelled with another path's provenance).
  const shownCompAgeDays = usingTile ? null : (detail?.daysSinceNewestComp ?? null);
  const parallels = candidate?.parallels ?? [];
  // CF-TITLE-CARD-IDENTITY (Drew, 2026-08-11). Backend enriches the
  // response with cardIdentity (player, year, set, number) precisely
  // so the frontend can build a proper title — "2018 Topps Update
  // Shohei Ohtani #US285" — instead of falling back to summary text
  // or a literal "Card detail" placeholder. The frontend was never
  // updated to read cardIdentity, so titles kept breaking for cards
  // that had no stashed candidate. This block builds the title from
  // cardIdentity first, then falls back to slug-parse, then finally
  // to the placeholder.
  // CF-FULL-CARD-TITLE (2026-08-22). identityTitle used to stop at
  // year / set / player / number — no parallel, no auto, no print run. That
  // was invisible while cardIdentity had no player, because the title fell
  // through to slugTitle which DOES carry them. The moment the player started
  // resolving, identityTitle won and the title regressed from
  //
  //   2024 Bowman Draft #CPA-TG Blue Refractor Auto /150
  // to
  //   2024 Bowman Draft Theo Gillen #CPA-TG
  //
  // — gaining the player and losing which of the card's 65 parallels it is,
  // on a page quoting $729 for the Blue Refractor /150 specifically.
  //
  // Neither source is complete on its own: identity has the player, the slug
  // has the print run. So compose from both, preferring identity per field.
  //
  // CF-CARD-TITLE-NEVER-DOUBLES-THE-YEAR (Drew, 2026-09-06, on hobby-iq.com,
  // search "2023 mike trout"):
  //
  //   2023 2023 Topps Heritage Mike Trout #74PB-1
  //
  // `cardIdentity.set` is the catalog's STORED name and carries its own year on
  // 83-99% of rows per product, so joining it after `year` printed the year
  // twice. Three other surfaces had each grown a private year-strip to survive
  // this; this one, alone in a render closure where no test could reach it,
  // never did.
  //
  // The fix is not a fourth strip. The backend composes the title ONCE
  // (services/catalog/setNameYear.ts, on the wire as cardIdentity.displayName)
  // and this composer moved to lib/cardIdentityTitle.ts so a test can hold it.
  const identityTitle = cardIdentityTitle(detail?.cardIdentity, String(cardsightCardId));
  const slugTitle = (() => {
    // CF-SLUG-TITLE-KEEPS-THE-PARALLEL (2026-08-22). This parsed the slug and
    // then DROPPED the parallel, the auto flag and the print run, so
    //
    //   hiq:baseball:2024:bowman-draft:cpa-tg:blue-refractor:auto:num-150
    //
    // rendered as "2024 Bowman Draft #CPA-TG" — a title that cannot tell you
    // which of that card's 65 catalogued parallels you are looking at, on a
    // page quoting $729 for the Blue Refractor /150 specifically. The id was
    // in the URL the whole time; only three of its seven segments were used.
    //
    // Segments: hiq : sport : year : setKey : cardNumber : parallel :
    //           auto|no-auto : num-N (optional)
    const parts = String(cardsightCardId).split(":");
    if (parts[0] !== "hiq" || parts.length < 5) return null;
    const [, , year, setKey, cardNumber, parallelSeg, autoSeg, printRunSeg] = parts;
    const pretty = (v: string | undefined) => String(v || "")
      .split("-")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    // "base" adds nothing a reader wants — the absence of a parallel says it.
    const parallelPretty = parallelSeg && parallelSeg !== "base" ? pretty(parallelSeg) : "";
    const autoPretty = autoSeg === "auto" ? "Auto" : "";
    const printRun = /^num-\d+$/.test(String(printRunSeg ?? ""))
      ? `/${String(printRunSeg).slice(4)}`
      : "";
    const segs = [
      year,
      pretty(setKey),
      cardNumber ? `#${String(cardNumber).toUpperCase()}` : "",
      parallelPretty,
      autoPretty,
      printRun,
    ].filter(Boolean);
    return segs.join(" ") || null;
  })();
  const title = candidate?.title ?? identityTitle ?? slugTitle ?? "Card detail";

  return (
    <div className="hiq-card p-6 space-y-6">
      <Header
        title={title}
        image={image}
        // CF-FULL-CARD-TITLE (2026-08-22). The summary is price-by-id's prose
        // and says "Insufficient recent comps — no comps on file" whenever THAT
        // path found nothing. When the grade-curve tile supplied the number,
        // the panel below already reports "1 comps used · source: observed",
        // so the sentence contradicts the figures directly above and below it.
        // Same defect as the comps/confidence line, one element up.
        summary={usingTile ? undefined : detail?.summary}
        candidate={candidate}
        cardIdentity={detail?.cardIdentity ?? null}
        grade={grade}
        parallel={parallel}
        cardsightCardId={cardsightCardId}
      />

      <div className="space-y-4">
        <GradeSelector value={grade} onChange={updateGrade} />
        {parallels.length > 0 && (
          <ParallelSelector parallels={parallels} value={parallel} onChange={updateParallel} />
        )}
      </div>

      {loading && (
        <div className="text-sm text-[color:var(--color-muted)]">Loading pricing detail…</div>
      )}

      {error && (
        <div className="text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>
      )}

      {detail && !loading && !error && (
        <>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 flex-1 min-w-0">
              <Stat
                label={grade ? `${grade.company} ${grade.value} FMV` : "Raw FMV"}
                value={formatUSD(fmv, { hideCents: fmv != null && fmv >= 100 })}
                sub={<ProvenanceChip rung={shownRung} source={shownRungSource} daysSinceNewestComp={shownCompAgeDays} />}
              />
              <Stat
                label="Predicted sale"
                value={formatUSD(predicted, { hideCents: predicted != null && predicted >= 100 })}
              />
              {shownConfidence != null && (
                <Stat label="Confidence" value={formatPct(shownConfidence * 100, { signed: false })} />
              )}
            </div>
            <button
              onClick={() => setAlertOpen(true)}
              className="hiq-btn-secondary text-xs px-3 py-1.5 whitespace-nowrap"
            >
              🔔 Price Alert
            </button>
          </div>

          {alertOpen && (
            <AlertModal
              cardsightCardId={cardsightCardId}
              playerName={candidate?.player ?? title}
              currentPrice={fmv ?? predicted ?? null}
              snapshot={{
                playerName: candidate?.player ?? title,
                year: candidate?.year ?? null,
                setName: candidate?.setName ?? candidate?.brand ?? null,
                cardNumber: candidate?.cardNumber ?? null,
                grade: grade ? `${grade.company} ${grade.value}` : null,
                variant: parallel ?? null,
              }}
              onClose={() => setAlertOpen(false)}
            />
          )}

          {(detail.buyZone || detail.holdZone || detail.sellZone) && (
            <div>
              <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">
                Trading zones
              </div>
              <div className="grid grid-cols-3 gap-3">
                {detail.buyZone && <ZonePill label="Buy" range={detail.buyZone} color="var(--color-success)" />}
                {detail.holdZone && <ZonePill label="Hold" range={detail.holdZone} />}
                {detail.sellZone && <ZonePill label="Sell" range={detail.sellZone} color="var(--color-accent)" />}
              </div>
            </div>
          )}

          {(detail.gradeBreakdown?.length || detail.gradedEstimates?.length) ? (
            <GradeLadder
              observed={detail.gradeBreakdown ?? []}
              estimated={detail.gradedEstimates ?? []}
              activeGrade={grade}
              onPick={updateGrade}
            />
          ) : null}

          {/* CF-COMPS-MUST-BACK-THE-NUMBER (Drew, 2026-08-23). Only render the
              comps that produced the price shown above. detail.recentComps is
              price-by-id's pool; when the tile supplies the value it is a
              DIFFERENT pool, and printing it under the tile's number claims
              evidence the number never used.

              Theo Gillen Blue Refractor Auto /150: the tile priced it at $729
              from its one real auto comp and the footer said "1 comps used",
              while this list showed eight $15-$54 sales — non-autos, and a Sky
              Blue Refractor among them. Nothing was mis-tagged in sold_comps;
              exactly one sale is attached to that slug and it is the auto. The
              page was just showing someone else's pool.

              iOS already holds this line — recentComps.length === compsUsed is
              the stated contract (CF-RECENTCOMPS-FULL-POOL, 2026-07-17). Web
              was the surface that broke it. The RecentCompsList panel below
              queries the slug directly and remains the place to browse the
              wider market. */}
          {!usingTile && detail.recentComps && detail.recentComps.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-3">
                Recent comps
              </div>
              <div className="space-y-1.5">
                {detail.recentComps.slice(0, 12).map((c, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-sm py-1.5 border-b border-[color:var(--color-border)] last:border-0"
                  >
                    <div className="text-[color:var(--color-muted)]">
                      {c.soldDate?.slice(0, 10)} · {c.grader ?? "Raw"} {c.gradeValue ?? ""}
                      {c.parallel && ` · ${c.parallel}`}
                    </div>
                    <div className="font-medium tabular-nums">{formatUSD(c.price, { hideCents: c.price >= 100 })}</div>
                  </div>
                ))}
              </div>
              {detail.recentComps.length > 12 && (
                <div className="text-xs text-[color:var(--color-muted)] mt-3">
                  + {detail.recentComps.length - 12} more comps
                </div>
              )}
            </div>
          )}

          <div className="text-xs text-[color:var(--color-muted)] pt-3 border-t border-[color:var(--color-border)]">
            {shownComps != null && <span>{shownComps} comps used</span>}
            {!usingTile && detail.compsAvailable != null && <span> · {detail.compsAvailable} available</span>}
            {detail.daysSinceNewestComp != null && <span> · newest {detail.daysSinceNewestComp}d ago</span>}
            {/* D20: the rung is the chip under the FMV above; the raw label
                rides in its tooltip, so no second "source:" string here. */}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Price alert modal ─────────────────────────────────────────────

function AlertModal({
  cardsightCardId,
  playerName,
  currentPrice,
  snapshot,
  onClose,
}: {
  cardsightCardId: string;
  playerName: string;
  currentPrice: number | null;
  snapshot: {
    playerName: string;
    year: number | null;
    setName: string | null;
    cardNumber: string | null;
    grade: string | null;
    variant: string | null;
  };
  onClose: () => void;
}) {
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [target, setTarget] = useState<string>(
    currentPrice != null ? currentPrice.toFixed(2) : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit() {
    const n = Number(target);
    if (!(n > 0)) {
      setError("Enter a positive target price.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await createPriceAlert({
        cardId: cardsightCardId,
        playerName,
        targetPrice: n,
        direction,
        currentPrice: currentPrice ?? null,
        cardSnapshot: snapshot,
      });
      if (res.success) setSaved(true);
      else setError("Failed to create alert");
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 402) setError("Price alerts cap reached. Upgrade for more.");
      else setError(e.message ?? "Failed to create alert");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div className="hiq-card p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        {saved ? (
          <>
            <h2 className="text-xl font-bold mb-2">✓ Alert created</h2>
            <p className="text-sm text-[color:var(--color-muted)] mb-6">
              You&apos;ll be notified when {playerName} crosses ${target} {direction}.
              Manage or delete on the alerts page.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button onClick={onClose} className="hiq-btn-secondary">
                Close
              </button>
              <Link href="/app/alerts" className="hiq-btn-primary">
                View alerts
              </Link>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-xl font-bold mb-1">Price Alert</h2>
            <p className="text-sm text-[color:var(--color-muted)] mb-6">
              Push notification when {playerName} crosses your target.
              {currentPrice != null && ` Current price ${formatUSD(currentPrice, { hideCents: currentPrice >= 100 })}.`}
            </p>
            <div className="space-y-4">
              <div>
                <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2 block font-medium">
                  Notify me when price is
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDirection("above")}
                    className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors"
                    style={
                      direction === "above"
                        ? { background: "var(--color-accent)", color: "var(--color-bg)" }
                        : { background: "var(--color-bg-card)", color: "var(--color-muted)", border: "1px solid var(--color-border)" }
                    }
                  >
                    ≥ Above
                  </button>
                  <button
                    onClick={() => setDirection("below")}
                    className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors"
                    style={
                      direction === "below"
                        ? { background: "var(--color-accent)", color: "var(--color-bg)" }
                        : { background: "var(--color-bg-card)", color: "var(--color-muted)", border: "1px solid var(--color-border)" }
                    }
                  >
                    ≤ Below
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2 block font-medium">
                  Target price (USD)
                </label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
                  style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
                  autoFocus
                />
              </div>
            </div>
            {error && (
              <div className="mt-4 text-sm" style={{ color: "var(--color-danger)" }}>
                {error}
              </div>
            )}
            <div className="mt-6 flex items-center justify-end gap-3">
              <button onClick={onClose} className="hiq-btn-secondary" disabled={submitting}>
                Cancel
              </button>
              <button
                onClick={onSubmit}
                disabled={submitting || !target}
                className="hiq-btn-primary disabled:opacity-50"
              >
                {submitting ? "Creating…" : "Create alert"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Header (title + image + action buttons) ─────────────────────────

/**
 * Short support/debug reference under the title.
 *
 * The `.slice(0, 8)` this replaces was written for a vendor UUID. Canonical
 * ids are `hiq:<sport>:<year>:<setKey>:<cardNumber>:<parallel>:<auto>`, and
 * the first eight characters of that are "hiq:base" — which rendered as
 * "#hiq:base" under EVERY canonically-identified card and reads as a
 * parallel, not an id. Show the card number, which is the reference a
 * collector actually uses.
 */
function shortCardRef(id: string): string {
  const parts = String(id).split(":");
  if (parts[0] === "hiq" && parts.length >= 5 && parts[4]) return parts[4].toUpperCase();
  return String(id).slice(0, 8);
}

function Header({
  title, image, summary, candidate, cardIdentity, grade, parallel, cardsightCardId,
}: {
  title: string;
  image: string | null;
  summary?: string;
  candidate?: SearchCandidate | null;
  /** CF-ADD-USES-RESOLVED-IDENTITY (2026-08-22). The resolved identity for
   *  this card, so Add does not depend on a stashed search candidate. */
  cardIdentity?: PriceByIdResponse["cardIdentity"] | null;
  grade: Grade | null;
  parallel: string | null;
  cardsightCardId: string;
}) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  // CF-ADD-THEN-EDIT (2026-08-22). Adding from a card page can only supply
  // what the page knows — identity. Grade and what you paid are things only
  // the owner can say, and leaving them unset means the holding prices as Raw
  // against a cost basis of nothing. So the add hands straight over to the
  // edit sheet, seeded with the holding we just created.
  const [justAdded, setJustAdded] = useState<PortfolioHolding | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [watched, setWatched] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);

  const canWatch = Boolean(candidate?.player);

  async function onAddToPortfolio() {
    setAdding(true);
    setAddError(null);
    try {
      // CF-ADD-USES-RESOLVED-IDENTITY (2026-08-22). Every field here read ONLY
      // from `candidate` — the search result stashed on the way to this page.
      // Arrive by URL, or come back after the stash expires, and candidate is
      // null, so all of them go undefined and the add 400s with "card identity
      // missing player name" on a card we price perfectly well.
      //
      // detail.cardIdentity is the resolved identity for exactly this card and
      // is present however you got here; the slug supplies parallel, number and
      // print run. Candidate still wins when it exists — it is the most
      // specific thing the user actually picked.
      const ident = cardIdentity;
      // Last-resort identity straight from the slug in the URL, so Add works
      // on a cold page load with no stash and no enrichment.
      const sp = String(cardsightCardId).split(":");
      const isHiq = sp[0] === "hiq" && sp.length >= 7;
      const slugCardNumber = isHiq ? (String(sp[4] ?? "").toUpperCase() || null) : null;
      const slugParallel = isHiq && sp[5] && sp[5] !== "base"
        ? String(sp[5]).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
        : null;
      const slugIsAuto = isHiq ? sp[6] === "auto" : undefined;
      const res = await addHolding({
        cardsightCardId,
        playerName: candidate?.player ?? ident?.player ?? undefined,
        cardTitle: title,
        cardYear: candidate?.year ?? ident?.year ?? undefined,
        product: candidate?.setName ?? candidate?.brand ?? ident?.set ?? undefined,
        parallel: parallel ?? ident?.parallel ?? slugParallel ?? undefined,
        cardNumber: candidate?.cardNumber ?? ident?.number ?? slugCardNumber ?? undefined,
        serialNumber: candidate?.serialNumber ?? undefined,
        isAuto: candidate?.isAuto ?? ident?.isAuto ?? slugIsAuto,
        gradeCompany: grade?.company ?? null,
        gradeValue: grade?.value ?? null,
        quantity: 1,
      });
      if (res.success) {
        setAdded(true);
        if (res.id) {
          // Seed the sheet from what we just sent, so it opens populated
          // rather than empty and the user only fills in grade + price paid.
          setJustAdded({
            id: res.id,
            playerName: candidate?.player ?? ident?.player ?? undefined,
            cardYear: candidate?.year ?? ident?.year ?? undefined,
            product: candidate?.setName ?? candidate?.brand ?? ident?.set ?? undefined,
            parallel: parallel ?? ident?.parallel ?? slugParallel ?? undefined,
            cardNumber: candidate?.cardNumber ?? ident?.number ?? slugCardNumber ?? undefined,
            isAuto: candidate?.isAuto ?? ident?.isAuto ?? slugIsAuto,
            hobbyiqCardId: cardsightCardId,
            quantity: 1,
          } as unknown as PortfolioHolding);
        }
      }
      else setAddError(res.error ?? "Failed to add");
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 402) setAddError("Holdings cap reached. Upgrade to add more cards.");
      else if (e.status === 400) setAddError("Card identity missing — try a candidate with more detail.");
      else setAddError(e.message ?? "Failed to add");
    } finally {
      setAdding(false);
    }
  }

  async function onAddToWatchlist() {
    if (!candidate?.player) return;
    setWatching(true);
    setWatchError(null);
    try {
      const res = await addWatchlist({ playerName: candidate.player });
      if (res.success) setWatched(true);
      else setWatchError("Failed to add");
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 402) setWatchError("Watchlist is Collector+.");
      else if (e.status === 404) setWatchError("Player not in DailyIQ pool.");
      else setWatchError(e.message ?? "Failed to add");
    } finally {
      setWatching(false);
    }
  }

  return (
    <div className="flex items-start gap-5 flex-wrap">
      {/* CF-PHOTO-DISPLAY (Drew, 2026-08-15: "we want the full image to show
          in the rectangular shape so it shows the full image").
          Was w-24 h-24 + object-cover — a square box center-cropping a 2.5x3.5
          card, so the top and bottom of every card were cut off. The card
          detail page is where the user confirms they picked the right card, so
          the whole card has to be visible. */}
      <div
        className="w-28 aspect-[3/4] rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center"
        style={{ background: "var(--color-bg)" }}
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="w-full h-full object-contain" />
        ) : (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
            <path d="M4 6h16v12H4V6zm2 2v8h12V8H6zm2 2h4v4H8v-4z" />
          </svg>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-xl mb-1">{title}</div>
        {summary && <p className="text-sm text-[color:var(--color-muted)]">{summary}</p>}
        {/* CF-VENDOR-SCRUB (Drew, 2026-08-02). Do not expose vendor
            name to end users. Card id kept for support/debug but
            without the "cardsight:" prefix. */}
        <div className="text-xs text-[color:var(--color-muted)] mt-2 tabular-nums break-all">
          #{shortCardRef(cardsightCardId)}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {added ? (
          <Link
            href="/app/portfolio"
            className="hiq-btn-secondary text-sm whitespace-nowrap"
            style={{ borderColor: "var(--color-success)", color: "var(--color-success)" }}
          >
            ✓ Added — View portfolio
          </Link>
        ) : (
          <button
            onClick={onAddToPortfolio}
            disabled={adding}
            className="hiq-btn-primary text-sm whitespace-nowrap disabled:opacity-60"
          >
            {adding ? "Adding…" : "+ Add to portfolio"}
          </button>
        )}
        {justAdded && (
          <EditHoldingModal
            holding={justAdded}
            onCancel={() => setJustAdded(null)}
            onSaved={() => setJustAdded(null)}
          />
        )}

        {addError && (
          <div className="text-xs max-w-[220px] text-right" style={{ color: "var(--color-danger)" }}>
            {addError}
          </div>
        )}

        {canWatch && (
          watched ? (
            <Link
              href="/app/watchlist"
              className="hiq-btn-secondary text-sm whitespace-nowrap"
              style={{ borderColor: "var(--color-success)", color: "var(--color-success)" }}
            >
              ★ On watchlist
            </Link>
          ) : (
            <button
              onClick={onAddToWatchlist}
              disabled={watching}
              className="hiq-btn-secondary text-sm whitespace-nowrap disabled:opacity-60"
            >
              {watching ? "Adding…" : "★ Watchlist player"}
            </button>
          )
        )}
        {watchError && (
          <div className="text-xs max-w-[220px] text-right" style={{ color: "var(--color-danger)" }}>
            {watchError}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Selectors + shared bits ────────────────────────────────────────

function GradeSelector({
  value, onChange,
}: {
  value: Grade | null;
  onChange: (g: Grade | null) => void;
}) {
  const company = value?.company ?? "raw";
  const gradeValue = value?.value ?? null;
  const grader = GRADERS.find((g) => g.company === company);

  function apply(nextCompany: string, nextValue: number | null) {
    if (nextCompany === "raw" || nextValue == null) onChange(null);
    else onChange({ company: nextCompany, value: nextValue });
  }

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">Grade</div>
      <div className="flex flex-wrap gap-2 items-center">
        <PillButton active={company === "raw"} onClick={() => apply("raw", null)}>Raw</PillButton>
        {GRADERS.map((g) => (
          <PillButton
            key={g.company}
            active={company === g.company}
            onClick={() => apply(g.company, g.values[0])}
          >
            {g.label}
          </PillButton>
        ))}
        {grader && (
          <select
            value={gradeValue ?? ""}
            onChange={(e) => apply(company, e.target.value ? Number(e.target.value) : null)}
            className="ml-2 px-3 py-1.5 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
          >
            {grader.values.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function ParallelSelector({
  parallels, value, onChange,
}: {
  parallels: NonNullable<SearchCandidate["parallels"]>;
  value: string | null;
  onChange: (p: string | null) => void;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">Parallel</div>
      <div className="flex flex-wrap gap-2">
        {parallels.map((p) => (
          <PillButton key={p.id} active={value === p.name} onClick={() => onChange(p.name)}>
            {p.name}
            {p.numberedTo != null && <span className="ml-1 opacity-60 text-[10px]">/{p.numberedTo}</span>}
          </PillButton>
        ))}
      </div>
    </div>
  );
}

function PillButton({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
      style={active
        ? { background: "var(--color-accent)", color: "var(--color-bg)" }
        : { background: "var(--color-bg-card)", color: "var(--color-muted)", border: "1px solid var(--color-border)" }}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      {/* D20: the provenance chip sits under the number it describes. */}
      {sub && <div className="mt-1.5">{sub}</div>}
    </div>
  );
}

function ZonePill({ label, range, color }: { label: string; range: [number, number]; color?: string }) {
  return (
    <div className="hiq-card p-3 text-center" style={{ background: "var(--color-bg)" }}>
      <div
        className="text-xs uppercase tracking-wide font-medium mb-1"
        style={color ? { color } : { color: "var(--color-muted)" }}
      >
        {label}
      </div>
      <div className="text-sm font-medium tabular-nums">
        {formatUSD(range[0], { hideCents: range[0] >= 100 })} – {formatUSD(range[1], { hideCents: range[1] >= 100 })}
      </div>
    </div>
  );
}

function GradeLadder({
  observed, estimated, activeGrade, onPick,
}: {
  observed: NonNullable<PriceByIdResponse["gradeBreakdown"]>;
  estimated: NonNullable<PriceByIdResponse["gradedEstimates"]>;
  activeGrade: Grade | null;
  onPick: (g: Grade) => void;
}) {
  type Row = {
    gradeCompany: string;
    gradeValue: number;
    kind: "observed" | "estimated";
    value: number | null;
    count?: number;
    conf?: string | null;
    /** D20: the tier's rung in words + its raw label (tooltip). */
    rung: RungDescription;
  };
  const rows: Row[] = [];
  // Legacy `gradeBreakdown` (vendor ids the catalog cannot name): its
  // `medianPrice` is a MEDIAN and must not sit in a ladder as if it were a
  // price. The tier shows its last sale — an observed number — with the
  // count; the breakdown names no rung, and the row says so.
  for (const o of observed) {
    if (o.gradeCompany && o.gradeValue != null) {
      rows.push({
        gradeCompany: o.gradeCompany,
        gradeValue: o.gradeValue,
        kind: "observed",
        value: o.lastSalePrice ?? null,
        count: o.count,
        rung: { kind: "unknown", text: "last sale (legacy breakdown, rung not reported)", label: null },
      });
    }
  }
  // D16 `gradedEstimates`: every tier of the one-path curve, each with its
  // own rung and whether it was observed or estimated.
  for (const e of estimated) {
    if (rows.some((r) => r.gradeCompany === e.gradeCompany && r.gradeValue === e.gradeValue)) continue;
    const rung = describeRung(e.rungLabel, { compsUsed: e.sampleCount });
    rows.push({
      gradeCompany: e.gradeCompany,
      gradeValue: e.gradeValue,
      kind: e.valueSource === "observed" ? "observed" : "estimated",
      value: e.estimatedValue ?? null,
      count: e.sampleCount ?? undefined,
      conf: e.estimateConfidence,
      rung,
    });
  }
  rows.sort((a, b) => {
    if (a.gradeCompany !== b.gradeCompany) return a.gradeCompany.localeCompare(b.gradeCompany);
    return b.gradeValue - a.gradeValue;
  });

  if (rows.length === 0) return null;

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-3">
        Grade ladder — click any tier to price at that grade
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {rows.map((r, i) => {
          const isActive = activeGrade?.company === r.gradeCompany && activeGrade?.value === r.gradeValue;
          return (
            <button
              key={i}
              onClick={() => onPick({ company: r.gradeCompany, value: r.gradeValue })}
              className={`p-3 rounded-lg text-center transition-colors ${isActive ? "ring-2" : "hover:bg-white/[0.03]"}`}
              style={{
                background: "var(--color-bg)",
                ...(isActive ? ({ ["--tw-ring-color" as string]: "var(--color-accent)" } as React.CSSProperties) : {}),
              }}
            >
              <div className="text-xs font-medium mb-1">
                {r.gradeCompany} {r.gradeValue}
              </div>
              <div className="text-lg font-bold tabular-nums">
                {formatUSD(r.value, { hideCents: r.value != null && r.value >= 100 })}
              </div>
              <div
                className="text-[10px] uppercase mt-1 tracking-wide"
                style={{
                  color: r.kind === "observed" ? "var(--color-success)" : "var(--color-muted)",
                }}
              >
                {r.kind === "observed" ? `${r.count ?? 0} sold` : (r.conf ?? "est")}
              </div>
              {/* D20: the tier's rung in words; the raw label in the tooltip. */}
              <div
                className="text-[10px] mt-1 leading-tight"
                style={{ color: r.rung.kind === "observed" ? "var(--hiq-hobby-green)" : r.rung.kind === "estimate" ? "var(--hiq-electric-blue)" : "var(--hiq-warning)" }}
                title={`rung: ${r.rung.label ?? "(none)"}`}
              >
                {r.rung.text}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
