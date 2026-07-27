"use client";

import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  searchCards,
  fetchPriceById,
  addHolding,
  addWatchlist,
  candidateIdToCardsightId,
  type SearchCandidate,
  type SearchResponse,
  type PriceByIdResponse,
} from "@/lib/api";
import { formatUSD, formatPct } from "@/lib/format";

const EXAMPLE_QUERIES = [
  "2018 Bowman Chrome Vlad Guerrero Jr.",
  "2020 Prizm Justin Herbert Silver",
  "1993 SP Derek Jeter Foil",
  "PSA 12345678",
  "Eric Hartman CPA-EHA",
];

const GRADERS: Array<{ label: string; company: string; values: number[] }> = [
  { label: "PSA",  company: "PSA", values: [10, 9, 8.5, 8, 7, 6, 5, 4, 3, 2, 1] },
  { label: "BGS",  company: "BGS", values: [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6, 5.5, 5] },
  { label: "SGC",  company: "SGC", values: [10, 9.5, 9, 8.5, 8, 7, 6, 5] },
  { label: "CGC",  company: "CGC", values: [10, 9.5, 9, 8.5, 8, 7, 6, 5] },
];

type Phase = "idle" | "searching" | "results" | "detail";

interface Grade {
  company: string;
  value: number;
}

// The pricing lookup takes optional grade + parallel filters. Cached
// by (candidateId, parallelName, grade) so switching between grades on
// the same candidate is instant on repeat.
type PriceCacheKey = string;
function keyFor(candidateId: string, parallelName: string | null, grade: Grade | null): PriceCacheKey {
  return `${candidateId}||${parallelName ?? ""}||${grade ? `${grade.company}:${grade.value}` : "raw"}`;
}

export default function SearchPage() {
  return (
    <Suspense fallback={<Loading />}>
      <SearchPageInner />
    </Suspense>
  );
}

function Loading() {
  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="text-sm text-[color:var(--color-muted)]">Loading…</div>
    </div>
  );
}

