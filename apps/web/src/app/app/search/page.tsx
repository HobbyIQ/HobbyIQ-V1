"use client";

import { useState, type FormEvent } from "react";
import {
  searchCards,
  fetchPriceById,
  candidateIdToCardsightId,
  type SearchCandidate,
  type SearchResponse,
  type PriceByIdResponse,
} from "@/lib/api";
import { formatUSD, formatPct } from "@/lib/format";

type Phase = "idle" | "searching" | "results" | "detail";

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [selected, setSelected] = useState<SearchCandidate | null>(null);
  const [detail, setDetail] = useState<PriceByIdResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setPhase("searching");
    setError(null);
    setSelected(null);
    setDetail(null);
    try {
      const res = await searchCards(q);
      setResults(res);
      setPhase("results");
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as { message?: string })?.message;
      setError(msg ?? "Search failed");
      setPhase("idle");
    }
  }

  async function loadDetail(c: SearchCandidate) {
    const cardsightId = candidateIdToCardsightId(c.candidateId);
    if (!cardsightId) {
      setDetailError("This candidate isn't a Cardsight card — detail lookup unavailable.");
      setSelected(c);
      setPhase("detail");
      return;
    }
    setSelected(c);
    setPhase("detail");
    setDetailLoading(true);
    setDetail(null);
    setDetailError(null);
    try {
      const res = await fetchPriceById({ cardsightCardId: cardsightId });
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

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-1">Search</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Player, set, cert number, or free text. Same catalog + FMV engine as iOS.
        </p>
      </div>

      <form onSubmit={onSubmit} className="mb-8 flex gap-3">
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
              onClick={() => loadDetail(c)}
            />
          ))}
        </div>
      )}

      {phase === "detail" && selected && (
        <PriceDetail
          candidate={selected}
          detail={detail}
          loading={detailLoading}
          error={detailError}
        />
      )}
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
      className={`w-full hiq-card p-4 flex items-center gap-4 text-left transition-all ${
        selected ? "ring-2" : "hover:bg-white/[0.02]"
      }`}
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
  detail,
  loading,
  error,
}: {
  candidate: SearchCandidate;
  detail: PriceByIdResponse | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) {
    return (
      <div className="hiq-card p-6 text-sm text-[color:var(--color-muted)]">
        Loading pricing detail…
      </div>
    );
  }
  if (error) {
    return (
      <div className="hiq-card p-6 text-sm" style={{ color: "var(--color-danger)" }}>
        {error}
      </div>
    );
  }
  if (!detail) return null;

  const image = detail.cardImageUrl ?? candidate.imageUrl;
  const fmv = detail.fairMarketValueLive ?? detail.marketValue ?? null;
  const predicted = detail.predictedPrice;

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
          {detail.summary && (
            <p className="text-sm text-[color:var(--color-muted)]">{detail.summary}</p>
          )}
        </div>
      </div>

      {/* FMV headline */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Stat
          label="Fair market value"
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
              <div key={i} className="flex items-center justify-between text-sm py-1.5 border-b border-[color:var(--color-border)] last:border-0">
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
    </div>
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
}: {
  observed: NonNullable<PriceByIdResponse["gradeBreakdown"]>;
  estimated: NonNullable<PriceByIdResponse["gradedEstimates"]>;
}) {
  // Merge observed + estimated into one sortable list
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
    // Skip if we already have an observed entry for same grade
    if (rows.some((r) => r.gradeCompany === e.gradeCompany && r.gradeValue === e.gradeValue)) {
      continue;
    }
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
        Grade ladder
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {rows.map((r, i) => (
          <div
            key={i}
            className="p-3 rounded-lg text-center"
            style={{ background: "var(--color-bg)" }}
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
                color:
                  r.kind === "observed" ? "var(--color-success)" : "var(--color-muted)",
              }}
            >
              {r.kind === "observed"
                ? `${r.count ?? 0} sold`
                : (r.conf ?? "est")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
