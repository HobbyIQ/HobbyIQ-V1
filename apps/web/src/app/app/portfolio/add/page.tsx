"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  searchCards,
  candidateIdToCardsightId,
  addHolding,
  type SearchCandidate,
  type SearchResponse,
} from "@/lib/api";

const GRADE_COMPANIES = ["PSA", "BGS", "SGC", "CGC"];
const GRADE_VALUES = [10, 9.5, 9, 8.5, 8, 7, 6, 5, 4, 3, 2, 1];

export default function AddCardPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SearchCandidate | null>(null);
  const [saving, setSaving] = useState(false);

  // form state
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
        router.push("/app/portfolio");
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
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-6">
        <Link
          href="/app/portfolio"
          className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors"
        >
          ← Back to portfolio
        </Link>
      </div>
      <h1 className="text-3xl font-bold mb-2">Add a card</h1>
      <p className="text-sm text-[color:var(--color-muted)] mb-8">
        Search for the card first, then fill in your grade and what you paid.
      </p>

      {/* Step 1: Search */}
      <form onSubmit={onSearch} className="flex gap-3 mb-6">
        <input
          type="search"
          placeholder="e.g. 2018 Bowman Chrome Vlad Guerrero Jr."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 px-4 py-3 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
          style={{
            background: "var(--color-bg)",
            borderColor: "var(--color-border)",
            color: "white",
          }}
          autoFocus
        />
        <button type="submit" disabled={searching || !query.trim()} className="hiq-btn-primary disabled:opacity-50 whitespace-nowrap">
          {searching ? "Searching…" : "Search"}
        </button>
      </form>

      {error && (
        <div className="hiq-card p-4 mb-4 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {/* Step 2: Pick candidate */}
      {results && !selected && (
        <div className="space-y-2 mb-8">
          {results.candidates.length === 0 && (
            <div className="hiq-card p-6 text-sm text-[color:var(--color-muted)] text-center">
              No cards matched. Try broader keywords.
            </div>
          )}
          {results.candidates.map((c) => (
            <button
              key={c.candidateId}
              onClick={() => setSelected(c)}
              className="w-full hiq-card p-4 flex items-center gap-4 text-left hover:bg-white/[0.02] transition-colors"
            >
              <div className="w-14 h-14 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center" style={{ background: "var(--color-bg)" }}>
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
                <div className="text-xs text-[color:var(--color-muted)] mt-0.5">
                  {[c.year, c.setName ?? c.brand, c.cardNumber ? `#${c.cardNumber}` : null].filter(Boolean).join(" · ")}
                  {c.parallel && ` · ${c.parallel}`}
                </div>
              </div>
              <div className="text-[color:var(--color-muted)] text-sm">Select →</div>
            </button>
          ))}
        </div>
      )}

      {/* Step 3: Fill in details */}
      {selected && (
        <div className="hiq-card p-6">
          <div className="flex items-center gap-4 mb-6 pb-6 border-b border-[color:var(--color-border)]">
            <div className="w-16 h-16 rounded-lg flex-shrink-0 overflow-hidden flex items-center justify-center" style={{ background: "var(--color-bg)" }}>
              {selected.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={selected.imageUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
                  <path d="M4 6h16v12H4V6zm2 2v8h12V8H6zm2 2h4v4H8v-4z" />
                </svg>
              )}
            </div>
            <div className="flex-1">
              <div className="font-medium">{selected.title}</div>
              <div className="text-xs text-[color:var(--color-muted)] mt-1">
                {[selected.year, selected.setName ?? selected.brand, selected.cardNumber ? `#${selected.cardNumber}` : null].filter(Boolean).join(" · ")}
              </div>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-sm text-[color:var(--color-muted)] hover:text-white"
            >
              Change
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <FormField label="Quantity">
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                className="w-full px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
                style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
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
                className="w-full px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
                style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
              />
            </FormField>
            <FormField label="Purchase date">
              <input
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
                style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
              />
            </FormField>
            <FormField label="Grade company (optional)">
              <select
                value={gradeCompany}
                onChange={(e) => setGradeCompany(e.target.value)}
                className="w-full px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
                style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
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
                  className="w-full px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)]"
                  style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
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
                rows={3}
                className="w-full px-4 py-2.5 rounded-xl border text-sm outline-none focus:border-[color:var(--color-accent)] resize-none"
                style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
                placeholder="Cert #, storage location, source, etc."
              />
            </FormField>
          </div>

          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              onClick={() => setSelected(null)}
              className="hiq-btn-secondary"
              disabled={saving}
            >
              Cancel
            </button>
            <button onClick={onSave} disabled={saving} className="hiq-btn-primary disabled:opacity-50">
              {saving ? "Adding…" : "Add to portfolio"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FormField({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "md:col-span-2" : ""}>
      <label className="block text-xs uppercase tracking-wide text-[color:var(--color-muted)] mb-2 font-medium">
        {label}
      </label>
      {children}
    </div>
  );
}
