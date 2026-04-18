"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAlertIfNotDuplicate = createAlertIfNotDuplicate;
exports.getAlerts = getAlerts;
exports.markAlertRead = markAlertRead;
exports.dismissAlert = dismissAlert;
exports.evaluateAlertsForCard = evaluateAlertsForCard;
const client_1 = require("@prisma/client");
const rules_1 = require("./rules");
const prisma = new client_1.PrismaClient();
async function createAlertIfNotDuplicate(input) {
    // Dedupe: check for recent identical alert
    const recent = await prisma.alert.findFirst({
        where: {
            alertType: input.alertType,
            portfolioCardId: input.portfolioCardId,
            createdAt: { gte: new Date(Date.now() - 1000 * 60 * 10) }, // 10 min window
            isDismissed: false,
        },
    });
    if (recent)
        return { success: false, duplicate: true, alertId: recent.id };
    const alert = await prisma.alert.create({ data: { ...input, type: input.alertType } });
    return { success: true, alertId: alert.id };
}
async function getAlerts(userId) {
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
async function markAlertRead(alertId) {
    await prisma.alert.update({ where: { id: alertId }, data: { isRead: true } });
    return { success: true };
}
async function dismissAlert(alertId) {
    await prisma.alert.update({ where: { id: alertId }, data: { isDismissed: true } });
    return { success: true };
}
async function evaluateAlertsForCard(card, watchlistItem, prevRecommendation) {
    const alerts = [];
    const buyBreach = (0, rules_1.evaluateBuyTargetBreach)(card, watchlistItem);
    if (buyBreach)
        alerts.push(buyBreach);
    const sellBreach = (0, rules_1.evaluateSellTargetBreach)(card, watchlistItem);
    if (sellBreach)
        alerts.push(sellBreach);
    const recShift = (0, rules_1.evaluateRecommendationShift)(card, prevRecommendation);
    if (recShift)
        alerts.push(recShift);
    const negPressure = (0, rules_1.evaluateNegativePressureSpike)(card);
    if (negPressure)
        alerts.push(negPressure);
    const strongMomentum = (0, rules_1.evaluateStrongMomentum)(card);
    if (strongMomentum)
        alerts.push(strongMomentum);
    for (const alert of alerts) {
        await createAlertIfNotDuplicate(alert);
    }
    return alerts;
}
