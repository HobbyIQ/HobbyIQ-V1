"use client";

// CF-QUARANTINE-PAGE (Drew, 2026-08-01). Admin browser for all sold_comp
// rows carrying any contamination flag. Filter by flag type, click a
// row to clear or force-quarantine.

import { useEffect, useState } from "react";
import {
  fetchQuarantine,
  clearQuarantineRow,
  forceQuarantineRow,
  type QuarantineRow,
  type QuarantineFilter,
} from "@/lib/adminApi";

const FILTERS: Array<{ key: QuarantineFilter; label: string }> = [
  { key: "any", label: "Any flag" },
  { key: "price-outlier", label: "Price outlier" },
  { key: "cardsight-unverified", label: "Cardsight unverified" },
  { key: "user-flagged", label: "User flagged" },
  { key: "bad-actor", label: "Bad actor seller" },
];

export default function QuarantinePage() {
  const [filter, setFilter] = useState<QuarantineFilter>("any");
  const [rows, setRows] = useState<QuarantineRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (nextFilter: QuarantineFilter = filter) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchQuarantine(nextFilter, 100);
      setRows(r.items);
      setHasMore(r.hasMore);
    } catch (e) { setError((e as Error)?.message ?? "Failed to load"); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(filter); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const onFilter = (f: QuarantineFilter) => { setFilter(f); void load(f); };
  const onClear = async (row: QuarantineRow) => {
    setBusyRowId(row.id);
    try { await clearQuarantineRow(row.cardId, row.id); await load(filter); }
    catch (e) { setError((e as Error)?.message ?? "Failed to clear"); }
    finally { setBusyRowId(null); }
  };
  const onForceQuar = async (row: QuarantineRow) => {
    const reason = prompt("Reason for force-quarantine:") ?? "";
    if (!reason) return;
    setBusyRowId(row.id);
    try { await forceQuarantineRow(row.cardId, row.id, reason); await load(filter); }
    catch (e) { setError((e as Error)?.message ?? "Failed to quarantine"); }
    finally { setBusyRowId(null); }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Quarantine</h1>
        <p className="text-sm text-[color:var(--color-text-muted)]">
          Rows with contamination flags. Clear a row that's actually clean, or force-quarantine one that's borderline.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => onFilter(f.key)}
            className={`text-xs px-2 py-1 rounded ${filter === f.key ? "bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]" : "border border-[color:var(--color-border)]"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <div className="text-sm text-red-500">Error: {error}</div>}
      {loading && rows.length === 0 && <div className="text-sm text-[color:var(--color-text-muted)]">Loading…</div>}

      <div className="text-xs text-[color:var(--color-text-muted)]">
        Showing {rows.length}{hasMore ? "+" : ""} rows (filter: {filter})
      </div>

      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.id} className="rounded border border-[color:var(--color-border)] p-3 flex gap-3 items-start bg-[color:var(--color-surface)]">
            <div className="w-16 h-20 shrink-0 rounded overflow-hidden bg-[color:var(--color-surface-2)] flex items-center justify-center text-[10px] text-[color:var(--color-text-muted)]">
              {row.imageUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={row.imageUrl} alt={row.playerName ?? ""} className="w-full h-full object-cover" />
              ) : "no img"}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold flex items-baseline gap-2">
                <span>${row.price.toFixed(2)}</span>
                <span className="text-[color:var(--color-text-muted)] text-xs">{row.playerName} · {row.cardYear ?? "?"}</span>
              </div>
              <div className="text-xs text-[color:var(--color-text-muted)] truncate">{row.title ?? "—"}</div>
              <div className="text-[10px] text-[color:var(--color-text-muted)] mt-1 truncate">
                slug={row.hobbyiqCardId ?? "—"} · source={row.source}
              </div>
              <div className="flex flex-wrap gap-1 mt-2">
                {row.flags.priceOutlier && <FlagPill color="red" text={`price outlier${row.flags.priceOutlierPoolMedian ? ` (pool $${row.flags.priceOutlierPoolMedian.toFixed(0)})` : ""}`} />}
                {row.flags.cardsightUnverified && <FlagPill color="amber" text="cardsight unverified" />}
                {row.flags.userFlagQuarantine && <FlagPill color="red" text={`user flagged (${row.flags.userFlagCount})`} />}
                {row.flags.badActorSeller && <FlagPill color="red" text="bad actor" />}
              </div>
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <button
                type="button"
                disabled={busyRowId === row.id}
                onClick={() => void onClear(row)}
                className="text-[11px] px-2 py-1 rounded bg-emerald-500/10 text-emerald-500 disabled:opacity-50"
              >Clear</button>
              <button
                type="button"
                disabled={busyRowId === row.id}
                onClick={() => void onForceQuar(row)}
                className="text-[11px] px-2 py-1 rounded bg-red-500/10 text-red-500 disabled:opacity-50"
              >Quarantine</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlagPill({ color, text }: { color: "red" | "amber" | "emerald"; text: string }) {
  const cls = color === "red" ? "bg-red-500/10 text-red-500"
            : color === "amber" ? "bg-amber-500/10 text-amber-500"
            : "bg-emerald-500/10 text-emerald-500";
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{text}</span>;
}
