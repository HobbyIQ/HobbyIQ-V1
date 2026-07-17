// notification.service.ts — Wraps `apn` and sends APNs pushes.
//
// Rules enforced:
//  - Gracefully no-ops when APNS_* env vars are missing (so deploy succeeds
//    even before the .p8 key is uploaded).
//  - On every send failure with status 400/410 ("BadDeviceToken" or
//    "Unregistered"), the invalid token is removed from Cosmos.
//  - Device tokens are NEVER kept in process memory beyond a single send.

import apn from "apn";
import {
  getTokensForUser,
  getTokensForUsers,
  removeToken,
  DeviceTokenRecord,
} from "../repositories/deviceToken.repository.js";

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
    console.warn(
      "[notification.service] APNs not configured (need APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_KEY_P8). Push sends will no-op.",
    );
    return null;
  }

  try {
    _provider = new apn.Provider({
      token: {
        key: Buffer.from(keyP8, "utf8"),
        keyId,
        teamId,
      },
      production,
    });
    _bundleId = bundleId;
    console.log(`[notification.service] APNs provider ready (production=${production}, bundle=${bundleId})`);
    return _provider;
  } catch (err: any) {
    console.error("[notification.service] APNs provider init failed:", err?.message ?? err);
    _provider = null;
    return null;
  }
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
