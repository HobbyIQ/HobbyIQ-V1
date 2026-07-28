"use client";

// CF-UX-CLEANUP #4 (Drew, 2026-07-27). Add-a-card as a modal launched
// from Portfolio, matching the modal pattern used by Log expense +
// Log purchase. Previously a full page at /app/portfolio/add — that
// route now redirects here with ?add=1 so bookmarks + deep links
// keep working.
//
// Same 3-step flow the page had: search → pick candidate → fill
// details. Zero backend changes. Onboarding-checklist "Add your
// first card" still deep-links to /app/portfolio/add which lands
// with the modal auto-opened.

import Link from "next/link";
import { useState, type FormEvent } from "react";
import {
  addHolding,
  candidateIdToCardsightId,
  searchCards,
  type SearchCandidate,
  type SearchResponse,
} from "@/lib/api";

const GRADE_COMPANIES = ["PSA", "BGS", "SGC", "CGC"];
const GRADE_VALUES = [10, 9.5, 9, 8.5, 8, 7, 6, 5, 4, 3, 2, 1];

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

export function AddCardModal({ onClose, onAdded }: Props) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SearchCandidate | null>(null);
  const [saving, setSaving] = useState(false);

  const [quantity, setQuantity] = useState(1);
  const [purchasePrice, setPurchasePrice] = useState<string>("");
  const [purchaseDate, setPurchaseDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [gradeCompany, setGradeCompany] = useState<string>("");
  const [gradeValue, setGradeValue] = useState<string>("");
  const [notes, setNotes] = useState("");

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    setSelected(null);
    try {
      const res = await searchCards(q);
      setResults(res);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Search failed");
    } finally {
      setSearching(false);
    }
  }

  async function onSave() {
    if (!selected) return;
    const cardsightCardId = candidateIdToCardsightId(selected.candidateId) ?? undefined;
    setSaving(true);
    setError(null);
    try {
      const res = await addHolding({
        cardsightCardId,
        playerName: selected.player ?? undefined,
        cardTitle: selected.title,
        cardYear: selected.year ?? undefined,
        product: selected.setName ?? selected.brand ?? undefined,
        parallel: selected.parallel ?? undefined,
        cardNumber: selected.cardNumber ?? undefined,
        serialNumber: selected.serialNumber ?? undefined,
        isAuto: selected.isAuto,
        gradeCompany: gradeCompany || null,
        gradeValue: gradeValue ? Number(gradeValue) : null,
        quantity,
        purchasePrice: purchasePrice ? Number(purchasePrice) : undefined,
        purchaseDate,
        notes: notes.trim() || undefined,
      });
      if (res.success) {
        onAdded();
      } else {
        setError(res.error ?? "Failed to add holding");
      }
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 402) {
        setError("You've hit your holdings cap. Upgrade to add more cards.");
      } else {
        setError(e.message ?? "Failed to add holding");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="hiq-card p-6 max-w-3xl w-full max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold">Add a card</h2>
            <p className="text-xs mt-1" style={{ color: "var(--color-muted)" }}>
              Search first, then pick a match and fill in your grade + cost basis.
              Prefer bulk?{" "}
              <Link href="/app/portfolio/import" className="hover:underline" style={{ color: "var(--color-accent)" }}>
                Import CSV
              </Link>
              .
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-2xl leading-none hover:text-white"
            style={{ color: "var(--color-muted)" }}
          >
            ×
          </button>
        </div>

        {/* Step 1: Search */}
        <form onSubmit={onSearch} className="flex gap-2 mb-4">
          <input
            type="search"
            placeholder="e.g. 2018 Bowman Chrome Vlad Guerrero Jr."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)]"
            style={{
              background: "var(--color-bg)",
              borderColor: "var(--color-border)",
              color: "white",
            }}
            autoFocus
          />
          <button
            type="submit"
            disabled={searching || !query.trim()}
            className="hiq-btn-primary disabled:opacity-50 whitespace-nowrap"
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </form>

        {error && (
          <div
            className="rounded-lg p-3 mb-3 text-sm"
            style={{
              background: "color-mix(in oklab, var(--color-danger) 12%, transparent)",
              color: "var(--color-danger)",
            }}
          >
            {error}
          </div>
        )}

        {/* Step 2: Pick candidate */}
        {results && !selected && (
          <div className="space-y-2 mb-2">
            {results.candidates.length === 0 && (
              <div className="hiq-card p-6 text-sm text-[color:var(--color-muted)] text-center">
                No cards matched. Try broader keywords or a cert number.
              </div>
            )}
            {results.candidates.slice(0, 20).map((c) => (
              <button
                key={c.candidateId}
                onClick={() => setSelected(c)}
                className="w-full flex items-center gap-3 p-3 rounded-lg border text-left hover:bg-white/[0.02] transition-colors"
                style={{ borderColor: "var(--color-border)" }}
              >
                <div
                  className="w-11 h-14 rounded flex-shrink-0 overflow-hidden flex items-center justify-center"
                  style={{ background: "var(--color-bg)" }}
                >
                  {c.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.imageUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
                      <path d="M4 6h16v12H4V6z" />
                    </svg>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{c.title}</div>
                  <div className="text-xs text-[color:var(--color-muted)] mt-0.5">
                    {[c.year, c.setName ?? c.brand, c.cardNumber ? `#${c.cardNumber}` : null].filter(Boolean).join(" · ")}
                    {c.parallel && ` · ${c.parallel}`}
                  </div>
                </div>
                <div className="text-[color:var(--color-muted)] text-xs">Select →</div>
              </button>
            ))}
          </div>
        )}

        {/* Step 3: Fill in details */}
        {selected && (
          <div>
            <div className="flex items-center gap-3 mb-4 pb-4 border-b border-[color:var(--color-border)]">
              <div
                className="w-14 h-18 rounded flex-shrink-0 overflow-hidden flex items-center justify-center"
                style={{ background: "var(--color-bg)", height: 72 }}
              >
                {selected.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selected.imageUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
                    <path d="M4 6h16v12H4V6z" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold truncate">{selected.title}</div>
                <div className="text-xs text-[color:var(--color-muted)] mt-1">
                  {[selected.year, selected.setName ?? selected.brand, selected.cardNumber ? `#${selected.cardNumber}` : null].filter(Boolean).join(" · ")}
                </div>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="text-xs text-[color:var(--color-muted)] hover:text-white hover:underline"
              >
                Change
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <FormField label="Quantity">
                <input
                  type="number"
                  min={1}
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                  className={inputCls}
                />
              </FormField>
              <FormField label="Purchase price (USD)">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="0.00"
                  value={purchasePrice}
                  onChange={(e) => setPurchasePrice(e.target.value)}
                  className={inputCls}
                />
              </FormField>
              <FormField label="Purchase date">
                <input
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  className={inputCls}
                />
              </FormField>
              <FormField label="Grade company">
                <select
                  value={gradeCompany}
                  onChange={(e) => setGradeCompany(e.target.value)}
                  className={inputCls}
                >
                  <option value="">Raw (ungraded)</option>
                  {GRADE_COMPANIES.map((g) => (
                    <option key={g} value={g}>{g}</option>
                  ))}
                </select>
              </FormField>
              {gradeCompany && (
                <FormField label="Grade">
                  <select
                    value={gradeValue}
                    onChange={(e) => setGradeValue(e.target.value)}
                    className={inputCls}
                  >
                    <option value="">Choose grade…</option>
                    {GRADE_VALUES.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </FormField>
              )}
              <FormField label="Notes (optional)" wide>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className={`${inputCls} resize-y`}
                  placeholder="Cert #, storage location, source, etc."
                />
              </FormField>
            </div>

            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                onClick={() => setSelected(null)}
                className="hiq-btn-secondary"
                disabled={saving}
              >
                Back
              </button>
              <button
                onClick={onSave}
                disabled={saving}
                className="hiq-btn-primary disabled:opacity-50"
              >
                {saving ? "Adding…" : "Add to portfolio"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputCls =
  "w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)] " +
  "bg-[color:var(--color-bg)] border-[color:var(--color-border)] text-white disabled:opacity-50";

function FormField({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <label className="block text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-1.5 font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}
