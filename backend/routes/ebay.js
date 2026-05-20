const express = require('express');
const router = express.Router();
const { getUserBySession } = require('../services/authService');
const {
  ebayConnectionStatus,
  ebayConnectStart,
  ebayReconnectStart,
  ebayDisconnect,
  ebayConnectCallback,
} = require('../services/ebayService');

async function resolveUser(req, res) {
  const sessionId = String(req.headers['x-session-id'] || '').trim();
  if (!sessionId) {
    res.status(401).json({ success: false, error: 'Missing x-session-id header' });
    return null;
  }

  const user = await getUserBySession(sessionId);
  if (!user) {
    res.status(401).json({ success: false, error: 'Invalid or expired session' });
    return null;
  }

  return user;
}

router.get('/status', async (req, res) => {
  const user = await resolveUser(req, res);
  if (!user) return;

  try {
    const status = await ebayConnectionStatus(user.userId);
    res.json({
      success: true,
      ...status,
      connectedUser: status.ebayUserId || status.connectedUser || undefined,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Failed to fetch eBay status' });
  }
});

router.get('/connect/start', async (req, res) => {
  const user = await resolveUser(req, res);
  if (!user) return;

  try {
    const out = await ebayConnectStart(user.userId);
    res.json({ success: true, authUrl: out.authUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Failed to start eBay connect' });
  }
});

router.get('/connect/restart', async (req, res) => {
  const user = await resolveUser(req, res);
  if (!user) return;

  try {
    const out = await ebayReconnectStart(user.userId);
    res.json({ success: true, authUrl: out.authUrl, reconnected: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Failed to restart eBay connect' });
  }
});

router.get('/connect/callback', async (req, res) => {
  const { code, state } = req.query || {};
  if (!code || !state) {
    res.status(400).send('Missing code or state parameter');
    return;
  }

  try {
    const record = await ebayConnectCallback(String(code), String(state));
    const appDeepLink = `hobbyiq://ebay/connected?ebayUser=${encodeURIComponent(record.ebayUserId || 'unknown')}`;
    res.redirect(302, appDeepLink);
  } catch (err) {
    const msg = err.message || 'Unknown error';
    const appDeepLink = `hobbyiq://ebay/error?message=${encodeURIComponent(msg)}`;
    res.redirect(302, appDeepLink);
  }
});

router.delete('/disconnect', async (req, res) => {
  const user = await resolveUser(req, res);
  if (!user) return;

  try {
    await ebayDisconnect(user.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Failed to disconnect eBay' });
  }
});

module.exports = router;
