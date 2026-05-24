// Per-URL real-resolution health checks.
//
// CF-HEALTH-SIGNAL-URL-CHECK (2026-05-24): /health was reporting
// `has_signal_url: true` based on `Boolean(process.env.AZURE_SIGNAL_FUNCTION_URL)`
// — env-var-presence check only. When the URL was misconfigured to
// `/api/serve-signals` (404 path, since the real route is `/api/signals`),
// the boolean still said true and production `fetchSignals` silently fell
// back to NEUTRAL_SIGNAL for an unknown duration before the misconfiguration
// was discovered (see docs/phase0/phase4b_diagnostic_findings.md addendum
// at e26db5d).
//
// This module replaces env-var-presence with real lightweight HTTP probes
// that distinguish:
//   URL_OK                  — URL resolves, function answers (2xx or 400)
//   URL_AUTH_FAILED         — 401 (key wrong)
//   URL_NOT_FOUND           — 404 (path wrong; today's bug case)
//   URL_REACHABLE_BUT_BROKEN — other 4xx (function exists but rejects)
//   URL_SERVER_ERROR        — 5xx
//   URL_UNREACHABLE         — timeout / network error
//   URL_NOT_CONFIGURED      — env var unset/empty
//
// The probe uses GET with ?code=<KEY> only (no extra params). For fn-compiq
// HTTP-trigger functions this returns 400 (URL_OK by our taxonomy) — no
// side effects, no signal-budget burn.

export type UrlStatus =
  | "URL_OK"
  | "URL_AUTH_FAILED"
  | "URL_NOT_FOUND"
  | "URL_REACHABLE_BUT_BROKEN"
  | "URL_SERVER_ERROR"
  | "URL_UNREACHABLE"
  | "URL_NOT_CONFIGURED";

export interface UrlHealth {
  status: UrlStatus;
  status_code?: number;
  latency_ms?: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Probe a URL referenced by an env var; classify the response per UrlStatus.
 * Optionally pass `?code=<key>` if a key env var is provided (Azure Functions
 * convention).
 *
 * Used by /health to surface real URL resolution status. Never throws —
 * any error path returns a UrlHealth with status=URL_UNREACHABLE.
 */
export async function checkUrlReachable(
  urlEnvVar: string,
  keyEnvVar?: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<UrlHealth> {
  const url = process.env[urlEnvVar]?.trim();
  if (!url) return { status: "URL_NOT_CONFIGURED" };

  const key = keyEnvVar ? process.env[keyEnvVar]?.trim() : undefined;

  const start = Date.now();
  try {
    const u = new URL(url);
    if (key) u.searchParams.set("code", key);
    const resp = await fetch(u.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latency_ms = Date.now() - start;
    return classifyResponse(resp.status, latency_ms);
  } catch (err) {
    const latency_ms = Date.now() - start;
    return {
      status: "URL_UNREACHABLE",
      latency_ms,
      error: (err as Error).message,
    };
  }
}

function classifyResponse(status: number, latency_ms: number): UrlHealth {
  // 2xx → OK. 400 is treated as OK because for fn-compiq HTTP-trigger
  // functions, GET without required query params returns 400 ("missing player
  // parameter") — that confirms the URL resolves AND the function is alive,
  // without burning a real signal fetch. Distinguishes from 404 (path wrong)
  // which is the load-bearing case to catch.
  if (status >= 200 && status < 300) {
    return { status: "URL_OK", status_code: status, latency_ms };
  }
  if (status === 400) {
    return { status: "URL_OK", status_code: status, latency_ms };
  }
  if (status === 401 || status === 403) {
    return { status: "URL_AUTH_FAILED", status_code: status, latency_ms };
  }
  if (status === 404) {
    return { status: "URL_NOT_FOUND", status_code: status, latency_ms };
  }
  if (status >= 500) {
    return { status: "URL_SERVER_ERROR", status_code: status, latency_ms };
  }
  return { status: "URL_REACHABLE_BUT_BROKEN", status_code: status, latency_ms };
}

/**
 * Convenience: true only when status === URL_OK. Used by /health to compute
 * the backward-compatible `has_<name>_url` boolean.
 */
export function isUrlHealthy(h: UrlHealth): boolean {
  return h.status === "URL_OK";
}
