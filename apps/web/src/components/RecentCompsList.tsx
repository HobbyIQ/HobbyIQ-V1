"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchRecentComps, flagComp, type RecentCompSale } from "@/lib/api";
import { formatUSD } from "@/lib/format";

interface Props {
  cardId: string;
  // Optional filters — when provided, the component pre-filters to this
  // parallel + grade so the comps shown are the ones that actually back
  // the surface's FMV. Callers pass null explicitly to filter on "base"
  // parallel; undefined means "show all parallels for this cardId."
  parallel?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  defaultDays?: number;
  title?: string;
  subtitle?: string;
}

// "Show me the actual comps behind this price" — surfaces
// /api/compiq/cards/:cardId/recent-sales as a compact list. Renders on
// the holding detail page (right under the FMV/estimate block) so users
// can see WHY the number is what it is.
export function RecentCompsList({
  cardId,
  parallel,
  gradeCompany,
  gradeValue,
  defaultDays = 180,
  title = "Recent comps",
  subtitle,
}: Props) {
  const [sales, setSales] = useState<RecentCompSale[]>([]);
  const [count, setCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(defaultDays);
  const [sourceFilter, setSourceFilter] = useState<"all" | "user" | "ebay" | "partner">("all");
  // CF-RECENT-COMPS-ALL-GRADES (Drew, 2026-08-07). Default: show ALL
  // grades (Raw + PSA/BGS/SGC/CGC) for this card+parallel. Users can
  // narrow via the grade dropdown. Prior behavior filtered to the
  // holding's grade only, hiding the market context around the tile.
  const [gradeFilter, setGradeFilter] = useState<string>("all");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchRecentComps({ cardId, parallel, allGrades: true, days, limit: 50 })
      .then((res) => {
        if (cancelled) return;
        setSales(res.sales);
        setCount(res.count);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as { message?: string })?.message ?? "Failed to load comps");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cardId, parallel, days]);

  const filtered = useMemo(() => {
    let out = sales;
    // Client-side grade filter — cheap since the server already
    // narrowed by parallel + window. Options built from what's in the pool.
    if (gradeFilter !== "all") {
      out = out.filter((s) => {
        const label = s.gradeCompany && s.gradeValue != null
          ? `${s.gradeCompany} ${s.gradeValue}`
          : "Raw";
        return label === gradeFilter;
      });
    }
    if (sourceFilter === "all") return out;
    return out.filter((s) => {
      const src = (s.source ?? "").toLowerCase();
      if (sourceFilter === "user") return src.startsWith("ebay-user") || src === "manual" || src === "user";
      if (sourceFilter === "ebay") return src === "ebay" || src.startsWith("ebay-");
      if (sourceFilter === "partner") return src === "cardhedge" || src.startsWith("ch-") || src === "ch" || src === "cardsight" || src.startsWith("cs");
      return true;
    });
  }, [sales, sourceFilter, gradeFilter]);

  // D20 — the web says what the engine says. These are facts about the
  // LIST below (how many, lowest, highest, newest) under the filters the
  // user picked. The client-side median that used to sit here, labelled
  // "Median (n)" beside the FMV, is gone: FMV is the engine's projected next
  // sale under a named rung, never a median, and a median in a stat tile
  // next to it read as one.
  const stats = useMemo(() => {
    if (filtered.length === 0) return null;
    const prices = filtered.map((s) => s.price).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
    const min = prices[0] ?? 0;
    const max = prices[prices.length - 1] ?? 0;
    const newest = filtered.reduce((acc, s) => (s.soldAt > acc ? s.soldAt : acc), "");
    return { min, max, newest, n: prices.length };
  }, [filtered]);

  return (
    <div className="hiq-card p-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-3">
        <div>
          <h2 className="font-bold text-lg">{title}</h2>
          {subtitle && (
            <p className="text-xs text-[color:var(--color-muted)] mt-1">{subtitle}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={String(days)}
            onChange={(e) => setDays(Number(e.target.value))}
            className={filterCls}
          >
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="180">180 days</option>
            <option value="365">365 days</option>
          </select>
          <select
            value={gradeFilter}
            onChange={(e) => setGradeFilter(e.target.value)}
            className={filterCls}
          >
            <option value="all">All grades</option>
            {Array.from(new Set(sales.map((s) => s.gradeCompany && s.gradeValue != null ? `${s.gradeCompany} ${s.gradeValue}` : "Raw")))
              .sort((a, b) => {
                if (a === "Raw") return -1;
                if (b === "Raw") return 1;
                return a.localeCompare(b);
              })
              .map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)}
            className={filterCls}
          >
            <option value="all">All sources</option>
            <option value="user">HobbyIQ users</option>
            <option value="ebay">eBay</option>
            <option value="partner">Partner data</option>
          </select>
        </div>
      </div>

      {loading && (
        <div className="text-sm text-[color:var(--color-muted)] py-6 text-center">Loading comps…</div>
      )}
      {error && (
        <div className="text-sm py-4" style={{ color: "var(--color-danger)" }}>{error}</div>
      )}

      {!loading && !error && stats && (
        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted)] mb-2">
            Sales shown — facts about the list below, not the value above
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MiniStat label="Sales shown" value={String(stats.n)} />
            <MiniStat label="Low" value={formatUSD(stats.min, { hideCents: stats.min >= 100 })} />
            <MiniStat label="High" value={formatUSD(stats.max, { hideCents: stats.max >= 100 })} />
            <MiniStat label="Newest sale" value={stats.newest.slice(0, 10)} />
          </div>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="text-sm text-[color:var(--color-muted)] text-center py-6">
          No comps in the selected window.
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="space-y-1 max-h-96 overflow-y-auto -mr-2 pr-2">
          {filtered.map((s, i) => (
            <CompRow key={s.soldAt + i} s={s} />
          ))}
          {count > filtered.length && (
            <div className="text-xs text-[color:var(--color-muted)] text-center mt-2 py-2">
              {count - filtered.length} more comps in the full pool (filters applied)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CompRow({ s }: { s: RecentCompSale }) {
  const grade =
    s.gradeCompany && s.gradeValue != null ? `${s.gradeCompany} ${s.gradeValue}` : "Raw";
  const inner = (
    <div className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 transition-colors">
      {/* CF-PHOTO-DISPLAY (Drew, 2026-08-10). Slab-ratio (~3:4)
          container + object-contain so the whole slab is visible
          (grade banner + card + cert #). */}
      <div className="w-12 h-16 rounded flex-shrink-0 overflow-hidden flex items-center justify-center" style={{ background: "var(--color-bg)" }}>
        {s.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={s.imageUrl} alt="" className="w-full h-full object-contain" />
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
            <path d="M4 6h16v12H4V6z" />
          </svg>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{s.title ?? "Sale"}</div>
        <div className="text-xs text-[color:var(--color-muted)] flex items-center gap-2 flex-wrap mt-0.5">
          <span>{s.soldAt.slice(0, 10)}</span>
          <span>{grade}</span>
          {s.parallel && s.parallel.toLowerCase() !== "base" && <span>{s.parallel}</span>}
          <SourcePill src={s.source} />
          {/* CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03). The viewer's own
              imported purchase is a real sale and is listed like any other --
              it just says whose it is. It used to be filtered out of this list
              entirely, so the comp count disagreed with the pool the FMV came
              from. */}
          {s.isOwn && <OwnCompPill label={s.ownLabel ?? "your purchase"} />}
        </div>
      </div>
      <div className="text-right flex-shrink-0 ml-2">
        <div className="text-sm font-medium tabular-nums">
          {formatUSD(s.price, { hideCents: s.price >= 100 })}
        </div>
        {typeof s.confidenceScore === "number" && (
          <ConfidenceBadge score={s.confidenceScore} band={s.confidenceBand ?? null} explain={s.confidenceExplain ?? null} />
        )}
      </div>
      {s.id && s.cardId && <FlagButton rowId={s.id} cardId={s.cardId} />}
    </div>
  );
  if (s.listingUrl) {
    return (
      <a href={s.listingUrl} target="_blank" rel="noopener noreferrer" className="block">
        {inner}
      </a>
    );
  }
  return inner;
}

function ConfidenceBadge({ score, band, explain }: { score: number; band: string | null; explain: string | null }) {
  const pct = Math.round(score * 100);
  const color = score >= 0.85 ? "text-emerald-500"
              : score >= 0.60 ? "text-yellow-500"
              : "text-red-500";
  const title = `Confidence: ${pct}%${band ? ` (${band})` : ""}${explain ? ` — ${explain}` : ""}`;
  return (
    <div className={`text-[10px] tabular-nums ${color}`} title={title}>
      {pct}%
    </div>
  );
}

function FlagButton({ rowId, cardId }: { rowId: string; cardId: string }) {
  const [state, setState] = useState<"idle" | "sending" | "flagged" | "error">("idle");
  const [msg, setMsg] = useState<string>("");
  const onClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (state === "sending" || state === "flagged") return;
    setState("sending");
    try {
      const r = await flagComp({ rowId, cardId, category: "looks-wrong" });
      setState("flagged");
      setMsg(r.autoQuarantined ? "Flagged (quarantined)" : `Flagged (${r.flagCount})`);
    } catch (err) {
      setState("error");
      setMsg((err as Error)?.message ?? "Error");
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`ml-2 flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded transition-colors ${
        state === "flagged" ? "bg-emerald-500/10 text-emerald-500"
        : state === "error" ? "bg-red-500/10 text-red-500"
        : "text-[color:var(--color-muted)] hover:bg-red-500/10 hover:text-red-500"
      }`}
      title={state === "flagged" ? msg : "Flag as suspicious"}
      disabled={state === "sending" || state === "flagged"}
    >
      {state === "sending" ? "…" : state === "flagged" ? "✓" : state === "error" ? "!" : "⚑ flag"}
    </button>
  );
}

function SourcePill({ src }: { src: string }) {
  const label = prettySource(src);
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wide"
      style={{ background: "var(--color-bg)", color: "var(--color-muted)" }}
    >
      {label}
    </span>
  );
}

// CF-OWN-PURCHASE-IS-A-SALE (Drew, 2026-09-03). The chip that says a comp is
// the viewer's own imported purchase. Deliberately quiet -- the row is an
// ordinary sale in the list and reads as one; the label is context, not a
// warning. Only the viewer ever sees it: the backend computes `isOwn`
// against the requesting session, so another user's purchase is unlabelled.
function OwnCompPill({ label }: { label: string }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[10px] font-medium border"
      style={{
        borderColor: "var(--color-border)",
        color: "var(--color-muted)",
        background: "var(--color-bg)",
      }}
      title="This sale is your own purchase, imported from eBay. It is a real sale and counts as a comp."
    >
      {label}
    </span>
  );
}

function prettySource(s: string): string {
  const l = s.toLowerCase();
  // Third-party pricing partners are surfaced under a single neutral
  // label to keep the comp source anonymous on the UI.
  if (l === "cardhedge" || l.startsWith("ch") || l === "cardsight" || l.startsWith("cs")) return "Partner";
  if (l.startsWith("ebay-user")) return "User (eBay)";
  if (l === "ebay") return "eBay";
  if (l === "manual" || l === "user") return "User";
  return s.slice(0, 10);
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hiq-card p-3 text-center" style={{ background: "var(--color-bg)" }}>
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-1">
        {label}
      </div>
      <div className="text-sm font-bold tabular-nums">{value}</div>
    </div>
  );
}

const filterCls =
  "px-2 py-1 rounded border text-xs outline-none " +
  "bg-[color:var(--color-bg)] border-[color:var(--color-border)] text-white";
