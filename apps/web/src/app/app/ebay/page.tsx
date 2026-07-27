"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchEbayStatus,
  fetchEbayConnectUrl,
  reconnectEbay,
  disconnectEbay,
  fetchEbayPolicies,
  type EbayStatus,
  type EbayPoliciesResponse,
} from "@/lib/api";

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

          <div className="hiq-card p-6">
            <h2 className="font-bold text-lg mb-3">Next steps</h2>
            <p className="text-sm text-[color:var(--color-muted)] mb-4 leading-relaxed">
              Head to your{" "}
              <Link
                href="/app/portfolio"
                className="hover:underline"
                style={{ color: "var(--color-accent)" }}
              >
                portfolio
              </Link>{" "}
              — every holding will get a &ldquo;List on eBay&rdquo; action that generates a
              draft using the FMV as the suggested price and the card&apos;s metadata as
              the listing title. Approve → publish. Sales sync automatically feeds back
              into your holdings and our sold-comps pool.
            </p>
            <Link href="/app/portfolio" className="hiq-btn-primary text-sm inline-block">
              Open portfolio
            </Link>
          </div>
        </>
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
