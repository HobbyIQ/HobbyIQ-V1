"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchTaxFiling,
  upsertTaxFiling,
  accountingExportUrl,
  TAX_FILING_RAILS,
  type TaxFilingReport,
  type TaxFilingRail,
  type RailReconciliation,
} from "@/lib/api";
import { formatUSD, formatUSDCompact, formatPct } from "@/lib/format";

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2, CURRENT_YEAR - 3];

interface RailInputState {
  reported: string;
  note: string;
}

export default function TaxPage() {
  const [year, setYear] = useState<number>(CURRENT_YEAR);
  const [report, setReport] = useState<TaxFilingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<"none" | "upsell" | "error">("none");
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<TaxFilingRail, RailInputState>>({
    ebay: { reported: "", note: "" },
    paypal: { reported: "", note: "" },
    venmo: { reported: "", note: "" },
  });
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSaveNote(null);
    fetchTaxFiling(year)
      .then((res) => {
        if (cancelled) return;
        setReport(res);
        setInputs({
          ebay: railInputFor(res.rails, "ebay"),
          paypal: railInputFor(res.rails, "paypal"),
          venmo: railInputFor(res.rails, "venmo"),
        });
        setLoading(false);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 402 || err.status === 403) {
          setGate("upsell");
        } else {
          setGate("error");
          setError(err.message ?? "Failed to load tax filing");
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  async function onSave() {
    setSaving(true);
    setError(null);
    setSaveNote(null);
    try {
      const rails: Partial<Record<TaxFilingRail, { reportedGross1099K: number; note?: string }>> = {};
      for (const rail of ["ebay", "paypal", "venmo"] as TaxFilingRail[]) {
        const raw = inputs[rail].reported.trim();
        if (raw === "") continue;
        const n = Number(raw);
        if (!(Number.isFinite(n) && n >= 0)) {
          setError(`${labelForRail(rail)}: enter a non-negative number.`);
          setSaving(false);
          return;
        }
        rails[rail] = {
          reportedGross1099K: n,
          ...(inputs[rail].note.trim() ? { note: inputs[rail].note.trim() } : {}),
        };
      }
      const next = await upsertTaxFiling(year, rails);
      setReport(next);
      setSaveNote("Saved.");
    } catch (err) {
      setError((err as { message?: string }).message ?? "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading tax filing…</div>
      </div>
    );
  }

  if (gate === "upsell") {
    return <UpsellCard />;
  }

  if (gate === "error" || !report) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link href="/app/erp" className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors mb-6 inline-block">
          ← Back to ERP
        </Link>
        <div className="hiq-card p-6 mt-4 text-sm" style={{ color: "var(--color-danger)" }}>
          {error ?? "Failed to load."}
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
          <h1 className="text-3xl font-bold mb-1">Tax filings</h1>
          <p className="text-sm text-[color:var(--color-muted)]">
            Reconcile the 1099-K each rail sent you against what your ledger
            recorded. Delta = what you need to reconcile or dispute.
          </p>
        </div>
        <select
          value={String(year)}
          onChange={(e) => setYear(Number(e.target.value))}
          className={selectCls}
        >
          {YEAR_OPTIONS.map((y) => (
            <option key={y} value={String(y)}>{y}</option>
          ))}
        </select>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <MiniStat label={`Ledger gross ${year}`} value={formatUSDCompact(report.totals.ledgerGross)} />
        <MiniStat
          label="Reported (1099-K)"
          value={report.totals.reported1099K != null ? formatUSDCompact(report.totals.reported1099K) : "—"}
        />
        <MiniStat
          label="Delta"
          value={report.totals.delta != null ? formatUSDCompact(report.totals.delta) : "—"}
          color={deltaColorOf(report.totals.delta)}
          sub={report.totals.delta != null && report.totals.ledgerGross > 0
            ? formatPct((report.totals.delta / report.totals.ledgerGross) * 100)
            : undefined}
        />
      </div>

      {/* Rails */}
      <div className="space-y-3 mb-6">
        {report.rails.map((r) => (
          <RailCard
            key={r.rail}
            rail={r}
            input={inputs[r.rail]}
            onChange={(next) => setInputs((prev) => ({ ...prev, [r.rail]: next }))}
          />
        ))}
      </div>

      {error && (
        <div className="mb-4 text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>
      )}
      {saveNote && (
        <div className="mb-4 text-sm" style={{ color: "var(--color-success)" }}>{saveNote}</div>
      )}

      <div className="flex items-center justify-between flex-wrap gap-3 mb-8">
        <div className="text-xs text-[color:var(--color-muted)]">
          {report.updatedAt ? `Last saved ${report.updatedAt.slice(0, 10)}` : "Not saved yet"}
        </div>
        <button
          onClick={onSave}
          disabled={saving}
          className="hiq-btn-primary text-sm disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save reconciliation"}
        </button>
      </div>

      {/* Accounting export */}
      <div className="hiq-card p-5">
        <h2 className="font-bold text-lg mb-2">Accounting export</h2>
        <p className="text-sm text-[color:var(--color-muted)] mb-4 leading-relaxed">
          Download every reconciled sale and expense in {year} as a
          QuickBooks / Xero-friendly CSV. Only includes ledger entries with
          all fees + user costs filled in — unreconciled rows are excluded so
          the export never misstates your books.
        </p>
        <a
          href={accountingExportUrl({
            from: `${year}-01-01`,
            to: `${year}-12-31`,
            format: "csv",
          })}
          className="hiq-btn-secondary text-sm inline-block"
          target="_blank"
          rel="noopener"
        >
          Download {year} CSV
        </a>
      </div>
    </div>
  );
}

function railInputFor(rails: RailReconciliation[], target: TaxFilingRail): RailInputState {
  const r = rails.find((x) => x.rail === target);
  return {
    reported: r?.reported1099K != null ? String(r.reported1099K) : "",
    note: r?.note ?? "",
  };
}

function labelForRail(r: TaxFilingRail): string {
  return TAX_FILING_RAILS.find((x) => x.value === r)?.label ?? r;
}

function deltaColorOf(n: number | null): string | undefined {
  if (n == null) return undefined;
  if (Math.abs(n) < 0.005) return "var(--color-success)";
  return "var(--color-accent)";
}

function MiniStat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="hiq-card p-4">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-1">
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="text-xs mt-1 tabular-nums" style={color ? { color } : undefined}>{sub}</div>}
    </div>
  );
}

