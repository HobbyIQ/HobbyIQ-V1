"use client";

// CF-BUYERIQ-DEAL-FEED (Drew, 2026-09-02). The deals feed: live asks on
// the user's BuyerIQ targets that sit far enough under the card's
// projected next sale to be worth a look.
//
// Every deal shows its BASIS — the projection, the rung it came from,
// the confidence in it, and the discount required vs carried. A user
// deciding to spend money is entitled to see what the number rests on.
//
// A truncated scan (vendor-call budget exhausted) is announced as
// truncated. We never present a partial feed as the whole market.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  fetchBuyerIqDeals,
  type BuyerIqDeal,
  type BuyerIqDealFeed,
  type BuyerIqSkippedTarget,
} from "@/lib/api";

const THRESHOLD_CHOICES = [
  { label: "15% under", value: 0.15 },
  { label: "20% under", value: 0.20 },
  { label: "30% under", value: 0.30 },
  { label: "40% under", value: 0.40 },
];

export default function BuyerIqDealsPage() {
  const [feed, setFeed] = useState<BuyerIqDealFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(0.20);

  const refresh = useCallback(async (t: number) => {
    setLoading(true);
    setError(null);
    try {
      setFeed(await fetchBuyerIqDeals({ threshold: t }));
    } catch (err) {
      setError((err as { message?: string }).message ?? "Failed to scan for deals");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(threshold); }, [refresh, threshold]);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/app/buyeriq" className="text-sm text-[color:var(--color-muted)] hover:opacity-80">
              BuyerIQ
            </Link>
            <span className="text-sm text-[color:var(--color-muted)]">/</span>
            <h1 className="text-3xl font-bold">Deals</h1>
          </div>
          <p className="text-sm text-[color:var(--color-muted)] max-w-xl">
            Live asks on your wanted targets, measured against each card&apos;s projected
            next sale. Thin-pool projections have to be beaten by more before they
            show up here.
          </p>
        </div>
        <div className="shrink-0">
          <label className="block text-xs uppercase tracking-wider text-[color:var(--color-muted)] mb-1">
            Threshold
          </label>
          <select
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="px-3 py-2 rounded-lg border text-sm outline-none"
            style={{ background: "var(--color-bg)", borderColor: "var(--color-border)", color: "white" }}
          >
            {THRESHOLD_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
      </div>

      {loading && (
        <div className="text-sm text-[color:var(--color-muted)]">Scanning your targets…</div>
      )}

      {error && (
        <div className="hiq-card p-4 text-sm" style={{ color: "var(--color-danger)" }}>{error}</div>
      )}

      {!loading && !error && feed && (
        <>
          {!feed.complete && <TruncationNotice feed={feed} />}

          <div className="text-xs text-[color:var(--color-muted)] mb-4">
            Scanned {feed.targetsScanned} of {feed.targetsEligible} wanted{" "}
            {feed.targetsEligible === 1 ? "target" : "targets"} ·{" "}
            {feed.deals.length} {feed.deals.length === 1 ? "deal" : "deals"} at{" "}
            {Math.round(feed.baseDiscountPct * 100)}% or better
          </div>

          {feed.deals.length === 0 && (
            <div className="hiq-card p-8 text-center">
              <p className="text-sm text-[color:var(--color-muted)] max-w-md mx-auto">
                {feed.targetsEligible === 0
                  ? "No wanted targets to scan. Add cards to a buying list and they'll be checked against the live market here."
                  : "Nothing on your list is listed far enough under its projection right now. Lower the threshold, or check back — asks move daily."}
              </p>
            </div>
          )}

          {feed.deals.length > 0 && (
            <div className="space-y-3">
              {feed.deals.map((d) => <DealCard key={`${d.targetId}:${d.listing.listingId}`} deal={d} />)}
            </div>
          )}

          {feed.skipped.length > 0 && <SkippedSection skipped={feed.skipped} />}
        </>
      )}
    </div>
  );
}

function TruncationNotice({ feed }: { feed: BuyerIqDealFeed }) {
  return (
    <div
      className="hiq-card p-4 mb-4 text-sm"
      style={{ borderColor: "var(--color-warning, #d97706)" }}
    >
      <div className="font-semibold mb-1">Partial scan</div>
      <div className="text-[color:var(--color-muted)]">
        This scan stopped after {feed.budget.spent} live marketplace lookups —
        its daily budget for this run. {feed.targetsUnexamined}{" "}
        {feed.targetsUnexamined === 1 ? "target was" : "targets were"} not checked, so
        there may be deals below that aren&apos;t shown. The next scan picks up the
        rest as cached results free up budget.
      </div>
    </div>
  );
}

function DealCard({ deal }: { deal: BuyerIqDeal }) {
  const { basis, listing } = deal;
  const identity = [
    deal.cardYear ?? "",
    deal.setName ?? "",
    deal.playerName,
    deal.cardNumber ? `#${deal.cardNumber}` : "",
    deal.parallel ?? "",
    deal.gradeCompany ? `${deal.gradeCompany} ${deal.gradeValue ?? ""}`.trim() : "Raw",
  ].filter(Boolean).join(" · ");

  return (
    <div className="hiq-card p-4">
      <div className="flex items-start gap-4">
        {listing.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={listing.imageUrl}
            alt=""
            className="w-16 h-20 object-cover rounded shrink-0"
          />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="font-semibold">{deal.playerName}</div>
            <div
              className="text-sm font-bold px-2 py-0.5 rounded-full shrink-0"
              style={{ background: "var(--color-bg-card-hover)", color: "var(--color-success)" }}
            >
              {deal.discountPctDisplay.toFixed(0)}% under
            </div>
          </div>
          <div className="text-xs text-[color:var(--color-muted)] mt-0.5">{identity}</div>

          <div className="flex items-baseline gap-3 mt-2 flex-wrap">
            <span className="text-lg font-bold">${listing.price.toFixed(2)}</span>
            <span className="text-sm text-[color:var(--color-muted)]">
              vs ${basis.projection.toFixed(2)} projected for {deal.matchedTier}
            </span>
            <span className="text-sm" style={{ color: "var(--color-success)" }}>
              save ${deal.savingsVsProjection.toFixed(2)}
            </span>
          </div>

          <BasisRow deal={deal} />

          <div className="mt-3 flex items-center gap-3 flex-wrap">
            <a
              href={listing.itemWebUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hiq-btn-primary text-sm"
            >
              View listing
            </a>
            {listing.sellerHandle && (
              <span className="text-xs text-[color:var(--color-muted)]">
                seller {listing.sellerHandle}
              </span>
            )}
            {listing.endsAt && (
              <span className="text-xs text-[color:var(--color-muted)]">
                ends {new Date(listing.endsAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The per-deal basis: what the discount is measured against, and how
 *  much we trust it. This is the part that makes the number defensible. */
function BasisRow({ deal }: { deal: BuyerIqDeal }) {
  const { basis } = deal;
  return (
    <div
      className="mt-3 pt-3 text-xs grid gap-x-6 gap-y-1 grid-cols-2 sm:grid-cols-4"
      style={{ borderTop: "1px solid var(--color-border)" }}
    >
      <Field label="Projection" value={`$${basis.projection.toFixed(2)}`} />
      <Field label="Rung" value={rungLabel(basis.rung)} title={basis.rung ?? undefined} />
      <Field
        label="Confidence"
        value={`${Math.round(basis.confidence * 100)}%`}
        tone={basis.exactPool ? "success" : "muted"}
      />
      <Field
        label="Needed / got"
        value={`${deal.requiredDiscountPctDisplay.toFixed(0)}% / ${deal.discountPctDisplay.toFixed(0)}%`}
      />
    </div>
  );
}

function Field({ label, value, tone, title }: {
  label: string; value: string; tone?: "success" | "muted"; title?: string;
}) {
  return (
    <div title={title}>
      <div className="uppercase tracking-wider text-[10px] text-[color:var(--color-muted)]">{label}</div>
      <div
        className="font-medium"
        style={tone === "success" ? { color: "var(--color-success)" } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

/** Human-readable rung names. The machine vocabulary is fmvRung.ts;
 *  this only renames it for display and never reinterprets it. */
function rungLabel(rung: string | null): string {
  if (!rung) return "unknown";
  const named: Record<string, string> = {
    "exact-pool-projection": "This card's sales",
    "exact-pool-last-sale": "This card's last sale",
    "exact-pool-leading-edge": "This card's recent sales",
    "exact-pool-weighted-median": "This card's sales (thin)",
    "exact-pool-median": "This card's sales (median)",
    "exact-pool-trajectory": "This card's trajectory",
    "cross-grade-fallback": "Another grade, rescaled",
    "grade-curve-estimate": "Grade curve estimate",
    "graded-pool-inverse": "Its own graded sales",
    "player-index-projection": "Player trend (speculative)",
    "sibling-estimate": "A sibling card",
    "cross-parallel": "A neighbouring parallel",
    "neighbor-parallel": "A neighbouring parallel",
    "sibling-parallel": "A sibling parallel",
    "family-baseline": "Product family baseline",
    "product-tier": "Product tier",
  };
  return named[rung] ?? rung;
}

/** The "why isn't X here?" section. A user who put a card on their list
 *  and sees no deal deserves to know whether it's because nothing is
 *  listed, or because we don't trust the price enough to judge. */
function SkippedSection({ skipped }: { skipped: BuyerIqSkippedTarget[] }) {
  const [open, setOpen] = useState(false);
  const reasons: Record<BuyerIqSkippedTarget["reason"], string> = {
    "no-basis": "No pricing basis — we have no projection for this card, so there's nothing to discount from.",
    "speculative-confidence": "Projection is speculative (stale anchor carried on the player's trend). We won't call a deal off a guess.",
    "below-threshold": "Listed, but not far enough under its projection.",
    "no-listing-price": "Listing had no usable price.",
    "no-listings": "Nothing matching is listed right now.",
    "no-player-name": "Target has no player name.",
    // CF-BUYERIQ-GRADE-AWARE-MATCH (2026-09-03). Identity includes the
    // grade tier, so these say "there ARE listings, they're just not
    // your card" — which is a different and more useful answer than
    // "nothing is listed".
    "grade-unknown":
      "Listings found, but their titles don't state a grade — we can't tell which tier they're in, so we didn't score them.",
    "listing-raw-target-graded":
      "The listings we found are raw. Your target is graded, and a raw card isn't a discount on a slab.",
    "listing-graded-target-raw":
      "The listings we found are graded. Your target is raw, and they price off a different pool.",
    "grade-company-mismatch":
      "Listings found, but graded by a different company than your target.",
    "grade-value-mismatch":
      "Listings found, but at a different grade than your target. Each grade has its own price.",
  };
  return (
    <div className="mt-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-sm text-[color:var(--color-muted)] hover:opacity-80"
      >
        {open ? "Hide" : "Show"} {skipped.length} target{skipped.length === 1 ? "" : "s"} with no deal
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          {skipped.map((s) => (
            <div key={s.targetId} className="hiq-card p-3 text-xs">
              <div className="font-medium">{s.playerName || "(unnamed target)"}</div>
              <div className="text-[color:var(--color-muted)] mt-0.5">{reasons[s.reason]}</div>
              {s.basis && (
                <div className="text-[color:var(--color-muted)] mt-1">
                  Best ask was {(s.basis.discountPct * 100).toFixed(0)}% under a $
                  {s.basis.projection.toFixed(2)} projection; needed{" "}
                  {(s.basis.requiredDiscountPct * 100).toFixed(0)}% at{" "}
                  {Math.round(s.basis.confidence * 100)}% confidence.
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
