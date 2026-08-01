"use client";

// CF-SLUG-AUDIT-PAGE (Drew, 2026-08-01). Per-slug pool health browser.
// Toggle: top-by-volume (largest pools) or top-by-contamination
// (pools most in need of cleanup).

import { useEffect, useState } from "react";
import { fetchSlugAudit, type SlugAuditReport, type SlugAuditRow } from "@/lib/adminApi";

export default function SlugAuditPage() {
  const [report, setReport] = useState<SlugAuditReport | null>(null);
  const [view, setView] = useState<"volume" | "contamination">("volume");
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (force = false) => {
    force ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      setReport(await fetchSlugAudit(force));
    } catch (e) { setError((e as Error)?.message ?? "Failed to load"); }
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { void load(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (loading && !report) return <div className="text-sm text-[color:var(--color-text-muted)]">Loading slug audit…</div>;
  if (error) return <div className="text-sm text-red-500">Error: {error}</div>;
  if (!report) return null;

  const rows = view === "volume" ? report.topByVolume : report.topByContamination;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Slug Audit</h1>
          <p className="text-sm text-[color:var(--color-text-muted)]">
            {report.totalSlugs.toLocaleString()} slugs with ≥ {report.minSampleFilter} samples · computed {new Date(report.computedAt).toLocaleString()}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing}
          className="rounded border border-[color:var(--color-border)] px-3 py-1 text-sm disabled:opacity-50"
        >
          {refreshing ? "Recomputing…" : "Force recompute"}
        </button>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setView("volume")}
          className={`text-xs px-3 py-1 rounded ${view === "volume" ? "bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]" : "border border-[color:var(--color-border)]"}`}
        >
          Top by volume ({report.topByVolume.length})
        </button>
        <button
          type="button"
          onClick={() => setView("contamination")}
          className={`text-xs px-3 py-1 rounded ${view === "contamination" ? "bg-red-500 text-white" : "border border-[color:var(--color-border)]"}`}
        >
          Top by contamination ({report.topByContamination.length})
        </button>
      </div>

      <div className="space-y-1">
        {rows.map((row) => (
          <SlugRow key={row.slug} row={row} />
        ))}
        {rows.length === 0 && <div className="text-sm text-[color:var(--color-text-muted)]">No slugs match filter.</div>}
      </div>
    </div>
  );
}

function SlugRow({ row }: { row: SlugAuditRow }) {
  const contaminationColor = row.contaminationPct >= 50 ? "text-red-500"
                           : row.contaminationPct >= 25 ? "text-amber-500"
                           : row.contaminationPct >= 10 ? "text-yellow-500"
                           : "text-emerald-500";
  const topSource = Object.entries(row.bySource).sort((a, b) => b[1] - a[1])[0];
  return (
    <div className="rounded border border-[color:var(--color-border)] p-2 bg-[color:var(--color-surface)]">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-mono text-xs truncate flex-1">{row.slug}</span>
        <span className="tabular-nums">n={row.sampleCount}</span>
        <span className="tabular-nums text-[color:var(--color-text-muted)]">med=${row.median.toFixed(0)}</span>
        <span className={`tabular-nums font-medium ${contaminationColor}`}>{row.contaminationPct}%</span>
      </div>
      <div className="text-[10px] text-[color:var(--color-text-muted)] mt-0.5">
        ${row.min.toFixed(0)}-${row.max.toFixed(0)} · {row.flaggedCount} flagged · top: {topSource ? `${topSource[0]}=${topSource[1]}` : "—"} · last {row.lastActivityAt ? new Date(row.lastActivityAt).toLocaleDateString() : "—"}
      </div>
    </div>
  );
}
