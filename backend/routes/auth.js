const express = require('express');
const { getUserBySession, signIn, signOut, signInWithApple } = require('../services/authService');
const { verifyAppleIdentityToken } = require('../services/appleAuthService');

const router = express.Router();

router.post('/signin', async (req, res) => {
  const identifier = String(req.body?.username ?? req.body?.email ?? '');
  const password = String(req.body?.password ?? '');
  const result = await signIn(identifier, password);

  if (!result.success) {
    return res.status(401).json(result);
  }

  return res.json(result);
});

router.post('/signout', async (req, res) => {
  const sessionId = String(req.headers['x-session-id'] ?? req.body?.sessionId ?? '');
  if (!sessionId) {
    return res.status(400).json({ success: false, error: 'Missing sessionId' });
  }

  const result = await signOut(sessionId);
  return res.json(result);
});

router.get('/session', async (req, res) => {
  const sessionId = String(req.headers['x-session-id'] ?? '');
  if (!sessionId) {
    return res.status(401).json({ success: false, error: 'Missing sessionId' });
  }

  const user = await getUserBySession(sessionId);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Invalid session' });
  }

  return res.json({ success: true, user });
});

/**
 * POST /api/auth/apple
 * Body: { identityToken, authorizationCode?, nonce?, fullName?, email? }
 *
 * Verifies the Apple identity token (signature + audience + nonce hash), then
 * upserts a user keyed on the token's `sub` claim and returns a session.
 */
router.post('/apple', async (req, res) => {
  const body = req.body || {};
  const identityToken = String(body.identityToken || '');
  const nonce = body.nonce ? String(body.nonce) : null;
  const clientEmail = body.email ? String(body.email).trim() : '';
  const clientName = body.fullName ? String(body.fullName).trim() : '';

  if (!identityToken) {
    return res.status(400).json({ success: false, error: 'identityToken required' });
  }

  let claims;
  try {
    claims = await verifyAppleIdentityToken(identityToken, nonce);
  } catch (err) {
    console.warn('[auth/apple] verify failed:', err.message);
    return res.status(401).json({ success: false, error: 'invalid_apple_token' });
  }

  // Apple only ships `email` in the JWT on the first sign-in for the app, but
  // ASAuthorizationAppleIDCredential gives us the email/name on that first
  // call too. Trust JWT email when present; fall back to the client-supplied
  // value for first-touch profile data.
  const email = claims.email || clientEmail || null;
  const displayName = clientName || '';

  const result = await signInWithApple({
    sub: claims.sub,
    email,
    displayName,
  });

  if (!result.success) {
    return res.status(500).json(result);
  }
  return res.json(result);
});

module.exports = router;
