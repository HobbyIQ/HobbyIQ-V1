// notification.service.ts — Wraps `apn` and sends APNs pushes.
//
// Rules enforced:
//  - Gracefully no-ops when APNS_* env vars are missing (so deploy succeeds
//    even before the .p8 key is uploaded).
//  - On every send failure with status 400/410 ("BadDeviceToken" or
//    "Unregistered"), the invalid token is removed from Cosmos.
//  - Device tokens are NEVER kept in process memory beyond a single send.

import apn from "apn";
import { createPrivateKey } from "node:crypto";
import {
  getTokensForUser,
  getTokensForUsers,
  removeToken,
  DeviceTokenRecord,
} from "../repositories/deviceToken.repository.js";

/**
 * D-APNS (2026-09-04) — the key is a PEM, whatever shape the setting is in.
 *
 * App Service held APNS_KEY_P8 as the BASE64 of the whole .p8 file. The
 * provider got those 344 characters as UTF-8 bytes, OpenSSL refused them
 * ("error:1E08010C:DECODER routines::unsupported"), getProvider() returned
 * null and every push silently no-op'd from ~2026-08-20. Only the Personal
 * Prospect Breakout nightly asserts delivery, so it alone went red.
 *
 * A setting round-trips through consoles, shell exports and JSON blobs, and
 * comes out in one of three shapes. All three are the same key, so all three
 * are accepted and normalised to a PEM:
 *
 *   1. raw PEM       — real newlines, what a .p8 file holds
 *   2. escaped PEM   — literal "\\n" two-character sequences, what a JSON or
 *                      shell round-trip leaves behind
 *   3. base64 of PEM — no "-----BEGIN" marker at all; decode, then it is a PEM
 *
 * Detection is by content, never by length or config: a value carrying
 * "-----BEGIN" is already PEM-shaped, anything else is tried as base64 and
 * MUST decode to a PEM. Nothing is guessed — the result is parsed with
 * createPrivateKey before it is handed to the provider, so a value that only
 * looks like a key is refused here rather than inside `apn`.
 *
 * A flattened PEM (newlines stripped, no escapes) is NOT recoverable and is
 * refused: re-wrapping it would be inventing structure we cannot verify.
 *
 * Refusal logs the shape tried and the length ONLY. The key is a credential —
 * its content never reaches a log line.
 */
export type ApnsKeyShape = "pem" | "escaped-pem" | "base64-pem";

export interface ApnsKeyLoadResult {
  key: string | null;
  shape: ApnsKeyShape | null;
  /** Human-readable reason, safe to log — never contains key content. */
  reason: string | null;
}

/** True when the text parses as a private key OpenSSL will actually use. */
function parsesAsPrivateKey(pem: string): boolean {
  try {
    createPrivateKey(pem);
    return true;
  } catch {
    return false;
  }
}

/** Turn literal "\n" / "\r\n" escapes into real newlines. */
function unescapeNewlines(text: string): string {
  return text.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");
}

/**
 * One key, one PEM. `.trim()` above strips the trailing newline a .p8 file
 * carries, while a base64 payload decodes with it intact — so without this
 * the same key normalises to two different strings depending on the shape it
 * arrived in. Both parse, but only one of them is canonical.
 */
