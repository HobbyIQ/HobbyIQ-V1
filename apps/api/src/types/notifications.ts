// src/types/notifications.ts
export interface Notification {
  id: string;
  userId: string;
  type: string;
  message: string;
  createdAt: string;
  read: boolean;
  relatedCardId?: string;
  relatedOutcomeId?: string;
}
