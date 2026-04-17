import type { PlanTier } from '../../models/planTiers.js';
import { PLAN_NOTIFICATION_LIMITS } from '../../models/planTiers.js';
// Notification provider abstraction for HobbyIQ
// Supports in-app and push notification strategies

export type NotificationChannel = 'in-app' | 'push';
export type NotificationType =
  | 'price-spike'
  | 'supply-drop'
  | 'sell-signal'
  | 'buy-signal'
  | 'portfolio-roi';

export interface NotificationPayload {
  userId: string;
  type: NotificationType;
  message: string;
  data?: Record<string, any>;
}

export interface NotificationProvider {
  send(payload: NotificationPayload, channel: NotificationChannel): Promise<void>;
}

// Multi-provider orchestrator
export class NotificationService implements NotificationProvider {
  private inAppProvider: NotificationProvider;
  private pushProvider: NotificationProvider;
  // Track in-app alert counts per user for gating
  private inAppAlertCounts: Map<string, number> = new Map();

  constructor(inAppProvider: NotificationProvider, pushProvider: NotificationProvider) {
    this.inAppProvider = inAppProvider;
    this.pushProvider = pushProvider;
  }

  // planTier: pass user's plan tier for gating
  async send(payload: NotificationPayload, channel: NotificationChannel, planTier: PlanTier = 'Prospect') {
    if (channel === 'in-app') {
      const limits = PLAN_NOTIFICATION_LIMITS[planTier];
      if (limits.maxInAppAlerts !== null) {
        const count = this.inAppAlertCounts.get(payload.userId) || 0;
        if (count >= limits.maxInAppAlerts) {
          // Gated: skip sending
          // Beta: suppress in-app alert gate log
          return;
        }
        this.inAppAlertCounts.set(payload.userId, count + 1);
      }
      await this.inAppProvider.send(payload, channel);
    } else if (channel === 'push') {
      // Only Dealer Pro gets premium signals (example logic)
      const limits = PLAN_NOTIFICATION_LIMITS[planTier];
      if (payload.type === 'sell-signal' || payload.type === 'buy-signal') {
        if (!limits.premiumSignals) {
          // Beta: suppress push premium signal gate log
          return;
        }
      }
      await this.pushProvider.send(payload, channel);
    }
  }
}
