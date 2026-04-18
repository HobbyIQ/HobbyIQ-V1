import { AlertDelivery } from "../domain/alerts/alert-delivery";

export interface AlertDeliveryRepository {
  save(delivery: AlertDelivery): Promise<void>;
  listPending(limit: number): Promise<AlertDelivery[]>;
}
