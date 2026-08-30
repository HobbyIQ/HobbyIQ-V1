/**
 * eBay OAuth 2.0 per-user token management.
 *
 * Flow:
 *   1. GET  /api/ebay/connect/start       → redirect user to eBay auth page
 *   2. GET  /api/ebay/connect/callback    → exchange code for tokens, store per-user
 *   3. All listing calls call getAccessToken(userId) which auto-refreshes if needed
 *
 * Tokens are stored in-memory (keyed by userId) and persisted to a flat JSON
 * sidecar file so they survive restarts.  When Cosmos is available this can be
 * migrated to a dedicated container.
 *
 * Required env vars:
 *   EBAY_CLIENT_ID       — eBay App Client ID (also called App ID)
 *   EBAY_CLIENT_SECRET   — eBay Cert ID (client secret)
 *   EBAY_REDIRECT_URI    — RuName registered in your eBay developer dashboard
 *   EBAY_ENV             — "production" | "sandbox"  (default: sandbox)
 */

import crypto from "crypto";
import {

  EbayTokenRecord,
  readTokenRecord,
  writeTokenRecord,
  deleteTokenRecord,
  markReconnectRequired,

  connectionStatusOf,
} from "./ebayTokenStore.service.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SANDBOX = (process.env.EBAY_ENV ?? "sandbox") !== "production";

const EBAY_BASE_AUTH  = SANDBOX
  ? "https://auth.sandbox.ebay.com"
  : "https://auth.ebay.com";
const EBAY_BASE_API   = SANDBOX
  ? "https://api.sandbox.ebay.com"
  : "https://api.ebay.com";
// The Commerce Identity API lives on apiz.ebay.com (not api.ebay.com)
const EBAY_IDENTITY_API = SANDBOX
  ? "https://apiz.sandbox.ebay.com"
  : "https://apiz.ebay.com";

// Scopes needed for fixed-price sell listings + finances reconciliation
const REQUIRED_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.marketing",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  // CF-EBAY-FINANCES-SCOPE (2026-07-12, Drew — live E2E on prod): without
  // `sell.finances` the /sell/finances/v1/transaction endpoint returns 404
  // for every request, blocking the ENTIRE fee-enrichment pipeline. All
  // eBay-sourced ledger entries stay stuck at needsReconciliation=true
  // forever because the finances job can't find any transactions to
  // enrich. Verified live 2026-07-12 against Drew's justtheboysandcards
  // account: without this scope, `/finances/v1/transaction` +
  // `/finances/v1/payout` + `/finances/v1/seller_funds_summary` all 404'd
  // with empty body. Adding this scope + user reconnection unblocks the
  // whole /erp/pnl pipeline for eBay-sourced sales.
  "https://api.ebay.com/oauth/api_scope/sell.finances",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
].join(" ");

// ---------------------------------------------------------------------------
// PKCE state store (file-backed, survives restarts)
// ---------------------------------------------------------------------------
// PKCE state — self-contained HMAC-signed token
//
// The state parameter encodes {userId, codeVerifier, exp} as base64url JSON,
// signed with HMAC-SHA256.  No server-side store is needed, so this works
// correctly regardless of how many App Service instances are running.
// ---------------------------------------------------------------------------

// CF-AUTH-SESSION-SECRET-FAIL-CLOSED (Drew, 2026-07-26, prod-readiness
// audit P0.3). Same fail-closed guard as authService.ts — refuses to
// resolve if the shared secret is unset, blank, or matches the retired
// literal. If authService.ts already threw at boot the process died
// there; this second guard exists so any code path that imports THIS
// module without pulling in authService also fails visibly.
const RETIRED_DEFAULT_SECRET = "hobbyiq-admin-testing-session-secret";
function resolveStateSecret(): string {
  const raw = process.env.AUTH_SESSION_SECRET;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("AUTH_SESSION_SECRET is unset — ebayAuth cannot sign OAuth state. Set a high-entropy value in App Service.");
  }
  if (raw.trim() === RETIRED_DEFAULT_SECRET) {
    throw new Error("AUTH_SESSION_SECRET is the retired hardcoded default — ebayAuth refuses to sign OAuth state. Rotate immediately.");
  }
  if (raw.trim().length < 32) {
    throw new Error(`AUTH_SESSION_SECRET too short (length=${raw.trim().length}) — ebayAuth refuses. Minimum 32; recommended 64+.`);
  }
  return raw;
}
const STATE_SECRET = resolveStateSecret();

export type EbayAuthPlatform = "ios" | "web";

