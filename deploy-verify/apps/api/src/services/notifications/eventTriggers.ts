// Backend event trigger points for notifications
import type { NotificationService, NotificationType } from './provider.js';
import type { PlanTier } from '../../models/planTiers.js';

export async function triggerNotification(
  service: NotificationService,
  userId: string,
  type: NotificationType,
  message: string,
  data?: Record<string, any>,
  planTier: PlanTier = 'Prospect'
) {
  // This function can be called from pricing, supply, portfolio, etc.
  // Example: check user preferences before sending
  await service.send({ userId, type, message, data }, 'in-app', planTier);
  await service.send({ userId, type, message, data }, 'push', planTier);
}

// Example trigger wrappers
export async function onPriceSpike(service: NotificationService, userId: string, details: any, planTier: PlanTier = 'Prospect') {
  await triggerNotification(service, userId, 'price-spike', 'Price spike detected!', details, planTier);
}
export async function onSupplyDrop(service: NotificationService, userId: string, details: any, planTier: PlanTier = 'Prospect') {
  await triggerNotification(service, userId, 'supply-drop', 'Supply drop detected!', details, planTier);
}
export async function onSellSignal(service: NotificationService, userId: string, details: any, planTier: PlanTier = 'Prospect') {
  await triggerNotification(service, userId, 'sell-signal', 'Sell signal generated!', details, planTier);
}
export async function onBuySignal(service: NotificationService, userId: string, details: any, planTier: PlanTier = 'Prospect') {
  await triggerNotification(service, userId, 'buy-signal', 'Buy signal generated!', details, planTier);
}
export async function onPortfolioRoi(service: NotificationService, userId: string, details: any, planTier: PlanTier = 'Prospect') {
  await triggerNotification(service, userId, 'portfolio-roi', 'Portfolio ROI threshold reached!', details, planTier);
}
