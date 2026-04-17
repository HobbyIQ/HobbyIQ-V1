"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationService = void 0;
const planTiers_js_1 = require("../../models/planTiers.js");
// Multi-provider orchestrator
class NotificationService {
    constructor(inAppProvider, pushProvider) {
        // Track in-app alert counts per user for gating
        this.inAppAlertCounts = new Map();
        this.inAppProvider = inAppProvider;
        this.pushProvider = pushProvider;
    }
    // planTier: pass user's plan tier for gating
    async send(payload, channel, planTier = 'Prospect') {
        if (channel === 'in-app') {
            const limits = planTiers_js_1.PLAN_NOTIFICATION_LIMITS[planTier];
            if (limits.maxInAppAlerts !== null) {
                const count = this.inAppAlertCounts.get(payload.userId) || 0;
                if (count >= limits.maxInAppAlerts) {
                    // Gated: skip sending
                    console.log(`[GATE][${payload.userId}] In-app alert limit reached for plan ${planTier}`);
                    return;
                }
                this.inAppAlertCounts.set(payload.userId, count + 1);
            }
            await this.inAppProvider.send(payload, channel);
        }
        else if (channel === 'push') {
            // Only Dealer Pro gets premium signals (example logic)
            const limits = planTiers_js_1.PLAN_NOTIFICATION_LIMITS[planTier];
            if (payload.type === 'sell-signal' || payload.type === 'buy-signal') {
                if (!limits.premiumSignals) {
                    console.log(`[GATE][${payload.userId}] Push premium signal gated for plan ${planTier}`);
                    return;
                }
            }
            await this.pushProvider.send(payload, channel);
        }
    }
}
exports.NotificationService = NotificationService;
