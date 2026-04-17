export interface AlertEvent {
  eventId: string;
  candidateId: string;
  eventType: "created" | "suppressed" | "promoted_to_ready" | "sent" | "failed" | "dismissed";
  eventAt: string;
  metadataJson?: Record<string, unknown>;
}
