// In-app notification provider (keeps current in-app notification logic working)
import type { NotificationProvider, NotificationPayload, NotificationChannel } from './provider.js';

export class InAppNotificationProvider implements NotificationProvider {
  async send(payload: NotificationPayload, channel: NotificationChannel) {
    // TODO: Integrate with in-app notification storage/logic
    // Example: Save to DB, emit websocket, etc.
    // Placeholder: Log to console
    // Beta: suppress in-app notification log
  }
}
