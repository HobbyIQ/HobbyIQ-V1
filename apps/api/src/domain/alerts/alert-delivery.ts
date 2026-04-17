export type AlertDeliveryStatus = "pending" | "sent" | "failed" | "skipped";
import { AlertChannel } from "./alert-subscription";

export interface AlertDelivery {
  deliveryId: string;
  candidateId: string;
  userId: string;
  channel: AlertChannel;
  status: AlertDeliveryStatus;
  renderedTitle: string;
  renderedBody: string;
  sentAt?: string;
  errorMessage?: string;
  createdAt: string;
}
