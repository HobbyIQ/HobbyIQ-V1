"use client";

// CF-CUSTOM-TIERS (Drew, 2026-08-17: "make people select their own tiers of
// what they want to own? That way they can build it their way").
//
// The editor makes two things impossible to get wrong, because they are the
// two ways a tier set silently stops meaning anything:
//
//   1. ORDER IS VISIBLE AND MOVABLE. First match wins, so a tier list is a
//      priority statement. Buckets always overlap — a 1955 PSA 4 is both
//      "vintage" and "graded" — and without visible ordering the user cannot
//      predict where a card lands.
//   2. TARGETS MUST TOTAL 100%. Shown live, and Save stays disabled until it
//      does. The server rejects rather than renormalises, so silently rescaling
//      here would just produce a confusing round-trip error.
//
// Rules are deliberately a small fixed set of predicates rather than an
// expression language: they map to facts the system can actually read off a
// holding. Print run in particular is parsed from card text and is often
// unknown, and an unknown never satisfies a print-run bound.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchPortfolioTiers, savePortfolioTiers, type CustomTier, type TierRule,
} from "@/lib/api";

function blankTier(n: number): CustomTier {
  return { id: `tier-${Date.now()}-${n}`, name: "New tier", targetShare: 0, rules: [{}] };
}

