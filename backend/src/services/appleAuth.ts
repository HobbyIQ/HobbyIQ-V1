import crypto from "crypto";

/**
 * Verifies an Apple Sign-In identity token (JWT signed by Apple).
 * - Fetches Apple's public JWKS, finds the matching key by `kid`.
 * - Verifies the RSA-SHA256 signature.
 * - Validates `iss`, `aud` (bundle id), and `exp`.
 *
 * Returns the decoded payload on success, throws on failure.
 */

export interface AppleIdentityPayload {
  iss: string;
  sub: string;          // stable Apple user id
  aud: string;          // app bundle id
  iat: number;
  exp: number;
  email?: string;
  email_verified?: string | boolean;
  is_private_email?: string | boolean;
  nonce?: string;
  nonce_supported?: boolean;
}

interface AppleJwk {
  kty: "RSA";
  kid: string;
  use: "sig";
  alg: "RS256";
  n: string;
  e: string;
}

const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";
const JWKS_CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

let _jwksCache: { fetchedAt: number; keys: AppleJwk[] } | null = null;

async function fetchAppleJwks(): Promise<AppleJwk[]> {
  if (_jwksCache && Date.now() - _jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return _jwksCache.keys;
  }
  const res = await fetch(APPLE_JWKS_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch Apple JWKS: ${res.status}`);
  }
  const body = (await res.json()) as { keys: AppleJwk[] };
  _jwksCache = { fetchedAt: Date.now(), keys: body.keys };
  return body.keys;
}

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export async function verifyAppleIdentityToken(
  identityToken: string,
  expectedAudience?: string,
): Promise<AppleIdentityPayload> {
  if (!identityToken || typeof identityToken !== "string") {
    throw new Error("Missing identityToken");
  }
  const parts = identityToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed identityToken");
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(base64UrlDecode(headerB64).toString("utf8")) as {
    alg: string;
    kid: string;
  };
  if (header.alg !== "RS256") {
    throw new Error(`Unsupported JWT alg: ${header.alg}`);
  }

  const keys = await fetchAppleJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new Error(`Apple JWKS missing kid ${header.kid}`);
  }

  const publicKey = crypto.createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e } as any,
    format: "jwk",
  });

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64UrlDecode(signatureB64);

  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  const ok = verifier.verify(publicKey, signature);
  if (!ok) {
    throw new Error("Apple identityToken signature invalid");
  }

  const payload = JSON.parse(
    base64UrlDecode(payloadB64).toString("utf8"),
  ) as AppleIdentityPayload;

  if (payload.iss !== APPLE_ISSUER) {
    throw new Error(`Invalid iss: ${payload.iss}`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new Error("Apple identityToken expired");
  }

  const audience =
    expectedAudience ?? process.env.APPLE_BUNDLE_ID ?? process.env.APPLE_CLIENT_ID;
  if (audience && payload.aud !== audience) {
    throw new Error(`Invalid aud: ${payload.aud}`);
  }

  return payload;
}
