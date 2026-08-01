"use client";

// CF-CLEANLINESS-PAGE (Drew, 2026-08-01). The dashboard Drew calls
// when someone asks "how clean is the data?". Top-line score,
// per-source breakdown, contamination surface areas, trending flags.

import { useEffect, useState } from "react";
import {
  fetchCleanlinessReport,
  refreshCleanlinessReport,
  type CleanlinessReport,
} from "@/lib/adminApi";

export default function CleanlinessPage() {
  const [report, setReport] = useState<CleanlinessReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await fetchCleanlinessReport());
    } catch (e) { setError((e as Error)?.message ?? "Failed to load"); }
    finally { setLoading(false); }
  };
  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      setReport(await refreshCleanlinessReport());
    } catch (e) { setError((e as Error)?.message ?? "Failed to refresh"); }
    finally { setRefreshing(false); }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  if (loading && !report) return <div className="text-sm text-[color:var(--color-text-muted)]">Loading cleanliness report…</div>;
  if (error) return <div className="text-sm text-red-500">Error: {error}</div>;
  if (!report) return null;

  const scoreColor = report.cleanliness.score >= 80 ? "text-emerald-500"
                   : report.cleanliness.score >= 60 ? "text-yellow-500"
                   : "text-red-500";

  const totalConfirmedFlags = report.flags.priceOutliers + report.flags.cardsightUnverified;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Pool Cleanliness</h1>
          <p className="text-sm text-[color:var(--color-text-muted)]">
            {report.totalRows.toLocaleString()} sold_comps rows · computed {new Date(report.computedAt).toLocaleString()}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={refreshing}
          className="rounded border border-[color:var(--color-border)] px-3 py-1 text-sm disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Force recompute"}
        </button>
      </div>

      <div className="rounded-xl border border-[color:var(--color-border)] p-6 bg-[color:var(--color-surface)]">
        <div className="flex items-baseline gap-4">
          <div className={`text-6xl font-bold tabular-nums ${scoreColor}`}>{report.cleanliness.score}</div>
          <div>
            <div className="text-lg font-medium">{report.cleanliness.label}</div>
            <div className="text-xs text-[color:var(--color-text-muted)]">composite score 0-100</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card title="Slug integrity">
          <Metric label="Valid slug" value={report.slug.withValid.toLocaleString()} pct={`${report.slug.validPct}%`} />
          <Metric label="Missing/invalid" value={report.slug.missingOrInvalid.toLocaleString()} accent={report.slug.missingOrInvalid > 100} />
        </Card>
        <Card title="Identity fields">
          <Metric label="With cardNumber" value={report.identity.withCardNumber.toLocaleString()} />
          <Metric label="With playerName" value={report.identity.withPlayerName.toLocaleString()} />
          <Metric label="With cardYear" value={report.identity.withCardYear.toLocaleString()} />
          <Metric label="Missing any" value={report.identity.missingAny.toLocaleString()} accent={report.identity.missingAny > 500} />
        </Card>
        <Card title="Clean-up progress">
          <Metric label="Stage 1 (catalog) fixed" value={report.flags.catalogCanonicalized.toLocaleString()} good />
          <Metric label="Stage 2 (title) fixed" value={report.flags.stage2TitleParsed.toLocaleString()} good />
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card title="Contamination flags">
          <Metric label="Price outliers total" value={report.flags.priceOutliers.toLocaleString()} accent={report.flags.priceOutliers > 10000} />
          <Metric label="…below floor (contamination)" value={report.flags.priceOutlierBelowFloor.toLocaleString()} />
          <Metric label="…above ceiling (usually higher-grade)" value={report.flags.priceOutlierAboveCeiling.toLocaleString()} />
          <Metric label="Cardsight unverified" value={report.flags.cardsightUnverified.toLocaleString()} accent={report.flags.cardsightUnverified > 100000} />
          <div className="mt-2 pt-2 border-t border-[color:var(--color-border)] text-xs text-[color:var(--color-text-muted)]">
            Total flagged rows: {totalConfirmedFlags.toLocaleString()}
          </div>
        </Card>
        <Card title="By source">
          {Object.entries(report.bySource).sort((a, b) => b[1] - a[1]).map(([src, n]) => (
            <Metric key={src} label={src} value={n.toLocaleString()} />
          ))}
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[color:var(--color-border)] p-4 bg-[color:var(--color-surface)]">
      <div className="text-sm font-semibold mb-3">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Metric({ label, value, pct, accent, good }: { label: string; value: string; pct?: string; accent?: boolean; good?: boolean }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-[color:var(--color-text-muted)]">{label}</span>
      <span className={`tabular-nums ${accent ? "text-red-500 font-medium" : good ? "text-emerald-500" : ""}`}>
        {value}{pct ? ` (${pct})` : ""}
      </span>
    </div>
  );
}
