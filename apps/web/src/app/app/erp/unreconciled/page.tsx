"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchUnreconciled,
  saveUnreconciledCosts,
  type UnreconciledEntry,
  type UnreconciledListResponse,
} from "@/lib/api";
import { formatUSD, formatUSDCompact } from "@/lib/format";

export default function UnreconciledQueuePage() {
  const [data, setData] = useState<UnreconciledListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<"none" | "upsell" | "error">("none");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchUnreconciled()
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setLoading(false);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        if (err.status === 402 || err.status === 403) setGate("upsell");
        else {
          setGate("error");
          setError(err.message ?? "Failed to load queue");
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function onEntryUpdated(next: UnreconciledEntry) {
    setData((prev) => {
      if (!prev) return prev;
      const filtered = prev.entries.filter((e) => e.id !== next.id);
      // If the entry finalized (needsReconciliation went false), it drops
      // out of the queue entirely. Otherwise keep it in the list with
      // fresh state.
      if (next.needsReconciliation === false) {
        return {
          ...prev,
          entries: filtered,
          counts: {
            ...prev.counts,
            unreconciledTotal: Math.max(0, prev.counts.unreconciledTotal - 1),
          },
        };
      }
      return { ...prev, entries: [next, ...filtered] };
    });
  }

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-6 py-8">
        <div className="text-sm text-[color:var(--color-muted)]">Loading queue…</div>
      </div>
    );
  }
  if (gate === "upsell") return <UpsellCard />;
  if (gate === "error" || !data) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-8">
        <Link href="/app/erp" className="text-sm text-[color:var(--color-muted)] hover:text-white transition-colors mb-6 inline-block">
          ← Back to Financials
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
        ← Back to Financials
      </Link>
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">Reconciliation queue</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          eBay sales that need supplies / grading cost input before they're
          included in P&amp;L totals and tax exports.
        </p>
      </div>

      {data.entries.length === 0 ? (
        <div className="hiq-card p-8 text-center">
          <div
            className="w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ background: "color-mix(in oklab, var(--color-success) 12%, transparent)" }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: "var(--color-success)" }}>
              <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h2 className="text-xl font-bold mb-2">All caught up</h2>
          <p className="text-sm text-[color:var(--color-muted)]">
            No eBay sales waiting for you.
            {data.counts.dismissedHidden > 0 && (
              <> {data.counts.dismissedHidden} dismissed row{data.counts.dismissedHidden === 1 ? " is" : "s are"} hidden but still excluded from totals.</>
            )}
          </p>
        </div>
      ) : (
        <>
          <div className="hiq-card p-4 mb-5 text-sm flex items-center justify-between flex-wrap gap-2"
            style={{
              background: "color-mix(in oklab, var(--color-accent) 6%, transparent)",
              color: "var(--color-accent)",
            }}
          >
            <div>
              <strong>{data.entries.length}</strong> sale{data.entries.length === 1 ? "" : "s"} awaiting your input · excluded from P&amp;L until reconciled
            </div>
            {data.counts.dismissedHidden > 0 && (
              <div className="text-xs text-[color:var(--color-muted)]">
                +{data.counts.dismissedHidden} dismissed
              </div>
            )}
          </div>

          <div className="space-y-3">
            {data.entries.map((e) => (
              <UnreconciledRow key={e.id} e={e} onSaved={onEntryUpdated} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function UnreconciledRow({ e, onSaved }: { e: UnreconciledEntry; onSaved: (next: UnreconciledEntry) => void }) {
  const [gradingCost, setGradingCost] = useState<string>(e.gradingCost != null ? String(e.gradingCost) : "");
  const [suppliesCost, setSuppliesCost] = useState<string>(e.suppliesCost != null ? String(e.suppliesCost) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const feesMissing = e.missingFields.filter((f) => f !== "gradingCost" && f !== "suppliesCost");
  const feesReady = feesMissing.length === 0;

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const body: { gradingCost?: number | null; suppliesCost?: number | null } = {};
      const g = gradingCost.trim();
      const s = suppliesCost.trim();
      body.gradingCost = g === "" ? 0 : Number(g);
      body.suppliesCost = s === "" ? 0 : Number(s);
      if (!Number.isFinite(body.gradingCost as number) || (body.gradingCost as number) < 0) {
        setError("Grading cost must be a non-negative number.");
        setSaving(false);
        return;
      }
      if (!Number.isFinite(body.suppliesCost as number) || (body.suppliesCost as number) < 0) {
        setError("Supplies cost must be a non-negative number.");
        setSaving(false);
        return;
      }
      const res = await saveUnreconciledCosts(e.id, body);
      if (!res.success) {
        setError("Save failed.");
        setSaving(false);
        return;
      }
      onSaved(res.entry);
    } catch (err) {
      setError((err as { message?: string }).message ?? "Save failed.");
      setSaving(false);
    }
  }

  return (
    <div className="hiq-card p-5">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-sm">{e.cardTitle}</div>
          <div className="text-xs text-[color:var(--color-muted)] mt-1 flex items-center gap-3 flex-wrap">
            <span>{e.soldAt.slice(0, 10)}</span>
            <span>qty {e.quantitySold}</span>
            {e.ebayOrderId && <span>eBay order {e.ebayOrderId.slice(0, 12)}…</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-bold tabular-nums">
            {formatUSD(e.grossProceeds, { hideCents: e.grossProceeds >= 100 })}
          </div>
          <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted)]">Gross</div>
        </div>
      </div>

      {/* Missing fields summary */}
      {!feesReady && (
        <div className="hiq-card p-2 mb-3 text-xs" style={{
          background: "color-mix(in oklab, var(--color-accent) 10%, transparent)",
          color: "var(--color-accent)",
        }}>
          Waiting on {feesMissing.length} fee field{feesMissing.length === 1 ? "" : "s"} from eBay:{" "}
          {feesMissing.map(prettyField).join(", ")}
        </div>
      )}

      {/* Cost inputs */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
        <div>
          <label className={labelCls}>Grading cost ($)</label>
          <input
            type="number" min={0} step="0.01"
            value={gradingCost}
            onChange={(ev) => setGradingCost(ev.target.value)}
            className={inputCls}
            placeholder="0.00"
            disabled={saving}
          />
        </div>
        <div>
          <label className={labelCls}>Supplies cost ($)</label>
          <input
            type="number" min={0} step="0.01"
            value={suppliesCost}
            onChange={(ev) => setSuppliesCost(ev.target.value)}
            className={inputCls}
            placeholder="0.00"
            disabled={saving}
          />
        </div>
        <button
          onClick={onSave}
          disabled={saving}
          className="hiq-btn-primary text-sm disabled:opacity-50 min-h-[42px]"
        >
          {saving ? "Saving…" : feesReady ? "Save + finalize" : "Save costs"}
        </button>
      </div>

      {error && (
        <div className="mt-3 text-xs" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {e.costsStatus === "saved_pending_fees" && (
        <div className="mt-3 text-xs text-[color:var(--color-muted)]">
          Costs already saved — will finalize automatically when eBay reports remaining fees.
        </div>
      )}
    </div>
  );
}

function prettyField(k: string): string {
  switch (k) {
    case "finalValueFee": return "final value fee";
    case "paymentProcessingFee": return "payment processing";
    case "promotedListingFee": return "promoted listing";
    case "adFee": return "ad fee";
    case "otherFees": return "other fees";
    case "netPayout": return "net payout";
    case "actualShippingCost": return "actual shipping";
    default: return k;
  }
}

function UpsellCard() {
  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      <div className="hiq-card p-8 text-center">
        <h1 className="text-2xl font-bold mb-3">Reconciliation is a Pro Seller feature</h1>
        <p className="text-[color:var(--color-muted)] mb-6">
          Match eBay sales to portfolio cards, edit fees and costs per sale.
        </p>
        <Link href="/pricing" className="hiq-btn-primary inline-block">
          See Pro Seller pricing
        </Link>
      </div>
    </div>
  );
}

const labelCls = "text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium block mb-1.5";
const inputCls = "w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)] bg-[color:var(--color-bg)] border-[color:var(--color-border)] text-white";
