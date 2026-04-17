// Alerts Engine types and DTOs
import { AlertType, AlertSeverity } from "@prisma/client";

export interface CreateAlertInput {
  userId: string;
  portfolioId?: string;
  portfolioCardId?: string;
  watchlistItemId?: string;
  alertType: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  metadata?: Record<string, any>;
}

export interface AlertDTO {
  id: string;
  userId: string;
  portfolioId?: string;
  portfolioCardId?: string;
  watchlistItemId?: string;
  alertType: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  isRead: boolean;
  isDismissed: boolean;
  deliveryStatus?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}
