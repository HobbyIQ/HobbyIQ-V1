"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CatalogPickerModal } from "@/components/CatalogPickerModal";
import {
  fetchEbayStatus,
  fetchEbayConnectUrl,
  reconnectEbay,
  disconnectEbay,
  fetchEbayPolicies,
  fetchPortfolio,
  fetchEbayOfferStatus,
  endEbayListing,
  importEbayPurchases,
  type CatalogSearchHit,
  fetchPendingReviewHoldings,
  generatePendingReviewSuggestions,
  confirmPendingReviewHolding,
  confirmPendingReviewHoldingsBatch,
  BATCH_CONFIRM_MAX,
  backfillPurchaseHoldings,
  type EbayStatus,
  type EbayPoliciesResponse,
  type EbayOfferStatus,
  type PortfolioHolding,
  type EbayImportSummary,
  type PendingReviewHolding,
  type BatchConfirmItemResult,
} from "@/lib/api";
import { formatUSD, formatCardTitle } from "@/lib/format";
import { EbayListModal } from "@/components/EbayListModal";
import { describeEbayConnection } from "@/lib/ebayConnection";

export default function EbayPage() {
  const [status, setStatus] = useState<EbayStatus | null>(null);
  const [policies, setPolicies] = useState<EbayPoliciesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // On return from OAuth, backend may redirect back with ?connected=true
    const url = new URL(window.location.href);
    if (url.searchParams.get("connected") === "true") {
      setBanner("Connected to eBay successfully.");
      window.history.replaceState({}, "", "/app/ebay");
    } else if (url.searchParams.get("error")) {
      setBanner(`eBay connect failed: ${url.searchParams.get("error")}`);
      window.history.replaceState({}, "", "/app/ebay");
    }

    fetchEbayStatus()
      .then(async (s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.connected) {
          try {
            const p = await fetchEbayPolicies();
            if (!cancelled) setPolicies(p);
          } catch {
            /* non-fatal */
          }
        }
        setLoading(false);
      })
      .catch((err: { status?: number; message?: string }) => {
        if (cancelled) return;
        setError(err.message ?? "Failed to load eBay status");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function onConnect() {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetchEbayConnectUrl();
      // Redirect the whole browser to eBay OAuth so the callback lands
      // cleanly back on the API which then bounces back to /app/ebay.
      window.location.href = res.authUrl;
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to start connect flow");
      setConnecting(false);
    }
  }

  async function onReconnect() {
    setConnecting(true);
    setError(null);
    try {
      const res = await reconnectEbay();
      window.location.href = res.authUrl;
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to reconnect");
      setConnecting(false);
    }
  }

  async function onDisconnect() {
    if (!confirm("Disconnect your eBay account? You can reconnect anytime.")) return;
    setDisconnecting(true);
    setError(null);
    try {
      await disconnectEbay();
      setStatus({ success: true, connected: false });
      setPolicies(null);
      setBanner("Disconnected.");
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-1">eBay</h1>
        <p className="text-sm text-[color:var(--color-muted)]">
          Connect your eBay seller account for one-click listing drafts from your
          portfolio, automatic sales sync back into your holdings + comp pool, and
          shipping-policy management.
        </p>
      </div>

      {banner && (
        <div
          className="hiq-card p-4 mb-6 text-sm"
          style={{
            background: "color-mix(in oklab, var(--color-accent) 10%, transparent)",
            color: "var(--color-accent)",
          }}
        >
          {banner}
        </div>
      )}
      {error && (
        <div className="hiq-card p-4 mb-6 text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {loading && <div className="text-sm text-[color:var(--color-muted)]">Loading eBay status…</div>}

      {!loading && status && !status.connected && (
        <div className="hiq-card p-8 text-center">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ background: "var(--color-bg)" }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" style={{ color: "var(--color-accent)" }}>
              <path d="M20 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V6a2 2 0 00-2-2zM12 15l-6-6h4V6h4v3h4l-6 6z" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold mb-3">Connect your eBay account</h2>
          <p className="text-[color:var(--color-muted)] mb-6 max-w-xl mx-auto leading-relaxed">
            One authorization gets you: listing drafts from any holding, sales sync back
            into your portfolio + comp pool, and access to your shipping / return / payment
            policies. You&apos;ll authorize HobbyIQ on eBay&apos;s site — we never see your
            eBay password.
          </p>
          <button
            onClick={onConnect}
            disabled={connecting}
            className="hiq-btn-primary disabled:opacity-60"
          >
            {connecting ? "Starting…" : "Connect eBay"}
          </button>
        </div>
      )}

      {/* CF-EBAY-RECONNECT-SURFACE (found by #1721). `status.connected` is
          TRUE even when eBay has already refused the refresh token — a token
          record still exists — so this branch used to paint a green dot and
          the word "Connected" over a connection that had been dead since
          2026-08-31 for two real users, with purchases silently not syncing.
          The state now comes from describeEbayConnection(), which reads the
          `status` field the backend has returned since D26. */}
      {!loading && status && status.connected && (
        <>
          {(() => {
            const conn = describeEbayConnection(status);
            const broken = conn.needsReconnect;
            const accent = broken ? "var(--color-warning)" : "var(--color-success)";
            return (
              <div
                className="hiq-card p-6 mb-6"
                style={
                  broken
                    ? {
                        borderColor: "color-mix(in oklab, var(--color-warning) 45%, transparent)",
                        background: "color-mix(in oklab, var(--color-warning) 8%, var(--hiq-card-navy))",
                      }
                    : undefined
                }
              >
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-[200px] flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: accent }} />
                      <span
                        className="text-sm font-medium"
                        style={broken ? { color: "var(--color-warning)" } : undefined}
                      >
                        {conn.label}
                      </span>
                    </div>
                    <div className="text-lg font-bold mb-1">
                      {status.connectedUser ?? status.ebayUserId ?? "eBay account"}
                    </div>
                    {broken && (
                      <p className="text-sm leading-relaxed mt-2 mb-1 text-[color:var(--color-muted)]">
                        {conn.detail}
                      </p>
                    )}
                    {broken && conn.reason && (
                      <p className="text-xs mb-2 text-[color:var(--color-muted)] opacity-80">
                        eBay said: {conn.reason}
                      </p>
                    )}
                    <div className="text-xs text-[color:var(--color-muted)] space-y-0.5">
                      {status.connectedAt && (
                        <div>Since {status.connectedAt.slice(0, 10)}</div>
                      )}
                      {!broken && status.refreshTokenExpiresAt && (
                        <div>
                          Refresh token expires{" "}
                          {new Date(status.refreshTokenExpiresAt).toISOString().slice(0, 10)}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={onReconnect}
                      disabled={connecting}
                      className={`${broken ? "hiq-btn-primary" : "hiq-btn-secondary"} text-sm disabled:opacity-60`}
                    >
                      {connecting ? "…" : broken ? "Reconnect eBay" : "Reconnect"}
                    </button>
                    <button
                      onClick={onDisconnect}
                      disabled={disconnecting}
                      className="hiq-btn-secondary text-sm disabled:opacity-60"
                      style={{ color: "var(--color-danger)" }}
                    >
                      {disconnecting ? "…" : "Disconnect"}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <PolicyCard
              title="Payment policies"
              count={policies?.paymentPolicies?.length ?? 0}
              policies={policies?.paymentPolicies}
            />
            <PolicyCard
              title="Return policies"
              count={policies?.returnPolicies?.length ?? 0}
              policies={policies?.returnPolicies}
            />
            <PolicyCard
              title="Shipping policies"
              count={policies?.fulfillmentPolicies?.length ?? 0}
              policies={policies?.fulfillmentPolicies}
            />
          </div>

          <ImportPurchasesSection />
          <ReviewQueueSection />
          <LiveListingsSection />
          {/* CF-UX-CLEANUP (Drew, 2026-07-27): "Next steps" filler card
              removed — its only CTA was "Open portfolio" which is one
              click away in the sidebar anyway. */}
        </>
      )}
    </div>
  );
}

function LiveListingsSection() {
  const [holdings, setHoldings] = useState<PortfolioHolding[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, EbayOfferStatus | { error: string }>>({});
  const [ending, setEnding] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [revising, setRevising] = useState<{ holdingId: string; offerId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const port = await fetchPortfolio();
        if (cancelled) return;
        const listed = port.items.filter((h) => h.ebayOfferId && h.ebayListingId);
        setHoldings(listed);

        // Fan-out per-offer status. Parallel is fine — eBay's Sell API
        // handles single-offer reads well and the offer count is small.
        const results = await Promise.allSettled(
          listed.map((h) => fetchEbayOfferStatus(h.ebayOfferId as string)),
        );
        if (cancelled) return;
        const nextStatuses: Record<string, EbayOfferStatus | { error: string }> = {};
        results.forEach((res, i) => {
          const offerId = listed[i].ebayOfferId as string;
          if (res.status === "fulfilled") {
            nextStatuses[offerId] = res.value;
          } else {
            nextStatuses[offerId] = { error: (res.reason as { message?: string })?.message ?? "eBay error" };
          }
        });
        setStatuses(nextStatuses);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setHoldings([]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onEnd(h: PortfolioHolding) {
    const offerId = h.ebayOfferId;
    if (!offerId) return;
    if (!confirm(`End the eBay listing for ${formatCardTitle(h)}?`)) return;
    setEnding((prev) => ({ ...prev, [offerId]: true }));
    try {
      const res = await endEbayListing(offerId);
      if (res.success) {
        setHoldings((prev) => (prev ? prev.filter((x) => x.id !== h.id) : prev));
      } else {
        alert(res.error ?? "End failed.");
      }
    } catch (err) {
      alert((err as { message?: string }).message ?? "End failed.");
    } finally {
      setEnding((prev) => ({ ...prev, [offerId]: false }));
    }
  }

  if (loading) {
    return (
      <div className="hiq-card p-6 mb-6">
        <h2 className="font-bold text-lg mb-2">Live listings</h2>
        <div className="text-sm text-[color:var(--color-muted)]">Loading your active listings…</div>
      </div>
    );
  }

  if (!holdings || holdings.length === 0) {
    return null;   // nothing to show — hide the section when no listings exist
  }

  return (
    <div className="hiq-card p-6 mb-6">
      <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="font-bold text-lg">Live listings</h2>
          <p className="text-xs text-[color:var(--color-muted)] mt-1">
            Active offers from your portfolio. Status is fetched live from eBay.
          </p>
        </div>
        <span className="text-xs text-[color:var(--color-muted)]">
          {holdings.length} listing{holdings.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="space-y-2">
        {holdings.map((h) => {
          const offerId = h.ebayOfferId as string;
          const s = statuses[offerId];
          const isError = s && "error" in s;
          const status = s && !isError ? (s as EbayOfferStatus) : null;
          return (
            <div
              key={h.id}
              className="flex items-center gap-4 p-3 rounded-lg"
              style={{ background: "var(--color-bg)" }}
            >
              <div className="flex-1 min-w-0">
                <Link
                  href={`/app/portfolio/${encodeURIComponent(h.id)}`}
                  className="text-sm font-medium hover:underline truncate block"
                >
                  {formatCardTitle(h)}
                </Link>
                <div className="text-xs text-[color:var(--color-muted)] mt-0.5 flex items-center gap-3 flex-wrap">
                  {status?.status && (
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide"
                      style={{
                        background:
                          status.status.toUpperCase() === "PUBLISHED"
                            ? "color-mix(in oklab, var(--color-success) 15%, transparent)"
                            : "color-mix(in oklab, var(--color-accent) 15%, transparent)",
                        color:
                          status.status.toUpperCase() === "PUBLISHED"
                            ? "var(--color-success)"
                            : "var(--color-accent)",
                      }}
                    >
                      {status.status}
                    </span>
                  )}
                  {isError && (
                    <span style={{ color: "var(--color-danger)" }}>eBay status error</span>
                  )}
                  {status?.price != null && (
                    <span className="tabular-nums">
                      {formatUSD(status.price, { hideCents: status.price >= 100 })}
                    </span>
                  )}
                  {h.ebayListingPublishedAt && (
                    <span>listed {h.ebayListingPublishedAt.slice(0, 10)}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {status?.listingUrl && (
                  <a
                    href={status.listingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hiq-btn-secondary text-xs"
                  >
                    View on eBay ↗
                  </a>
                )}
                <button
                  onClick={() => setRevising({ holdingId: h.id, offerId })}
                  className="hiq-btn-secondary text-xs"
                >
                  Revise
                </button>
                <button
                  onClick={() => onEnd(h)}
                  disabled={!!ending[offerId]}
                  className="hiq-btn-secondary text-xs disabled:opacity-40"
                  style={{ color: "var(--color-danger)" }}
                >
                  {ending[offerId] ? "Ending…" : "End"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {revising && (
        <EbayListModal
          holdingId={revising.holdingId}
          reviseOfferId={revising.offerId}
          onClose={() => setRevising(null)}
          onPublished={() => setRevising(null)}
        />
      )}
    </div>
  );
}

function PolicyCard({
  title,
  count,
  policies,
}: {
  title: string;
  count: number;
  policies: Array<{ name?: string; description?: string }> | undefined;
}) {
  return (
    <div className="hiq-card p-4">
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-xs uppercase tracking-wide text-[color:var(--color-muted)] font-medium">
          {title}
        </div>
        <div className="text-lg font-bold tabular-nums">{count}</div>
      </div>
      {policies && policies.length > 0 && (
        <div className="mt-3 space-y-1 border-t border-[color:var(--color-border)] pt-3">
          {policies.slice(0, 3).map((p, i) => (
            <div key={i} className="text-xs">
              <div className="text-white truncate">{p.name ?? "Unnamed"}</div>
              {p.description && (
                <div className="text-[color:var(--color-muted)] truncate">
                  {p.description}
                </div>
              )}
            </div>
          ))}
          {policies.length > 3 && (
            <div className="text-xs text-[color:var(--color-muted)] pt-1">
              + {policies.length - 3} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// CF-EBAY-IMPORT-WEB (Drew, 2026-08-03). Trigger a 30/60/90-day
// purchase import from the /app/ebay page. Backend routes each result
// through the review queue (EBAY_IMPORT_FORCE_REVIEW=true) — nothing
// auto-lands in inventory.
function ImportPurchasesSection() {
  const [days, setDays] = useState<7 | 30 | 60 | 90>(30);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<EbayImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
    setRunning(true);
    setError(null);
    try {
      const res = await importEbayPurchases(days);
      setSummary(res);
      generatePendingReviewSuggestions().catch(() => {});
      window.dispatchEvent(new CustomEvent("hiq:review-queue-refresh"));
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Import failed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="hiq-card p-6 mb-6">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h2 className="text-xl font-bold mb-1">Import eBay purchases</h2>
          <p className="text-xs text-[color:var(--color-muted)]">
            Pulls your buy history and queues each purchase for match review.
            Nothing lands in inventory until you confirm the identity.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 60 | 90)}
            disabled={running}
            className="text-sm px-3 py-2 rounded-lg border outline-none focus:border-[color:var(--color-accent)] transition-colors"
            style={{
              background: "var(--color-bg)",
              borderColor: "var(--color-border)",
              color: "white",
              colorScheme: "dark",
            }}
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
          <button
            onClick={onRun}
            disabled={running}
            className="hiq-btn-primary text-sm disabled:opacity-60"
          >
            {running ? "Importing…" : "Import now"}
          </button>
        </div>
      </div>
      {error && (
        <div className="text-sm mb-3" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
      {summary && (
        <div className="text-sm border-t border-[color:var(--color-border)] pt-4 space-y-1">
          <div>
            <span className="text-[color:var(--color-muted)]">Fetched from eBay:</span>{" "}
            <span className="font-bold tabular-nums">{summary.fetched}</span>
          </div>
          <div>
            <span className="text-[color:var(--color-muted)]">New purchases imported:</span>{" "}
            <span className="font-bold tabular-nums">{summary.imported}</span>
          </div>
          <div>
            <span className="text-[color:var(--color-muted)]">Already in system (deduped):</span>{" "}
            <span className="font-bold tabular-nums">{summary.replayHits}</span>
          </div>
          <div>
            <span className="text-[color:var(--color-muted)]">Queued for match review:</span>{" "}
            <span className="font-bold tabular-nums">{summary.holdingsNeedingReview}</span>
          </div>
          {summary.holdingsCreated > 0 && (
            <div>
              <span className="text-[color:var(--color-muted)]">Auto-created (existing config):</span>{" "}
              <span className="font-bold tabular-nums">{summary.holdingsCreated}</span>
            </div>
          )}
          {summary.errors > 0 && (
            <div style={{ color: "var(--color-danger)" }}>
              Errors: <span className="font-bold tabular-nums">{summary.errors}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// CF-EBAY-REVIEW-QUEUE-WEB (Drew, 2026-08-03). Renders pending-review
// holdings so users approve each match before it enters the portfolio.
function ReviewQueueSection() {
  const [holdings, setHoldings] = useState<PendingReviewHolding[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<Record<string, boolean>>({});
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);

  // CF-APPROVE-MULTIPLES (Drew, 2026-08-31). Which rows are ticked, and the
  // per-row outcome of the last batch. rowStatus is keyed by holding id and
  // survives the row leaving the list only for rows that FAILED — a confirmed
  // row is removed outright, which is the optimistic part.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [rowStatus, setRowStatus] = useState<
    Record<string, { status: BatchConfirmItemResult["status"]; reason?: string }>
  >({});
  const [batchMsg, setBatchMsg] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPendingReviewHoldings();
      setHoldings(res.holdings ?? []);
      // A reload is a fresh queue: stale ticks would silently re-approve rows
      // the user never looked at.
      setSelected(new Set());
      setRowStatus({});
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Failed to load review queue");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const handler = () => { void load(); };
    window.addEventListener("hiq:review-queue-refresh", handler);
    return () => window.removeEventListener("hiq:review-queue-refresh", handler);
  }, []);

  async function onRetryMatch() {
    setBackfilling(true);
    setBackfillMsg(null);
    setError(null);
    try {
      // 1. Run auto-holding batch pass — re-parses every orphan
      //    purchase and creates pending-review holdings for parseable
      //    rows. Used to recover after a parser fix ships.
      const bf = await backfillPurchaseHoldings();
      // 2. Fire-and-forget cardId suggester so each pending-review row
      //    lands with a pre-filled match hint. Failure is soft.
      generatePendingReviewSuggestions().catch(() => {});
      const created = bf.holdingsNeedingReview ?? bf.holdingsCreated ?? 0;
      const processed = bf.processed ?? 0;
      setBackfillMsg(
        created > 0
          ? `Auto-matched ${created} purchase${created === 1 ? "" : "s"} (of ${processed} processed). Generating card suggestions…`
          : `Processed ${processed} purchase${processed === 1 ? "" : "s"}, no new matches — parse confidence too low.`,
      );
      // Re-poll a few times so suggestions land in the visible list.
      await load();
      setTimeout(() => { void load(); }, 4000);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Retry match failed");
    } finally {
      setBackfilling(false);
    }
  }

  // CF-SEARCH-AND-PICK (Drew, 2026-08-23). Which holding is being identified,
  // or null when the picker is closed.
  const [picking, setPicking] = useState<PendingReviewHolding | null>(null);
  const [pickBusy, setPickBusy] = useState(false);

  // The pick IS the identity. Confirming with cardId makes the backend adopt
  // that catalog row's fields wholesale, so the holding's set/parallel can
  // never disagree with its slug — that disagreement is what prices a card off
  // the wrong pool.
  async function onPickCard(holdingId: string, hit: CatalogSearchHit) {
    setPickBusy(true);
    try {
      await confirmPendingReviewHolding(holdingId, { cardId: hit.slug });
      setHoldings((prev) => (prev ?? []).filter((h) => h.id !== holdingId));
      setPicking(null);
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Could not attach that card");
    } finally {
      setPickBusy(false);
    }
  }

  async function onApprove(id: string) {
    setApproving((prev) => ({ ...prev, [id]: true }));
    try {
      await confirmPendingReviewHolding(id, {});
      setHoldings((prev) => (prev ?? []).filter((h) => h.id !== id));
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Approve failed");
    } finally {
      setApproving((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  const visibleIds = (holdings ?? []).map((h) => h.id);
  const selectedVisible = visibleIds.filter((id) => selected.has(id));
  const allVisibleSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelected(allVisibleSelected ? new Set() : new Set(visibleIds));
  }

  // CF-APPROVE-MULTIPLES (Drew, 2026-08-31). One request per chunk of
  // BATCH_CONFIRM_MAX; the server caps the batch because each holding still
  // costs its own catalog work even though the 1.7 MB portfolio doc read/write
  // is amortized across the whole batch.
  async function onApproveSelected() {
    const ids = selectedVisible;
    if (ids.length === 0) return;
    setBatchBusy(true);
    setError(null);
    setBatchMsg(null);
    setRowStatus({});

    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += BATCH_CONFIRM_MAX) {
      chunks.push(ids.slice(i, i + BATCH_CONFIRM_MAX));
    }

    try {
      const all: BatchConfirmItemResult[] = [];
      for (const chunk of chunks) {
        const res = await confirmPendingReviewHoldingsBatch(chunk);
        all.push(...(res.results ?? []));
      }

      const confirmedIds = new Set(
        all.filter((r) => r.status === "confirmed").map((r) => r.holdingId),
      );
      const failures = all.filter((r) => r.status !== "confirmed");

      // Optimistic: confirmed rows leave the queue immediately. Failures stay
      // put, carrying the reason they did not land, so nothing disappears
      // silently.
      setHoldings((prev) => (prev ?? []).filter((h) => !confirmedIds.has(h.id)));
      setSelected(new Set(failures.map((r) => r.holdingId)));
      setRowStatus(
        Object.fromEntries(failures.map((r) => [r.holdingId, { status: r.status, reason: r.reason }])),
      );

      setBatchMsg(
        failures.length === 0
          ? `Approved ${confirmedIds.size} card${confirmedIds.size === 1 ? "" : "s"}.`
          : `Approved ${confirmedIds.size} of ${all.length}. ${failures.length} still need attention.`,
      );
    } catch (err) {
      const e = err as { message?: string };
      setError(e.message ?? "Batch approve failed");
    } finally {
      setBatchBusy(false);
    }
  }

  function labelForRowStatus(s: BatchConfirmItemResult["status"], reason?: string): string {
    if (s === "not-pending") return "Already approved elsewhere — refresh";
    if (s === "not-found") return "No longer in your queue — refresh";
    return reason ? `Failed: ${reason}` : "Failed";
  }

  return (
    <div className="hiq-card p-6 mb-6">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold mb-1">
            Match review{" "}
            {holdings && holdings.length > 0 && (
              <span className="text-sm font-normal text-[color:var(--color-muted)]">
                ({holdings.length})
              </span>
            )}
          </h2>
          <p className="text-xs text-[color:var(--color-muted)]">
            Confirm the auto-suggested identity for each imported purchase.
            Approved cards land in your portfolio.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void onRetryMatch()}
            disabled={backfilling || loading}
            className="hiq-btn-primary text-xs disabled:opacity-60"
            title="Re-parse every orphan purchase and auto-match cards"
          >
            {backfilling ? "Matching…" : "Auto-match now"}
          </button>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="hiq-btn-secondary text-xs disabled:opacity-60"
          >
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>
      {backfillMsg && (
        <div className="text-sm mb-3 text-[color:var(--color-muted)]">
          {backfillMsg}
        </div>
      )}
      {/* CF-APPROVE-MULTIPLES (Drew, 2026-08-31). Bulk bar — only meaningful
          when there is more than one row to act on. */}
      {holdings && holdings.length > 0 && (
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              ref={(el) => {
                if (el) el.indeterminate = selectedVisible.length > 0 && !allVisibleSelected;
              }}
              onChange={toggleSelectAllVisible}
              disabled={batchBusy}
              aria-label="Select all visible"
            />
            Select all ({visibleIds.length})
          </label>
          <button
            onClick={() => void onApproveSelected()}
            disabled={batchBusy || selectedVisible.length === 0}
            className="hiq-btn-primary text-xs disabled:opacity-60"
          >
            {batchBusy
              ? `Approving ${selectedVisible.length}…`
              : `Approve selected${selectedVisible.length > 0 ? ` (${selectedVisible.length})` : ""}`}
          </button>
          {batchMsg && (
            <span className="text-xs text-[color:var(--color-muted)]">{batchMsg}</span>
          )}
        </div>
      )}
      {error && (
        <div className="text-sm mb-3" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}
      {loading && !holdings && (
        <div className="text-sm text-[color:var(--color-muted)]">Loading…</div>
      )}
      {!loading && holdings && holdings.length === 0 && (
        <div className="text-sm text-[color:var(--color-muted)]">
          Nothing to review. Import purchases above to populate this queue.
        </div>
      )}
      {holdings && holdings.length > 0 && (
        <div className="space-y-2">
          {holdings.map((h) => {
            const suggested = h.suggestion?.displayTitle || h.cardTitle || h.notes || "(no title)";
            const parts = [
              h.cardYear ? String(h.cardYear) : null,
              h.setName,
              h.playerName,
              h.cardNumber ? `#${h.cardNumber}` : null,
              h.parallel && h.parallel.toLowerCase() !== "base" ? h.parallel : null,
              h.isAuto ? "Auto" : null,
              h.gradeCompany ? `${h.gradeCompany} ${h.gradeValue ?? ""}`.trim() : null,
            ].filter(Boolean) as string[];
            const detail = parts.length > 0 ? parts.join(" · ") : "(identity pending)";
            const conf =
              typeof h.parseConfidence === "number"
                ? Math.round(h.parseConfidence * 100)
                : null;
            return (
              <div
                key={h.id}
                className="border border-[color:var(--color-border)] rounded p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(h.id)}
                    onChange={() => toggleRow(h.id)}
                    disabled={batchBusy || !!approving[h.id]}
                    aria-label={`Select ${suggested}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {suggested}
                    </div>
                    {rowStatus[h.id] && (
                      <div
                        className="text-xs mt-1"
                        style={{ color: "var(--color-danger)" }}
                      >
                        {labelForRowStatus(rowStatus[h.id].status, rowStatus[h.id].reason)}
                      </div>
                    )}
                    <div className="text-xs text-[color:var(--color-muted)] mt-1">
                      {detail}
                    </div>
                    <div className="text-xs text-[color:var(--color-muted)] mt-1 flex gap-3 flex-wrap">
                      {conf !== null && <span>Match confidence: {conf}%</span>}
                      {typeof h.totalCostBasis === "number" && (
                        <span>Cost: {formatUSD(h.totalCostBasis)}</span>
                      )}
                      {h.purchaseDate && (
                        <span>Purchased: {h.purchaseDate.slice(0, 10)}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => void onApprove(h.id)}
                      disabled={!!approving[h.id]}
                      className="hiq-btn-primary text-xs disabled:opacity-60"
                    >
                      {approving[h.id] ? "…" : "Approve"}
                    </button>
                    <button
                      onClick={() => setPicking(h)}
                      className="hiq-btn-secondary text-xs"
                    >
                      Find card
                    </button>
                    <Link
                      href={`/app/portfolio/${encodeURIComponent(h.id)}`}
                      className="hiq-btn-secondary text-xs text-center"
                    >
                      Edit
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* CF-SEARCH-AND-PICK (Drew, 2026-08-23). Opens pre-searched on the
          holding's own details and ranked against them, so the right card is
          usually the first row rather than something to go hunting for. */}
      <CatalogPickerModal
        open={picking !== null}
        busy={pickBusy}
        initialQuery={
          picking
            ? [
                picking.cardYear ? String(picking.cardYear) : null,
                picking.setName,
                picking.playerName,
                picking.cardNumber ? `#${picking.cardNumber}` : null,
              ].filter(Boolean).join(" ")
            : ""
        }
        context={
          picking
            ? {
                cardNumber: picking.cardNumber ?? null,
                year: picking.cardYear ?? null,
                setName: picking.setName ?? null,
                playerName: picking.playerName ?? null,
                isAuto: picking.isAuto ?? null,
              }
            : undefined
        }
        onPick={(hit) => { if (picking) void onPickCard(picking.id, hit); }}
        onClose={() => setPicking(null)}
      />
    </div>
  );
}
