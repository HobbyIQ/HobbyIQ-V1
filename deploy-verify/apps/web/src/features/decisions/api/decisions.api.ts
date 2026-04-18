import { DecisionOutputDto, DecisionSummaryDto } from "../types/decisions.types";
import { apiClient } from "../../../services/api/client";

export async function getDecision(entityType: string, entityKey: string): Promise<{ decision: DecisionOutputDto; summary?: DecisionSummaryDto | null; freshness?: Record<string, unknown> }> {
  return apiClient.get(`/api/decision/${entityType}/${entityKey}`);
}
