// src/providers/factories/aiProviderFactory.ts
import { env } from "../../config/env";
import { MockAIProvider } from "../ai/MockAIProvider";
import { AzureOpenAIProvider } from "../ai/AzureOpenAIProvider";
import { monitoringProviderFactory } from "./monitoringProviderFactory";

export function aiProviderFactory() {
  const monitoring = monitoringProviderFactory();
  let provider;
  if (env.AI_MODE === "azure" && env.AZURE_OPENAI_API_KEY && env.AZURE_OPENAI_ENDPOINT) {
    provider = new AzureOpenAIProvider();
  } else {
    provider = new MockAIProvider();
  }
  // Beta: suppress AI provider init log
  monitoring.logEvent?.("AIProviderInitialized", { mode: provider.getProviderMode() });
  return provider;
}
