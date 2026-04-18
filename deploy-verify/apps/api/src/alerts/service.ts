import { PrismaClient } from "@prisma/client";
import { CreateAlertInput, AlertDTO } from "./types";
import {
  evaluateBuyTargetBreach,
  evaluateSellTargetBreach,
  evaluateRecommendationShift,
  evaluateNegativePressureSpike,
  evaluateStrongMomentum
} from "./rules";

const prisma = new PrismaClient();

export async function createAlertIfNotDuplicate(input: CreateAlertInput): Promise<{ success: boolean; alertId?: string; duplicate?: boolean }> {
  // Dedupe: check for recent identical alert
  const recent = await prisma.alert.findFirst({
    where: {
      alertType: input.alertType,
      portfolioCardId: input.portfolioCardId,
      createdAt: { gte: new Date(Date.now() - 1000 * 60 * 10) }, // 10 min window
      isDismissed: false,
    },
  });
  if (recent) return { success: false, duplicate: true, alertId: recent.id };
  const alert = await prisma.alert.create({ data: { ...input, type: input.alertType } });
  return { success: true, alertId: alert.id };
}

export async function getAlerts(userId: string): Promise<{ success: boolean; data: AlertDTO[] }> {
  const alerts = await prisma.alert.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  return {
    success: true,
    data: alerts.map(a => ({
      ...a,
      alertType: a.type, // Prisma model uses 'type', DTO expects 'alertType'
      title: "", // fallback for required DTO field
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString()
    }))
  };
}

export async function markAlertRead(alertId: string): Promise<{ success: boolean }> {
  await prisma.alert.update({ where: { id: alertId }, data: { isRead: true } });
  return { success: true };
}

export async function dismissAlert(alertId: string): Promise<{ success: boolean }> {
  await prisma.alert.update({ where: { id: alertId }, data: { isDismissed: true } });
  return { success: true };
}

export async function evaluateAlertsForCard(card: any, watchlistItem: any, prevRecommendation: string): Promise<CreateAlertInput[]> {
  const alerts: CreateAlertInput[] = [];
  const buyBreach = evaluateBuyTargetBreach(card, watchlistItem);
  if (buyBreach) alerts.push(buyBreach);
  const sellBreach = evaluateSellTargetBreach(card, watchlistItem);
  if (sellBreach) alerts.push(sellBreach);
  const recShift = evaluateRecommendationShift(card, prevRecommendation);
  if (recShift) alerts.push(recShift);
  const negPressure = evaluateNegativePressureSpike(card);
  if (negPressure) alerts.push(negPressure);
  const strongMomentum = evaluateStrongMomentum(card);
  if (strongMomentum) alerts.push(strongMomentum);
  for (const alert of alerts) {
    await createAlertIfNotDuplicate(alert);
  }
  return alerts;
}
