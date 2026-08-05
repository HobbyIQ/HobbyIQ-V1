"use client";

import { Suspense, useCallback, useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
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

  async function onSelect(c: SearchCandidate) {
    // Stash the full candidate so the detail page can render its
    // header, meta, and parallels selector without a round-trip.
    stashCandidate(c);
    const cardsightId = candidateIdToCardsightId(c.candidateId);
    const search = new URLSearchParams();
    if (c.parallel) search.set("parallel", c.parallel);
    if (c.attribution === "authoritative" && c.gradeCompany && c.gradeValue != null) {
      search.set("grade", `${c.gradeCompany}:${c.gradeValue}`);
    }
    const qs = search.toString();
    if (cardsightId) {
      router.push(`/app/card/${cardsightId}${qs ? `?${qs}` : ""}`);
      return;
    }
    // CF-CATALOG-CANDIDATE-CLICKTHROUGH (Drew, 2026-08-02). Candidate
    // came from the sold_comps fallback rung — no vendor cardId
    // available. Instead of the "cert lookup" dead-end that was here,
    // rebuild a search-quality free-text query from the candidate's
    // identity and let /api/compiq/price resolve it via the CH AI
    // matcher. If resolution succeeds we get a real cardId and route
    // to the normal card page; if it fails we surface the honest
    // "no pricing yet" state.
    try {
      setError(null);
      const parts: string[] = [];
      if (c.year) parts.push(String(c.year));
      if (c.setName) parts.push(c.setName);
      if (c.player) parts.push(c.player);
      if (c.cardNumber) parts.push(`#${c.cardNumber}`);
      if (c.parallel && c.parallel.toLowerCase() !== "base") parts.push(c.parallel);
      if (c.isAuto) parts.push("auto");
      const query = parts.filter(Boolean).join(" ").trim();
      if (!query) {
        setError("No identity to look up on this card yet.");
        return;
      }
      const { fetchPriceByQuery } = await import("@/lib/api");
      const priced = await fetchPriceByQuery(query);
      const resolvedId = priced?.cardIdentity?.card_id;
      if (resolvedId) {
        router.push(`/app/card/${resolvedId}${qs ? `?${qs}` : ""}`);
        return;
      }
      setError("We have sales history for this card but haven't matched it to our detail catalog yet — pricing detail will fill in once the catalog links up.");
    } catch (err) {
      setError((err as { message?: string })?.message ?? "Lookup failed. Try again.");
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-1">Search</h1>
          <p className="text-sm text-[color:var(--color-muted)]">
            Player, set, cert number, or free text. Click any result for full pricing detail.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Link
            href="/app/identify"
            className="text-sm font-medium px-3 py-2 rounded-lg hover:bg-white/[0.04]"
            style={{ background: "color-mix(in oklab, var(--color-accent) 12%, transparent)", color: "var(--color-accent)", border: "1px solid color-mix(in oklab, var(--color-accent) 35%, transparent)" }}
            title="Upload a photo of a card to identify it"
          >
            Identify from photo →
          </Link>
          <Link
            href="/app/products?year=2025"
            className="text-sm font-medium px-3 py-2 rounded-lg hover:bg-white/[0.04]"
            style={{ background: "color-mix(in oklab, var(--color-accent) 12%, transparent)", color: "var(--color-accent)", border: "1px solid color-mix(in oklab, var(--color-accent) 35%, transparent)" }}
            title="Browse every catalog product by year + brand"
          >
            Browse products →
          </Link>
        </div>
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

// CF-CATALOG-FIRST candidate → product-family drill-down (2026-08-04).
// Derived client-side from year + setName. Product-overview page 404s
// gracefully if the BCCP scrape hasn't imported this specific product
// yet — no client validation needed.
function candidateProductKey(c: SearchCandidate): string | null {
  if (!c.year || !c.setName) return null;
  const slug = c.setName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return null;
  return `${c.year}-${slug}`;
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
  const productKey = candidateProductKey(c);
  return (
    <div className="relative">
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
    {productKey && (
      <Link
        href={`/app/product/${encodeURIComponent(productKey)}`}
        className="absolute top-2 right-2 text-[10px] px-2 py-1 rounded-md font-medium hover:bg-white/[0.06]"
        style={{ color: "var(--color-accent)", background: "color-mix(in oklab, var(--color-accent) 12%, transparent)" }}
        onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
        title="View product family (parallels, inserts, autos)"
      >
        Product family →
      </Link>
    )}
    </div>
  );
}