function SearchPageInner() {
  const router = useRouter();
  const params = useSearchParams();
  const initialQ = params.get("q") ?? "";

  const [query, setQuery] = useState(initialQ);
  const [phase, setPhase] = useState<Phase>(initialQ ? "searching" : "idle");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState<SearchCandidate | null>(null);
  const [selectedParallel, setSelectedParallel] = useState<string | null>(null);
  const [selectedGrade, setSelectedGrade] = useState<Grade | null>(null);
  const [detailCache] = useState<Map<PriceCacheKey, PriceByIdResponse>>(new Map());
  const [detail, setDetail] = useState<PriceByIdResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setPhase("searching");
    setError(null);
    setSelected(null);
    setDetail(null);
    setDetailError(null);
    setSelectedParallel(null);
    setSelectedGrade(null);
    try {
      const res = await searchCards(trimmed);
      setResults(res);
      setPhase("results");
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message;
      setError(msg ?? "Search failed");
      setPhase("idle");
    }
  }, []);

  // If URL has ?q= on mount, kick off search
  useEffect(() => {
    if (initialQ && phase === "searching") {
      runSearch(initialQ);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadDetail(c: SearchCandidate, parallel: string | null, grade: Grade | null) {
    const cardsightId = candidateIdToCardsightId(c.candidateId);
    if (!cardsightId) {
      setDetailError("This candidate isn't a Cardsight card — detail lookup unavailable.");
      return;
    }
    const key = keyFor(c.candidateId, parallel, grade);
    const cached = detailCache.get(key);
    if (cached) {
      setDetail(cached);
      setDetailError(null);
      return;
    }
    setDetailLoading(true);
    setDetail(null);
    setDetailError(null);
    try {
      const res = await fetchPriceById({
        cardsightCardId: cardsightId,
        gradeCompany: grade?.company,
        gradeValue: grade?.value,
        parallelName: parallel ?? undefined,
      });
      detailCache.set(key, res);
      setDetail(res);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 402) {
        setDetailError("You've hit your daily price-check limit. Upgrade for higher caps.");
      } else {
        setDetailError(e.message ?? "Couldn't load pricing detail");
      }
    } finally {
      setDetailLoading(false);
    }
  }

  function onSelectCandidate(c: SearchCandidate) {
    setSelected(c);
    setPhase("detail");
    // Default parallel to whatever's on the candidate; grade defaults to raw
    // (null) unless the candidate carries a cert grade.
    const defaultParallel = c.parallel ?? c.parallels?.[0]?.name ?? null;
    const defaultGrade: Grade | null =
      c.attribution === "authoritative" && c.gradeCompany && c.gradeValue != null
        ? { company: c.gradeCompany, value: c.gradeValue }
        : null;
    setSelectedParallel(defaultParallel);
    setSelectedGrade(defaultGrade);
    loadDetail(c, defaultParallel, defaultGrade);
  }

  function onChangeParallel(next: string | null) {
    setSelectedParallel(next);
    if (selected) loadDetail(selected, next, selectedGrade);
  }
  function onChangeGrade(next: Grade | null) {
    setSelectedGrade(next);
    if (selected) loadDetail(selected, selectedParallel, next);
  }

  function onSubmitForm(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    router.replace(`/app/search?q=${encodeURIComponent(q)}`);
    runSearch(q);
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-1">Search</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Player, set, cert number, or free text. Same catalog + FMV engine as iOS.
        </p>
      </div>

      <form onSubmit={onSubmitForm} className="mb-8 flex gap-3">
        <input
          type="search"
          placeholder="e.g. 2018 Bowman Chrome Vlad Guerrero Jr. or PSA cert 12345678"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 px-4 py-3 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
          style={{
            background: "var(--color-bg)",
            borderColor: "var(--color-border)",
            color: "white",
          }}
          autoFocus
        />
        <button
          type="submit"
          disabled={phase === "searching" || !query.trim()}
          className="hiq-btn-primary disabled:opacity-50 whitespace-nowrap"
        >
          {phase === "searching" ? "Searching…" : "Search"}
        </button>
      </form>

      {phase === "idle" && !error && <EmptyState onPick={(q) => { setQuery(q); router.replace(`/app/search?q=${encodeURIComponent(q)}`); runSearch(q); }} />}

      {error && (
        <div className="hiq-card p-4 mb-4 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {(phase === "results" || phase === "detail") && results && (
        <div className="mb-4 text-xs text-[color:var(--color-muted)]">
          {results.candidates.length} match{results.candidates.length === 1 ? "" : "es"}
          {results.input.detectedMode === "cert" && " · cert lookup"}
          {results.warnings.length > 0 && ` · ${results.warnings.join(", ")}`}
        </div>
      )}

      {phase === "results" && results && results.candidates.length === 0 && (
        <div className="hiq-card p-8 text-center text-sm text-[color:var(--color-muted)]">
          No cards matched. Try broader keywords or a cert number.
        </div>
      )}

      {(phase === "results" || phase === "detail") && results && results.candidates.length > 0 && (
        <div className="space-y-2 mb-8">
          {results.candidates.map((c) => (
            <CandidateRow
              key={c.candidateId}
              c={c}
              selected={selected?.candidateId === c.candidateId}
              onClick={() => onSelectCandidate(c)}
            />
          ))}
        </div>
      )}

      {phase === "detail" && selected && (
        <PriceDetail
          candidate={selected}
          parallel={selectedParallel}
          grade={selectedGrade}
          onChangeParallel={onChangeParallel}
          onChangeGrade={onChangeGrade}
          detail={detail}
          loading={detailLoading}
          error={detailError}
        />
      )}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div className="hiq-card p-8">
      <h2 className="font-bold text-lg mb-4">Try one of these to see how it works:</h2>
      <div className="flex flex-wrap gap-2">
        {EXAMPLE_QUERIES.map((q) => (
          <button
            key={q}
            onClick={() => onPick(q)}
            className="px-3 py-2 rounded-lg text-sm font-medium transition-colors hover:bg-white/[0.04]"
            style={{
              background: "var(--color-bg)",
              border: "1px solid var(--color-border)",
              color: "white",
            }}
          >
            {q}
          </button>
        ))}
      </div>
      <div className="mt-6 text-xs text-[color:var(--color-muted)] leading-relaxed">
        Every result includes the full grade ladder (PSA / BGS / SGC / CGC), recent comps,
        buy/hold/sell zones, and predicted next sale.
      </div>
    </div>
  );
}

function CandidateRow({
  c,
  selected,
  onClick,
}: {
  c: SearchCandidate;
  selected: boolean;
  onClick: () => void;
}) {
  const meta = [c.year, c.setName ?? c.brand, c.cardNumber ? `#${c.cardNumber}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      onClick={onClick}
      className={`w-full hiq-card p-4 flex items-center gap-4 text-left transition-all ${selected ? "ring-2" : "hover:bg-white/[0.02]"}`}
      style={selected ? ({ ["--tw-ring-color" as string]: "var(--color-accent)" } as React.CSSProperties) : undefined}
    >
      <div
        className="w-14 h-14 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center"
        style={{ background: "var(--color-bg)" }}
      >
        {c.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.imageUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
            <path d="M4 6h16v12H4V6zm2 2v8h12V8H6zm2 2h4v4H8v-4z" />
          </svg>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{c.title}</div>
        <div className="text-xs text-[color:var(--color-muted)] mt-0.5 flex items-center gap-2">
          {meta && <span>{meta}</span>}
          {c.parallel && <span>· {c.parallel}</span>}
          {c.isAuto && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{
                background: "color-mix(in oklab, var(--color-accent) 15%, transparent)",
                color: "var(--color-accent)",
              }}
            >
              AUTO
            </span>
          )}
          {c.attribution === "authoritative" && (
            <span
              className="px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={{
                background: "color-mix(in oklab, var(--color-success) 15%, transparent)",
                color: "var(--color-success)",
              }}
            >
              CERT
            </span>
          )}
        </div>
      </div>
      <div className="text-xs text-[color:var(--color-muted)] hidden md:block">
        {c.attribution === "authoritative" ? "1.00" : c.confidence.toFixed(2)}
      </div>
    </button>
  );
}

function PriceDetail({
  candidate,
  parallel,
  grade,
  onChangeParallel,
  onChangeGrade,
  detail,
  loading,
  error,
}: {
  candidate: SearchCandidate;
  parallel: string | null;
  grade: Grade | null;
  onChangeParallel: (p: string | null) => void;
  onChangeGrade: (g: Grade | null) => void;
  detail: PriceByIdResponse | null;
  loading: boolean;
  error: string | null;
}) {
  const image = detail?.cardImageUrl ?? candidate.imageUrl;
  const fmv = detail?.fairMarketValueLive ?? detail?.marketValue ?? null;
  const predicted = detail?.predictedPrice;
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [watching, setWatching] = useState(false);
  const [watched, setWatched] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);

  const parallels = candidate.parallels ?? [];
  const canWatch = Boolean(candidate.player);

  async function onAddToPortfolio() {
    setAdding(true);
    setAddError(null);
    try {
      const res = await addHolding({
        cardsightCardId: candidateIdToCardsightId(candidate.candidateId) ?? undefined,
        playerName: candidate.player ?? undefined,
        cardTitle: candidate.title,
        cardYear: candidate.year ?? undefined,
        product: candidate.setName ?? candidate.brand ?? undefined,
        parallel: parallel ?? undefined,
        cardNumber: candidate.cardNumber ?? undefined,
        serialNumber: candidate.serialNumber ?? undefined,
        isAuto: candidate.isAuto,
        gradeCompany: grade?.company ?? null,
        gradeValue: grade?.value ?? null,
        quantity: 1,
      });
      if (res.success) {
        setAdded(true);
      } else {
        setAddError(res.error ?? "Failed to add");
      }
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 402) setAddError("Holdings cap reached. Upgrade to add more cards.");
      else setAddError(e.message ?? "Failed to add");
    } finally {
      setAdding(false);
    }
  }

  async function onAddToWatchlist() {
    if (!candidate.player) return;
    setWatching(true);
    setWatchError(null);
    try {
      const res = await addWatchlist({ playerName: candidate.player });
      if (res.success) {
        setWatched(true);
      } else {
        setWatchError("Failed to add");
      }
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 402) setWatchError("Watchlist is Collector+.");
      else if (e.status === 404) setWatchError("Player not found in DailyIQ pool.");
      else setWatchError(e.message ?? "Failed to add");
    } finally {
      setWatching(false);
    }
  }

  return (
    <div className="hiq-card p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start gap-5">
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
          <div className="font-bold text-lg mb-1">{candidate.title}</div>
          {detail?.summary && (
            <p className="text-sm text-[color:var(--color-muted)]">{detail.summary}</p>
          )}
        </div>
        <div className="flex flex-col gap-2 flex-shrink-0">
          <AddToPortfolioButton
            adding={adding}
            added={added}
            error={addError}
            onClick={onAddToPortfolio}
          />
          {canWatch && (
            <AddToWatchlistButton
              watching={watching}
              watched={watched}
              error={watchError}
              onClick={onAddToWatchlist}
            />
          )}
        </div>
      </div>

      {/* Grade + parallel selectors */}
      <div className="space-y-4">
        <GradeSelector value={grade} onChange={onChangeGrade} />
        {parallels.length > 0 && (
          <ParallelSelector
            parallels={parallels}
            value={parallel}
            onChange={onChangeParallel}
          />
        )}
      </div>

      {loading && (
        <div className="text-sm text-[color:var(--color-muted)]">Loading pricing detail…</div>
      )}

      {error && (
        <div className="text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {detail && !loading && !error && (
        <>
          {/* FMV headline */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
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

          {/* Zones */}
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

          {/* Grade ladder */}
          {(detail.gradeBreakdown?.length || detail.gradedEstimates?.length) ? (
            <GradeLadder
              observed={detail.gradeBreakdown ?? []}
              estimated={detail.gradedEstimates ?? []}
              activeGrade={grade}
              onPick={onChangeGrade}
            />
          ) : null}

          {/* Recent comps */}
          {detail.recentComps && detail.recentComps.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-3">
                Recent comps
              </div>
              <div className="space-y-1.5">
                {detail.recentComps.slice(0, 8).map((c, i) => (
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
              {detail.recentComps.length > 8 && (
                <div className="text-xs text-[color:var(--color-muted)] mt-3">
                  + {detail.recentComps.length - 8} more comps
                </div>
              )}
            </div>
          )}

          {/* Meta footer */}
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

function AddToPortfolioButton({
  adding, added, error, onClick,
}: {
  adding: boolean;
  added: boolean;
  error: string | null;
  onClick: () => void;
}) {
  if (added) {
    return (
      <Link
        href="/app/portfolio"
        className="hiq-btn-secondary text-sm whitespace-nowrap"
        style={{ borderColor: "var(--color-success)", color: "var(--color-success)" }}
      >
        ✓ Added — View portfolio
      </Link>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={onClick}
        disabled={adding}
        className="hiq-btn-primary text-sm whitespace-nowrap disabled:opacity-60"
      >
        {adding ? "Adding…" : "+ Add to portfolio"}
      </button>
      {error && (
        <div className="text-xs max-w-[180px] text-right" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

function AddToWatchlistButton({
  watching, watched, error, onClick,
}: {
  watching: boolean;
  watched: boolean;
  error: string | null;
  onClick: () => void;
}) {
  if (watched) {
    return (
      <Link
        href="/app/watchlist"
        className="hiq-btn-secondary text-sm whitespace-nowrap"
        style={{ borderColor: "var(--color-success)", color: "var(--color-success)" }}
      >
        ★ On watchlist
      </Link>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={onClick}
        disabled={watching}
        className="hiq-btn-secondary text-sm whitespace-nowrap disabled:opacity-60"
      >
        {watching ? "Adding…" : "★ Watchlist player"}
      </button>
      {error && (
        <div className="text-xs max-w-[180px] text-right" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
    </div>
  );
}

function GradeSelector({
  value,
  onChange,
}: {
  value: Grade | null;
  onChange: (g: Grade | null) => void;
}) {
  const [company, setCompany] = useState<string>(value?.company ?? "raw");
  const [gradeValue, setGradeValue] = useState<number | null>(value?.value ?? null);

  useEffect(() => {
    setCompany(value?.company ?? "raw");
    setGradeValue(value?.value ?? null);
  }, [value]);

  const grader = GRADERS.find((g) => g.company === company);

  function apply(nextCompany: string, nextValue: number | null) {
    setCompany(nextCompany);
    setGradeValue(nextValue);
    if (nextCompany === "raw" || nextValue == null) {
      onChange(null);
    } else {
      onChange({ company: nextCompany, value: nextValue });
    }
  }

  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">
        Grade
      </div>
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
            style={{
              background: "var(--color-bg)",
              borderColor: "var(--color-border)",
              color: "white",
            }}
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
  parallels,
  value,
  onChange,
}: {
  parallels: NonNullable<SearchCandidate["parallels"]>;
  value: string | null;
  onChange: (p: string | null) => void;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2">
        Parallel
      </div>
      <div className="flex flex-wrap gap-2">
        {parallels.map((p) => (
          <PillButton
            key={p.id}
            active={value === p.name}
            onClick={() => onChange(p.name)}
          >
            {p.name}
            {p.numberedTo != null && (
              <span className="ml-1 opacity-60 text-[10px]">/{p.numberedTo}</span>
            )}
          </PillButton>
        ))}
      </div>
    </div>
  );
}

function PillButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
      style={
        active
          ? { background: "var(--color-accent)", color: "var(--color-bg)" }
          : { background: "var(--color-bg-card)", color: "var(--color-muted)", border: "1px solid var(--color-border)" }
      }
    >
      {children}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1">
        {label}
      </div>
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
  observed,
  estimated,
  activeGrade,
  onPick,
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
