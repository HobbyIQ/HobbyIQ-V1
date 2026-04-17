"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PushNotificationProvider = void 0;
class PushNotificationProvider {
    async send(payload, channel) {
        // TODO: Integrate with APNS/FCM here
        // Placeholder: Log to console
        console.log(`[PUSH][${payload.userId}] ${payload.type}: ${payload.message}`);
        // No-op: App remains executable without real push credentials
    }
}
exports.PushNotificationProvider = PushNotificationProvider;
