"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLAN_NOTIFICATION_LIMITS = void 0;
exports.PLAN_NOTIFICATION_LIMITS = {
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
