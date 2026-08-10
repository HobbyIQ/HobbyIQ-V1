"use client";

import { useEffect, useState } from "react";
import {
  previewFmvForCard,
  searchCards,
  updateHolding,
  uploadHoldingPhoto,
  type FmvPreviewResponse,
  type PortfolioHolding,
  type SearchCandidate,
} from "@/lib/api";
import { formatUSD } from "@/lib/format";
import { CalendarInput } from "@/components/CalendarInput";

interface Props {
  holding: PortfolioHolding;
  onCancel: () => void;
  onSaved: (h: PortfolioHolding) => void;
}

// Edit the metadata the user typed / imported. Identity fields
// (playerName, year, product, parallel, cardNumber, printRun, isAuto,
// grade) all round-trip through PATCH /api/portfolio/holdings/:id.
// Cost-basis edits (purchasePrice, purchaseDate) are here too — the
// same PATCH endpoint accepts them.
//
// Not editable from this modal (dedicated flows exist):
//   - Mark as sold  → SellModal on parent page
//   - Regrade + roll grading cost into cost basis  → follow-up route
//   - Photos → follow-up flow with upload UX
export function EditHoldingModal({ holding, onCancel, onSaved }: Props) {
  const [playerName, setPlayerName] = useState(holding.playerName ?? "");
  const [cardYear, setCardYear] = useState(holding.cardYear != null ? String(holding.cardYear) : "");
  const [product, setProduct] = useState(holding.product ?? "");
  const [parallel, setParallel] = useState(holding.parallel ?? "");
  const [cardNumber, setCardNumber] = useState(holding.cardNumber ?? "");
  const [serialNumber, setSerialNumber] = useState(holding.serialNumber ?? "");
  const [isAuto, setIsAuto] = useState<boolean>(holding.isAuto ?? false);
  const [gradeCompany, setGradeCompany] = useState<string>(holding.gradeCompany ?? "");
  const [gradeValue, setGradeValue] = useState<string>(holding.gradeValue != null ? String(holding.gradeValue) : "");
  const [purchasePrice, setPurchasePrice] = useState<string>(
    holding.purchasePrice != null ? String(holding.purchasePrice) : "",
  );
  const [purchaseDate, setPurchaseDate] = useState<string>(holding.purchaseDate?.slice(0, 10) ?? "");
  const [certNumber, setCertNumber] = useState<string>(holding.certNumber ?? "");
  const [notes, setNotes] = useState<string>(holding.notes ?? "");
  const [photos, setPhotos] = useState<string[]>(holding.photos ?? []);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // CF-EDIT-CATALOG-PICKER (Drew, 2026-07-27). Search /api/search/cards
  // with a free-text query (or a cert number). Debounced 400ms. Picking
  // a candidate autofills every identity field in one click — same UX
  // as the iOS "find card, select card" flow.
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerResults, setPickerResults] = useState<SearchCandidate[]>([]);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerShow, setPickerShow] = useState(false);

  // CF-IDENTITY-VERIFIED (Drew, 2026-07-27). After picking a candidate,
  // pop a Confirm gate: side-by-side identity + photo, projected FMV at
  // the current grade. Only on Confirm do we autofill the form fields
  // AND stamp identityVerified=true. Cert-source (authoritative)
  // candidates bypass the gate — grader IS the source of truth.
  const [confirmCandidate, setConfirmCandidate] = useState<SearchCandidate | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<FmvPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [verifiedTag, setVerifiedTag] = useState<{
    source: string;
    candidateId: string;
    verifiedAt: string;
  } | null>(
    holding.identityVerifiedBy ?? null,
  );

  useEffect(() => {
    const q = pickerQuery.trim();
    if (!q || q.length < 3) {
      setPickerResults([]);
      setPickerError(null);
      return;
    }
    setPickerLoading(true);
    setPickerError(null);
    const handle = setTimeout(async () => {
      try {
        const res = await searchCards(q);
        setPickerResults(res.candidates ?? []);
      } catch (err) {
        const e = err as { message?: string };
        setPickerError(e.message ?? "Search failed");
        setPickerResults([]);
      } finally {
        setPickerLoading(false);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [pickerQuery]);

  // CF-IDENTITY-VERIFIED: writes identity fields + stamps the
  // verified marker so Save persists both atomically.
  function applyAndVerify(c: SearchCandidate, source: "cert" | "manual-confirm") {
    if (c.player) setPlayerName(c.player);
    if (c.year != null) setCardYear(String(c.year));
    const productPick = c.setName ?? c.brand ?? "";
    if (productPick) setProduct(productPick);
    if (c.parallel) setParallel(c.parallel);
    if (c.cardNumber) setCardNumber(c.cardNumber);
    if (c.serialNumber) setSerialNumber(c.serialNumber);
    if (typeof c.isAuto === "boolean") setIsAuto(c.isAuto);
    if (c.gradeCompany) setGradeCompany(c.gradeCompany);
    if (c.gradeValue != null) setGradeValue(String(c.gradeValue));
    if (c.certNumber) setCertNumber(c.certNumber);
    setVerifiedTag({
      source: source === "cert" ? "cert-lookup" : "manual-confirm",
      candidateId: c.candidateId,
      verifiedAt: new Date().toISOString(),
    });
    setPickerShow(false);
    setPickerQuery("");
    setPickerResults([]);
  }

  function onPickCandidate(c: SearchCandidate) {
    // Cert-source lookups (PSA/BGS/SGC/CGC) are authoritative — skip
    // the manual confirm step because the grader is the source of truth.
    if (c.attribution === "authoritative" || /^(psa|bgs|sgc|cgc):/i.test(c.candidateId)) {
      applyAndVerify(c, "cert");
      return;
    }
    // Otherwise open the Confirm gate + kick off an FMV preview at the
    // user's CURRENT grade so a wrong pick reads as "$50 vs the $5k
    // I know this is" on sight.
    setConfirmCandidate(c);
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    const rawCardId = c.candidateId.replace(/^[a-z-]+:/i, "").split("::")[0];
    const gvN = gradeValue.trim() ? Number(gradeValue) : NaN;
    previewFmvForCard({
      cardId: rawCardId,
      gradeCompany: gradeCompany || null,
      gradeValue: Number.isFinite(gvN) ? gvN : null,
      parallelName: c.parallel || null,
    })
      .then((r) => setPreview(r))
      .catch((err: unknown) => {
        const e = err as { message?: string };
        setPreviewError(e.message ?? "Preview failed");
      })
      .finally(() => setPreviewLoading(false));
  }

  async function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";  // allow re-selecting same filename
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setError("Choose an image file (jpg / png / webp).");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("Photo must be under 10 MB.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const blobUrl = await uploadHoldingPhoto(file);
      setPhotos((prev) => [...prev, blobUrl]);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function onRemovePhoto(url: string) {
    setPhotos((prev) => prev.filter((p) => p !== url));
  }

  async function onSave() {
    setSubmitting(true);
    setError(null);
    try {
      const yearN = cardYear.trim() ? Number(cardYear) : undefined;
      const gvN = gradeValue.trim() ? Number(gradeValue) : null;
      const ppN = purchasePrice.trim() ? Number(purchasePrice) : undefined;

      if (yearN !== undefined && !(Number.isFinite(yearN) && yearN > 1900 && yearN < 2100)) {
        setError("Year must be a 4-digit year.");
        setSubmitting(false);
        return;
      }
      if (gvN !== null && !(Number.isFinite(gvN) && gvN > 0 && gvN <= 10)) {
        setError("Grade must be between 1 and 10.");
        setSubmitting(false);
        return;
      }
      if (ppN !== undefined && !(Number.isFinite(ppN) && ppN >= 0)) {
        setError("Purchase price can't be negative.");
        setSubmitting(false);
        return;
      }

      const patch = {
        playerName: playerName.trim() || undefined,
        cardYear: yearN,
        product: product.trim() || undefined,
        parallel: parallel.trim() || undefined,
        cardNumber: cardNumber.trim() || undefined,
        serialNumber: serialNumber.trim() || undefined,
        isAuto,
        // Grade: an empty gradeCompany + null gradeValue means "back to raw" —
        // the backend accepts null to clear.
        gradeCompany: gradeCompany.trim() || null,
        gradeValue: gvN,
        certNumber: certNumber.trim() || null,
        photos,
        purchasePrice: ppN,
        purchaseDate: purchaseDate || undefined,
        notes: notes.trim() || undefined,
        quantity: holding.quantity,   // required by AddHoldingInput type, preserve
        // CF-IDENTITY-VERIFIED (Drew, 2026-07-27): stamp verified marker
        // when the user confirmed a picker candidate this session. Never
        // clears an existing verified flag — a bare Save of an already-
        // verified holding leaves the marker intact.
        ...(verifiedTag
          ? {
              identityVerified: true,
              identityVerifiedAt: verifiedTag.verifiedAt,
              identityVerifiedBy: verifiedTag,
            }
          : {}),
      };

      const res = await updateHolding(holding.id, patch);
      if (!res.success || !res.holding) {
        setError(res.message ?? "Update failed.");
        setSubmitting(false);
        return;
      }
      onSaved(res.holding);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Update failed.");
      setSubmitting(false);
    }
  }

  // CF-IDENTITY-VERIFIED Confirm gate. Rendered as a NESTED overlay
  // above the Edit modal so pressing Back / Cancel returns you to the
  // form with your typed edits intact.
  const confirmView = confirmCandidate ? (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.75)" }}
      onClick={() => setConfirmCandidate(null)}
    >
      <div
        className="hiq-card p-6 max-w-3xl w-full max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold">Confirm this is your card</h2>
            <p className="text-xs mt-1" style={{ color: "var(--hiq-muted-text)" }}>
              Compare your photo + the current identity to the catalog match.
              Confirming stamps <strong>Verified</strong> on this holding so
              future FMV runs trust the ID.
            </p>
          </div>
          <button
            onClick={() => setConfirmCandidate(null)}
            aria-label="Back"
            className="text-2xl leading-none hover:text-white"
            style={{ color: "var(--hiq-muted-text)" }}
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="hiq-card p-4">
            <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--hiq-muted-text)" }}>
              Your current identity
            </div>
            <div className="flex items-start gap-3">
              {photos[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photos[0]} alt="" className="w-16 h-22 object-cover rounded flex-shrink-0" style={{ maxHeight: 88 }} />
              ) : (
                <div className="w-16 h-22 rounded flex-shrink-0" style={{ background: "var(--hiq-slate-gray)", height: 88 }} />
              )}
              <div className="min-w-0 text-sm space-y-1">
                <div className="font-semibold">{playerName || "(no player)"}</div>
                <IdRow label="Year" value={cardYear || "—"} />
                <IdRow label="Set" value={product || "—"} />
                <IdRow label="#" value={cardNumber || "—"} />
                <IdRow label="Parallel" value={parallel || "—"} />
                <IdRow label="Auto" value={isAuto ? "Yes" : "No"} />
              </div>
            </div>
          </div>

          <div
            className="hiq-card p-4"
            style={{ borderColor: "color-mix(in oklab, var(--hiq-hobby-green) 45%, transparent)" }}
          >
            <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--hiq-hobby-green)" }}>
              Catalog match
            </div>
            <div className="flex items-start gap-3">
              {confirmCandidate.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={confirmCandidate.imageUrl} alt="" className="w-16 h-22 object-cover rounded flex-shrink-0" style={{ maxHeight: 88 }} />
              ) : (
                <div className="w-16 h-22 rounded flex-shrink-0" style={{ background: "var(--hiq-slate-gray)", height: 88 }} />
              )}
              <div className="min-w-0 text-sm space-y-1">
                <div className="font-semibold">{confirmCandidate.player || "(no player)"}</div>
                <IdRow label="Year" value={confirmCandidate.year != null ? String(confirmCandidate.year) : "—"} />
                <IdRow label="Set" value={confirmCandidate.setName ?? confirmCandidate.brand ?? "—"} />
                <IdRow label="#" value={confirmCandidate.cardNumber ?? "—"} />
                <IdRow label="Parallel" value={confirmCandidate.parallel ?? "—"} />
                <IdRow label="Auto" value={confirmCandidate.isAuto ? "Yes" : "No"} />
              </div>
            </div>
          </div>
        </div>

        {/* FMV preview */}
        <div className="mt-4 hiq-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs uppercase tracking-wide" style={{ color: "var(--hiq-muted-text)" }}>
              Projected FMV at {gradeCompany && gradeValue ? `${gradeCompany} ${gradeValue}` : "current grade"}
            </div>
            {gradeCompany && gradeValue ? null : (
              <div className="text-[10px]" style={{ color: "var(--hiq-muted-text)" }}>
                (set grade for a graded preview)
              </div>
            )}
          </div>
          {previewLoading ? (
            <div className="text-sm mt-2" style={{ color: "var(--hiq-muted-text)" }}>
              Calculating…
            </div>
          ) : previewError ? (
            <div className="text-sm mt-2" style={{ color: "var(--hiq-danger)" }}>
              Couldn&apos;t preview FMV: {previewError}
            </div>
          ) : preview ? (
            <div className="mt-2 flex items-baseline gap-3 flex-wrap">
              <div className="text-3xl font-bold tabular-nums" style={{ color: "var(--hiq-hobby-green)" }}>
                {preview.fmv != null ? formatUSD(preview.fmv, { hideCents: preview.fmv >= 100 }) : "—"}
              </div>
              {preview.compsCount != null && (
                <div className="text-xs" style={{ color: "var(--hiq-muted-text)" }}>
                  {preview.compsCount} comp{preview.compsCount === 1 ? "" : "s"}
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm mt-2" style={{ color: "var(--hiq-muted-text)" }}>—</div>
          )}
          <div className="text-[10px] mt-2" style={{ color: "var(--hiq-muted-text)" }}>
            Sanity check: if this number looks wildly wrong for this card, you probably picked the wrong candidate — go Back and try again.
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={() => setConfirmCandidate(null)}
            className="hiq-btn-secondary"
          >
            Back
          </button>
          <button
            onClick={() => {
              const c = confirmCandidate;
              setConfirmCandidate(null);
              if (c) applyAndVerify(c, "manual-confirm");
            }}
            className="hiq-btn-primary"
          >
            Confirm — this is my card
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onCancel}
    >
      <div
        className="hiq-card p-6 max-w-2xl w-full max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold">Edit card</h2>
            <p className="text-xs text-[color:var(--color-muted)] mt-1">
              Fix identity + cost basis. Sale + regrade have their own flows.
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="text-[color:var(--color-muted)] hover:text-white transition-colors text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {/* CF-EDIT-CATALOG-PICKER: search + select flow. Collapsed by
            default so returning users who just want to fix a typo
            aren't distracted by it. */}
        <div className="mb-4">
          {!pickerShow ? (
            <button
              type="button"
              onClick={() => setPickerShow(true)}
              className="w-full text-sm text-left px-3 py-2 rounded-lg border border-dashed hover:border-[color:var(--color-accent)] transition-colors flex items-center gap-2"
              style={{ borderColor: "var(--color-border)", color: "var(--hiq-muted-text)" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 2a8 8 0 016.32 12.9l5.39 5.4-1.42 1.4-5.39-5.39A8 8 0 1110 2zm0 2a6 6 0 100 12 6 6 0 000-12z" />
              </svg>
              Find card in catalog to autofill identity…
            </button>
          ) : (
            <div className="rounded-lg border p-3" style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}>
              <div className="flex items-center gap-2 mb-2">
                <input
                  autoFocus
                  type="text"
                  value={pickerQuery}
                  onChange={(e) => setPickerQuery(e.target.value)}
                  placeholder="Player, set, cert number… (e.g. 'trout 2011 update' or '76556858')"
                  className={inputCls}
                />
                <button
                  type="button"
                  onClick={() => {
                    setPickerShow(false);
                    setPickerQuery("");
                    setPickerResults([]);
                    setPickerError(null);
                  }}
                  className="text-xs px-2 py-1 hover:underline"
                  style={{ color: "var(--hiq-muted-text)" }}
                >
                  Cancel
                </button>
              </div>
              {pickerLoading && (
                <div className="text-xs px-2 py-3" style={{ color: "var(--hiq-muted-text)" }}>
                  Searching…
                </div>
              )}
              {pickerError && (
                <div className="text-xs px-2 py-2" style={{ color: "var(--hiq-danger)" }}>
                  {pickerError}
                </div>
              )}
              {!pickerLoading && !pickerError && pickerQuery.trim().length >= 3 && pickerResults.length === 0 && (
                <div className="text-xs px-2 py-3" style={{ color: "var(--hiq-muted-text)" }}>
                  No matches. Try broader keywords or a cert number.
                </div>
              )}
              {pickerResults.length > 0 && (
                <div className="max-h-64 overflow-y-auto divide-y divide-[color:var(--color-border)] rounded" style={{ background: "var(--color-bg-card)" }}>
                  {pickerResults.slice(0, 15).map((c) => (
                    <button
                      key={c.candidateId}
                      type="button"
                      onClick={() => onPickCandidate(c)}
                      className="w-full text-left flex items-center gap-3 px-3 py-2 hover:bg-white/5 transition-colors"
                    >
                      {c.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={c.imageUrl} alt="" className="w-8 h-11 object-cover rounded flex-shrink-0" />
                      ) : (
                        <div className="w-8 h-11 rounded flex-shrink-0" style={{ background: "var(--hiq-slate-gray)" }} />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{c.title}</div>
                        <div className="text-[10px] mt-0.5 flex items-center gap-2" style={{ color: "var(--hiq-muted-text)" }}>
                          <span>{c.source}</span>
                          {c.attribution === "authoritative" && (
                            <span
                              className="px-1 rounded"
                              style={{ background: "color-mix(in oklab, var(--hiq-hobby-green) 15%, transparent)", color: "var(--hiq-hobby-green)" }}
                            >
                              VERIFIED
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {pickerQuery.trim().length > 0 && pickerQuery.trim().length < 3 && (
                <div className="text-xs px-2 py-2" style={{ color: "var(--hiq-muted-text)" }}>
                  Type 3+ characters.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Player">
            <input value={playerName} onChange={(e) => setPlayerName(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Year">
            <input
              type="number"
              min={1900}
              max={2099}
              value={cardYear}
              onChange={(e) => setCardYear(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Product">
            <input value={product} onChange={(e) => setProduct(e.target.value)} className={inputCls} placeholder="Bowman Chrome" />
          </Field>
          <Field label="Parallel">
            <input value={parallel} onChange={(e) => setParallel(e.target.value)} className={inputCls} placeholder="Orange Shimmer" />
          </Field>
          <Field label="Card #">
            <input value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} className={inputCls} placeholder="CPA-EHA" />
          </Field>
          <Field label="Serial #">
            <input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} className={inputCls} placeholder="01/25" />
          </Field>
          <Field label="Auto?">
            <label className="flex items-center gap-2 h-full">
              <input
                type="checkbox"
                checked={isAuto}
                onChange={(e) => setIsAuto(e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-sm">{isAuto ? "Autographed" : "No"}</span>
            </label>
          </Field>
          <div />
          <Field label="Grade company">
            <select value={gradeCompany} onChange={(e) => setGradeCompany(e.target.value)} className={inputCls}>
              <option value="">Raw</option>
              <option value="PSA">PSA</option>
              <option value="BGS">BGS</option>
              <option value="SGC">SGC</option>
              <option value="CGC">CGC</option>
            </select>
          </Field>
          <Field label="Grade">
            <input
              type="number"
              min={0}
              max={10}
              step="0.5"
              value={gradeValue}
              onChange={(e) => setGradeValue(e.target.value)}
              className={inputCls}
              disabled={!gradeCompany}
              placeholder={gradeCompany ? "10" : "—"}
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Cert # (optional)">
              <input
                value={certNumber}
                onChange={(e) => setCertNumber(e.target.value)}
                className={inputCls}
                disabled={!gradeCompany}
                placeholder={gradeCompany ? "e.g. 12345678" : "Set grade first"}
              />
            </Field>
          </div>
          <Field label="Purchase price ($)">
            <input
              type="number"
              min={0}
              step="0.01"
              value={purchasePrice}
              onChange={(e) => setPurchasePrice(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Purchase date">
            <CalendarInput
              value={purchaseDate}
              onChange={setPurchaseDate}
              className={inputCls}
            />
          </Field>
          <div className="md:col-span-2">
            <Field label="Photos">
              <div className="flex flex-wrap items-center gap-3">
                {photos.map((url) => (
                  <div key={url} className="relative w-24 h-32 rounded-lg overflow-hidden" style={{ background: "var(--color-bg)" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {/* CF-PHOTO-DISPLAY (Drew, 2026-08-10). Slab-ratio
                        container (w-24 h-32 = 3:4) + object-contain so the
                        whole slab is visible — labels, cert #, corners.
                        Wrapped in an <a> so tapping opens the full-size
                        original in a new tab. */}
                    <a href={url} target="_blank" rel="noopener noreferrer" className="block w-full h-full" title="Open full size">
                      <img src={url} alt="" className="w-full h-full object-contain" />
                    </a>
                    <button
                      type="button"
                      onClick={() => onRemovePhoto(url)}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-xs leading-none"
                      style={{ background: "rgba(0,0,0,0.7)", color: "white" }}
                      aria-label="Remove photo"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <label
                  className={`w-24 h-32 rounded-lg border-2 border-dashed flex items-center justify-center cursor-pointer text-xs text-center px-2 ${uploading ? "opacity-60 cursor-wait" : "hover:border-[color:var(--color-accent)]"}`}
                  style={{ borderColor: "var(--color-border)", color: "var(--color-muted)" }}
                >
                  {uploading ? "Uploading…" : "+ Photo"}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={onPickPhoto}
                    disabled={uploading}
                    className="sr-only"
                  />
                </label>
              </div>
              <p className="text-[10px] text-[color:var(--color-muted)] mt-2">
                JPG / PNG / WebP · max 10 MB · first photo shows in your portfolio list
              </p>
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Notes">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className={`${inputCls} resize-y`}
              />
            </Field>
          </div>
        </div>

        {error && (
          <div className="mt-4 text-sm" style={{ color: "var(--color-danger)" }}>
            {error}
          </div>
        )}

        {verifiedTag && (
          <div
            className="mt-4 text-xs flex items-center gap-2"
            style={{ color: "var(--hiq-hobby-green)" }}
          >
            <span
              className="px-2 py-0.5 rounded-full text-[10px] font-bold"
              style={{
                background: "color-mix(in oklab, var(--hiq-hobby-green) 15%, transparent)",
              }}
            >
              ✓ VERIFIED
            </span>
            <span style={{ color: "var(--hiq-muted-text)" }}>
              Identity confirmed via {verifiedTag.source}. Save to persist.
            </span>
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button onClick={onCancel} className="hiq-btn-secondary" disabled={submitting}>
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={submitting}
            className="hiq-btn-primary disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
      {confirmView}
    </div>
  );
}

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className="text-[10px] uppercase tracking-wide w-14 flex-shrink-0"
        style={{ color: "var(--hiq-muted-text)" }}
      >
        {label}
      </span>
      <span className="truncate">{value}</span>
    </div>
  );
}

// CF-INPUT-BRAND-FOCUS (Drew, 2026-08-04). Consistent border across
// all inputs so no single field visually pops on focus while others
// look flat. Matches AddCardModal styling.
const inputCls =
  "w-full px-3 py-2 rounded-lg border text-sm outline-none transition-colors " +
  "bg-[color:var(--color-bg)] border-[color:var(--color-border-soft)] text-white " +
  "hover:border-[color:var(--color-accent)]/60 " +
  "focus:border-[color:var(--color-accent)] focus:ring-2 focus:ring-[color:var(--color-accent)]/30 " +
  "disabled:opacity-50";

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
