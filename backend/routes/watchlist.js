/**
 * routes/watchlist.js
 *
 * Per-user, server-backed player watchlist. Backed by Cosmos container
 * `watchlist` (partition /userId). All routes require x-session-id and
 * return 401 if missing or invalid.
 *
 *   GET    /api/watchlist               -> list current user's watched players
 *   POST   /api/watchlist               -> add (or upsert) a watched player
 *   PATCH  /api/watchlist/:itemId       -> toggle alertEnabled
 *   DELETE /api/watchlist/:itemId       -> remove a watched player
 */

const express = require('express');
const { getUserBySession } = require('../services/authService');
const watchlistService = require('../services/watchlistService');

const router = express.Router();

async function requireUser(req, res, next) {
  const sessionId = String(req.headers['x-session-id'] || '');
  if (!sessionId) {
    return res.status(401).json({ success: false, error: 'Missing session' });
  }
  const user = await getUserBySession(sessionId);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Invalid session' });
  }
  req.user = user;
  next();
}

router.get('/', requireUser, async (req, res) => {
  try {
    const items = await watchlistService.listItems(req.user.userId);
    return res.json({ success: true, items });
  } catch (err) {
    console.error('[watchlist] list failed:', err.message);
    return res.status(500).json({ success: false, error: 'list_failed' });
  }
});

router.post('/', requireUser, async (req, res) => {
  const { playerId, playerName, sport, alertEnabled } = req.body || {};
  if (!playerId || !playerName) {
    return res.status(400).json({ success: false, error: 'playerId and playerName required' });
  }
  try {
    const item = await watchlistService.addItem(req.user.userId, {
      playerId: String(playerId),
      playerName: String(playerName),
      sport: sport ? String(sport) : 'MLB',
      alertEnabled: typeof alertEnabled === 'boolean' ? alertEnabled : true,
    });
    return res.json({
      success: true,
      watchlistItemId: item.watchlistItemId,
      item,
    });
  } catch (err) {
    console.error('[watchlist] add failed:', err.message);
    return res.status(500).json({ success: false, error: 'add_failed' });
  }
});

router.patch('/:itemId', requireUser, async (req, res) => {
  const { itemId } = req.params;
  const { alertEnabled } = req.body || {};
  if (typeof alertEnabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'alertEnabled (bool) required' });
  }
  try {
    const updated = await watchlistService.setAlertEnabled(
      req.user.userId,
      String(itemId),
      alertEnabled
    );
    if (!updated) {
      return res.status(404).json({ success: false, error: 'not_found' });
    }
    return res.json({ success: true, item: updated });
  } catch (err) {
    console.error('[watchlist] patch failed:', err.message);
    return res.status(500).json({ success: false, error: 'patch_failed' });
  }
});

router.delete('/:itemId', requireUser, async (req, res) => {
  const { itemId } = req.params;
  try {
    const ok = await watchlistService.removeItem(req.user.userId, String(itemId));
    if (!ok) {
      return res.status(404).json({ success: false, error: 'not_found' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[watchlist] delete failed:', err.message);
    return res.status(500).json({ success: false, error: 'delete_failed' });
  }
});

module.exports = router;
