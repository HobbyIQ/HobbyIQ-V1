// CF-PAYMENTS-APPLE-1 (2026-06-03): Apple App Store Server library config.
//
// Reads credentials from App Settings at first use (lazy) so the backend
// can boot in environments that don't carry the Apple secrets (local dev,
// CI without payments). Throws AppleConfigError on first verifier/client
// access when required settings are missing — the route handler maps
// that to 503 service_unavailable so iOS sees an explicit "payments not
// configured" rather than a confusing 500.
//
// SECRET HANDLING:
//   APP_STORE_PRIVATE_KEY_B64 — the .p8 file contents, base64-encoded.
//     The lib expects the raw PEM string; we decode at load time. We
//     NEVER log the decoded key, NEVER echo it to clients.
//   APP_STORE_APPLE_ROOT_CERTS_B64 — comma-separated list of base64 DER
//     bytes for Apple's root CAs (G2 / G3). The lib does NOT bundle
//     these; Drew uploads the .cer files (downloaded from
//     https://www.apple.com/certificateauthority/) base64-encoded into
//     this setting. Without them, JWS cert-chain verification fails.

import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
} from "@apple/app-store-server-library";

export class AppleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleConfigError";
  }
}

interface ResolvedAppleConfig {
  issuerId: string;
  keyId: string;
  signingKeyPem: string;
  bundleId: string;
  appAppleId: number;
  rootCertificates: Buffer[];
  // Verifiers + API clients per environment. Built once at first access.
  verifierProduction: SignedDataVerifier;
  verifierSandbox: SignedDataVerifier;
  apiClientProduction: AppStoreServerAPIClient;
  apiClientSandbox: AppStoreServerAPIClient;
}

let _resolved: ResolvedAppleConfig | null = null;

function readRequiredEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new AppleConfigError(`Missing required App Setting: ${name}`);
  }
  return v.trim();
}

function decodeBase64Pem(b64: string): string {
  try {
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    throw new AppleConfigError("APP_STORE_PRIVATE_KEY_B64 is not valid base64");
  }
}

function decodeRootCertsB64(raw: string): Buffer[] {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) {
    throw new AppleConfigError(
      "APP_STORE_APPLE_ROOT_CERTS_B64 must contain at least one base64-encoded root cert (G2 / G3)",
    );
  }
  return parts.map((p) => {
    try {
      return Buffer.from(p, "base64");
    } catch {
      throw new AppleConfigError("APP_STORE_APPLE_ROOT_CERTS_B64 contains an invalid base64 entry");
    }
  });
}

function buildResolved(): ResolvedAppleConfig {
  const issuerId = readRequiredEnv("APP_STORE_ISSUER_ID");
  const keyId = readRequiredEnv("APP_STORE_KEY_ID");
  const signingKeyPem = decodeBase64Pem(readRequiredEnv("APP_STORE_PRIVATE_KEY_B64"));
  const bundleId = readRequiredEnv("APP_STORE_BUNDLE_ID");
  const appAppleIdRaw = readRequiredEnv("APP_STORE_APP_APPLE_ID");
  const appAppleId = Number(appAppleIdRaw);
  if (!Number.isFinite(appAppleId) || appAppleId <= 0) {
    throw new AppleConfigError("APP_STORE_APP_APPLE_ID must be a positive integer");
  }
  const rootCertificates = decodeRootCertsB64(readRequiredEnv("APP_STORE_APPLE_ROOT_CERTS_B64"));

  // Two verifiers — Apple's lib pins env at construction. We pick the
  // right one per-JWS based on the (untrusted) `environment` peek; the
  // crypto + cert-chain validation still happens inside the verifier
  // so a tampered JWS can't escape.
  //
  // ─── enableOnlineChecks: FALSE (deliberate decision 2026-06-03) ────
  //
  // When TRUE, the library performs OCSP revocation checks + cert
  // expiry checks against current time on every verifyAndDecodeTransaction
  // call. When FALSE, only the cert chain is validated against Apple's
  // root certs — revocation is not checked.
  //
  // We ship FALSE for launch because:
  //   1. Latency: OCSP responder round-trips add ~50-300ms per /verify
  //      call. iOS calls /verify on launch + Transaction.updates +
  //      restore; that's high-traffic for what should be a fast path.
  //   2. External dependency: Apple's OCSP responder is a separate
  //      uptime surface. We don't want a brief OCSP outage to take
  //      down every fresh subscription verify.
  //   3. Cert-chain validation against Apple roots is the PRIMARY
  //      control — only Apple can issue a signing cert that chains
  //      to AppleRootCA-G2/G3. A revoked-but-chain-valid Apple signing
  //      cert is a remote risk.
  //   4. Defense-in-depth: getAllSubscriptionStatuses (App Store Server
  //      API) is called on every /verify regardless. Even if a stale
  //      revoked-cert-signed JWS slipped through here, the API status
  //      check would surface the real subscription state — refunded
  //      txns return EXPIRED/REVOKED and we 422 instead of upgrading.
  //
  // Flip to TRUE if (a) Apple announces a signing-cert revocation,
  // (b) compliance audit requires OCSP at JWS layer, or (c) we see a
  // counterfeit-JWS incident the API status check missed.
  const ENABLE_ONLINE_CHECKS = false;
  const verifierProduction = new SignedDataVerifier(
    rootCertificates,
    ENABLE_ONLINE_CHECKS,
    Environment.PRODUCTION,
    bundleId,
    appAppleId,
  );
  // Sandbox per Apple docs: appAppleId is OMITTED.
  const verifierSandbox = new SignedDataVerifier(
    rootCertificates,
    ENABLE_ONLINE_CHECKS,
    Environment.SANDBOX,
    bundleId,
  );

  const apiClientProduction = new AppStoreServerAPIClient(
    signingKeyPem,
    keyId,
    issuerId,
    bundleId,
    Environment.PRODUCTION,
  );
  const apiClientSandbox = new AppStoreServerAPIClient(
    signingKeyPem,
    keyId,
    issuerId,
    bundleId,
    Environment.SANDBOX,
  );

  return {
    issuerId,
    keyId,
    signingKeyPem,
    bundleId,
    appAppleId,
    rootCertificates,
    verifierProduction,
    verifierSandbox,
    apiClientProduction,
    apiClientSandbox,
  };
}

