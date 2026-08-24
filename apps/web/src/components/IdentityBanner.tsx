"use client";

/**
 * CF-SURFACE-THE-PARKED-MATCH (2026-08-23).
 *
 * The importer already finds a catalog match for most holdings it cannot pin.
 * It writes that match to `catalogMatchSlug` and, below the pin threshold,
 * stops. Nothing ever showed it to anyone. In prod, 20 of 23 unidentified
 * holdings were carrying a match that no screen rendered — the work of finding
 * the card had been done and then thrown away at the glass.
 *
 * Meanwhile the holding stays unpriced (the no-identity-no-price guard at the
 * store door is doing its job), so the owner sees a blank value and no way to
 * act on it. This banner is the missing half: it shows the match, says how
 * confident the machine is, and puts the decision where it belongs.
 *
 * Two states, and the second matters as much as the first:
 *
 *   PROPOSAL   we have a candidate -> accept it, or go pick a different one
 *   NO MATCH   we have nothing     -> go find it, with the reason we failed
 *
 * A low-confidence proposal is presented AS low-confidence rather than being
 * hidden or silently accepted. 0.72 is worth showing to the one person who can
 * settle it in a glance; it is not worth pinning behind their back, which is
 * exactly what the ungated PATCH path used to do.
 */

import { useState } from "react";
import { acceptHoldingIdentity, type PortfolioHolding, type CatalogSearchHit } from "@/lib/api";
import { describeSlug } from "@/lib/format";
import { CatalogPickerModal } from "@/components/CatalogPickerModal";

export function IdentityBanner({
  holding,
  onResolved,
}: {
  holding: PortfolioHolding;
  /** Called after the server pins an identity. The server also kicks a
   *  reprice, so the caller should re-read rather than patch state locally —
   *  the value that arrives next is the whole point of accepting. */
  onResolved: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const identified =
    String(holding.cardId ?? "").trim() !== "" ||
    String(holding.hobbyiqCardId ?? "").trim() !== "";
  const proposal = holding.proposedIdentity ?? null;

  // Nothing to say: the card knows what it is, and there is no review flag.
  if (identified && !holding.needsReview) return null;

  const conf = typeof proposal?.confidence === "number" ? proposal.confidence : null;
  const pretty = proposal ? describeSlug(proposal.slug) : null;

  async function accept(cardId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await acceptHoldingIdentity(holding.id, cardId);
      if (!res.success) {
        // 409 slug-not-in-catalog arrives here with a real explanation.
        setError(res.detail ?? res.error ?? "Could not attach that card");
        return;
      }
      setPicking(false);
      await onResolved();
    } catch (err) {
      setError((err as { message?: string })?.message ?? "Could not attach that card");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div
        className="rounded-xl p-5 mb-6 border"
        style={{
          background: "color-mix(in oklab, var(--color-accent) 8%, transparent)",
          borderColor: "color-mix(in oklab, var(--color-accent) 35%, transparent)",
        }}
      >
        {proposal ? (
          <>
            <div className="flex items-baseline gap-2 flex-wrap mb-1">
              <span className="text-sm font-semibold">Is this your card?</span>
              {conf != null && (
                <span
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                  style={{
                    background: "color-mix(in oklab, var(--color-accent) 18%, transparent)",
                    color: "var(--color-accent)",
                  }}
                  title="How sure the matcher is. Below 0.90 we will not pin it for you."
                >
                  {Math.round(conf * 100)}% match
                </span>
              )}
            </div>
            <div className="text-base font-medium">{pretty ?? proposal.slug}</div>
            <div className="text-[11px] font-mono text-[color:var(--color-muted)] mt-1 break-all">
              {proposal.slug}
            </div>
            <p className="text-xs text-[color:var(--color-muted)] mt-3">
              We found this while importing but weren&apos;t sure enough to attach it on
              our own. Until a card is attached, we can&apos;t price this holding.
            </p>
            <div className="flex gap-2 mt-4 flex-wrap">
              <button
                onClick={() => void accept(proposal.slug)}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
                style={{ background: "var(--color-accent)", color: "var(--color-bg)" }}
              >
                {busy ? "Attaching…" : "Yes, that's it"}
              </button>
              <button
                onClick={() => setPicking(true)}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-50"
                style={{ borderColor: "var(--color-border)" }}
              >
                No — find the right one
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="text-sm font-semibold mb-1">
              {identified ? "This card needs a look" : "This card isn't matched yet"}
            </div>
            <p className="text-xs text-[color:var(--color-muted)]">
              {holding.reviewReason ??
                "We couldn't tell which catalog card this is, so we're not showing a value we can't stand behind."}
            </p>
            <button
              onClick={() => setPicking(true)}
              disabled={busy}
              className="mt-4 px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
              style={{ background: "var(--color-accent)", color: "var(--color-bg)" }}
            >
              Find this card
            </button>
          </>
        )}

        {error && (
          <p className="text-xs mt-3" style={{ color: "var(--hiq-danger)" }}>
            {error}
          </p>
        )}
      </div>

      {/* Same picker the match-review queue uses — one way to choose a card,
          not a second one invented for this screen. */}
      <CatalogPickerModal
        open={picking}
        busy={busy}
        initialQuery={[
          holding.cardYear ? String(holding.cardYear) : null,
          holding.product,
          holding.playerName,
          holding.cardNumber ? `#${holding.cardNumber}` : null,
        ].filter(Boolean).join(" ")}
        context={{
          cardNumber: holding.cardNumber ?? null,
          year: holding.cardYear ?? null,
          setName: holding.product ?? null,
          playerName: holding.playerName ?? null,
          isAuto: holding.isAuto ?? null,
        }}
        onPick={(hit: CatalogSearchHit) => void accept(hit.slug)}
        onClose={() => setPicking(false)}
      />
    </>
  );
}