function buildState(userId: string, platform: EbayAuthPlatform): string {
  const payload = Buffer.from(JSON.stringify({
    userId,
    platform,
    exp: Date.now() + 10 * 60 * 1000,
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function parseState(state: string): { userId: string; platform: EbayAuthPlatform } | null {
  const dot = state.lastIndexOf(".");
  if (dot === -1) return null;
  const payload = state.slice(0, dot);
  const sig     = state.slice(dot + 1);
  const expected = crypto.createHmac("sha256", STATE_SECRET).update(payload).digest("base64url");
  // Constant-time compare
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected, "base64url"), Buffer.from(sig, "base64url"))) return null;
  } catch { return null; }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      userId: string; exp: number; platform?: string;
    };
    if (data.exp < Date.now()) return null;
    const platform: EbayAuthPlatform = data.platform === "web" ? "web" : "ios";
    return { userId: data.userId, platform };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Build the eBay OAuth authorization URL for this user.
 *  `platform` is encoded into the signed state so the OAuth callback can
 *  redirect back to the appropriate destination (iOS deep link vs the
 *  web app). Defaults to "ios" for iOS-app callers who never pass one. */
export function buildAuthUrl(userId: string, platform: EbayAuthPlatform = "ios"): string {
  // State is self-contained and HMAC-signed — no server-side store needed.
  // eBay does not support PKCE, so we use standard authorization code flow.
  const state = buildState(userId, platform);

  const params = new URLSearchParams({
    client_id:     process.env.EBAY_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri:  process.env.EBAY_REDIRECT_URI ?? "",
    scope:         REQUIRED_SCOPES,
    state,
  });

  return `${EBAY_BASE_AUTH}/oauth2/authorize?${params.toString()}`;
}

/** Exchange the auth code from eBay's callback for tokens and persist them.
 *  Returns the token record augmented with the platform hint from state
 *  so the route can decide where to redirect the browser. */
export async function handleCallback(
  code: string,
  state: string,
): Promise<EbayTokenRecord & { platform: EbayAuthPlatform }> {
  const pending = parseState(state);
  if (!pending) {
    throw new Error("Invalid or expired OAuth state parameter");
  }
  const { userId, platform } = pending;

  const body = new URLSearchParams({
    grant_type:   "authorization_code",
    code,
    redirect_uri: process.env.EBAY_REDIRECT_URI ?? "",
  });

  const tokenRes = await fetchEbayToken(body);

  // Fetch the eBay username via Identity API (uses apiz.ebay.com, not api.ebay.com)
  let ebayUserId = "unknown";
  try {
    const idRes = await fetch(`${EBAY_IDENTITY_API}/commerce/identity/v1/user/`, {
      headers: { Authorization: `Bearer ${tokenRes.access_token}` },
    });
    const idText = await idRes.text();
    console.log("[eBayAuth] Identity API status ->", idRes.status);
    // Identity body carries username + accountId — treat as sensitive PII
    // and don't stream it to stdout; parse silently. On failure the status
    // code is enough for debugging.
    if (idRes.ok) {
      const idData = JSON.parse(idText) as { username?: string; userId?: string };
      ebayUserId = idData.username ?? idData.userId ?? "unknown";
    }
  } catch (err) {
    console.log("[eBayAuth] Identity API error ->", err);
  }

  const record: EbayTokenRecord = {
    userId,
    ebayUserId,
    accessToken:            tokenRes.access_token,
    refreshToken:           tokenRes.refresh_token,
    accessTokenExpiresAt:   Date.now() + (tokenRes.expires_in - 60) * 1000,
    refreshTokenExpiresAt:  Date.now() + (tokenRes.refresh_token_expires_in - 60) * 1000,
    scopes:                 tokenRes.scope?.split(" ") ?? [],
    connectedAt:            new Date().toISOString(),
  };

  await writeTokenRecord(record);

  return { ...record, platform };
}

/**
 * D26 (Drew 2026-08-30). An eBay token failure that no retry can fix.
 *
 * eBay answers a dead / revoked refresh grant with `invalid_grant`, and the
 * OAuth token endpoint returns 400 or 401 for a credential problem. A 5xx, a
 * 429 or a socket error is the OTHER kind: transient, and marking a user
 * reconnect-required for one of those would log them out of their own sync
 * over a blip. Only the terminal shapes count.
 */
export function isTerminalTokenError(message: string): boolean {
  const m = String(message ?? "").toLowerCase();
  if (m.includes("refresh token expired")) return true;
  if (m.includes("not connected")) return false;
  if (m.includes("invalid_grant") || m.includes("invalid_client")) return true;
  if (m.includes("invalid_scope") || m.includes("unauthorized_client")) return true;
  // `fetchEbayToken` puts the HTTP status in the message ("eBay token
  // exchange failed: 400 ...").
  return /(400|401|403)/.test(m);
}