/**
 * Lazy accessor. Throws AppleConfigError on first call if any required
 * env setting is missing. Subsequent calls return the cached result.
 */
export function getAppleConfig(): ResolvedAppleConfig {
  if (!_resolved) _resolved = buildResolved();
  return _resolved;
}

/**
 * Test-only reset. Test setup populates env vars + calls this so the
 * next getAppleConfig() picks up the new env values.
 */
export function _resetAppleConfigForTests(): void {
  _resolved = null;
}

/**
 * Pick the right verifier + API client for the given Apple environment.
 * Accepts string ("Sandbox" / "Production") because that's the wire form
 * carried inside the decoded JWS payload's `environment` field.
 */
export function pickEnvironmentClients(env: string): {
  verifier: SignedDataVerifier;
  apiClient: AppStoreServerAPIClient;
  environment: Environment;
} {
  const config = getAppleConfig();
  if (env === Environment.SANDBOX || env === "Sandbox") {
    return {
      verifier: config.verifierSandbox,
      apiClient: config.apiClientSandbox,
      environment: Environment.SANDBOX,
    };
  }
  return {
    verifier: config.verifierProduction,
    apiClient: config.apiClientProduction,
    environment: Environment.PRODUCTION,
  };
}

/**
 * Read the `environment` field from a JWS payload WITHOUT cryptographic
 * verification. Used only to pick which environment-pinned verifier to
 * route to — the verifier then does the real signature + cert-chain
 * validation. A tampered JWS that lies about `environment` would route
 * to the wrong verifier and fail verification there.
 *
 * CF-PAYMENTS-APPLE-PEEK-ENV-FIX (2026-06-04): ASSN V2 puts `environment`
 * INSIDE `data` (e.g. `payload.data.environment === "Sandbox"`), not at
 * top level. The original implementation only read top-level → returned
 * "Production" by default on every real V2 notification → routed sandbox
 * traffic to the production verifier → verification failed silently with
 * a 401 → Apple recorded `UNSUCCESSFUL_HTTP_RESPONSE_CODE` and retried.
 * Bug surfaced via end-to-end test (Drew, 2026-06-04 01:25Z): local verify
 * with explicit Environment.SANDBOX succeeded on the same JWS the route
 * rejected. Fix: read `data.environment` first, fall back to top-level
 * for any V1-shaped payload.
 *
 * Returns "Production" on any decode failure (safer default — prod
 * verifier strictly checks bundleId + appAppleId).
 */
export function peekJwsEnvironment(jws: string): "Sandbox" | "Production" {
  try {
    const [, payloadB64] = jws.split(".");
    if (!payloadB64) return "Production";
    // base64url -> base64
    const padded = payloadB64.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const obj = JSON.parse(decoded) as {
      environment?: string;
      data?: { environment?: string };
    };
    const env = obj.data?.environment ?? obj.environment;
    return env === "Sandbox" ? "Sandbox" : "Production";
  } catch {
    return "Production";
  }
}
