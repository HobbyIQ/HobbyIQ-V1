"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  prepareEbayListing,
  publishEbayListing,
  reviseEbayListing,
  fetchEbayStatus,
  uploadHoldingPhoto,
  type EbayListingPrepared,
  type EbaySellSignal,
} from "@/lib/api";

interface Props {
  holdingId: string;
  onClose: () => void;
  onPublished?: (offerId: string, listingId: string) => void;
  // Optional: when set, the modal opens in "revise" mode and PUT
  // /listings/:offerId/revise on submit instead of publishing.
  reviseOfferId?: string;
}

// Full-fidelity review-and-publish for one holding. Surfaces every field
// the backend /listings/prepare returns so nothing gets edited only
// server-side. Sections mirror the payload shape:
//   1. Listing basics   — title / price / qty / description
//   2. Card identity    — playerName / year / set / parallel / number /
//                          isAuto / isRookie / team / sport
//   3. Condition        — grader / grade / cert# / raw condition
//   4. Category aspects — league / type / country / year manufactured /
//                          season / language
//   5. Photos           — reorder + add + remove
//   6. Advanced         — best-offer + description-full editor
export function EbayListModal({ holdingId, onClose, onPublished, reviseOfferId }: Props) {
  const isRevise = !!reviseOfferId;
  const [prep, setPrep] = useState<EbayListingPrepared | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [publishedOffer, setPublishedOffer] = useState<{ offerId: string; listingId: string } | null>(null);

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
    if (prep.listing.priceCents <= 0) {
      setError("Enter a positive listing price.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = isRevise
        ? await reviseEbayListing(reviseOfferId as string, prep)
        : await publishEbayListing(prep);
      if (isRevise) {
        // Revise returns just success; there's no new offerId. Close on success.
        if (!res.success) {
          setError(res.error ?? "eBay rejected the revision.");
          setSubmitting(false);
          return;
        }
        onPublished?.(reviseOfferId as string, "");
        onClose();
        return;
      }
      if (!res.success || !res.offerId || !res.listingId) {
        const missing = res.requiredMissing?.length
          ? ` Missing: ${res.requiredMissing.join(", ")}.`
          : "";
        setError((res.error ?? "eBay rejected the listing.") + missing);
        setSubmitting(false);
        return;
      }
      setPublishedOffer({ offerId: res.offerId, listingId: res.listingId });
      onPublished?.(res.offerId, res.listingId);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? (isRevise ? "Revise failed." : "Publish failed."));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={submitting ? undefined : onClose}
    >
      <div
        className="hiq-card p-6 max-w-4xl w-full max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold">{isRevise ? "Revise eBay listing" : "List on eBay"}</h2>
            <p className="text-xs text-[color:var(--color-muted)] mt-1">
              {isRevise
                ? "Update your live listing. Changes push to eBay on save."
                : "Review every field before publishing. Anything you leave alone posts as-is from the holding."}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            disabled={submitting}
            className="text-[color:var(--color-muted)] hover:text-white transition-colors text-2xl leading-none disabled:opacity-40"
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
          <ListingEditor
            prep={prep}
            onChange={setPrep}
            onPublish={onPublish}
            onCancel={onClose}
            submitting={submitting}
            error={error}
            submitLabel={isRevise ? "Save revision" : "Publish to eBay"}
            submitLoadingLabel={isRevise ? "Saving…" : "Publishing…"}
          />
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

function ListingEditor({
  prep,
  onChange,
  onPublish,
  onCancel,
  submitting,
  submitLabel = "Publish to eBay",
  submitLoadingLabel = "Publishing…",
  error,
}: {
  prep: EbayListingPrepared;
  onChange: (next: EbayListingPrepared) => void;
  onPublish: () => void;
  onCancel: () => void;
  submitting: boolean;
  submitLabel?: string;
  submitLoadingLabel?: string;
  error: string | null;
}) {
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const listing = prep.listing;
  const identity = prep.identity;
  const condition = prep.condition;
  const aspects = prep.categoryAspects;

  function updateListing(patch: Partial<EbayListingPrepared["listing"]>) {
    onChange({ ...prep, listing: { ...prep.listing, ...patch } });
  }
  function updateIdentity(patch: Partial<EbayListingPrepared["identity"]>) {
    onChange({ ...prep, identity: { ...prep.identity, ...patch } });
  }
  function updateCondition(patch: Partial<EbayListingPrepared["condition"]>) {
    onChange({ ...prep, condition: { ...prep.condition, ...patch } });
  }
  function updateAspects(patch: Partial<EbayListingPrepared["categoryAspects"]>) {
    onChange({ ...prep, categoryAspects: { ...prep.categoryAspects, ...patch } });
  }
  function updatePhotos(next: string[]) {
    onChange({ ...prep, photos: next });
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingPhoto(true);
    try {
      const url = await uploadHoldingPhoto(file);
      updatePhotos([...(prep.photos ?? []), url]);
    } catch {
      // Silent — errors surface as photos-missing in validation
    } finally {
      setUploadingPhoto(false);
    }
  }

  function movePhoto(idx: number, dir: -1 | 1) {
    const next = [...prep.photos];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    updatePhotos(next);
  }

  const priceUsd = listing.priceCents / 100;

  return (
    <>
      {prep.validation.requiredMissing.length > 0 && (
        <div className="hiq-card p-3 mb-4 text-xs" style={{
          background: "color-mix(in oklab, var(--color-danger) 10%, transparent)",
          color: "var(--color-danger)",
        }}>
          <div className="font-medium mb-1">Missing before eBay accepts:</div>
          <ul className="list-disc list-inside space-y-0.5">
            {prep.validation.requiredMissing.map((m) => <li key={m}>{prettyMissing(m)}</li>)}
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

      <Section title="Listing basics" defaultOpen>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_140px_100px] gap-3">
          <Field label={`Title (${listing.titleSuggested.length}/80)`}>
            <input
              value={listing.titleSuggested}
              onChange={(e) => updateListing({ titleSuggested: e.target.value.slice(0, 80) })}
              maxLength={80}
              className={inputCls}
            />
          </Field>
          <Field label="Price (USD)">
            <input
              type="number"
              min={0}
              step="0.01"
              value={Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd.toFixed(2) : ""}
              onChange={(e) => updateListing({ priceCents: Math.round(Number(e.target.value) * 100) })}
              className={inputCls}
            />
          </Field>
          <Field label="Quantity">
            <input
              type="number" min={1} step={1}
              value={listing.quantity}
              onChange={(e) => updateListing({ quantity: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
              className={inputCls}
            />
          </Field>
        </div>
        {/* CF-EBAY-SELL-LOOP: where the price came from, and every
            disclosure it carries. Read-only by design — the number is the
            engine's, and the caveats are re-derived server-side at publish
            so they cannot be edited away here. */}
        <PriceBasis
          pricing={prep.pricing}
          sellSignal={prep.sellSignal ?? null}
          editedCents={listing.priceCents}
        />
        <Field label="Description">
          <textarea
            value={listing.description}
            onChange={(e) => updateListing({ description: e.target.value })}
            rows={3}
            className={`${inputCls} resize-y`}
          />
        </Field>
      </Section>

      <Section title="Card identity">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Player">
            <input
              value={identity.playerName ?? ""}
              onChange={(e) => updateIdentity({ playerName: e.target.value || null })}
              className={inputCls}
            />
          </Field>
          <Field label="Year">
            <input
              type="number" min={1900} max={2099}
              value={identity.cardYear ?? ""}
              onChange={(e) => updateIdentity({ cardYear: e.target.value ? Number(e.target.value) : null })}
              className={inputCls}
            />
          </Field>
          <Field label="Set">
            <input
              value={identity.setName ?? ""}
              onChange={(e) => updateIdentity({ setName: e.target.value || null })}
              className={inputCls}
            />
          </Field>
          <Field label="Parallel">
            <input
              value={identity.parallel ?? ""}
              onChange={(e) => updateIdentity({ parallel: e.target.value || null })}
              placeholder="Orange Shimmer, Refractor, Base…"
              className={inputCls}
            />
          </Field>
          <Field label="Card #">
            <input
              value={identity.cardNumber ?? ""}
              onChange={(e) => updateIdentity({ cardNumber: e.target.value || null })}
              className={inputCls}
            />
          </Field>
          <Field label="Team">
            <input
              value={identity.team ?? ""}
              onChange={(e) => updateIdentity({ team: e.target.value || null })}
              className={inputCls}
            />
          </Field>
          <Field label="Sport">
            <select
              value={identity.sport ?? "Baseball"}
              onChange={(e) => updateIdentity({ sport: e.target.value })}
              className={inputCls}
            >
              {["Baseball", "Basketball", "Football", "Hockey", "Soccer", "Pokemon"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3 items-end">
            <Checkbox
              label="Autograph"
              checked={identity.isAuto}
              onChange={(v) => updateIdentity({ isAuto: v })}
            />
            <Checkbox
              label="Rookie"
              checked={identity.isRookie}
              onChange={(v) => updateIdentity({ isRookie: v })}
            />
          </div>
        </div>
      </Section>

      <Section title={condition.isGraded ? `Condition — ${condition.gradingCompany ?? "graded"}` : "Condition — raw"}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="Grading company">
            <select
              value={condition.gradingCompany ?? ""}
              onChange={(e) => updateCondition({ gradingCompany: e.target.value || null, isGraded: !!e.target.value })}
              className={inputCls}
            >
              <option value="">Raw</option>
              <option value="PSA">PSA</option>
              <option value="BGS">BGS</option>
              <option value="SGC">SGC</option>
              <option value="CGC">CGC</option>
            </select>
          </Field>
          <Field label="Grade">
            <input
              value={condition.grade ?? ""}
              onChange={(e) => updateCondition({ grade: e.target.value || null })}
              placeholder={condition.isGraded ? "10" : "—"}
              disabled={!condition.isGraded}
              className={inputCls}
            />
          </Field>
          <Field label="Cert #">
            <input
              value={condition.certNumber ?? ""}
              onChange={(e) => updateCondition({ certNumber: e.target.value || null })}
              placeholder={condition.isGraded ? "e.g. 12345678" : "—"}
              disabled={!condition.isGraded}
              className={inputCls}
            />
          </Field>
          {!condition.isGraded && (
            <Field label="Raw condition">
              <select
                value={condition.conditionEstimate ?? ""}
                onChange={(e) => updateCondition({ conditionEstimate: e.target.value || null })}
                className={inputCls}
              >
                <option value="">Auto (defaults to Near Mint)</option>
                <option value="Mint">Mint</option>
                <option value="Near Mint">Near Mint</option>
                <option value="Excellent">Excellent</option>
                <option value="Very Good">Very Good</option>
                <option value="Good">Good</option>
              </select>
            </Field>
          )}
          <div className="md:col-span-2">
            <Field label="Condition notes">
              <textarea
                value={condition.conditionNotes ?? ""}
                onChange={(e) => updateCondition({ conditionNotes: e.target.value || null })}
                rows={2}
                placeholder="Any centering / edge / surface notes for the listing"
                className={`${inputCls} resize-y`}
              />
            </Field>
          </div>
        </div>
      </Section>

      <Section title="eBay category aspects">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label="League">
            <input
              value={aspects.league ?? ""}
              onChange={(e) => updateAspects({ league: e.target.value || null })}
              placeholder="MLB / NBA / NFL / NHL …"
              className={inputCls}
            />
          </Field>
          <Field label="Type">
            <input
              value={aspects.type ?? "Sports Trading Card"}
              onChange={(e) => updateAspects({ type: e.target.value || null })}
              className={inputCls}
            />
          </Field>
          <Field label="Country of manufacture">
            <input
              value={aspects.countryOfManufacture ?? "United States"}
              onChange={(e) => updateAspects({ countryOfManufacture: e.target.value || null })}
              className={inputCls}
            />
          </Field>
          <Field label="Language">
            <input
              value={aspects.language ?? "English"}
              onChange={(e) => updateAspects({ language: e.target.value || null })}
              className={inputCls}
            />
          </Field>
          <Field label="Year manufactured">
            <input
              type="number" min={1900} max={2099}
              value={aspects.yearManufactured ?? ""}
              onChange={(e) => updateAspects({ yearManufactured: e.target.value ? Number(e.target.value) : null })}
              className={inputCls}
            />
          </Field>
          <Field label="Season">
            <input
              type="number" min={1900} max={2099}
              value={aspects.season ?? ""}
              onChange={(e) => updateAspects({ season: e.target.value ? Number(e.target.value) : null })}
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      <Section title={`Photos (${prep.photos.length})`}>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          {prep.photos.map((url, i) => (
            <div key={url + i} className="relative w-24 h-24 rounded-lg overflow-hidden group" style={{ background: "var(--color-bg)" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="w-full h-full object-cover" />
              <div className="absolute inset-0 flex items-end justify-between p-1 opacity-0 group-hover:opacity-100 transition-opacity" style={{ background: "linear-gradient(to top, rgba(0,0,0,0.7), transparent)" }}>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => movePhoto(i, -1)}
                    disabled={i === 0}
                    className="w-5 h-5 rounded text-xs bg-black/60 text-white disabled:opacity-30"
                    aria-label="Move earlier"
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    onClick={() => movePhoto(i, 1)}
                    disabled={i === prep.photos.length - 1}
                    className="w-5 h-5 rounded text-xs bg-black/60 text-white disabled:opacity-30"
                    aria-label="Move later"
                  >
                    →
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => updatePhotos(prep.photos.filter((_, j) => j !== i))}
                  className="w-5 h-5 rounded text-xs bg-black/60 text-white"
                  aria-label="Remove"
                >
                  ×
                </button>
              </div>
              {i === 0 && (
                <span className="absolute top-1 left-1 text-[9px] font-bold px-1 py-0.5 rounded bg-black/60 text-white uppercase tracking-wide">
                  Cover
                </span>
              )}
            </div>
          ))}
          <label
            className={`w-24 h-24 rounded-lg border-2 border-dashed flex items-center justify-center cursor-pointer text-xs text-center px-2 ${uploadingPhoto ? "opacity-60 cursor-wait" : "hover:border-[color:var(--color-accent)]"}`}
            style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
          >
            {uploadingPhoto ? "Uploading…" : "+ Photo"}
            <input
              type="file"
              accept="image/*"
              onChange={onPickPhoto}
              disabled={uploadingPhoto}
              className="sr-only"
            />
          </label>
        </div>
        <p className="text-[10px] text-[color:var(--color-muted)]">
          First photo is the cover on eBay. Drag or use the arrow buttons to reorder.
          Max 12 photos, https only.
        </p>
      </Section>

      <Section title="Advanced">
        <Checkbox
          label="Enable Best Offer"
          checked={listing.bestOfferEnabled}
          onChange={(v) => updateListing({ bestOfferEnabled: v, bestOfferMinPriceCents: v ? listing.bestOfferMinPriceCents : null })}
        />
        {listing.bestOfferEnabled && (
          <div className="mt-3">
            <Field label="Auto-accept above (USD)">
              <input
                type="number" min={0} step="0.01"
                value={listing.bestOfferMinPriceCents ? (listing.bestOfferMinPriceCents / 100).toFixed(2) : ""}
                onChange={(e) => updateListing({ bestOfferMinPriceCents: e.target.value ? Math.round(Number(e.target.value) * 100) : null })}
                placeholder="Leave blank to review every offer"
                className={inputCls}
              />
            </Field>
          </div>
        )}
      </Section>

      {error && (
        <div className="text-sm mb-4" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-4 border-t border-[color:var(--color-border)]">
        <button onClick={onCancel} className="hiq-btn-secondary text-sm" disabled={submitting}>
          Cancel
        </button>
        <button
          onClick={onPublish}
          disabled={submitting || !prep.validation.readyToPublish || prep.photos.length === 0}
          className="hiq-btn-primary text-sm disabled:opacity-40"
        >
          {submitting ? submitLoadingLabel : submitLabel}
        </button>
      </div>
    </>
  );
}

// Flat layout — every section always visible in one scroll. Section
// headers still act as a visual anchor / eyebrow so users can skim, but
// nothing collapses. Every field is on-screen the moment the modal
// mounts.
function Section({ title, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-xl border border-[color:var(--color-border)]">
      <div className="px-4 py-3 text-sm font-medium border-b border-[color:var(--color-border)]">
        {title}
      </div>
      <div className="px-4 py-4 space-y-3">
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium block mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

function Checkbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4"
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * CF-EBAY-SELL-LOOP (Drew, 2026-09-02). The price's provenance, shown to
 * the seller before they list.
 *
 * The doctrine this renders: the number in the price field is HobbyIQ's
 * projected next sale, produced by a named rung, and a soft number says
 * so in words. Nothing here is editable and nothing here is computed
 * client-side — the panel reports what the backend decided.
 *
 * Three states worth distinguishing, because they mean different things
 * to someone about to sell a card:
 *
 *   - HobbyIQ priced it, and the seller kept that number. The rung, the
 *     evidence and every disclosure are shown, and the same disclosures
 *     will be appended to the listing.
 *   - HobbyIQ priced it and the seller CHANGED it. Then the listing is
 *     their number, no basis is attached at publish, and the panel says
 *     so rather than continuing to display a basis for a price that is no
 *     longer on the listing.
 *   - HobbyIQ declined. The reason is shown, and the price field is the
 *     seller's own to fill.
 */
function PriceBasis({
  pricing,
  sellSignal,
  editedCents,
}: {
  pricing: EbayListingPrepared["pricing"];
  sellSignal: EbaySellSignal | null;
  editedCents: number;
}) {
  if (!pricing) return null;

  const muted = { color: "var(--color-text-muted)" };

  // No engine price: show why, so "enter a price" is an informed act.
  if (pricing.status !== "engine" || pricing.priceCents === null) {
    return (
      <div className="mt-3 text-xs rounded-lg p-3 hiq-card" style={muted}>
        <span className="font-medium">No HobbyIQ price for this card.</span>{" "}
        {pricing.declineReason ?? "Enter your own asking price."}
      </div>
    );
  }

  // The seller overrode our number — one cent of tolerance for the
  // dollars/cents round-trip, matching the backend's own gate.
  const overridden = Math.abs(editedCents - pricing.priceCents) > 1;
  const enginePrice = (pricing.priceCents / 100).toFixed(2);

  return (
    <div className="mt-3 text-xs rounded-lg p-3 hiq-card space-y-2">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <span className="font-medium">
          HobbyIQ projects ${enginePrice}
        </span>
        {pricing.rungLabel && (
          <span
            className="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide"
            style={{
              background: pricing.exactPool
                ? "color-mix(in oklab, var(--color-success) 16%, transparent)"
                : "color-mix(in oklab, var(--color-accent) 16%, transparent)",
              color: pricing.exactPool ? "var(--color-success)" : "var(--color-accent)",
            }}
            title={
              pricing.exactPool
                ? "Read from sales of this exact card at this grade"
                : "Read from a related pool, not this exact card at this grade"
            }
          >
            {pricing.rungLabel}
          </span>
        )}
      </div>

      <div style={muted}>
        Projected next sale
        {pricing.compCount > 0 && (
          <> from {pricing.compCount} sale{pricing.compCount === 1 ? "" : "s"}</>
        )}
        {pricing.range && (
          <> (range ${pricing.range.min.toFixed(2)}-${pricing.range.max.toFixed(2)})</>
        )}
        {typeof pricing.confidence === "number" && (
          <> · confidence {pricing.confidence.toFixed(2)}</>
        )}
        .
      </div>

      {/* Every disclosure, shown in full. These are the same sentences the
          backend writes into the listing description. */}
      {pricing.labels.map((l) => (
        <div
          key={l.code}
          className="rounded p-2"
          style={{
            background: "color-mix(in oklab, var(--color-accent) 10%, transparent)",
            color: "var(--color-accent)",
          }}
        >
          {l.text}
        </div>
      ))}

      {overridden ? (
        <div style={muted}>
          You changed the price, so this listing is your number — HobbyIQ&apos;s
          basis will not be added to the description.
        </div>
      ) : (
        <div style={muted}>
          This basis is added to the listing description when you publish.
        </div>
      )}

      {/* Timing context. It never moved the price above. */}
      {sellSignal && sellSignal.signal !== "none" && (
        <div
          className="rounded p-2"
          style={{
            background: "color-mix(in oklab, var(--color-success) 10%, transparent)",
            color: "var(--color-success)",
          }}
        >
          <span className="font-medium uppercase text-[10px] tracking-wide">
            {sellSignal.signal}
            {sellSignal.horizon !== "none" && ` · ${sellSignal.horizon.replace(/-/g, " ")}`}
          </span>
          <div>{sellSignal.basis}</div>
        </div>
      )}
    </div>
  );
}

function prettyMissing(k: string): string {
  const map: Record<string, string> = {
    "photos": "at least one photo",
    "identity.playerName": "player name",
    "identity.cardYear": "card year",
    "identity.setName": "set name",
    "categoryAspects.league": "league",
    "categoryAspects.type": "type",
    "categoryAspects.countryOfManufacture": "country of manufacture",
    "categoryAspects.yearManufactured": "year manufactured",
    "listing.priceCents": "listing price",
    "listing.title": "listing title",
    "condition.gradingCompany": "grading company (graded card)",
    "condition.grade": "grade value (graded card)",
    "condition.certNumber": "cert number (graded card)",
  };
  return map[k] ?? k;
}

const inputCls =
  "w-full px-3 py-2 rounded-lg border text-sm outline-none focus:border-[color:var(--color-accent)] " +
  "bg-[color:var(--color-bg)] border-[color:var(--color-border)] text-white disabled:opacity-50";
