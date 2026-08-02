"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  fetchPriceById,
  addHolding,
  addWatchlist,
  createPriceAlert,
  candidateIdToCardsightId,
  type SearchCandidate,
  type PriceByIdResponse,
} from "@/lib/api";
import { formatUSD, formatPct } from "@/lib/format";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alertOpen, setAlertOpen] = useState(false);

  const load = useCallback(async (g: Grade | null, p: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPriceById({
        cardsightCardId,
        gradeCompany: g?.company,
        gradeValue: g?.value,
        parallelName: p ?? undefined,
      });
      setDetail(res);
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
  const fmv = detail?.fairMarketValueLive ?? detail?.marketValue ?? null;
  const predicted = detail?.predictedPrice;
  const parallels = candidate?.parallels ?? [];
  const title = candidate?.title ?? detail?.summary ?? "Card detail";

  return (
    <div className="hiq-card p-6 space-y-6">
      <Header
        title={title}
        image={image}
        summary={detail?.summary}
        candidate={candidate}
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
              />
              <Stat
                label="Predicted next sale"
                value={formatUSD(predicted, { hideCents: predicted != null && predicted >= 100 })}
              />
              {detail.confidence != null && (
                <Stat label="Confidence" value={formatPct(detail.confidence * 100, { signed: false })} />
              )}
            </div>
            <button
              onClick={() => setAlertOpen(true)}
              className="hiq-btn-secondary text-sm whitespace-nowrap"
            >
              🔔 Set price alert
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

          {detail.recentComps && detail.recentComps.length > 0 && (
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
            {detail.compsUsed != null && <span>{detail.compsUsed} comps used</span>}
            {detail.compsAvailable != null && <span> · {detail.compsAvailable} available</span>}
            {detail.daysSinceNewestComp != null && <span> · newest {detail.daysSinceNewestComp}d ago</span>}
            {detail.source && <span> · source: {detail.source}</span>}
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
            <h2 className="text-xl font-bold mb-1">Set price alert</h2>
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

function Header({
  title, image, summary, candidate, grade, parallel, cardsightCardId,
}: {
  title: string;
  image: string | null;
  summary?: string;
  candidate?: SearchCandidate | null;
  grade: Grade | null;
  parallel: string | null;
  cardsightCardId: string;
}) {
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const [watched, setWatched] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);

  const canWatch = Boolean(candidate?.player);

  async function onAddToPortfolio() {
    setAdding(true);
    setAddError(null);
    try {
      const res = await addHolding({
        cardsightCardId,
        playerName: candidate?.player ?? undefined,
        cardTitle: title,
        cardYear: candidate?.year ?? undefined,
        product: candidate?.setName ?? candidate?.brand ?? undefined,
        parallel: parallel ?? undefined,
        cardNumber: candidate?.cardNumber ?? undefined,
        serialNumber: candidate?.serialNumber ?? undefined,
        isAuto: candidate?.isAuto,
        gradeCompany: grade?.company ?? null,
        gradeValue: grade?.value ?? null,
        quantity: 1,
      });
      if (res.success) setAdded(true);
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
      <div
        className="w-24 h-24 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center"
        style={{ background: "var(--color-bg)" }}
      >
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="w-full h-full object-cover" />
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
          #{cardsightCardId.slice(0, 8)}
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
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
  };
  const rows: Row[] = [];
  for (const o of observed) {
    if (o.gradeCompany && o.gradeValue != null) {
      rows.push({
        gradeCompany: o.gradeCompany,
        gradeValue: o.gradeValue,
        kind: "observed",
        value: o.medianPrice ?? null,
        count: o.count,
      });
    }
  }
  for (const e of estimated) {
    if (rows.some((r) => r.gradeCompany === e.gradeCompany && r.gradeValue === e.gradeValue)) continue;
    rows.push({
      gradeCompany: e.gradeCompany,
      gradeValue: e.gradeValue,
      kind: "estimated",
      value: e.estimatedValue ?? null,
      conf: e.estimateConfidence,
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
            </button>
          );
        })}
      </div>
    </div>
  );
}
