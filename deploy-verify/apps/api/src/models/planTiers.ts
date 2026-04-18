// Plan gating for notifications
export type PlanTier = 'Prospect' | 'All-Star' | 'Dealer Pro';

export interface PlanNotificationLimits {
  maxInAppAlerts: number | null; // null = unlimited
  premiumSignals: boolean;
}

export const PLAN_NOTIFICATION_LIMITS: Record<PlanTier, PlanNotificationLimits> = {
  Prospect: {
    maxInAppAlerts: 5, // Example: 5 per week
    premiumSignals: false,
  },
  'All-Star': {
    maxInAppAlerts: null, // Unlimited
    premiumSignals: false,
  },
  'Dealer Pro': {
    maxInAppAlerts: null, // Unlimited
    premiumSignals: true,
  },
};
