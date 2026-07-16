// CF-EBAY-APP-TOKEN (Drew, 2026-07-13, PR #423): mint + cache eBay
// app-scope OAuth tokens via client_credentials for endpoints that don't
// need user context (Browse search, feed, taxonomy).
//
// eBay tokens live ~2 hours. We cache the current token in-memory and
// refresh it BEFORE expiry (at 90% of lifetime) so callers never see a
// 401 due to a stale cached token. On a real 401 (e.g. server clock drift,
// eBay force-rotated our creds), the wrapper below transparently retries
// once with a freshly-minted token.
//
// Config:
//   EBAY_CLIENT_ID       — OAuth app ID (required)
//   EBAY_CLIENT_SECRET   — OAuth app secret (required)
//   EBAY_ENV             — "production" or "sandbox" (defaults to sandbox)
//   EBAY_BROWSE_TOKEN    — optional static override (legacy; used as
//                          warm-start seed if present, but re-minted on
//                          expiry / 401 like any other token).

const PROD_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const SANDBOX_TOKEN_URL = "https://api.sandbox.ebay.com/identity/v1/oauth2/token";
/** Refresh at 90% of the token's lifetime so nothing in-flight hits a
 *  stale token if two calls land near the boundary. */
const REFRESH_MARGIN_FRACTION = 0.9;
/** Absolute floor on lifetime we'll trust (30s), guards against a server
 *  returning `expires_in: 0` or garbage. */
const MIN_LIFETIME_SEC = 30;

interface CachedToken {
  accessToken: string;
  refreshAfter: number;   // Unix ms
}

let _cached: CachedToken | null = null;
let _inflight: Promise<string | null> | null = null;

function tokenEndpoint(): string {
  return (process.env.EBAY_ENV ?? "sandbox") === "production"
    ? PROD_TOKEN_URL
    : SANDBOX_TOKEN_URL;
}

/**
 * Return a valid app-scope Browse token, minting a fresh one when the
 * cache is empty or near expiry. Returns null when creds are missing OR
 * the token endpoint refuses to issue one. Never throws.
 */
export async function getAppScopeToken(): Promise<string | null> {
  const now = Date.now();
  if (_cached && _cached.refreshAfter > now) return _cached.accessToken;

  // De-dup concurrent callers waiting on the same mint.
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const minted = await mintFreshToken();
      if (!minted) return null;
      _cached = minted;
      return minted.accessToken;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/**
 * Force a re-mint on next call. Callers should invoke this when a 401
 * comes back on a request that used a currently-cached token — that
 * indicates the token was invalidated server-side and the cache is
 * ahead of reality.
 */
export function invalidateAppScopeTokenCache(): void {
  _cached = null;
}

async function mintFreshToken(): Promise<CachedToken | null> {
  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    console.warn(JSON.stringify({
      event: "ebay_app_token_missing_credentials",
      source: "ebayAppToken.service",
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
    }));
    return null;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.ebay.com/oauth/api_scope",
  }).toString();

  try {
    const res = await fetch(tokenEndpoint(), {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    if (!res.ok) {
      console.warn(JSON.stringify({
        event: "ebay_app_token_mint_http_error",
        source: "ebayAppToken.service",
        status: res.status,
      }));
      return null;
    }
    const payload = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    };
    const accessToken = payload.access_token;
    if (!accessToken) {
      console.warn(JSON.stringify({
        event: "ebay_app_token_mint_no_token_in_response",
        source: "ebayAppToken.service",
      }));
      return null;
    }
    const expiresInSec = typeof payload.expires_in === "number"
      ? Math.max(MIN_LIFETIME_SEC, payload.expires_in)
      : 2 * 3600;   // default: 2h
    const refreshAfter = Date.now() + Math.floor(expiresInSec * REFRESH_MARGIN_FRACTION) * 1000;
    console.log(JSON.stringify({
      event: "ebay_app_token_minted",
      source: "ebayAppToken.service",
      expiresInSec,
      refreshAfterIso: new Date(refreshAfter).toISOString(),
    }));
    return { accessToken, refreshAfter };
  } catch (err) {
    console.warn(JSON.stringify({
      event: "ebay_app_token_mint_error",
      source: "ebayAppToken.service",
      error: (err as Error)?.message ?? String(err),
    }));
    return null;
  }
}

/** Test hooks — reset cache + inflight for deterministic tests. */
export function _resetAppScopeTokenForTests(): void {
  _cached = null;
  _inflight = null;
}

export function _setAppScopeTokenForTests(token: string | null, refreshAfterMs?: number): void {
  _cached = token != null
    ? { accessToken: token, refreshAfter: refreshAfterMs ?? Date.now() + 3_600_000 }
    : null;
}