export default function TiersEditorPage() {
  const [tiers, setTiers] = useState<CustomTier[]>([]);
  const [isCustom, setIsCustom] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetchPortfolioTiers();
        setTiers(r.tiers);
        setIsCustom(r.isCustom);
      } catch {
        setMsg("Could not load tiers.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const total = tiers.reduce((s, t) => s + (Number(t.targetShare) || 0), 0);
  const totalPct = Math.round(total * 100);
  const balanced = Math.abs(total - 1) <= 0.02;

  function update(i: number, patch: Partial<CustomTier>) {
    setTiers((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }
  function updateRule(i: number, patch: Partial<TierRule>) {
    setTiers((prev) => prev.map((t, idx) => {
      if (idx !== i) return t;
      const rule = { ...(t.rules[0] ?? {}), ...patch };
      // Strip emptied fields so a cleared input does not persist as a rule that
      // silently matches nothing.
      for (const k of Object.keys(rule) as (keyof TierRule)[]) {
        const v = rule[k];
        if (v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v))) delete rule[k];
      }
      return { ...t, rules: [rule] };
    }));
  }
  function move(i: number, dir: -1 | 1) {
    setTiers((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const r = await savePortfolioTiers(tiers);
      setTiers(r.tiers);
      setIsCustom(r.isCustom);
      setMsg("Saved. Your breakdown now uses these tiers.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefaults() {
    setSaving(true);
    setMsg(null);
    try {
      const r = await savePortfolioTiers([]);   // empty clears back to defaults
      setTiers(r.tiers);
      setIsCustom(false);
      setMsg("Reset to the HobbyIQ defaults.");
    } catch {
      setMsg("Could not reset.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-6 text-slate-400">Loading tiers…</div>;

  const input = "w-full rounded-lg border border-slate-700 bg-slate-800/60 px-2 py-1 text-sm text-white";

  return (
    <div className="mx-auto max-w-4xl p-6">
      <Link href="/app/portfolio/breakdown" className="text-sm text-sky-400 hover:underline">
        ← Breakdown
      </Link>
      <h1 className="mt-2 text-3xl font-bold text-white">Your Tiers</h1>
      <p className="mt-1 text-sm text-slate-400">
        Build the mix you actually want to own. A card lands in the{" "}
        <strong className="text-slate-200">first</strong> tier whose rules it matches, so order is
        your priority — drag the important ones up.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <span
          className="rounded-full px-3 py-1 text-sm font-bold"
          style={{
            color: balanced ? "#22c55e" : "#f59e0b",
            background: balanced ? "#22c55e22" : "#f59e0b22",
          }}
        >
          Targets total {totalPct}%
        </span>
        {!balanced && <span className="text-xs text-slate-400">Must total 100% to save.</span>}
        {isCustom && <span className="text-xs text-slate-500">Using your custom tiers</span>}
      </div>

      <div className="mt-5 space-y-3">
        {tiers.map((t, i) => {
          const rule = t.rules[0] ?? {};
          return (
            <div key={t.id} className="rounded-2xl border border-slate-700/60 bg-slate-900/60 p-4">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-500">#{i + 1}</span>
                <input
                  className={`${input} flex-1 font-semibold`}
                  value={t.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                />
                <div className="flex items-center gap-1">
                  <input
                    type="number" min={0} max={100}
                    className={`${input} w-20 text-right tabular-nums`}
                    value={Math.round((t.targetShare ?? 0) * 100)}
                    onChange={(e) => update(i, { targetShare: (Number(e.target.value) || 0) / 100 })}
                  />
                  <span className="text-sm text-slate-400">%</span>
                </div>
                <button onClick={() => move(i, -1)} disabled={i === 0}
                        className="px-1.5 text-slate-400 disabled:opacity-25" title="Move up">↑</button>
                <button onClick={() => move(i, 1)} disabled={i === tiers.length - 1}
                        className="px-1.5 text-slate-400 disabled:opacity-25" title="Move down">↓</button>
                <button onClick={() => setTiers((p) => p.filter((_, idx) => idx !== i))}
                        className="px-1.5 text-red-400/70 hover:text-red-400" title="Remove">✕</button>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                <Field label="Print run ≤" >
                  <input type="number" className={input} value={rule.printRunMax ?? ""}
                         onChange={(e) => updateRule(i, { printRunMax: e.target.value === "" ? undefined : Number(e.target.value) })} />
                </Field>
                <Field label="Year ≤">
                  <input type="number" className={input} value={rule.yearMax ?? ""}
                         onChange={(e) => updateRule(i, { yearMax: e.target.value === "" ? undefined : Number(e.target.value) })} />
                </Field>
                <Field label="Year ≥">
                  <input type="number" className={input} value={rule.yearMin ?? ""}
                         onChange={(e) => updateRule(i, { yearMin: e.target.value === "" ? undefined : Number(e.target.value) })} />
                </Field>
                <Field label="Value ≥">
                  <input type="number" className={input} value={rule.valueMin ?? ""}
                         onChange={(e) => updateRule(i, { valueMin: e.target.value === "" ? undefined : Number(e.target.value) })} />
                </Field>
                <Field label="Product contains">
                  <input className={input} value={rule.productContains ?? ""}
                         placeholder="bowman, prizm…"
                         onChange={(e) => updateRule(i, { productContains: e.target.value || undefined })} />
                </Field>
                <Field label="Name contains">
                  <input className={input} value={rule.nameContains ?? ""}
                         placeholder="ohtani, charizard…"
                         onChange={(e) => updateRule(i, { nameContains: e.target.value || undefined })} />
                </Field>
                <Field label="Graded">
                  <select className={input}
                          value={rule.graded === undefined ? "" : String(rule.graded)}
                          onChange={(e) => updateRule(i, { graded: e.target.value === "" ? undefined : e.target.value === "true" })}>
                    <option value="">Any</option>
                    <option value="true">Graded only</option>
                    <option value="false">Raw only</option>
                  </select>
                </Field>
                <Field label="Auto">
                  <select className={input}
                          value={rule.isAuto === undefined ? "" : String(rule.isAuto)}
                          onChange={(e) => updateRule(i, { isAuto: e.target.value === "" ? undefined : e.target.value === "true" })}>
                    <option value="">Any</option>
                    <option value="true">Autos only</option>
                    <option value="false">No autos</option>
                  </select>
                </Field>
              </div>

              {Object.keys(rule).length === 0 && (
                <p className="mt-2 text-[11px] text-slate-500">
                  No rules — this tier catches everything that reaches it. Useful as the last tier.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button onClick={() => setTiers((p) => [...p, blankTier(p.length)])}
                className="rounded-lg border border-slate-600 px-3 py-1.5 text-sm text-slate-200">
          + Add tier
        </button>
        <button onClick={save} disabled={saving || !balanced}
                className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40">
          {saving ? "Saving…" : "Save tiers"}
        </button>
        <button onClick={resetToDefaults} disabled={saving}
                className="text-sm text-slate-400 hover:underline">
          Reset to HobbyIQ defaults
        </button>
        {msg && <span className="text-xs text-slate-400">{msg}</span>}
      </div>

      <p className="mt-6 text-xs text-slate-500">
        Print run is read from the card&apos;s own text, so a card that never stated one will not
        match a print-run rule. Anything no tier matches is shown as{" "}
        <strong className="text-slate-400">Unassigned</strong> rather than being forced into a
        bucket — so you can see what your rules missed.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}