function canonicalPem(pem: string): string {
  return `${pem.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

/**
 * Normalise APNS_KEY_P8 to a PEM string, accepting every shape the setting
 * has legitimately been stored in. Returns `key: null` with a `reason` when
 * nothing parses — the caller logs it and no-ops rather than throwing.
 */
export function loadApnsKey(raw: string | undefined | null): ApnsKeyLoadResult {
  if (raw == null || raw.trim() === "") {
    return { key: null, shape: null, reason: "APNS_KEY_P8 is unset or empty" };
  }
  const value = raw.trim();
  const len = value.length;

  if (value.includes("-----BEGIN")) {
    // Shape 1: already a PEM with real newlines.
    if (parsesAsPrivateKey(value)) {
      return { key: canonicalPem(value), shape: "pem", reason: null };
    }
    // Shape 2: a PEM whose newlines survived as literal "\n" escapes.
    const unescaped = unescapeNewlines(value);
    if (unescaped !== value && parsesAsPrivateKey(unescaped)) {
      return { key: canonicalPem(unescaped), shape: "escaped-pem", reason: null };
    }
    return {
      key: null,
      shape: null,
      reason:
        `APNS_KEY_P8 carries a PEM header but does not parse as a private key ` +
        `(length=${len}); neither as-is nor after unescaping "\\n". A PEM ` +
        `flattened onto one line cannot be recovered — re-store the .p8 file contents.`,
    };
  }

  // Shape 3: no PEM marker at all — the only supported alternative is the
  // base64 of the whole .p8 file, which MUST decode to a PEM.
  let decoded: string;
  try {
    decoded = Buffer.from(value, "base64").toString("utf8");
  } catch {
    decoded = "";
  }
  if (decoded.includes("-----BEGIN")) {
    if (parsesAsPrivateKey(decoded)) {
      return { key: canonicalPem(decoded), shape: "base64-pem", reason: null };
    }
    const unescaped = unescapeNewlines(decoded);
    if (unescaped !== decoded && parsesAsPrivateKey(unescaped)) {
      return { key: canonicalPem(unescaped), shape: "base64-pem", reason: null };
    }
    return {
      key: null,
      shape: null,
      reason:
        `APNS_KEY_P8 base64-decodes to a PEM that does not parse as a private ` +
        `key (length=${len}). Re-store the .p8 file contents.`,
    };
  }

  return {
    key: null,
    shape: null,
    reason:
      `APNS_KEY_P8 is neither a PEM (no "-----BEGIN" marker) nor the base64 of ` +
      `one (decoded bytes carry no PEM header) (length=${len}). Store the .p8 ` +
      `file contents, or the base64 of that file.`,
  };
}

let _provider: apn.Provider | null = null;
let _bundleId: string | null = null;
let _providerInitTried = false;

function getProvider(): apn.Provider | null {
  if (_providerInitTried) return _provider;
  _providerInitTried = true;

  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID ?? process.env.APPLE_BUNDLE_ID;
  const keyP8 = process.env.APNS_KEY_P8;
  const production = String(process.env.APNS_PRODUCTION ?? "false").toLowerCase() === "true";

  if (!keyId || !teamId || !bundleId || !keyP8) {
    // Keep the no-op, but name what is actually missing rather than the
    // whole list — "not configured" read the same whether one var or four
    // were absent.
    const missing = [
      ["APNS_KEY_ID", keyId],
      ["APNS_TEAM_ID", teamId],
      ["APNS_BUNDLE_ID", bundleId],
      ["APNS_KEY_P8", keyP8],
    ].filter(([, v]) => !v).map(([n]) => n).join(", ");
    console.warn(
      `[notification.service] APNs not configured — missing: ${missing}. Push sends will no-op.`,
    );
    return null;
  }

  const loaded = loadApnsKey(keyP8);
  if (!loaded.key) {
    // Refuse loudly and by name — one line, the shape that failed and the
    // length, never the content. A silent no-op is what hid this for weeks.
    console.error(`[notification.service] APNs key rejected: ${loaded.reason} Push sends will no-op.`);
    return null;
  }

  try {
    _provider = new apn.Provider({
      token: {
        key: Buffer.from(loaded.key, "utf8"),
        keyId,
        teamId,
      },
      production,
    });
    _bundleId = bundleId;
    console.log(
      `[notification.service] APNs provider ready (production=${production}, bundle=${bundleId}, keyShape=${loaded.shape})`,
    );
    return _provider;
  } catch (err: any) {
    console.error("[notification.service] APNs provider init failed:", err?.message ?? err);
    _provider = null;
    return null;
  }
}

/**
 * D13 (2026-08-29) — alert gates prove delivery. Every push path above
 * no-ops silently when the APNs provider is missing; nightly jobs then
 * report `pushSent: 0` and exit green. Callers ask this before trusting
 * a zero. Same memoized init as a send, so the answer is the one a send
 * would get — not a bare env check that could disagree with it.
 */
export function isPushProviderConfigured(): boolean {
  return getProvider() !== null;
}

interface SendResult {
  sent: number;
  failed: number;
  removedTokens: number;
}

async function sendToTokens(
  records: DeviceTokenRecord[],
  payload: { title: string; body: string; data?: Record<string, unknown> },
): Promise<SendResult> {
  const provider = getProvider();
  if (!provider || records.length === 0) {
    return { sent: 0, failed: 0, removedTokens: 0 };
  }
  const note = new apn.Notification();
  note.expiry = Math.floor(Date.now() / 1000) + 3600; // 1h
  note.badge = 1;
  note.sound = "default";
  note.alert = { title: payload.title, body: payload.body };
  note.topic = _bundleId!;
  if (payload.data) note.payload = payload.data;

  let sent = 0;
  let failed = 0;
  let removedTokens = 0;

  await Promise.all(
    records.map(async (rec) => {
      try {
        const result = await provider.send(note, rec.token);
        if (result.sent?.length) {
          sent += result.sent.length;
        }
        for (const fail of result.failed ?? []) {
          failed += 1;
          const status = Number(fail.status ?? 0);
          const reason = (fail.response as any)?.reason ?? "";
          if (status === 410 || status === 400 || reason === "BadDeviceToken" || reason === "Unregistered") {
            try {
              await removeToken(rec.userId, rec.token);
              removedTokens += 1;
              console.warn(`[notification.service] removed invalid token user=${rec.userId} reason=${reason || status}`);
            } catch (rmErr: any) {
              console.error("[notification.service] removeToken failed:", rmErr?.message ?? rmErr);
            }
          } else {
            console.error(`[notification.service] APNs send failed user=${rec.userId} status=${status} reason=${reason}`);
          }
        }
      } catch (err: any) {
        failed += 1;
        console.error("[notification.service] send threw:", err?.message ?? err);
      }
    }),
  );

  return { sent, failed, removedTokens };
}

export interface FeaturedPlayer {
  playerId: string;
  playerName: string;
  league?: string;
  team?: string;
  rankingScore?: number;
  rank?: number;
}

export async function sendDailyIQNotification(
  userId: string,
  topPlayer: FeaturedPlayer,
  hasWatchlistMatch: boolean,
): Promise<SendResult> {
  const records = await getTokensForUser(userId);
  if (records.length === 0) return { sent: 0, failed: 0, removedTokens: 0 };

  const title = hasWatchlistMatch
    ? `📈 ${topPlayer.playerName} is on fire`
    : `📊 Today's DailyIQ Top Performer`;
  const body = hasWatchlistMatch
    ? `${topPlayer.playerName} (on your watchlist) is leading ${topPlayer.league ?? "today's"} board.`
    : `${topPlayer.playerName}${topPlayer.team ? ` (${topPlayer.team})` : ""} tops today's ${topPlayer.league ?? ""} performers.`;

  return sendToTokens(records, {
    title,
    body,
    data: {
      type: "dailyiq.top_performer",
      playerId: topPlayer.playerId,
      league: topPlayer.league ?? null,
      hasWatchlistMatch,
    },
  });
}

