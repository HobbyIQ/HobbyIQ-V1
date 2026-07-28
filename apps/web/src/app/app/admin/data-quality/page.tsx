"use client";

// CF-ADMIN-DATA-QUALITY-PAGE (Drew, 2026-07-28). Pool-level quality
// dashboard. "The number Drew calls when he says 99.9% accurate."

import { useEffect, useState } from "react";
import { fetchDataQualityReport, type DataQualityReport } from "@/lib/adminApi";

export default function DataQualityPage() {
  const [report, setReport] = useState<DataQualityReport | null>(null);
  const [cutoffDays, setCutoffDays] = useState(180);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (days: number) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchDataQualityReport(days);
      setReport(r);
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(cutoffDays); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  if (loading && !report) return <div className="text-sm text-[color:var(--color-text-muted)]">Loading pool quality report…</div>;
  if (error) return <div className="text-sm text-red-500">Error: {error}</div>;
  if (!report) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Pool Quality Report</h1>
          <p className="text-sm text-[color:var(--color-text-muted)]">
            Last {report.cutoffDays} days · {report.totalRows.toLocaleString()} rows · computed {new Date(report.computedAt).toLocaleString()}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {[30, 90, 180, 365].map((d) => (
            <button
              key={d}
              type="button"
              className={`px-2 py-1 text-xs rounded ${cutoffDays === d ? "bg-[color:var(--color-accent)] text-[color:var(--color-accent-fg)]" : "border border-[color:var(--color-border)]"}`}
              onClick={() => { setCutoffDays(d); void load(d); }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--color-border)] p-6 bg-[color:var(--color-surface)]">
        <div className="flex items-baseline gap-3">
          <div className="text-5xl font-bold tabular-nums">{report.trustPercentageDisplay}</div>
          <div className="text-sm text-[color:var(--color-text-muted)]">trust score (verified + auto-parsed) / total (excl. flagged)</div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Bucket label="Verified" value={report.buckets.verified} total={report.totalRows} tone="good" />
        <Bucket label="Catalog matched" value={report.buckets.catalogMatched} total={report.totalRows} tone="good" />
        <Bucket label="Auto-parsed" value={report.buckets.autoParsed} total={report.totalRows} tone="neutral" />
        <Bucket label="Uncertain" value={report.buckets.uncertain} total={report.totalRows} tone="warn" />
        <Bucket label="Flagged" value={report.buckets.flagged} total={report.totalRows} tone="bad" />
        <Bucket label="Pending verify" value={report.buckets.pendingVerify} total={report.totalRows} tone="warn" />
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-2">By source</h2>
        <div className="overflow-x-auto rounded-lg border border-[color:var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-[color:var(--color-text-muted)]">
              <tr>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">Uncertain</th>
                <th className="px-3 py-2 text-right">Flagged</th>
                <th className="px-3 py-2 text-right">Uncertain %</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(report.bySource)
                .sort((a, b) => b[1].total - a[1].total)
                .map(([src, s]) => (
                  <tr key={src} className="border-t border-[color:var(--color-border)] tabular-nums">
                    <td className="px-3 py-2 font-mono text-xs">{src}</td>
                    <td className="px-3 py-2 text-right">{s.total.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">{s.uncertain.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">{s.flagged.toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">{(s.uncertainPct * 100).toFixed(1)}%</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {report.topFlagReasons.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-2">Top flag reasons</h2>
          <ul className="text-sm space-y-1">
            {report.topFlagReasons.map((f) => (
              <li key={f.reason} className="flex justify-between border-b border-[color:var(--color-border)] py-1">
                <span className="font-mono text-xs">{f.reason}</span>
                <span className="tabular-nums">{f.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Bucket({ label, value, total, tone }: { label: string; value: number; total: number; tone: "good" | "neutral" | "warn" | "bad" }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  const toneClass =
    tone === "good" ? "text-emerald-500" :
    tone === "warn" ? "text-amber-500" :
    tone === "bad"  ? "text-red-500" :
    "text-[color:var(--color-text)]";
  return (
    <div className="rounded-lg border border-[color:var(--color-border)] p-4">
      <div className="text-xs uppercase text-[color:var(--color-text-muted)]">{label}</div>
      <div className={`text-2xl font-bold tabular-nums mt-1 ${toneClass}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-[color:var(--color-text-muted)] tabular-nums">{pct.toFixed(1)}%</div>
    </div>
  );
}
