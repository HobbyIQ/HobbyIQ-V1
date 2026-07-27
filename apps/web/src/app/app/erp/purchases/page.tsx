"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  fetchPurchases,
  createPurchase,
  importEbayPurchases,
  type PurchaseEntry,
  type PurchasesListResponse,
  type EbayImportSummary,
} from "@/lib/api";
import { formatUSD, formatUSDCompact } from "@/lib/format";

type SourceFilter = "all" | "manual" | "ebay";

export default function PurchasesPage() {
  const [data, setData] = useState<PurchasesListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [gate, setGate] = useState<"none" | "upsell" | "error">("none");
  const [error, setError] = useState<string | null>(null);
  const [yearFilter, setYearFilter] = useState<number | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  function reload() {
    fetchPurchases()
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (err.status === 402 || err.status === 403) setGate("upsell");
        else {
          setGate("error");
          setError(err.message ?? "Failed to load purchases");
        }
        setLoading(false);
      });
  }

  useEffect(() => {
    let cancelled = false;
    fetchPurchases()
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
          setError(err.message ?? "Failed to load purchases");
        }
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const years = useMemo(() => {
    if (!data) return [] as number[];
    const s = new Set<number>();
    for (const p of data.purchases) {
      const y = Number(p.purchaseDate.slice(0, 4));
      if (Number.isFinite(y)) s.add(y);
    }
    return Array.from(s).sort((a, b) => b - a);
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [] as PurchaseEntry[];
    return data.purchases.filter((p) => {
      if (yearFilter !== "all") {
        const y = Number(p.purchaseDate.slice(0, 4));
        if (y !== yearFilter) return false;
      }
      if (sourceFilter !== "all" && p.source !== sourceFilter) return false;
      return true;
    });
  }, [data, yearFilter, sourceFilter]);

  const filteredTotal = filtered.reduce((s, p) => s + (p.totalCost ?? 0), 0);

  if (loading) return <div className="max-w-6xl mx-auto px-6 py-8"><div className="text-sm text-[color:var(--color-muted)]">Loading purchases…</div></div>;
  if (gate === "upsell") return <UpsellCard />;
  if (gate === "error" || !data) {
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
          <h1 className="text-3xl font-bold mb-1">Purchases</h1>
          <p className="text-sm text-[color:var(--color-muted)]">
            Acquisition ledger — every buy with tax, shipping, and other fees
            split out. All-time cost {formatUSDCompact(data.totals.totalCost)}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setImportOpen(true)} className="hiq-btn-secondary text-sm">
            Import from eBay
          </button>
          <button onClick={() => setAddOpen(true)} className="hiq-btn-primary text-sm">
            + Log purchase
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <MiniStat label="Purchases" value={data.totals.count.toLocaleString()} />
        <MiniStat label="Subtotal" value={formatUSDCompact(data.totals.subtotal)} />
        <MiniStat label="Shipping + tax + fees" value={formatUSDCompact(data.totals.shipping + data.totals.tax + data.totals.otherFees)} />
        <MiniStat label="Total cost" value={formatUSDCompact(data.totals.totalCost)} />
      </div>

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
          {years.map((y) => <option key={y} value={String(y)}>{y}</option>)}
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
          className={filterCls}
        >
          <option value="all">All sources</option>
          <option value="manual">Manual</option>
          <option value="ebay">eBay</option>
        </select>
        <div className="text-xs text-[color:var(--color-muted)] ml-auto">
          {filtered.length} shown · {formatUSDCompact(filteredTotal)}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="hiq-card p-8 text-center">
          <p className="text-sm text-[color:var(--color-muted)]">
            {data.purchases.length === 0
              ? "No purchases logged yet."
              : "No purchases match the current filters."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((p) => <PurchaseRow key={p.id} p={p} />)}
        </div>
      )}

      {addOpen && (
        <AddPurchaseModal
          onCancel={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            reload();
          }}
        />
      )}
      {importOpen && (
        <EbayImportModal
          onCancel={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function EbayImportModal({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: () => void;
}) {
  const [days, setDays] = useState<30 | 60 | 90>(30);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<EbayImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
    setRunning(true);
    setError(null);
    try {
      const res = await importEbayPurchases(days);
      setSummary(res);
    } catch (err) {
      const e = err as { message?: string; status?: number };
      if (e.status === 400 && e.message?.toLowerCase().includes("ebay")) {
        setError("Connect your eBay account first at /app/ebay.");
      } else {
        setError(e.message ?? "Import failed.");
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={running ? undefined : onCancel}
    >
      <div
        className="hiq-card p-6 max-w-lg w-full max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="text-xl font-bold">Import from eBay</h2>
            <p className="text-xs text-[color:var(--color-muted)] mt-1">
              Pulls your eBay buy history for the selected window and creates
              purchase records with tax, shipping, and fee splits.
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close"
            disabled={running}
            className="text-[color:var(--color-muted)] hover:text-white text-2xl leading-none disabled:opacity-40"
          >
            ×
          </button>
        </div>

        {!summary ? (
          <>
            <div className="mb-4">
              <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium block mb-1.5">
                Window
              </label>
              <div className="flex items-center gap-2">
                {([30, 60, 90] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDays(d)}
                    disabled={running}
                    className="px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-40"
                    style={{
                      background: d === days ? "var(--hiq-electric-blue)" : "transparent",
                      color: d === days ? "var(--hiq-pure-white)" : "var(--hiq-muted-text)",
                      border: `1px solid ${d === days ? "var(--hiq-electric-blue)" : "var(--hiq-border)"}`,
                    }}
                  >
                    {d} days
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-[color:var(--color-muted)] mt-2">
                eBay caps buy-history windows at 90 days. Re-run monthly to keep
                your ledger current. Idempotent — replays skip anything already
                imported.
              </p>
            </div>

            {error && (
              <div className="mb-4 text-sm" style={{ color: "var(--color-danger)" }}>
                {error}
              </div>
            )}

            <div className="mt-6 flex items-center justify-end gap-2">
              <button onClick={onCancel} className="hiq-btn-secondary text-sm" disabled={running}>
                Cancel
              </button>
              <button onClick={onRun} disabled={running} className="hiq-btn-primary text-sm disabled:opacity-50">
                {running ? "Importing…" : `Import last ${days} days`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <SummaryTile label="eBay orders fetched" value={String(summary.fetched)} />
              <SummaryTile label="Newly imported" value={String(summary.imported)} tint="var(--hiq-success-green)" />
              <SummaryTile label="Already on file" value={String(summary.replayHits)} />
              <SummaryTile label="Skipped / errors" value={String(summary.skipped + summary.errors)} />
              <SummaryTile
                label="Holdings auto-created"
                value={String(summary.holdingsCreated)}
                tint="var(--hiq-hobby-green)"
              />
              <SummaryTile
                label="Holdings needs review"
                value={String(summary.holdingsNeedingReview)}
                tint="var(--hiq-warning)"
              />
            </div>
            <div className="hiq-tile-flat text-sm mb-4">
              <div className="flex justify-between">
                <span className="text-[color:var(--color-muted)]">Total spent in window</span>
                <span className="tabular-nums font-medium">
                  ${summary.totalCost.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              {summary.ebayTotalReported != null && (
                <div className="flex justify-between mt-1 text-xs text-[color:var(--color-muted)]">
                  <span>eBay-reported total</span>
                  <span className="tabular-nums">
                    ${summary.ebayTotalReported.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </div>
              )}
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <button onClick={onDone} className="hiq-btn-primary text-sm">Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryTile({ label, value, tint }: { label: string; value: string; tint?: string }) {
  return (
    <div className="hiq-tile-flat">
      <div className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-1">
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums" style={tint ? { color: tint } : undefined}>
        {value}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="hiq-card p-4">
      <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium mb-1">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function PurchaseRow({ p }: { p: PurchaseEntry }) {
  const extras = (p.tax ?? 0) + (p.shipping ?? 0) + (p.otherFees ?? 0);
  return (
    <div className="hiq-card p-4 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <div className="font-medium text-sm truncate">
            {p.vendor || (p.source === "ebay" ? "eBay purchase" : "Purchase")}
          </div>
          <span
            className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide"
            style={{
              background: p.source === "ebay"
                ? "color-mix(in oklab, var(--color-accent) 15%, transparent)"
                : "var(--color-bg)",
              color: p.source === "ebay" ? "var(--color-accent)" : "var(--color-muted)",
            }}
          >
            {p.source}
          </span>
          {p.holdingIds.length > 0 && (
            <span className="text-xs text-[color:var(--color-muted)]">
              · {p.holdingIds.length} card{p.holdingIds.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="text-xs text-[color:var(--color-muted)] mt-1 flex items-center gap-3 flex-wrap">
          <span>{p.purchaseDate.slice(0, 10)}</span>
          {p.invoiceRef && <span>ref {p.invoiceRef}</span>}
          {extras > 0 && (
            <span>+ {formatUSD(extras, { hideCents: true })} tax/ship/fees</span>
          )}
        </div>
        {p.notes && (
          <div className="text-xs text-[color:var(--color-muted)] mt-1 truncate max-w-md">
            {p.notes}
          </div>
        )}
      </div>
      <div className="text-right flex-shrink-0 ml-3">
        <div className="text-sm font-medium tabular-nums">
          {formatUSD(p.totalCost, { hideCents: p.totalCost >= 100 })}
        </div>
      </div>
    </div>
  );
}

function AddPurchaseModal({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [purchaseDate, setPurchaseDate] = useState(today);
  const [vendor, setVendor] = useState("");
  const [subtotal, setSubtotal] = useState("");
  const [tax, setTax] = useState("");
  const [shipping, setShipping] = useState("");
  const [otherFees, setOtherFees] = useState("");
  const [invoiceRef, setInvoiceRef] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total =
    (Number(subtotal) || 0) +
    (Number(tax) || 0) +
    (Number(shipping) || 0) +
    (Number(otherFees) || 0);

  async function onConfirm() {
    setError(null);
    const sub = Number(subtotal);
    if (!(Number.isFinite(sub) && sub > 0)) {
      setError("Enter a subtotal greater than 0.");
      return;
    }
    setSubmitting(true);
    try {
      await createPurchase({
        purchaseDate,
        source: "manual",
        subtotal: sub,
        tax: Number(tax) || 0,
        shipping: Number(shipping) || 0,
        otherFees: Number(otherFees) || 0,
        vendor: vendor.trim() || undefined,
        invoiceRef: invoiceRef.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onSaved();
    } catch (err) {
      setError((err as { message?: string }).message ?? "Save failed.");
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
          <h2 className="text-xl font-bold">Log purchase</h2>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="text-[color:var(--color-muted)] hover:text-white text-2xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className={labelCls}>Vendor / seller</label>
            <input
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              className={inputCls}
              placeholder="e.g. LCS name, breaker, eBay seller X"
              autoFocus
            />
          </div>
          <div>
            <label className={labelCls}>Date paid</label>
            <input
              type="date"
              value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Invoice ref (optional)</label>
            <input
              value={invoiceRef}
              onChange={(e) => setInvoiceRef(e.target.value)}
              className={inputCls}
              placeholder="Order # or invoice"
            />
          </div>
          <div>
            <label className={labelCls}>Subtotal ($)</label>
            <input
              type="number" min={0} step="0.01"
              value={subtotal} onChange={(e) => setSubtotal(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>Tax ($)</label>
            <input
              type="number" min={0} step="0.01"
              value={tax} onChange={(e) => setTax(e.target.value)}
              className={inputCls}
              placeholder="0"
            />
          </div>
          <div>
            <label className={labelCls}>Shipping ($)</label>
            <input
              type="number" min={0} step="0.01"
              value={shipping} onChange={(e) => setShipping(e.target.value)}
              className={inputCls}
              placeholder="0"
            />
          </div>
          <div>
            <label className={labelCls}>Other fees ($)</label>
            <input
              type="number" min={0} step="0.01"
              value={otherFees} onChange={(e) => setOtherFees(e.target.value)}
              className={inputCls}
              placeholder="0"
            />
          </div>
          <div className="col-span-2">
            <label className={labelCls}>Notes (optional)</label>
            <textarea
              value={notes} onChange={(e) => setNotes(e.target.value)}
              rows={2} className={`${inputCls} resize-y`}
            />
          </div>
        </div>

        {total > 0 && (
          <div className="hiq-card p-3 mt-4 flex items-center justify-between text-sm" style={{ background: "var(--color-bg)" }}>
            <span className="text-[color:var(--color-muted)]">Total cost</span>
            <span className="font-medium tabular-nums">{formatUSD(total, { hideCents: false })}</span>
          </div>
        )}

        {error && (
          <div className="mt-4 text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button onClick={onCancel} className="hiq-btn-secondary" disabled={submitting}>Cancel</button>
          <button onClick={onConfirm} disabled={submitting} className="hiq-btn-primary disabled:opacity-50">
            {submitting ? "Saving…" : "Save purchase"}
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
        <h1 className="text-2xl font-bold mb-3">Purchases is a Pro Seller feature</h1>
        <p className="text-[color:var(--color-muted)] mb-6">
          Track every buy with tax + shipping + other fees split out. Roll costs
          into cost-basis on the cards this purchase acquired.
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
const filterCls = "px-3 py-2 rounded-xl border text-sm outline-none bg-[color:var(--color-bg)] border-[color:var(--color-border)] text-white";