export async function sendPriceAlertNotification(
  userId: string,
  payload: {
    title: string;
    body: string;
    cardId?: string;
    alertId?: string;
  },
): Promise<SendResult> {
  const records = await getTokensForUser(userId);
  if (records.length === 0) return { sent: 0, failed: 0, removedTokens: 0 };
  return sendToTokens(records, {
    title: payload.title,
    body: payload.body,
    data: {
      type: "price.alert",
      cardId: payload.cardId ?? null,
      alertId: payload.alertId ?? null,
    },
  });
}

/**
 * CF-BUYERIQ-DEAL-ALERT (Drew, 2026-08-03). Push when a live listing on
 * a BuyerIQ target lands below FMV × threshold. iOS routes on
 * `data.type = "buyeriq.deal"` to the target detail screen.
 */
export async function sendBuyerIqDealNotification(
  userId: string,
  payload: {
    title: string;
    body: string;
    targetId: string;
    listingId: string;
    listingUrl?: string | null;
    listingPrice: number;
    fmv: number;
    dealPct: number;   // 0.15 = 15% below FMV
  },
): Promise<SendResult> {
  const records = await getTokensForUser(userId);
  if (records.length === 0) return { sent: 0, failed: 0, removedTokens: 0 };
  return sendToTokens(records, {
    title: payload.title,
    body: payload.body,
    data: {
      type: "buyeriq.deal",
      targetId: payload.targetId,
      listingId: payload.listingId,
      listingUrl: payload.listingUrl ?? null,
      listingPrice: payload.listingPrice,
      fmv: payload.fmv,
      dealPct: payload.dealPct,
    },
  });
}

/**
 * CF-ADVANCED-ALERTS (2026-06-03): distinct push taxon for advanced-rule
 * fires. `data.type = "advanced_alert"` so iOS push-routing can land on
 * the rule-detail screen instead of the basic price-alert detail.
 */
export async function sendAdvancedAlertNotification(
  userId: string,
  payload: {
    title: string;
    body: string;
    ruleId: string;
    cardId?: string | null;
    scopeType: "card" | "player" | "watchlist" | "holdings";
  },
): Promise<SendResult> {
  const records = await getTokensForUser(userId);
  if (records.length === 0) return { sent: 0, failed: 0, removedTokens: 0 };
  return sendToTokens(records, {
    title: payload.title,
    body: payload.body,
    data: {
      type: "advanced_alert",
      ruleId: payload.ruleId,
      cardId: payload.cardId ?? null,
      scopeType: payload.scopeType,
    },
  });
}

