"use client";

// CF-CATALOG-REVIEW-PAGE (Drew, 2026-08-08). Admin page for the two
// pending-review buckets: user-seeded catalog entries (from add-card /
// eBay import) and vendor-unmatched staging (from TCA/CH ingest that
// couldn't find a catalog match). Approve → verify + re-promote staged
// sales. Reject → delete / drop.

import { useCallback, useEffect, useState } from "react";
import {
  fetchCatalogReviewQueue,
  approveCatalogReview,
  rejectCatalogReview,
  type CatalogReviewItem,
} from "@/lib/adminApi";

type QueueType = "all" | "user-seeded" | "vendor-unmatched";

export default function CatalogReviewPage() {
  const [type, setType] = useState<QueueType>("all");
  const [items, setItems] = useState<CatalogReviewItem[]>([]);
  const [counts, setCounts] = useState<{ userSeeded: number; vendorUnmatched: number; total: number }>({ userSeeded: 0, vendorUnmatched: 0, total: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchCatalogReviewQueue(type, 100);
      setItems(r.items);
      setCounts(r.counts);
    } catch (e) {
      setError((e as Error)?.message ?? "Failed to load review queue");
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => { void load(); }, [load]);

  const onApprove = useCallback(async (item: CatalogReviewItem) => {
    setBusy((s) => ({ ...s, [item.slug]: true }));
    try {
      const r = await approveCatalogReview(item.slug, item.type);
      if (!r.ok) throw new Error(r.error ?? "approve failed");
      setItems((prev) => prev.filter((i) => i.slug !== item.slug));
    } catch (e) {
      setError((e as Error)?.message ?? "Approve failed");
    } finally {
      setBusy((s) => { const n = { ...s }; delete n[item.slug]; return n; });
    }
  }, []);

  const onReject = useCallback(async (item: CatalogReviewItem) => {
    if (!confirm(`Reject "${item.playerName ?? item.slug}"? This deletes the catalog entry (user-seeded) or drops the staged sales (vendor-unmatched).`)) return;
    setBusy((s) => ({ ...s, [item.slug]: true }));
    try {
      const r = await rejectCatalogReview(item.slug, item.type);
      if (!r.ok) throw new Error(r.error ?? "reject failed");
      setItems((prev) => prev.filter((i) => i.slug !== item.slug));
    } catch (e) {
      setError((e as Error)?.message ?? "Reject failed");
    } finally {
      setBusy((s) => { const n = { ...s }; delete n[item.slug]; return n; });
    }
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Catalog review</h1>
          <p className="text-sm text-[color:var(--color-text-muted)]">
            Cards waiting for admin confirmation. User-seeded from add-card &amp; eBay imports · Vendor-unmatched from TCA/CH ingest.
            Confirm against product checklists then approve or reject.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded border border-[color:var(--color-border)] px-3 py-1 text-sm disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <div className="text-sm text-red-500">Error: {error}</div>}

      {/* Counts */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <CountCard label="User-seeded" value={counts.userSeeded} active={type === "user-seeded"} onClick={() => setType("user-seeded")} />
        <CountCard label="Vendor-unmatched" value={counts.vendorUnmatched} active={type === "vendor-unmatched"} onClick={() => setType("vendor-unmatched")} />
        <CountCard label="All pending" value={counts.total} active={type === "all"} onClick={() => setType("all")} />
      </div>

      {/* Queue */}
      <div className="rounded-xl border border-[color:var(--color-border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-bg-subtle)] text-[color:var(--color-text-muted)] uppercase tracking-wide text-xs">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Type</th>
              <th className="text-left px-3 py-2 font-medium">Player</th>
              <th className="text-left px-3 py-2 font-medium">Year</th>
              <th className="text-left px-3 py-2 font-medium">Set / Card #</th>
              <th className="text-left px-3 py-2 font-medium">Parallel</th>
              <th className="text-left px-3 py-2 font-medium">Auto</th>
              <th className="text-left px-3 py-2 font-medium">Source</th>
              <th className="text-right px-3 py-2 font-medium">Staged</th>
              <th className="text-right px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && (
              <tr><td colSpan={9} className="px-3 py-8 text-center text-[color:var(--color-text-muted)]">Queue empty for the selected filter.</td></tr>
            )}
            {items.map((it) => (
              <tr key={it.slug} className="border-t border-[color:var(--color-border)]">
                <td className="px-3 py-2">
                  <span className={`inline-block rounded px-2 py-0.5 text-xs ${it.type === "user-seeded" ? "bg-blue-500/20 text-blue-500" : "bg-amber-500/20 text-amber-500"}`}>
                    {it.type === "user-seeded" ? "user" : "vendor"}
                  </span>
                </td>
                <td className="px-3 py-2 font-medium">{it.playerName ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums">{it.cardYear ?? "—"}</td>
                <td className="px-3 py-2">
                  <div>{it.setKey ?? it.setName ?? "—"}</div>
                  <div className="text-xs text-[color:var(--color-text-muted)]">#{it.cardNumber ?? "—"}</div>
                </td>
                <td className="px-3 py-2">{it.parallel ?? "base"}</td>
                <td className="px-3 py-2">{it.isAuto ? "Yes" : "—"}</td>
                <td className="px-3 py-2 text-xs text-[color:var(--color-text-muted)]">{it.source}</td>
                <td className="px-3 py-2 text-right tabular-nums">{it.stagedCompCount || "—"}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    onClick={() => void onApprove(it)}
                    disabled={busy[it.slug]}
                    className="rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-600 px-2 py-1 text-xs disabled:opacity-50 mr-1"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => void onReject(it)}
                    disabled={busy[it.slug]}
                    className="rounded bg-red-500/20 hover:bg-red-500/30 text-red-600 px-2 py-1 text-xs disabled:opacity-50"
                  >
                    Reject
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {items.length > 0 && items.some((i) => i.sampleTitles.length > 0) && (
        <div className="text-xs text-[color:var(--color-text-muted)]">
          Vendor-unmatched entries show a sample raw title — confirm the identity fields match the product checklist for that year/set before approving.
        </div>
      )}
    </div>
  );
}

function CountCard({ label, value, active, onClick }: { label: string; value: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-xl border p-4 text-left transition-colors ${
        active
          ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10"
          : "border-[color:var(--color-border)] bg-[color:var(--color-surface)] hover:border-[color:var(--color-accent)]"
      }`}
    >
      <div className="text-xs text-[color:var(--color-text-muted)] uppercase tracking-wide">{label}</div>
      <div className="text-3xl font-bold tabular-nums mt-1">{value.toLocaleString()}</div>
    </button>
  );
}
