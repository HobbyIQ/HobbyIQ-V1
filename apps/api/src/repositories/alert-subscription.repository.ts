import { AlertSubscription } from "../domain/alerts/alert-subscription";

export interface AlertSubscriptionRepository {
  listForEntity(entityType: string, entityKey: string): Promise<AlertSubscription[]>;
  save(subscription: AlertSubscription): Promise<void>;
  update(subscription: AlertSubscription): Promise<void>;
}
