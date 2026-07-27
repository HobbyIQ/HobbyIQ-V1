"use client";

import { useState } from "react";
import { regradeHolding, type PortfolioHolding } from "@/lib/api";
import { formatUSD } from "@/lib/format";

interface Props {
  holding: PortfolioHolding;
  onCancel: () => void;
  onSaved: (h: PortfolioHolding) => void;
}

// Dedicated flow for "I sent this card in and got it back graded."
// Distinct from the Edit modal because it does one atomic operation:
//   1. Sets the new grade + cert #
//   2. Adds the grading fee to totalCostBasis (so P&L reflects true
//      all-in cost)
//   3. Emits a "regrade" point on the price history chart
//
// Backend endpoint: POST /api/portfolio/holdings/:id/regrade
export function RegradeModal({ holding, onCancel, onSaved }: Props) {
  const [gradeCompany, setGradeCompany] = useState("PSA");
  const [gradeValue, setGradeValue] = useState("");
  const [certNumber, setCertNumber] = useState("");
  const [gradingCost, setGradingCost] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const oldBasis = holding.totalCostBasis ?? holding.purchasePrice ?? 0;
  const newBasisPreview = oldBasis + Number(gradingCost || 0);

  async function onConfirm() {
    setError(null);
    const gv = Number(gradeValue);
    if (!(Number.isFinite(gv) && gv > 0 && gv <= 10)) {
      setError("Grade must be between 1 and 10.");
      return;
    }
    const gc = gradingCost.trim() === "" ? 0 : Number(gradingCost);
    if (!(Number.isFinite(gc) && gc >= 0)) {
      setError("Grading cost can't be negative.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await regradeHolding(holding.id, {
        gradeCompany: gradeCompany.trim() || "PSA",
        gradeValue: gv,
        certNumber: certNumber.trim() || null,
        gradingCost: gc,
      });
      if (!res.success || !res.holding) {
        setError(res.message ?? "Regrade failed");
        setSubmitting(false);
        return;
      }
      onSaved(res.holding);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Regrade failed");
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
        className="hiq-card p-6 max-w-lg w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-2">
          <h2 className="text-xl font-bold">Mark as graded</h2>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="text-[color:var(--color-muted)] hover:text-white text-2xl leading-none"
          >
            ×
          </button>
        </div>
        <p className="text-xs text-[color:var(--color-muted)] mb-6">
          Sent it in and got it back? Set the grade and roll the grading fee
          into your total paid so P&amp;L stays honest.
        </p>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium block mb-1.5">
              Grader
            </label>
            <select
              value={gradeCompany}
              onChange={(e) => setGradeCompany(e.target.value)}
              className={inputCls}
            >
              <option value="PSA">PSA</option>
              <option value="BGS">BGS</option>
              <option value="SGC">SGC</option>
              <option value="CGC">CGC</option>
            </select>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium block mb-1.5">
              Grade
            </label>
            <input
              type="number"
              min={0}
              max={10}
              step="0.5"
              value={gradeValue}
              onChange={(e) => setGradeValue(e.target.value)}
              className={inputCls}
              autoFocus
              placeholder="10"
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium block mb-1.5">
              Cert # (optional)
            </label>
            <input
              value={certNumber}
              onChange={(e) => setCertNumber(e.target.value)}
              className={inputCls}
              placeholder="e.g. 12345678"
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium block mb-1.5">
              Grading cost ($)
            </label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={gradingCost}
              onChange={(e) => setGradingCost(e.target.value)}
              className={inputCls}
              placeholder="0.00"
            />
          </div>
        </div>

        {/* Cost roll-in preview */}
        <div className="hiq-card p-3 mt-4 text-xs" style={{ background: "var(--color-bg)" }}>
          <div className="flex justify-between text-[color:var(--color-muted)]">
            <span>Currently paid</span>
            <span className="tabular-nums text-white">{formatUSD(oldBasis, { hideCents: false })}</span>
          </div>
          <div className="flex justify-between text-[color:var(--color-muted)] mt-1">
            <span>+ Grading cost</span>
            <span className="tabular-nums text-white">{formatUSD(Number(gradingCost || 0), { hideCents: false })}</span>
          </div>
          <div className="flex justify-between mt-1 pt-1 border-t border-[color:var(--color-border)] font-medium">
            <span>New total paid</span>
            <span className="tabular-nums">{formatUSD(newBasisPreview, { hideCents: false })}</span>
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
            {submitting ? "Saving…" : "Confirm graded"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)] " +
  "bg-[color:var(--color-bg)] border-[color:var(--color-border)] text-white";
