"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchEbayStatus,
  prepareEbayListing,
  publishEbayListing,
  type EbayListingPrepared,
  type PortfolioHolding,
} from "@/lib/api";
import { formatUSD, formatCardTitle } from "@/lib/format";
import { EbayListModal } from "@/components/EbayListModal";

interface Props {
  holdings: PortfolioHolding[];
  onClose: () => void;
  onFinished?: (published: number) => void;
}

type RowStatus = "loading" | "ready" | "publishing" | "success" | "error";

interface RowState {
  holding: PortfolioHolding;
  prep: EbayListingPrepared | null;
  status: RowStatus;
  title: string;
  priceUsd: string;
  error?: string;
  offerId?: string;
  listingId?: string;
}

export function BulkEbayListModal({ holdings, onClose, onFinished }: Props) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [rows, setRows] = useState<RowState[]>(() =>
    holdings.map((h) => ({
      holding: h,
      prep: null,
      status: "loading" as RowStatus,
      title: "",
      priceUsd: "",
    })),
  );
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drillHoldingId, setDrillHoldingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const status = await fetchEbayStatus();
        if (cancelled) return;
        if (!status.connected) {
          setConnected(false);
          return;
        }
        setConnected(true);

        // Prep each holding sequentially — parallel would spam eBay's
        // sandbox and burn the shared client-token budget.
        for (let i = 0; i < holdings.length; i++) {
          if (cancelled) return;
          try {
            const prep = await prepareEbayListing(holdings[i].id);
            if (cancelled) return;
            setRows((prev) => {
              const next = [...prev];
              next[i] = {
                ...next[i],
                prep,
                title: prep.listing.titleSuggested,
                priceUsd:
                  prep.listing.priceCents > 0 ? (prep.listing.priceCents / 100).toFixed(2) : "",
                status: "ready",
              };
              return next;
            });
          } catch (err) {
            const e = err as { message?: string; status?: number };
            const msg = e.status === 402
              ? "Investor or Pro Seller plan required"
              : e.message ?? "Prepare failed";
            setRows((prev) => {
              const next = [...prev];
              next[i] = { ...next[i], status: "error", error: msg };
              return next;
            });
          }
        }
      } catch (err) {
        if (cancelled) return;
        const e = err as { message?: string };
        setError(e.message ?? "Failed to load eBay status");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [holdings]);

  function updateRow(idx: number, patch: Partial<RowState>) {
    setRows((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  async function onPublishAll() {
    if (publishing) return;
    setPublishing(true);
    setError(null);

    // Sequential — same reason as prepare above; also gives the user
    // an accurate per-row progress signal.
    let publishedCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.status !== "ready" || !r.prep) continue;
      const cents = Math.round(Number(r.priceUsd) * 100);
      if (!(cents > 0)) {
        updateRow(i, { status: "error", error: "Set a price" });
        continue;
      }
      updateRow(i, { status: "publishing" });
      try {
        const payload: EbayListingPrepared = {
          ...r.prep,
          listing: {
            ...r.prep.listing,
            titleSuggested: r.title.slice(0, 80),
            priceCents: cents,
          },
        };
        const res = await publishEbayListing(payload);
        if (!res.success || !res.offerId || !res.listingId) {
          updateRow(i, { status: "error", error: res.error ?? "eBay rejected" });
          continue;
        }
        updateRow(i, {
          status: "success",
          offerId: res.offerId,
          listingId: res.listingId,
        });
        publishedCount++;
      } catch (err) {
        const e = err as { message?: string };
        updateRow(i, { status: "error", error: e.message ?? "Publish failed" });
      }
    }
    setPublishing(false);
    if (publishedCount > 0) onFinished?.(publishedCount);
  }

  const readyCount = rows.filter((r) => r.status === "ready").length;
  const successCount = rows.filter((r) => r.status === "success").length;
  const errorCount = rows.filter((r) => r.status === "error").length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={publishing ? undefined : onClose}
    >
      <div
        className="hiq-card p-6 max-w-4xl w-full max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-2">
          <div>
            <h2 className="text-xl font-bold">List {holdings.length} on eBay</h2>
            <p className="text-xs text-[color:var(--color-muted)] mt-1">
              Review title + price per card. Publish all runs sequentially.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            disabled={publishing}
            className="text-[color:var(--color-muted)] hover:text-white text-2xl leading-none disabled:opacity-40"
          >
            ×
          </button>
        </div>

        {connected === false && (
          <div className="text-center py-8">
            <p className="text-sm text-[color:var(--color-muted)] mb-4">
              Connect your eBay account first.
            </p>
            <Link
              href="/app/ebay"
              className="hiq-btn-primary inline-block text-sm"
              onClick={onClose}
            >
              Go to eBay settings
            </Link>
          </div>
        )}

        {connected === true && (
          <>
            {error && (
              <div className="mb-4 text-sm" style={{ color: "var(--color-danger)" }}>
                {error}
              </div>
            )}

            <div className="mt-4 space-y-2">
              {rows.map((r, i) => (
                <BulkRow
                  key={r.holding.id}
                  row={r}
                  onChange={(p) => updateRow(i, p)}
                  disabled={publishing || r.status === "publishing" || r.status === "success"}
                  onOpenFullEditor={() => setDrillHoldingId(r.holding.id)}
                />
              ))}
            </div>

            <div className="mt-6 pt-4 border-t border-[color:var(--color-border)] flex items-center justify-between flex-wrap gap-3">
              <div className="text-xs text-[color:var(--color-muted)]">
                {readyCount} ready · {successCount} published · {errorCount} error
              </div>
              <div className="flex items-center gap-3">
                <button onClick={onClose} className="hiq-btn-secondary text-sm" disabled={publishing}>
                  {successCount > 0 && !publishing ? "Done" : "Cancel"}
                </button>
                <button
                  onClick={onPublishAll}
                  disabled={publishing || readyCount === 0}
                  className="hiq-btn-primary text-sm disabled:opacity-40"
                >
                  {publishing ? "Publishing…" : `Publish ${readyCount}`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {drillHoldingId && (
        <EbayListModal
          holdingId={drillHoldingId}
          onClose={() => setDrillHoldingId(null)}
          onPublished={(offerId, listingId) => {
            const idx = rows.findIndex((r) => r.holding.id === drillHoldingId);
            if (idx !== -1) {
              updateRow(idx, { status: "success", offerId, listingId });
            }
            setDrillHoldingId(null);
          }}
        />
      )}
    </div>
  );
}

function BulkRow({
  row,
  onChange,
  disabled,
  onOpenFullEditor,
}: {
  row: RowState;
  onChange: (patch: Partial<RowState>) => void;
  disabled: boolean;
  onOpenFullEditor: () => void;
}) {
  const h = row.holding;

  return (
    <div className="hiq-card p-3" style={{ background: "var(--color-bg)" }}>
      <div className="flex items-start gap-3">
        <div className="w-12 h-12 rounded flex-shrink-0 overflow-hidden flex items-center justify-center" style={{ background: "var(--color-bg-elevated, #000)" }}>
          {h.photos && h.photos[0] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={h.photos[0]} alt="" className="w-full h-full object-cover" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-[color:var(--color-muted)]">
              <path d="M4 6h16v12H4V6z" />
            </svg>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate mb-2">{formatCardTitle(h)}</div>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_100px] gap-2">
            <input
              value={row.title}
              onChange={(e) => onChange({ title: e.target.value })}
              maxLength={80}
              disabled={disabled || row.status === "loading" || row.status === "error"}
              placeholder={row.status === "loading" ? "Loading…" : row.status === "error" ? "—" : "Listing title"}
              className={inputCls}
            />
            <input
              type="number"
              min={0}
              step="0.01"
              value={row.priceUsd}
              onChange={(e) => onChange({ priceUsd: e.target.value })}
              disabled={disabled || row.status === "loading" || row.status === "error"}
              placeholder={h.fairMarketValue ? formatUSD(h.fairMarketValue, { hideCents: true }).replace("$", "") : "0.00"}
              className={inputCls}
            />
          </div>
          <div className="mt-1.5 text-xs flex items-center gap-2 flex-wrap">
            <StatusPill status={row.status} />
            {row.error && (
              <span style={{ color: "var(--color-danger)" }}>{row.error}</span>
            )}
            {row.status === "success" && row.offerId && (
              <span className="text-[color:var(--color-muted)]">
                offer {row.offerId.slice(0, 12)}…
              </span>
            )}
            {row.status === "ready" && row.prep && row.prep.photos.length === 0 && (
              <span style={{ color: "var(--color-accent)" }}>Add a photo before publishing</span>
            )}
            {(row.status === "ready" || row.status === "error") && (
              <button
                type="button"
                onClick={onOpenFullEditor}
                disabled={disabled}
                className="ml-auto text-[color:var(--color-accent)] hover:underline disabled:opacity-40"
              >
                Review all fields →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: RowStatus }) {
  const label = status === "loading" ? "Preparing…" : status === "publishing" ? "Publishing…" : status;
  const color =
    status === "success" ? "var(--color-success)" :
    status === "error" ? "var(--color-danger)" :
    status === "ready" ? "var(--color-accent)" :
    "var(--color-muted)";
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide"
      style={{
        background: `color-mix(in oklab, ${color} 15%, transparent)`,
        color,
      }}
    >
      {label}
    </span>
  );
}

const inputCls =
  "px-2.5 py-1.5 rounded-md border text-sm outline-none focus:border-[color:var(--color-accent)] " +
  "bg-black border-[color:var(--color-border)] text-white disabled:opacity-60";
