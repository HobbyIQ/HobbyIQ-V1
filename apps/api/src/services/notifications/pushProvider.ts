// Placeholder push notification provider (APNS/FCM integration TODO)
import type { NotificationProvider, NotificationPayload, NotificationChannel } from './provider.js';

export class PushNotificationProvider implements NotificationProvider {
  async send(payload: NotificationPayload, channel: NotificationChannel) {
    // TODO: Integrate with APNS/FCM here
    // Placeholder: Log to console
    console.log(`[PUSH][${payload.userId}] ${payload.type}: ${payload.message}`);
    // No-op: App remains executable without real push credentials
  }
}
