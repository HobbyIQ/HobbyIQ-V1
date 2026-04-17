import { randomUUID } from "crypto";
import { AlertSignal } from "../../domain/events/alert-signal";

export class AlertSignalBuilderService {
  build(entityType: "card" | "player", entityKey: string, diff: Record<string, unknown>): AlertSignal[] {
    const signals: AlertSignal[] = [];
    const now = new Date().toISOString();

    if ("actionPlanJson" in diff) {
      signals.push({
        signalId: randomUUID(),
        entityType,
        entityKey,
        signalType: "recommendation_upgraded",
        importanceScore: 7,
        summary: "Action plan changed materially.",
        payloadJson: diff,
        createdAt: now,
      });
    }

    if ("marketTemperatureJson" in diff) {
      signals.push({
        signalId: randomUUID(),
        entityType,
        entityKey,
        signalType: "market_overheated",
        importanceScore: 6,
        summary: "Market temperature changed.",
        payloadJson: diff,
        createdAt: now,
      });
    }

    if ("pricingBandsJson" in diff) {
      signals.push({
        signalId: randomUUID(),
        entityType,
        entityKey,
        signalType: "entered_buy_zone",
        importanceScore: 8,
        summary: "Pricing bands changed enough to re-check buy zone.",
        payloadJson: diff,
        createdAt: now,
      });
    }

    return signals;
  }
}