/**
 * CF-CASCADE-APNS-PUSH (Drew, 2026-07-17). Push taxon for cascade
 * (graded-market-leading-raw insider signal) events. `data.type =
 * "cascade.alert"` so iOS push-routing can land on the player-trend
 * detail screen for the flagged player.
 *
 * Payload shape:
 *   title: "Cascade signal: <player>"
 *   body:  event.reason (already human-readable — the detector formats it)
 *   userInfo: { player, severity, momentumRatio, playerSlug }
 */
export async function sendCascadeAlertNotification(
  userId: string,
  payload: {
    player: string;
    playerSlug: string;
    severity: "insider" | "emerging" | "confirmed";
    momentumRatio: number;
    reason: string;
  },
): Promise<SendResult> {
  const records = await getTokensForUser(userId);
  if (records.length === 0) return { sent: 0, failed: 0, removedTokens: 0 };
  return sendToTokens(records, {
    title: `Cascade signal: ${payload.player}`,
    body: payload.reason,
    data: {
      type: "cascade.alert",
      player: payload.player,
      playerSlug: payload.playerSlug,
      severity: payload.severity,
      momentumRatio: payload.momentumRatio,
    },
  });
}

/**
 * CF-WATCHLIST-DIGEST-PUSH (Drew, 2026-07-17). Push taxon for the
 * daily watchlist digest — a consolidated summary of which watchlist
 * players moved > 10% today. One push per user per day. `data.type =
 * "watchlist.digest"` so iOS push-routing can land on the watchlist
 * screen.
 */
export async function sendWatchlistDigestNotification(
  userId: string,
  payload: {
    moverCount: number;
    topMoverName: string;
    topMoverPercent: number;
    topMoverDirection: "up" | "down";
  },
): Promise<SendResult> {
  const records = await getTokensForUser(userId);
  if (records.length === 0) return { sent: 0, failed: 0, removedTokens: 0 };
  const sign = payload.topMoverDirection === "down" ? "-" : "+";
  const pctText = `${sign}${Math.round(Math.abs(payload.topMoverPercent))}%`;
  const title = `${payload.moverCount} watchlist ${payload.moverCount === 1 ? "player" : "players"} moved today`;
  const body = `Top mover: ${payload.topMoverName} ${pctText}. Tap to see all.`;
  return sendToTokens(records, {
    title,
    body,
    data: {
      type: "watchlist.digest",
      moverCount: payload.moverCount,
      topMoverName: payload.topMoverName,
      topMoverPercent: payload.topMoverPercent,
      topMoverDirection: payload.topMoverDirection,
    },
  });
}

/**
 * CF-GRADE-WORTHY-PUSH (Drew, 2026-07-17). Push taxon for a
 * grade-worthy alert on a specific holding. `data.type =
 * "grade_worthy.alert"` so iOS push-routing can land on the
 * grade-worthy analysis screen for the flagged holding.
 */
export async function sendGradeWorthyNotification(
  userId: string,
  payload: {
    holdingId: string;
    player: string;
    cardTitle: string;
    expectedGain: number;
    graderTier: string;
  },
): Promise<SendResult> {
  const records = await getTokensForUser(userId);
  if (records.length === 0) return { sent: 0, failed: 0, removedTokens: 0 };
  const gainRounded = Math.round(payload.expectedGain);
  const title = `Grade-worthy alert: ${payload.player}`;
  const body = `${payload.cardTitle} expected +$${gainRounded} if graded. Tap for analysis.`;
  return sendToTokens(records, {
    title,
    body,
    data: {
      type: "grade_worthy.alert",
      holdingId: payload.holdingId,
      player: payload.player,
      cardTitle: payload.cardTitle,
      expectedGain: payload.expectedGain,
      graderTier: payload.graderTier,
    },
  });
}

export async function broadcastToUsers(
  userIds: string[],
  payload: { title: string; body: string; data?: Record<string, unknown> },
): Promise<SendResult> {
  const provider = getProvider();
  if (!provider) return { sent: 0, failed: 0, removedTokens: 0 };
  const tokensByUser = await getTokensForUsers(userIds);
  const records: DeviceTokenRecord[] = [];
  for (const list of tokensByUser.values()) records.push(...list);
  return sendToTokens(records, payload);
}
