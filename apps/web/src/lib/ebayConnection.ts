/**
 * CF-EBAY-RECONNECT-SURFACE (found by #1721).
 *
 * The backend has known since D26 that a connection can be *present but
 * dead*: `getConnectionStatus` returns `status: "reconnect-required"` with a
 * `reconnectReason` and `reconnectRequiredAt` whenever eBay has refused the
 * refresh token. `connected` stays TRUE in that case — a record still exists.
 *
 * No client ever read it. Both the web page and the iOS view branched on
 * `connected` alone, so a dead connection rendered as "Connected" with a
 * green dot and a generic always-visible "Reconnect" button that said nothing
 * about why it was there. Two real users sat in that state from 2026-08-31
 * with purchases silently not syncing and no prompt telling them so.
 *
 * This module is the missing read. It collapses the wire shape into the three
 * states the glass actually has to distinguish, and owns the words for each —
 * kept pure (no React, no fetch) so vitest can pin them in the node lane.
 *
 * The load-bearing rule: `connected === true` is NOT "healthy". Only
 * `connected && status !== "reconnect-required"` is healthy. Anything that
 * drops the reconnect-required branch puts a broken connection back behind a
 * green dot, which is the exact bug this fixes.
 */

/** The wire fields this module reads. Mirrors EbayStatus in lib/api.ts,
 *  which mirrors getConnectionStatus() in backend ebayAuth.service.ts. */
export interface EbayConnectionWire {
  connected?: boolean;
  status?: "ok" | "reconnect-required" | string | null;
  reconnectReason?: string | null;
  reconnectRequiredAt?: string | null;
}

export type EbayConnectionState = "connected" | "reconnect-required" | "not-connected";

export interface EbayConnectionView {
  state: EbayConnectionState;
  /** True only for the state that needs the user to act right now. */
  needsReconnect: boolean;
  /** Short label next to the status dot. */
  label: string;
  /** Plain-words explanation. Never null for reconnect-required. */
  detail: string;
  /** The single action, or null when there is nothing to do. */
  action: { label: string; kind: "connect" | "reconnect" } | null;
  /** Raw reason from eBay, surfaced as secondary text. Null when healthy
   *  or when the backend recorded no reason. */
  reason: string | null;
  /** ISO date (YYYY-MM-DD) the connection broke, or null if unknown. */
  brokeOn: string | null;
}

/** YYYY-MM-DD from an ISO timestamp, or null if it is not a usable date.
 *  An unparseable date is never guessed at — the sentence drops the date
 *  rather than printing "Invalid Date" at a user. */
export function reconnectDate(iso: string | null | undefined): string | null {
  const s = String(iso ?? "").trim();
  if (s === "") return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The one place that decides which of the three states a status response is
 * in. `connected` alone cannot tell a working connection from a dead one.
 */
export function describeEbayConnection(
  wire: EbayConnectionWire | null | undefined,
): EbayConnectionView {
  if (!wire || wire.connected !== true) {
    return {
      state: "not-connected",
      needsReconnect: false,
      label: "Not connected",
      detail:
        "Connect your eBay account to sync purchases and sales into your portfolio.",
      action: { label: "Connect eBay", kind: "connect" },
      reason: null,
      brokeOn: null,
    };
  }

  if (wire.status === "reconnect-required") {
    const brokeOn = reconnectDate(wire.reconnectRequiredAt);
    const when = brokeOn ? ` on ${brokeOn}` : "";
    const rawReason = String(wire.reconnectReason ?? "").trim();
    return {
      state: "reconnect-required",
      needsReconnect: true,
      label: "Reconnect required",
      // Drew's framing: what happened, what it costs them, what to do.
      detail: `Your eBay connection stopped working${when}. Purchases are not syncing. Reconnect to resume.`,
      action: { label: "Reconnect eBay", kind: "reconnect" },
      reason: rawReason === "" ? null : rawReason,
      brokeOn,
    };
  }

  return {
    state: "connected",
    needsReconnect: false,
    label: "Connected",
    detail: "Purchases and sales are syncing.",
    action: null,
    reason: null,
    brokeOn: null,
  };
}
