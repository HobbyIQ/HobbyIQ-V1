"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InAppNotificationProvider = void 0;
class InAppNotificationProvider {
    async send(payload, channel) {
        // TODO: Integrate with in-app notification storage/logic
        // Example: Save to DB, emit websocket, etc.
        // Placeholder: Log to console
        console.log(`[IN-APP][${payload.userId}] ${payload.type}: ${payload.message}`);
    }
}
exports.InAppNotificationProvider = InAppNotificationProvider;
