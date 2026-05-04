import { AlertCandidateDto, AlertSubscriptionDto } from "../types/alerts.types";
import { apiClient } from "../../../services/api/client";

export async function listAlerts(params?: Record<string, any>): Promise<AlertCandidateDto[]> {
  return apiClient.get("/api/alerts", { params });
}

export async function listAlertSubscriptions(params?: Record<string, any>): Promise<AlertSubscriptionDto[]> {
  return apiClient.get("/api/alerts/subscriptions", { params });
}

export async function createAlertSubscription(input: Partial<AlertSubscriptionDto>): Promise<AlertSubscriptionDto> {
  return apiClient.post("/api/alerts/subscriptions", input);
}

export async function updateAlertSubscription(subscriptionId: string, input: Partial<AlertSubscriptionDto>): Promise<AlertSubscriptionDto> {
  return apiClient.patch(`/api/alerts/subscriptions/${subscriptionId}`, input);
}

export async function dismissAlert(candidateId: string): Promise<void> {
  return apiClient.post(`/api/alerts/${candidateId}/dismiss`);
}
