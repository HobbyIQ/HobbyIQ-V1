"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  prepareEbayListing,
  publishEbayListing,
  fetchEbayStatus,
  type EbayListingPrepared,
} from "@/lib/api";

interface Props {
  holdingId: string;
  onClose: () => void;
  onPublished?: (offerId: string, listingId: string) => void;
}

// Review-and-publish flow for one holding.
//   1. GET /ebay/status → if not connected, direct to /app/ebay.
//   2. POST /ebay/listings/prepare → prefilled payload + validation.
//   3. User adjusts title/price/description → POST /ebay/listings/publish.
export function EbayListModal({ holdingId, onClose, onPublished }: Props) {
  const [prep, setPrep] = useState<EbayListingPrepared | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [publishedOffer, setPublishedOffer] = useState<{ offerId: string; listingId: string } | null>(null);

  const [title, setTitle] = useState("");
  const [priceUsd, setPriceUsd] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await fetchEbayStatus();
        if (cancelled) return;
        if (!status.connected) {
          setConnected(false);
          setLoading(false);
          return;
        }
        setConnected(true);
        const p = await prepareEbayListing(holdingId);
        if (cancelled) return;
        setPrep(p);
        setTitle(p.listing.titleSuggested);
        setPriceUsd(p.listing.priceCents > 0 ? (p.listing.priceCents / 100).toFixed(2) : "");
        setDescription(p.listing.description);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        const e = err as { message?: string; status?: number };
        if (e.status === 402) {
          setError("eBay listing requires the Investor or Pro Seller plan.");
        } else {
          setError(e.message ?? "Failed to prepare listing");
        }
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [holdingId]);

  async function onPublish() {
    if (!prep) return;
    const cents = Math.round(Number(priceUsd) * 100);
    if (!(cents > 0)) {
      setError("Enter a positive listing price.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload: EbayListingPrepared = {
        ...prep,
        listing: {
          ...prep.listing,
          titleSuggested: title.slice(0, 80),
          priceCents: cents,
          description,
        },
      };
      const res = await publishEbayListing(payload);
      if (!res.success || !res.offerId || !res.listingId) {
        setError(res.error ?? "eBay rejected the listing.");
        setSubmitting(false);
        return;
      }
      setPublishedOffer({ offerId: res.offerId, listingId: res.listingId });
      onPublished?.(res.offerId, res.listingId);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Publish failed.");
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="hiq-card p-6 max-w-xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <h2 className="text-xl font-bold">List on eBay</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-[color:var(--color-muted)] hover:text-white transition-colors"
          >
            ×
          </button>
        </div>

        {loading && (
          <div className="text-sm text-[color:var(--color-muted)] py-6 text-center">
            Preparing draft…
          </div>
        )}

        {!loading && connected === false && (
          <div className="text-center py-6">
            <p className="text-sm text-[color:var(--color-muted)] mb-4">
              Connect your eBay account first — one auth gets listing + sales sync.
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

        {!loading && publishedOffer && (
          <div className="text-center py-6">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3"
              style={{ background: "color-mix(in oklab, var(--color-success) 15%, transparent)" }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ color: "var(--color-success)" }}>
                <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div className="font-bold mb-1">Published on eBay</div>
            <div className="text-xs text-[color:var(--color-muted)] mb-4 break-all">
              Offer {publishedOffer.offerId} · Listing {publishedOffer.listingId}
            </div>
            <button onClick={onClose} className="hiq-btn-primary text-sm">Done</button>
          </div>
        )}

        {!loading && prep && !publishedOffer && (
          <>
            {prep.validation.requiredMissing.length > 0 && (
              <div className="hiq-card p-3 mb-4 text-xs" style={{
                background: "color-mix(in oklab, var(--color-danger) 10%, transparent)",
                color: "var(--color-danger)",
              }}>
                <div className="font-medium mb-1">Missing before eBay accepts:</div>
                <ul className="list-disc list-inside space-y-0.5">
                  {prep.validation.requiredMissing.map((m) => <li key={m}>{m}</li>)}
                </ul>
              </div>
            )}
            {prep.validation.warnings.length > 0 && (
              <div className="hiq-card p-3 mb-4 text-xs" style={{
                background: "color-mix(in oklab, var(--color-accent) 10%, transparent)",
                color: "var(--color-accent)",
              }}>
                <ul className="list-disc list-inside space-y-0.5">
                  {prep.validation.warnings.map((m, i) => <li key={i}>{m}</li>)}
                </ul>
              </div>
            )}

            <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium block mb-1">
              Title (max 80)
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={80}
              className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)] mb-1"
              style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
            />
            <div className="text-[10px] text-[color:var(--color-muted)] mb-4 text-right tabular-nums">
              {title.length} / 80
            </div>

            <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium block mb-1">
              Price (USD)
            </label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={priceUsd}
              onChange={(e) => setPriceUsd(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)] mb-4"
              style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
            />

            <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium block mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)] mb-4 resize-y"
              style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
            />

            <div className="text-xs text-[color:var(--color-muted)] mb-4">
              {prep.photos.length > 0
                ? `${prep.photos.length} photo${prep.photos.length === 1 ? "" : "s"} from holding will be attached.`
                : "No photos on holding — add photos to the holding before publishing."}
            </div>

            {error && (
              <div className="text-sm mb-4" style={{ color: "var(--color-danger)" }}>
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={onClose}
                className="hiq-btn-secondary text-sm"
                disabled={submitting}
              >
                Cancel
              </button>
              <button
                onClick={onPublish}
                disabled={submitting || !prep.validation.readyToPublish || prep.photos.length === 0}
                className="hiq-btn-primary text-sm disabled:opacity-40"
              >
                {submitting ? "Publishing…" : "Publish to eBay"}
              </button>
            </div>
          </>
        )}

        {!loading && !prep && error && !publishedOffer && connected !== false && (
          <div className="text-sm py-4" style={{ color: "var(--color-danger)" }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
