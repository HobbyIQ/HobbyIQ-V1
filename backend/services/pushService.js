/**
 * services/pushService.js
 *
 * Apple Push Notification service (APNs) wrapper.
 *
 * Loads `apn` lazily so the rest of the backend keeps booting if the package
 * isn't installed yet. Auth uses an APNs Auth Key (.p8) — the modern flow that
 * Apple recommends. Configure via env:
 *
 *   APNS_KEY_ID         e.g. ABCD1234EF
 *   APNS_TEAM_ID        e.g. ABCDE12345
 *   APNS_BUNDLE_ID      e.g. com.justtheboysandcards.HobbyIQ
 *   APNS_KEY_P8         contents of AuthKey_XXX.p8 (PEM, multi-line OK)
 *   APNS_PRODUCTION     "true" for production APNs, anything else => sandbox
 *
 * If any of the required env vars are missing, send() resolves to a no-op so
 * the rest of the alert pipeline still runs (in-flight predictions, Cosmos
 * writes, etc.) — a missing push key must NEVER block alert evaluation.
 */

let _provider = null;
let _initTried = false;

function getProvider() {
  if (_provider) return _provider;
  if (_initTried) return null;
  _initTried = true;

  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const keyP8 = process.env.APNS_KEY_P8;
  const isProd = String(process.env.APNS_PRODUCTION || '').toLowerCase() === 'true';

  if (!keyId || !teamId || !keyP8) {
    console.warn('[push] APNs not configured (missing APNS_KEY_ID/TEAM_ID/KEY_P8)');
    return null;
  }

  let apn;
  try {
    apn = require('apn');
  } catch (err) {
    console.warn('[push] `apn` package not installed, skipping push:', err.message);
    return null;
  }

  try {
    _provider = new apn.Provider({
      token: {
        key: Buffer.from(keyP8, 'utf8'),
        keyId,
        teamId,
      },
      production: isProd,
    });
    console.log(`[push] APNs provider initialized (${isProd ? 'production' : 'sandbox'})`);
    return _provider;
  } catch (err) {
    console.error('[push] APNs provider init failed:', err.message);
    return null;
  }
}

/**
 * Send a single push notification.
 *
 * @param {string} deviceToken hex-encoded APNs device token (no spaces)
 * @param {{title: string, body: string, payload?: object, badge?: number}} opts
 * @returns {Promise<{ok: boolean, reason?: string, invalidToken?: boolean}>}
 */
async function send(deviceToken, opts) {
  if (!deviceToken) return { ok: false, reason: 'no_token' };
  const provider = getProvider();
  if (!provider) return { ok: false, reason: 'apns_not_configured' };

  try {
    const apn = require('apn');
    const note = new apn.Notification();
    note.alert = { title: opts.title || 'HobbyIQ', body: opts.body || '' };
    note.sound = 'default';
    if (typeof opts.badge === 'number') note.badge = opts.badge;
    note.topic = process.env.APNS_BUNDLE_ID || '';
    note.payload = opts.payload || {};
    note.contentAvailable = false;

    const result = await provider.send(note, deviceToken);
    if (result.failed && result.failed.length) {
      const f = result.failed[0];
      // Apple flags unrecoverable token problems with these error strings.
      const invalid = ['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']
        .includes(f?.response?.reason || '');
      return {
        ok: false,
        reason: f?.response?.reason || f?.error?.message || 'unknown',
        invalidToken: invalid,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}

function shutdown() {
  if (_provider && typeof _provider.shutdown === 'function') {
    try { _provider.shutdown(); } catch { /* ignore */ }
  }
  _provider = null;
  _initTried = false;
}

module.exports = { send, shutdown };
