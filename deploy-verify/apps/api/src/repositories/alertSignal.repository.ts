import { AlertSignal } from "../domain/events/alert-signal";

export interface AlertSignalRepository {
  saveMany(signals: AlertSignal[]): Promise<void>;
}
