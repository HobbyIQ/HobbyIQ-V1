import { MarketDataEvent } from "../domain/events/market-data-event";

export interface MarketEventRepository {
  save(event: MarketDataEvent): Promise<void>;
  existsByDedupeKey(dedupeKey: string): Promise<boolean>;
}
