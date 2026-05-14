/**
 * services/appleAuthService.js
 *
 * Sign in with Apple — verifies the iOS client's `identityToken` (a JWT signed
 * by Apple) and returns a normalized identity for HobbyIQ to attach a session
 * to.
 *
 * Verification steps (all enforced):
 *   1. JWT header `alg` is RS256 and `kid` is present
 *   2. Header `kid` exists in Apple's published JWKS
 *      (https://appleid.apple.com/auth/keys, cached in-process for 1 hour)
 *   3. Signature passes RS256 against the matching JWK
 *   4. Claims `iss === "https://appleid.apple.com"`
 *   5. Claims `aud` matches APPLE_BUNDLE_ID env (your iOS bundle id)
 *   6. Claims `exp` > now (no leeway)
 *   7. If a nonce was supplied by the client, sha256(nonce) base64-url
 *      (no padding) must equal the JWT's `nonce` claim
 *
 * Returns { sub, email?, emailVerified, isPrivateEmail }.
 */

const crypto = require('crypto');
const https = require('https');

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const JWKS_TTL_MS = 60 * 60 * 1000;

let _jwksCache = null; // { fetchedAt, keys: { kid: KeyObject } }

function base64UrlDecodeToString(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function base64UrlDecodeToBuffer(input) {
  return Buffer.from(input, 'base64url');
}

function sha256Base64Url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url').replace(/=+$/, '');
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10_000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`apple jwks ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('apple jwks timeout')); });
  });
}

async function loadJwks() {
  const now = Date.now();
  if (_jwksCache && now - _jwksCache.fetchedAt < JWKS_TTL_MS) {
    return _jwksCache.keys;
  }
  const payload = await fetchJson(APPLE_JWKS_URL);
  const keys = {};
  for (const jwk of payload.keys || []) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    try {
      keys[jwk.kid] = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    } catch (err) {
      console.warn('[apple] bad JWK skipped', jwk.kid, err.message);
    }
  }
  _jwksCache = { fetchedAt: now, keys };
  return keys;
}

/**
 * Verify an Apple identity token and return the verified payload.
 *
 * @param {string} identityToken full JWT from ASAuthorizationAppleIDCredential
 * @param {string|null} expectedNonceRaw the unhashed nonce the client used
 * @returns {Promise<{sub:string, email:string|null, emailVerified:boolean, isPrivateEmail:boolean}>}
 */
async function verifyAppleIdentityToken(identityToken, expectedNonceRaw) {
  if (!identityToken || typeof identityToken !== 'string') {
    throw new Error('invalid_token');
  }
  const parts = identityToken.split('.');
  if (parts.length !== 3) throw new Error('invalid_token_shape');
  const [headerB64, payloadB64, signatureB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(base64UrlDecodeToString(headerB64));
    payload = JSON.parse(base64UrlDecodeToString(payloadB64));
  } catch {
    throw new Error('invalid_token_json');
  }

  if (header.alg !== 'RS256') throw new Error('unexpected_alg');
  if (!header.kid) throw new Error('missing_kid');

  const keys = await loadJwks();
  const publicKey = keys[header.kid];
  if (!publicKey) throw new Error('unknown_kid');

  const signedInput = `${headerB64}.${payloadB64}`;
  const signature = base64UrlDecodeToBuffer(signatureB64);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(signedInput);
  verifier.end();
  if (!verifier.verify(publicKey, signature)) {
    throw new Error('bad_signature');
  }

  if (payload.iss !== APPLE_ISSUER) throw new Error('bad_issuer');

  const expectedAud = process.env.APPLE_BUNDLE_ID || process.env.APNS_BUNDLE_ID || '';
  if (!expectedAud) throw new Error('apple_aud_not_configured');
  const audOk = Array.isArray(payload.aud)
    ? payload.aud.includes(expectedAud)
    : payload.aud === expectedAud;
  if (!audOk) throw new Error('bad_audience');

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error('token_expired');
  }
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 60) {
    throw new Error('token_iat_in_future');
  }

  if (expectedNonceRaw) {
    const expected = sha256Base64Url(expectedNonceRaw);
    const actual = String(payload.nonce || '').replace(/=+$/, '');
    if (!actual || actual !== expected) {
      throw new Error('nonce_mismatch');
    }
  }

  return {
    sub: String(payload.sub),
    email: payload.email ? String(payload.email) : null,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
    isPrivateEmail: payload.is_private_email === true || payload.is_private_email === 'true',
  };
}

module.exports = { verifyAppleIdentityToken };
