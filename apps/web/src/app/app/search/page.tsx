"use client";

import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  searchCards,
  candidateIdToCardsightId,
  type SearchCandidate,
  type SearchResponse,
} from "@/lib/api";
import { stashCandidate } from "@/lib/candidateStash";

const EXAMPLE_QUERIES = [
  "2018 Bowman Chrome Vlad Guerrero Jr.",
  "2020 Prizm Justin Herbert Silver",
  "1993 SP Derek Jeter Foil",
  "PSA 12345678",
  "Eric Hartman CPA-EHA",
];

type Phase = "idle" | "searching" | "results";

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
  const [error, setError] = useState<string | null>(null);

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setPhase("searching");
    setError(null);
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

  // If URL has ?q= on mount, kick off the search
  useEffect(() => {
    if (initialQ && phase === "searching") {
      runSearch(initialQ);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    router.replace(`/app/search?q=${encodeURIComponent(q)}`);
    runSearch(q);
  }

  function onSelect(c: SearchCandidate) {
    // Stash the full candidate so the detail page can render its
    // header, meta, and parallels selector without a round-trip.
    stashCandidate(c);
    const cardsightId = candidateIdToCardsightId(c.candidateId);
    if (!cardsightId) {
      // Cert-only candidate (no catalog match on file) — fall back to a
      // query-based route that shows the identity info alone.
      setError(
        "This card is a cert lookup without a catalog match — pricing detail isn't available yet.",
      );
      return;
    }
    // Preserve any parallel/grade the candidate already carries (cert
    // candidates set gradeCompany/gradeValue authoritatively).
    const search = new URLSearchParams();
    if (c.parallel) search.set("parallel", c.parallel);
    if (c.attribution === "authoritative" && c.gradeCompany && c.gradeValue != null) {
      search.set("grade", `${c.gradeCompany}:${c.gradeValue}`);
    }
    const qs = search.toString();
    router.push(`/app/card/${cardsightId}${qs ? `?${qs}` : ""}`);
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-1">Search</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Player, set, cert number, or free text. Click any result for full pricing detail.
        </p>
      </div>

      <form onSubmit={onSubmit} className="mb-8 flex gap-3">
        <input
          type="search"
          placeholder="e.g. 2018 Bowman Chrome Vlad Guerrero Jr. or PSA cert 12345678"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 px-4 py-3 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
          style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
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

      {phase === "idle" && !error && (
        <EmptyState
          onPick={(q) => {
            setQuery(q);
            router.replace(`/app/search?q=${encodeURIComponent(q)}`);
            runSearch(q);
          }}
        />
      )}

      {error && (
        <div className="hiq-card p-4 mb-4 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {phase === "results" && results && (
        <>
          <div className="mb-4 text-xs text-[color:var(--color-muted)]">
            {results.candidates.length} match{results.candidates.length === 1 ? "" : "es"}
            {results.input.detectedMode === "cert" && " · cert lookup"}
            {results.warnings.length > 0 && ` · ${results.warnings.join(", ")}`}
          </div>

          {results.candidates.length === 0 ? (
            <div className="hiq-card p-8 text-center text-sm text-[color:var(--color-muted)]">
              No cards matched. Try broader keywords or a cert number.
            </div>
          ) : (
            <div className="space-y-2">
              {results.candidates.map((c) => (
                <CandidateRow key={c.candidateId} c={c} onClick={() => onSelect(c)} />
              ))}
            </div>
          )}
        </>
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
            style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "white" }}
          >
            {q}
          </button>
        ))}
      </div>
      <div className="mt-6 text-xs text-[color:var(--color-muted)] leading-relaxed">
        Every result page includes the full grade ladder (PSA / BGS / SGC / CGC), recent
        comps, buy/hold/sell zones, and predicted next sale. Add to portfolio or watchlist
        with one click.
      </div>
    </div>
  );
}

function CandidateRow({
  c,
  onClick,
}: {
  c: SearchCandidate;
  onClick: () => void;
}) {
  const meta = [c.year, c.setName ?? c.brand, c.cardNumber ? `#${c.cardNumber}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      onClick={onClick}
      className="w-full hiq-card p-4 flex items-center gap-4 text-left transition-colors hover:bg-white/[0.02]"
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
        <div className="text-xs text-[color:var(--color-muted)] mt-0.5 flex items-center gap-2 flex-wrap">
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
