"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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
  fetchPendingReviewHoldings,
  generatePendingReviewSuggestions,
  confirmPendingReviewHolding,
  type EbayStatus,
  type EbayPoliciesResponse,
  type EbayOfferStatus,
  type PortfolioHolding,
  type EbayImportSummary,
  type PendingReviewHolding,
} from "@/lib/api";
import { formatUSD, formatCardTitle } from "@/lib/format";
import { EbayListModal } from "@/components/EbayListModal";

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

      {!loading && status && status.connected && (
        <>
          <div className="hiq-card p-6 mb-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ background: "var(--color-success)" }}
                  />
                  <span className="text-sm font-medium">Connected</span>
                </div>
                <div className="text-lg font-bold mb-1">
                  {status.connectedUser ?? status.ebayUserId ?? "eBay account"}
                </div>
                <div className="text-xs text-[color:var(--color-muted)] space-y-0.5">
                  {status.connectedAt && (
                    <div>Since {status.connectedAt.slice(0, 10)}</div>
                  )}
                  {status.refreshTokenExpiresAt && (
                    <div>
                      Refresh token expires{" "}
                      {new Date(status.refreshTokenExpiresAt).toISOString().slice(0, 10)}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={onReconnect}
                  disabled={connecting}
                  className="hiq-btn-secondary text-sm disabled:opacity-60"
                >
                  {connecting ? "…" : "Reconnect"}
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
            className="hiq-input text-sm px-3 py-2"
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

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPendingReviewHoldings();
      setHoldings(res.holdings ?? []);
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
        <button
          onClick={() => void load()}
          disabled={loading}
          className="hiq-btn-secondary text-xs disabled:opacity-60"
        >
          {loading ? "…" : "Refresh"}
        </button>
      </div>
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
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {suggested}
                    </div>
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
    </div>
  );
}