function RailCard({
  rail,
  input,
  onChange,
}: {
  rail: RailReconciliation;
  input: RailInputState;
  onChange: (next: RailInputState) => void;
}) {
  const delta = rail.delta;
  return (
    <div className="hiq-card p-5">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="font-bold text-lg">{labelForRail(rail.rail)}</h2>
          <div className="text-xs text-[color:var(--color-muted)] mt-1">
            {rail.ledgerEntryCount} ledger sale{rail.ledgerEntryCount === 1 ? "" : "s"}
            {rail.unreconciledExcluded > 0 && (
              <span style={{ color: "var(--color-accent)" }}>
                {" "}
                · {rail.unreconciledExcluded} unreconciled excluded
              </span>
            )}
          </div>
        </div>
        {delta != null && (
          <div className="text-right">
            <div className="text-xs text-[color:var(--color-muted)] uppercase tracking-wide">Delta</div>
            <div className="text-lg font-bold tabular-nums" style={{ color: deltaColorOf(delta) }}>
              {formatUSDCompact(delta)}
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div>
          <label className={labelCls}>Ledger gross</label>
          <div className="px-3 py-2 text-sm tabular-nums font-medium">
            {formatUSD(rail.ledgerGross, { hideCents: rail.ledgerGross >= 100 })}
          </div>
        </div>
        <div>
          <label className={labelCls}>Reported 1099-K</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={input.reported}
            onChange={(e) => onChange({ ...input, reported: e.target.value })}
            placeholder="0.00"
            className={inputCls}
          />
        </div>
        <div className="md:col-span-1">
          <label className={labelCls}>Note</label>
          <input
            value={input.note}
            onChange={(e) => onChange({ ...input, note: e.target.value })}
            placeholder="Optional — form 1099-K reference, etc."
            className={inputCls}
          />
        </div>
      </div>
    </div>
  );
}

function UpsellCard() {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <div className="hiq-card p-8 text-center">
        <h1 className="text-2xl font-bold mb-3">Tax filings is a Pro Seller feature</h1>
        <p className="text-[color:var(--color-muted)] mb-6">
          Reconcile 1099-K forms across eBay, PayPal, and Venmo. Export a
          Schedule D-friendly CSV. Never miss a deduction.
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
  "bg-[color:var(--color-bg)] border-[color:var(--color-border)] text-white tabular-nums";
const selectCls =
  "px-3 py-2.5 rounded-xl border text-sm outline-none " +
  "bg-[color:var(--color-bg)] border-[color:var(--color-border)] text-white";
