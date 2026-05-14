/**
 * routes/alerts.js
 *
 * REST surface for price alerts.
 *
 *   GET    /api/alerts                 -> list signed-in user's alerts
 *   POST   /api/alerts                 -> create an alert
 *   DELETE /api/alerts/:alertId        -> delete an alert
 *   POST   /api/alerts/device          -> register an APNs device token
 *   POST   /api/alerts/internal/trigger -> called by fn-price-alert-checker
 *                                          to send a push and mark triggered
 *                                          (auth: x-admin-key)
 */

const express = require('express');
const { getUserBySession } = require('../services/authService');
const alertService = require('../services/alertService');
const pushService = require('../services/pushService');

const router = express.Router();

// ── auth helpers ─────────────────────────────────────────────────────────────

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

function requireAdminKey(req, res, next) {
  const expected = process.env.COMPIQ_ADMIN_KEY || process.env.ALERTS_ADMIN_KEY || '';
  if (!expected) {
    return res.status(503).json({ success: false, error: 'Admin key not configured' });
  }
  const supplied = String(req.headers['x-admin-key'] || '');
  if (supplied !== expected) {
    return res.status(401).json({ success: false, error: 'Bad admin key' });
  }
  next();
}

// ── user-facing routes ───────────────────────────────────────────────────────

router.get('/', requireUser, async (req, res) => {
  try {
    const alerts = await alertService.listAlerts(req.user.userId);
    return res.json({ success: true, alerts });
  } catch (err) {
    console.error('[alerts] list failed:', err.message);
    return res.status(500).json({ success: false, error: 'list_failed' });
  }
});

router.post('/', requireUser, async (req, res) => {
  const { cardId, playerName, targetPrice, direction, currentPrice } = req.body || {};
  const target = Number(targetPrice);
  if (!cardId || !playerName || !Number.isFinite(target) || target <= 0) {
    return res.status(400).json({ success: false, error: 'invalid_payload' });
  }
  if (direction && direction !== 'above' && direction !== 'below') {
    return res.status(400).json({ success: false, error: 'invalid_direction' });
  }
  try {
    const alert = await alertService.createAlert(req.user.userId, {
      cardId,
      playerName,
      targetPrice: target,
      direction: direction || 'above',
      currentPrice: currentPrice == null ? null : Number(currentPrice),
      cardSnapshot: req.body.cardSnapshot || null,
    });
    return res.json({ success: true, alert });
  } catch (err) {
    console.error('[alerts] create failed:', err.message);
    return res.status(500).json({ success: false, error: 'create_failed' });
  }
});

router.delete('/:alertId', requireUser, async (req, res) => {
  const { alertId } = req.params;
  try {
    const ok = await alertService.deleteAlert(req.user.userId, String(alertId));
    if (!ok) return res.status(404).json({ success: false, error: 'not_found' });
    return res.json({ success: true });
  } catch (err) {
    console.error('[alerts] delete failed:', err.message);
    return res.status(500).json({ success: false, error: 'delete_failed' });
  }
});

router.post('/device', requireUser, async (req, res) => {
  const { deviceToken, bundleId, platform } = req.body || {};
  if (!deviceToken) {
    return res.status(400).json({ success: false, error: 'missing_token' });
  }
  try {
    await alertService.registerDeviceToken(req.user.userId, {
      deviceToken: String(deviceToken),
      bundleId: bundleId ? String(bundleId) : '',
      platform: platform ? String(platform) : 'ios',
    });
    return res.json({ success: true });
  } catch (err) {
    console.error('[alerts] device register failed:', err.message);
    return res.status(500).json({ success: false, error: 'register_failed' });
  }
});

// ── internal: triggered by fn-price-alert-checker ────────────────────────────

/**
 * Body: { alertId: string, currentPrice: number, message?: string }
 *
 * Looks up the alert (and the user's device tokens), sends a push, and marks
 * the alert as triggered. Idempotent — a second call on an already-triggered
 * alert is a 200 no-op.
 */
router.post('/internal/trigger', requireAdminKey, async (req, res) => {
  const { alertId, userId, currentPrice, message } = req.body || {};
  if (!alertId || !userId) {
    return res.status(400).json({ success: false, error: 'missing_fields' });
  }

  try {
    const updated = await alertService.markTriggered(String(userId), String(alertId));
    if (!updated) return res.status(404).json({ success: false, error: 'alert_not_found' });

    if (updated.triggeredAt && updated.isActive === false) {
      const tokens = await alertService.getDeviceTokens(String(userId));
      const sentResults = [];
      for (const t of tokens) {
        const result = await pushService.send(t.token, {
          title: `${updated.playerName} hit your target`,
          body: message
            || `Predicted price ${formatCurrency(currentPrice)} ${updated.direction === 'below' ? 'fell to' : 'rose to'} your $${updated.targetPrice} alert.`,
          payload: {
            alertId: updated.alertId,
            cardId: updated.cardId,
            currentPrice: Number(currentPrice) || null,
          },
        });
        sentResults.push({ token: t.token.slice(0, 8) + '…', ...result });
        if (result.invalidToken) {
          await alertService.removeDeviceToken(String(userId), t.token).catch(() => {});
        }
      }
      return res.json({ success: true, alert: updated, pushes: sentResults });
    }

    return res.json({ success: true, alert: updated, pushes: [] });
  } catch (err) {
    console.error('[alerts] trigger failed:', err.message);
    return res.status(500).json({ success: false, error: 'trigger_failed' });
  }
});

/**
 * Internal: list every active alert across all users so the Python checker
 * can iterate without having Cosmos credentials of its own.
 *   GET /api/alerts/internal/all
 */
router.get('/internal/all', requireAdminKey, async (_req, res) => {
  try {
    const alerts = await alertService.listAllActive();
    return res.json({ success: true, alerts });
  } catch (err) {
    console.error('[alerts] internal/all failed:', err.message);
    return res.status(500).json({ success: false, error: 'list_failed' });
  }
});

function formatCurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return '$' + n.toFixed(2);
}

module.exports = router;
