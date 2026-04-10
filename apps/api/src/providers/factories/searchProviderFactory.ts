// src/providers/factories/searchProviderFactory.ts
import { env } from "../../config/env";
import { MockSearchProvider } from "../search/MockSearchProvider";
import { AzureAISearchProvider } from "../search/AzureAISearchProvider";
import { monitoringProviderFactory } from "./monitoringProviderFactory";

export function searchProviderFactory() {
  const monitoring = monitoringProviderFactory();
  let provider;
  if (env.AI_MODE === "azure" && env.AZURE_AI_SEARCH_API_KEY && env.AZURE_AI_SEARCH_ENDPOINT) {
    provider = new AzureAISearchProvider();
  } else {
    provider = new MockSearchProvider();
  }
  console.log(`[SearchProviderFactory] Initialized Search provider: ${provider.getProviderMode()}`);
  monitoring.logEvent?.("SearchProviderInitialized", { mode: provider.getProviderMode() });
  return provider;
}