/** Returns a valid access token for the user, refreshing if needed. Throws if not connected. */
export async function getAccessToken(userId: string): Promise<string> {
  const record = await readTokenRecord(userId);
  if (!record) throw new Error("eBay account not connected for this user");

  if (Date.now() > record.refreshTokenExpiresAt) {
    // D26: this used to `deleteTokenRecord`. Deleting the record is why
    // `refreshExpired` read 0 on every cycle while two users failed forever —
    // the first expiry erased the evidence AND removed the user from
    // `listConnectedUserIds`, so nothing could ever show them a "Reconnect
    // eBay" button. An expired refresh token is inert; the record is the only
    // thing that can explain the state, so it stays and is MARKED.
    await markReconnectRequired(userId, "refresh token expired");
    throw new Error("eBay refresh token expired. Please reconnect your eBay account.");
  }

  if (Date.now() < record.accessTokenExpiresAt) {
    return record.accessToken;
  }

  // Refresh
  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: record.refreshToken,
    scope:         REQUIRED_SCOPES,
  });

  let tokenRes;
  try {
    tokenRes = await fetchEbayToken(body);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (isTerminalTokenError(msg)) {
      // The reason is eBay's own error code, never the token or the body.
      await markReconnectRequired(userId, `refresh rejected by eBay: ${msg.slice(0, 200)}`);
    }
    throw err;
  }

  record.accessToken          = tokenRes.access_token;
  record.accessTokenExpiresAt = Date.now() + (tokenRes.expires_in - 60) * 1000;
  if (tokenRes.refresh_token) {
    record.refreshToken            = tokenRes.refresh_token;
    record.refreshTokenExpiresAt   = Date.now() + (tokenRes.refresh_token_expires_in - 60) * 1000;
  }
  // A refresh that worked proves the connection is healthy again.
  record.connectionStatus        = "ok";
  record.connectionStatusReason  = null;
  await writeTokenRecord(record);

  return record.accessToken;
}

/** Returns connection status for a user (no tokens exposed). */
export async function getConnectionStatus(userId: string): Promise<{
  connected: boolean;
  ebayUserId?: string;
  connectedUser?: string;
  connectedAt?: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  /** D26. "ok" or "reconnect-required". A record exists either way, so
   *  `connected` alone cannot tell a working connection from a dead one —
   *  which is what the account page needs to know. Additive: a client that
   *  reads only `connected` behaves exactly as before. */
  status?: "ok" | "reconnect-required";
  /** Why re-authorisation is needed. Null when the connection is healthy. */
  reconnectReason?: string | null;
  reconnectRequiredAt?: string | null;
}> {
  const r = await readTokenRecord(userId);
  if (!r) return { connected: false };
  const status = connectionStatusOf(r);
  return {
    connected: true,
    ebayUserId: r.ebayUserId,
    connectedUser: r.ebayUserId,
    connectedAt: r.connectedAt,
    accessTokenExpiresAt: r.accessTokenExpiresAt,
    refreshTokenExpiresAt: r.refreshTokenExpiresAt,
    status,
    reconnectReason: status === "reconnect-required" ? (r.connectionStatusReason ?? null) : null,
    reconnectRequiredAt: status === "reconnect-required" ? (r.connectionStatusAt ?? null) : null,
  };
}

/** Remove a user's eBay connection. */
export async function disconnect(userId: string): Promise<void> {
  await deleteTokenRecord(userId);
}

export { EBAY_BASE_API, SANDBOX };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface EbayTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_token_expires_in: number;
  scope?: string;
}

async function fetchEbayToken(body: URLSearchParams): Promise<EbayTokenResponse> {
  const clientId     = process.env.EBAY_CLIENT_ID ?? "";
  const clientSecret = process.env.EBAY_CLIENT_SECRET ?? "";
  const credentials  = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const url = `${EBAY_BASE_API}/identity/v1/oauth2/token`;
  // NEVER echo body / access-tokens / refresh-tokens / clientId to stdout —
  // stdout is the leak surface (per memory feedback_secrets_never_to_stdout,
  // 2026-07-12 CF-EBAY-BROWSE-ENRICHMENT). Diagnostic scalars only.
  console.log("[eBayAuth] fetchEbayToken →", url);
  console.log("[eBayAuth] clientId length →", clientId.length);
  console.log("[eBayAuth] clientSecret length →", clientSecret.length);

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
    },
    body: body.toString(),
  });

  const text = await res.text();
  console.log("[eBayAuth] token response status →", res.status);
  // NEVER echo raw response body — contains access_token + refresh_token
  // in cleartext on success. On failure eBay returns a JSON error object
  // with no secret, so it's safe to surface via the throw.
  if (!res.ok) {
    throw new Error(`eBay token request failed (${res.status}): ${text}`);
  }

  return JSON.parse(text) as EbayTokenResponse;
}
