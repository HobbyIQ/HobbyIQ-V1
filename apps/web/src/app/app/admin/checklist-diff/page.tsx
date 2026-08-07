"use client";

// CF-CHECKLIST-DIFF-PAGE (Drew, 2026-08-08). Paste a product checklist,
// diff against catalog. Shows: which checklist rows are already in
// catalog, which are missing (seed candidates), and which catalog
// entries exist for that year+set but aren't in the pasted checklist
// (likely spurious / non-canonical).

import { useCallback, useState } from "react";
import { fetchChecklistDiff, type ChecklistDiffResult } from "@/lib/adminApi";

const SPORTS = ["baseball", "basketball", "football", "hockey", "soccer", "pokemon", "mtg"];

export default function ChecklistDiffPage() {
  const [year, setYear] = useState<string>("2005");
  const [setName, setSetName] = useState<string>("Bowman Draft Picks & Prospects");
  const [sport, setSport] = useState<string>("baseball");
  const [checklistText, setChecklistText] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChecklistDiffResult | null>(null);

  const onRun = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const y = Number(year);
      if (!Number.isFinite(y) || y < 1900 || y > 2100) throw new Error("Invalid year");
      if (!setName.trim()) throw new Error("Set name required");
      if (!checklistText.trim()) throw new Error("Paste a checklist");
      const r = await fetchChecklistDiff(checklistText, y, setName, sport);
      setResult(r);
    } catch (e) {
      setError((e as Error)?.message ?? "Failed");
    } finally {
      setLoading(false);
    }
  }, [year, setName, sport, checklistText]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Checklist diff</h1>
        <p className="text-sm text-[color:var(--color-text-muted)]">
          Paste a product checklist to compare against the catalog. Confirms which cards are indexed, which are missing (add-me), and which catalog entries exist that AREN&apos;T in the official checklist (likely spurious).
        </p>
      </div>

      {/* Input form */}
      <div className="rounded-xl border border-[color:var(--color-border)] p-4 bg-[color:var(--color-surface)] space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-sm">
            <div className="text-xs text-[color:var(--color-text-muted)] uppercase tracking-wide mb-1">Year</div>
            <input
              type="number"
              min={1900}
              max={2100}
              value={year}
              onChange={(e) => setYear(e.target.value)}
              className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-1.5"
            />
          </label>
          <label className="text-sm md:col-span-2">
            <div className="text-xs text-[color:var(--color-text-muted)] uppercase tracking-wide mb-1">Set name (full product name)</div>
            <input
              type="text"
              value={setName}
              onChange={(e) => setSetName(e.target.value)}
              placeholder="e.g. Bowman Draft Picks & Prospects"
              className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-1.5"
            />
          </label>
        </div>
        <label className="text-sm block">
          <div className="text-xs text-[color:var(--color-text-muted)] uppercase tracking-wide mb-1">Sport</div>
          <select
            value={sport}
            onChange={(e) => setSport(e.target.value)}
            className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-1.5"
          >
            {SPORTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="text-sm block">
          <div className="text-xs text-[color:var(--color-text-muted)] uppercase tracking-wide mb-1">Checklist (one card per line — formats: &quot;#BDP129 Justin Verlander&quot; / &quot;BDP129 Justin Verlander RC&quot; / &quot;BDP129, Justin Verlander&quot;)</div>
          <textarea
            value={checklistText}
            onChange={(e) => setChecklistText(e.target.value)}
            placeholder={"BDP1 Ryan Braun\nBDP2 Cameron Maybin\n...\nBDP129 Justin Verlander RC"}
            rows={12}
            className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-2 font-mono text-xs"
          />
        </label>
        <button
          type="button"
          onClick={() => void onRun()}
          disabled={loading}
          className="rounded bg-[color:var(--color-accent)] text-white px-4 py-2 text-sm disabled:opacity-50"
        >
          {loading ? "Diffing…" : "Run diff"}
        </button>
        {error && <div className="text-sm text-red-500">Error: {error}</div>}
      </div>

      {/* Results */}
      {result && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <StatCard label="Checklist rows parsed" value={result.parsed} />
            <StatCard label="In catalog" value={result.inCatalog.length} color="emerald" />
            <StatCard label="Missing from catalog" value={result.missingFromCatalog.length} color="amber" />
            <StatCard label="Extra in catalog" value={result.extraInCatalog.length} color="red" />
          </div>
          <div className="text-xs text-[color:var(--color-text-muted)]">
            Set slug used: <code>{result.setKey}</code> · Year: {result.year}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-[color:var(--color-border)] overflow-hidden">
              <div className="bg-[color:var(--color-bg-subtle)] px-3 py-2 text-xs uppercase tracking-wide text-amber-600 font-medium border-b border-[color:var(--color-border)]">
                Missing from catalog ({result.missingFromCatalog.length}) — add these
              </div>
              <div className="max-h-96 overflow-y-auto">
                {result.missingFromCatalog.length === 0 ? (
                  <div className="p-4 text-sm text-[color:var(--color-text-muted)]">None — every checklist row already exists in catalog.</div>
                ) : (
                  <table className="w-full text-xs">
                    <tbody>
                      {result.missingFromCatalog.map((r) => (
                        <tr key={r.cardNumber} className="border-b border-[color:var(--color-border)] last:border-b-0">
                          <td className="px-3 py-1.5 font-mono">#{r.cardNumber}</td>
                          <td className="px-3 py-1.5">{r.player}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-[color:var(--color-border)] overflow-hidden">
              <div className="bg-[color:var(--color-bg-subtle)] px-3 py-2 text-xs uppercase tracking-wide text-red-600 font-medium border-b border-[color:var(--color-border)]">
                Extra in catalog ({result.extraInCatalog.length}) — likely spurious
              </div>
              <div className="max-h-96 overflow-y-auto">
                {result.extraInCatalog.length === 0 ? (
                  <div className="p-4 text-sm text-[color:var(--color-text-muted)]">None — every catalog entry for this set matches a checklist row.</div>
                ) : (
                  <table className="w-full text-xs">
                    <tbody>
                      {result.extraInCatalog.map((r) => (
                        <tr key={r.slug} className="border-b border-[color:var(--color-border)] last:border-b-0">
                          <td className="px-3 py-1.5 font-mono">#{r.cardNumber}</td>
                          <td className="px-3 py-1.5">{r.playerName ?? "—"}</td>
                          <td className="px-3 py-1.5 text-[color:var(--color-text-muted)] text-[10px]">
                            {r.verificationStatus ?? ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>

          <details className="rounded-xl border border-[color:var(--color-border)] p-3">
            <summary className="text-sm font-medium cursor-pointer">
              Confirmed in catalog ({result.inCatalog.length})
            </summary>
            <div className="max-h-96 overflow-y-auto mt-2">
              <table className="w-full text-xs">
                <tbody>
                  {result.inCatalog.map((r) => (
                    <tr key={r.matchedSlug} className="border-b border-[color:var(--color-border)] last:border-b-0">
                      <td className="px-3 py-1.5 font-mono">#{r.cardNumber}</td>
                      <td className="px-3 py-1.5">{r.player}</td>
                      <td className="px-3 py-1.5 text-[color:var(--color-text-muted)] text-[10px] truncate max-w-xs">{r.matchedSlug}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: "emerald" | "amber" | "red" }) {
  const c = color === "emerald" ? "text-emerald-500"
          : color === "amber" ? "text-amber-500"
          : color === "red" ? "text-red-500"
          : "";
  return (
    <div className="rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-4">
      <div className="text-xs text-[color:var(--color-text-muted)] uppercase tracking-wide">{label}</div>
      <div className={`text-3xl font-bold tabular-nums mt-1 ${c}`}>{value.toLocaleString()}</div>
    </div>
  );
}
