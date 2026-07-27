"use client";

import { useState } from "react";
import { updateHolding, type PortfolioHolding } from "@/lib/api";
import { formatUSD, formatCardTitle } from "@/lib/format";

interface Props {
  holdings: PortfolioHolding[];
  onClose: () => void;
  onDone: (updatedCount: number) => void;
}

type FieldMode = "unchanged" | "set" | "add";

type RowStatus = "idle" | "saving" | "success" | "error";
interface RowState {
  holding: PortfolioHolding;
  status: RowStatus;
  error?: string;
}

// Batch cost-basis editor. For each selected card, choose whether to
// - leave a field unchanged (default)
// - SET the field to a given value (overwrites)
// - ADD a delta to the existing value (bumps)
//
// Purchase price + purchase date + notes are all treated the same way
// as single-holding Edit — they're just applied to every selected row
// sequentially via PATCH.
export function BulkCostBasisModal({ holdings, onClose, onDone }: Props) {
  const [priceMode, setPriceMode] = useState<FieldMode>("unchanged");
  const [priceValue, setPriceValue] = useState("");
  const [dateMode, setDateMode] = useState<FieldMode>("unchanged");
  const [dateValue, setDateValue] = useState("");
  const [rows, setRows] = useState<RowState[]>(() =>
    holdings.map((h) => ({ holding: h, status: "idle" as RowStatus })),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  async function onApply() {
    setError(null);

    if (priceMode === "unchanged" && dateMode === "unchanged") {
      setError("Pick at least one field to update.");
      return;
    }

    let priceNum: number | null = null;
    if (priceMode !== "unchanged") {
      const n = Number(priceValue);
      if (!(Number.isFinite(n) && n >= 0)) {
        setError("Enter a non-negative purchase price.");
        return;
      }
      priceNum = n;
    }
    if (dateMode === "set" && !dateValue) {
      setError("Pick a purchase date.");
      return;
    }

    setSubmitting(true);
    let successCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      setRows((prev) => {
        const next = [...prev];
        next[i] = { ...next[i], status: "saving" };
        return next;
      });

      const h = r.holding;
      const patch: Record<string, unknown> = { quantity: h.quantity };

      if (priceMode === "set" && priceNum !== null) {
        patch.purchasePrice = priceNum;
      } else if (priceMode === "add" && priceNum !== null) {
        const current = h.purchasePrice ?? 0;
        patch.purchasePrice = current + priceNum;
      }

      if (dateMode === "set" && dateValue) {
        patch.purchaseDate = dateValue;
      }

      try {
        const res = await updateHolding(h.id, patch);
        if (!res.success) {
          setRows((prev) => {
            const next = [...prev];
            next[i] = { ...next[i], status: "error", error: res.message ?? "Update failed" };
            return next;
          });
          continue;
        }
        setRows((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: "success" };
          return next;
        });
        successCount++;
      } catch (err) {
        setRows((prev) => {
          const next = [...prev];
          next[i] = { ...next[i], status: "error", error: (err as { message?: string }).message ?? "Update failed" };
          return next;
        });
      }
    }

    setSubmitting(false);
    setFinished(true);
    onDone(successCount);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={submitting ? undefined : onClose}
    >
      <div
        className="hiq-card p-6 max-w-3xl w-full max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold">Update {holdings.length} cost bas{holdings.length === 1 ? "is" : "es"}</h2>
            <p className="text-xs text-[color:var(--color-muted)] mt-1">
              Pick which field to update and how. Applied sequentially per card.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            disabled={submitting}
            className="text-[color:var(--color-muted)] hover:text-white text-2xl leading-none disabled:opacity-40"
          >
            ×
          </button>
        </div>

        <div className="space-y-4 mb-5">
          <FieldEditor
            label="Purchase price"
            mode={priceMode}
            onModeChange={setPriceMode}
            value={priceValue}
            onValueChange={setPriceValue}
            inputType="number"
            hint={priceMode === "add" ? "Adds to each card's current purchase price" : priceMode === "set" ? "Overwrites current purchase price" : undefined}
          />
          <FieldEditor
            label="Purchase date"
            mode={dateMode}
            onModeChange={setDateMode}
            value={dateValue}
            onValueChange={setDateValue}
            inputType="date"
            addDisabled
          />
        </div>

        <div className="border-t border-[color:var(--color-border)] pt-4">
          <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-2">
            Cards ({holdings.length})
          </div>
          <div className="space-y-1 max-h-48 overflow-y-auto pr-2">
            {rows.map((r) => (
              <div
                key={r.holding.id}
                className="flex items-center justify-between gap-3 text-xs py-1"
              >
                <div className="flex-1 min-w-0 truncate">{formatCardTitle(r.holding)}</div>
                <div className="text-[color:var(--color-muted)] tabular-nums flex-shrink-0">
                  {r.holding.purchasePrice != null ? formatUSD(r.holding.purchasePrice, { hideCents: true }) : "—"}
                </div>
                <StatusPill status={r.status} error={r.error} />
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="mt-4 text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="hiq-btn-secondary"
            disabled={submitting}
          >
            {finished ? "Close" : "Cancel"}
          </button>
          <button
            onClick={onApply}
            disabled={submitting || finished}
            className="hiq-btn-primary disabled:opacity-40"
          >
            {submitting ? "Applying…" : finished ? "Done" : "Apply to all"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldEditor({
  label,
  mode,
  onModeChange,
  value,
  onValueChange,
  inputType,
  hint,
  addDisabled,
}: {
  label: string;
  mode: FieldMode;
  onModeChange: (m: FieldMode) => void;
  value: string;
  onValueChange: (v: string) => void;
  inputType: "number" | "date";
  hint?: string;
  addDisabled?: boolean;
}) {
  return (
    <div className="hiq-card p-4" style={{ background: "var(--color-bg)" }}>
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div className="font-medium text-sm">{label}</div>
        <div className="flex items-center gap-1 text-xs">
          {(["unchanged", "set", ...(addDisabled ? [] : ["add" as const])] as FieldMode[]).map((m) => (
            <button
              key={m}
              onClick={() => onModeChange(m)}
              className="px-2 py-1 rounded font-medium capitalize"
              style={{
                background: mode === m ? "var(--color-accent)" : "transparent",
                color: mode === m ? "var(--color-bg)" : "var(--color-muted)",
              }}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {mode !== "unchanged" && (
        <>
          <input
            type={inputType}
            {...(inputType === "number" ? { min: 0, step: "0.01", placeholder: "0.00" } : {})}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)] bg-black border-[color:var(--color-border)] text-white"
          />
          {hint && <div className="text-[10px] text-[color:var(--color-muted)] mt-2">{hint}</div>}
        </>
      )}
    </div>
  );
}

function StatusPill({ status, error }: { status: RowStatus; error?: string }) {
  if (status === "idle") return <span className="w-4 h-4 flex-shrink-0" />;
  if (status === "saving") return <span className="text-[color:var(--color-muted)] text-[10px]">…</span>;
  if (status === "success") return <span style={{ color: "var(--color-success)" }} className="text-[10px]">✓</span>;
  return (
    <span title={error} style={{ color: "var(--color-danger)" }} className="text-[10px]">
      ✕
    </span>
  );
}
