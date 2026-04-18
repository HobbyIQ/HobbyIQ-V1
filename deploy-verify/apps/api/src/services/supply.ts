// Placeholder for future Supply Tracking module
import { createSupplyProvider } from "../providers/factory";
import type { PortfolioEntry } from "../types/modules";
import type { SupplyResult } from "../types/providers";

const supplyProvider = createSupplyProvider();

export async function trackSupply(card: PortfolioEntry): Promise<SupplyResult> {
  return supplyProvider.getSupply(card.id);
}

export async function supplyProviderHealth() {
  return supplyProvider.health();
}
// TODO: Azure Functions/cron integration point for scheduled supply refresh
