"use client";

/**
 * CF-EBAY-RECONNECT-SURFACE (found by #1721).
 *
 * A dead eBay connection is silent by design everywhere else: the refresh
 * fails in a background job, the backend flips `connectionStatus` to
 * "reconnect-required", and nothing at the glass ever said so. Two real users
 * sat in that state from 2026-08-31 with purchases not syncing.
 *
 * This banner is the prompt. It renders on DailyIQ — the page behind the nav
 * item everyone actually opens — and ONLY in the reconnect-required state.
 * A healthy connection and a never-connected account both render nothing:
 * a banner that shows for "you have not linked eBay" is a nag, and the
 * /app/ebay page already owns that pitch.
 */

import { useEffect, useState } from "react";
import { fetchEbayStatus, reconnectEbay } from "@/lib/api";
import { describeEbayConnection, type EbayConnectionView } from "@/lib/ebayConnection";

export function EbayReconnectBanner({ className }: { className?: string }) {
  const [view, setView] = useState<EbayConnectionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchEbayStatus()
      .then((s) => {
        if (!cancelled) setView(describeEbayConnection(s));
      })
      .catch(() => {
        // Non-fatal, and deliberately silent: a 403 here just means the
        // user has no eBay entitlement. Never turn a failed status read
        // into a scary banner.
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing to say unless the connection is actually broken.
  if (!view || !view.needsReconnect) return null;

  async function onReconnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await reconnectEbay();
      window.location.href = res.authUrl;
    } catch (err) {
      setError((err as { message?: string }).message ?? "Could not start the reconnect flow.");
      setBusy(false);
    }
  }

  return (
    <section
      role="alert"
      className={`hiq-card p-5 flex items-start gap-4 flex-wrap ${className ?? ""}`}
      style={{
        borderColor: "color-mix(in oklab, var(--color-warning) 45%, transparent)",
        background: "color-mix(in oklab, var(--color-warning) 8%, var(--hiq-card-navy))",
      }}
    >
      <span
        aria-hidden="true"
        className="mt-0.5 shrink-0"
        style={{ color: "var(--color-warning)" }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2L1 21h22L12 2zm0 6l7.5 13h-15L12 8zm-1 4v4h2v-4h-2zm0 5v2h2v-2h-2z" />
        </svg>
      </span>
      <div className="flex-1 min-w-[200px]">
        <div className="text-sm font-semibold mb-1" style={{ color: "var(--color-warning)" }}>
          eBay {view.label.toLowerCase()}
        </div>
        <p className="text-sm leading-relaxed text-[color:var(--color-muted)] m-0">
          {view.detail}
        </p>
        {view.reason && (
          <p className="text-xs mt-1 mb-0 text-[color:var(--color-muted)] opacity-80">
            eBay said: {view.reason}
          </p>
        )}
        {error && (
          <p className="text-xs mt-2 mb-0" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        )}
      </div>
      <button
        onClick={onReconnect}
        disabled={busy}
        className="hiq-btn-primary text-sm disabled:opacity-60 w-full sm:w-auto"
      >
        {busy ? "Starting…" : view.action?.label ?? "Reconnect eBay"}
      </button>
    </section>
  );
}
