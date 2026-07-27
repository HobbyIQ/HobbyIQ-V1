"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  fetchExpenses,
  createExpense,
  deleteExpense,
  EXPENSE_CATEGORIES,
  type ExpenseEntry,
  type ExpenseCategory,
} from "@/lib/api";
import { formatUSD, formatUSDCompact } from "@/lib/format";

export default function ExpensesPage() {
  const [entries, setEntries] = useState<ExpenseEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<"none" | "upsell" | "error">("none");
  const [error, setError] = useState<string | null>(null);
  const [yearFilter, setYearFilter] = useState<number | "all">("all");
  const [catFilter, setCatFilter] = useState<ExpenseCategory | "all">("all");
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchExpenses()
      .then((res) => {
        if (cancelled) return;
        setEntries(res);
        setLoading(false);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 402 || err.status === 403) {
          setGate("upsell");
        } else {
          setGate("error");
          setError(err.message ?? "Failed to load expenses");
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const years = useMemo(() => {
    const s = new Set<number>();
    for (const e of entries) {
      const y = Number(e.date.slice(0, 4));
      if (Number.isFinite(y)) s.add(y);
    }
    return Array.from(s).sort((a, b) => b - a);
  }, [entries]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (yearFilter !== "all") {
        const y = Number(e.date.slice(0, 4));
        if (y !== yearFilter) return false;
      }
      if (catFilter !== "all" && e.category !== catFilter) return false;
      return true;
    });
  }, [entries, yearFilter, catFilter]);

  const total = filtered.reduce((s, e) => s + e.amount, 0);
  const totalYtd = entries
    .filter((e) => e.date.slice(0, 4) === String(new Date().getFullYear()))
    .reduce((s, e) => s + e.amount, 0);
  const totalAllTime = entries.reduce((s, e) => s + e.amount, 0);

  const byCategory = useMemo(() => {
    const map = new Map<ExpenseCategory, number>();
    for (const e of filtered) {
      map.set(e.category, (map.get(e.category) ?? 0) + e.amount);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [filtered]);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading expenses…</div>
      </div>
    );
  }

  if (gate === "upsell") {
    return <UpsellCard />;
  }

  if (gate === "error") {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <h1 className="text-3xl font-bold mb-1">Expenses</h1>
        <div className="hiq-card p-6 mt-6 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <Link href="/app/erp" className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors mb-6 inline-block">
        ← Back to ERP
      </Link>
      <div className="mb-8 flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold mb-1">Expenses</h1>
          <p className="text-sm text-[color:var(--color-muted)]">
            Deductible operating costs — supplies, shipping, grading, subscriptions.
          </p>
        </div>
        <button onClick={() => setAddOpen(true)} className="hiq-btn-primary text-sm">
          + Log expense
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <MiniStat label={`YTD (${new Date().getFullYear()})`} value={formatUSDCompact(totalYtd)} />
        <MiniStat label="Filtered total" value={formatUSDCompact(total)} />
        <MiniStat label="All-time" value={formatUSDCompact(totalAllTime)} />
      </div>

      {/* Filters */}
      <div className="mt-4 flex items-center gap-3 flex-wrap mb-6">
        <select
          value={yearFilter === "all" ? "all" : String(yearFilter)}
          onChange={(e) => {
            const v = e.target.value;
            setYearFilter(v === "all" ? "all" : Number(v));
          }}
          className={filterCls}
        >
          <option value="all">All years</option>
          {years.map((y) => (
            <option key={y} value={String(y)}>{y}</option>
          ))}
        </select>
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value as ExpenseCategory | "all")}
          className={filterCls}
        >
          <option value="all">All categories</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>

      {byCategory.length > 0 && (
        <div className="hiq-card p-4 mb-6">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-3">
            By category (filtered)
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            {byCategory.map(([cat, amt]) => (
              <div key={cat} className="flex items-baseline justify-between gap-2">
                <span className="text-[color:var(--color-muted)] truncate">
                  {labelForCategory(cat)}
                </span>
                <span className="tabular-nums font-medium">
                  {formatUSD(amt, { hideCents: true })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="hiq-card p-8 text-center">
          <p className="text-sm text-[color:var(--color-muted)]">
            {entries.length === 0
              ? "No expenses logged yet."
              : "No expenses match the current filters."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => (
            <ExpenseRow
              key={e.id}
              e={e}
              onDelete={async () => {
                if (!confirm("Delete this expense?")) return;
                try {
                  await deleteExpense(e.id);
                  setEntries((prev) => prev.filter((x) => x.id !== e.id));
                } catch (err) {
                  alert("Delete failed: " + ((err as { message?: string }).message ?? "unknown"));
                }
              }}
            />
          ))}
        </div>
      )}

      {addOpen && (
        <AddExpenseModal
          onCancel={() => setAddOpen(false)}
          onSaved={(e) => {
            setEntries((prev) => [e, ...prev]);
            setAddOpen(false);
          }}
        />
      )}
    </div>
  );
}

function labelForCategory(c: ExpenseCategory): string {
  return EXPENSE_CATEGORIES.find((x) => x.value === c)?.label ?? c;
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hiq-card p-4">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-1">
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function ExpenseRow({ e, onDelete }: { e: ExpenseEntry; onDelete: () => void }) {
  return (
    <div className="hiq-card p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <div className="font-medium text-sm">{labelForCategory(e.category)}</div>
          {e.categoryNote && (
            <span className="text-xs text-[color:var(--color-muted)]">· {e.categoryNote}</span>
          )}
        </div>
        <div className="text-xs text-[color:var(--color-muted)] mt-1 flex items-center gap-3 flex-wrap">
          <span>{e.date}</span>
          {e.note && <span className="truncate max-w-[280px]">{e.note}</span>}
          {e.receiptRef && (
            <span className="text-[color:var(--color-accent)] truncate max-w-[200px]">
              receipt {e.receiptRef}
            </span>
          )}
        </div>
      </div>
      <div className="text-right flex-shrink-0 ml-3">
        <div className="text-sm font-medium tabular-nums">
          {formatUSD(e.amount, { hideCents: e.amount >= 100 })}
        </div>
      </div>
      <button
        onClick={onDelete}
        className="text-xs text-[color:var(--color-muted)] hover:text-white transition-colors flex-shrink-0"
        aria-label="Delete expense"
      >
        Remove
      </button>
    </div>
  );
}

function AddExpenseModal({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: (e: ExpenseEntry) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [category, setCategory] = useState<ExpenseCategory>("supplies");
  const [categoryNote, setCategoryNote] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [note, setNote] = useState("");
  const [receiptRef, setReceiptRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setError(null);
    const n = Number(amount);
    if (!(Number.isFinite(n) && n > 0)) {
      setError("Enter a positive amount.");
      return;
    }
    if (category === "other" && !categoryNote.trim()) {
      setError("Describe the expense in \"Detail\" when category is Other.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await createExpense({
        category,
        amount: n,
        date,
        categoryNote: categoryNote.trim() || undefined,
        note: note.trim() || undefined,
        receiptRef: receiptRef.trim() || undefined,
      });
      onSaved(created);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Save failed.");
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onCancel}
    >
      <div
        className="hiq-card p-6 max-w-lg w-full max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-xl font-bold">Log expense</h2>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="text-[color:var(--color-muted)] hover:text-white text-2xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelCls}>Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              className={inputCls}
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Amount ($)</label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={inputCls}
              autoFocus
            />
          </div>
          <div>
            <label className={labelCls}>Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>
              Detail{category === "other" ? " (required)" : ""}
            </label>
            <input
              value={categoryNote}
              onChange={(e) => setCategoryNote(e.target.value)}
              placeholder="e.g. Card savers 8-count"
              className={inputCls}
            />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Note (optional)</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className={`${inputCls} resize-y`}
            />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Receipt URL / reference (optional)</label>
            <input
              value={receiptRef}
              onChange={(e) => setReceiptRef(e.target.value)}
              placeholder="drive.google.com/… or invoice #"
              className={inputCls}
            />
          </div>
        </div>

        {error && (
          <div className="mt-4 text-sm" style={{ color: "var(--color-danger)" }}>
            {error}
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button onClick={onCancel} className="hiq-btn-secondary" disabled={submitting}>
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={submitting}
            className="hiq-btn-primary disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save expense"}
          </button>
        </div>
      </div>
    </div>
  );
}

function UpsellCard() {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <div className="hiq-card p-8 text-center">
        <h1 className="text-2xl font-bold mb-3">Expenses is a Pro Seller feature</h1>
        <p className="text-[color:var(--color-muted)] mb-6">
          Log deductible expenses, tag receipts, and roll them into tax exports.
        </p>
        <Link href="/pricing" className="hiq-btn-primary inline-block">
          See Pro Seller pricing
        </Link>
      </div>
    </div>
  );
}

const labelCls =
  "text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium block mb-1.5";
const inputCls =
  "w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)] " +
  "bg-[color:var(--color-bg)] border-[color:var(--color-border)] text-white";
const filterCls =
  "px-3 py-2 rounded-xl border text-sm outline-none " +
  "bg-[color:var(--color-bg)] border-[color:var(--color-border)] text-white";
