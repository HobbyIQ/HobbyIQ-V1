import { createCompsProvider } from "../providers/factory";
import type { CompResult } from "../types/providers.js";

const compsProvider = createCompsProvider();

export async function getComps(query: string): Promise<CompResult[]> {
  return compsProvider.getComps(query);
}

export async function compsProviderHealth() {
  return compsProvider.health();
}
// TODO: Azure Functions/cron integration point for scheduled comps refresh
