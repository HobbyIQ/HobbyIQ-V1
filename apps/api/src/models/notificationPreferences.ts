// User notification preferences model
export type NotificationType =
  | 'price-spike'
  | 'supply-drop'
  | 'sell-signal'
  | 'buy-signal'
  | 'portfolio-roi';

export interface NotificationPreferences {
  userId: string;
  enabled: boolean;
  channels: {
    'in-app': boolean;
    push: boolean;
  };
  types: Partial<Record<NotificationType, boolean>>;
  quietHours?: {
    start: string; // e.g. '22:00'
    end: string;   // e.g. '07:00'
  };
}
