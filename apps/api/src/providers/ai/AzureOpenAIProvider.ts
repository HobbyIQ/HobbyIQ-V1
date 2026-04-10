// src/providers/ai/AzureOpenAIProvider.ts
import type { AIProvider } from "./AIProvider";
import { env } from "../../config/env";

export class AzureOpenAIProvider implements AIProvider {
  // TODO: Wire up Azure OpenAI SDK client here for production
  // import { OpenAIClient } from "@azure/openai"; // Example
  // const client = new OpenAIClient(...)
  getProviderMode() { return "azure"; }
  getPromptVersion() { return "v1.0.0-azure"; }
  async generateRationale(input: any): Promise<string> {
    if (!env.AZURE_OPENAI_API_KEY) return "[Azure OpenAI not configured]";
    // TODO: Integrate with Azure OpenAI SDK
    return `Azure rationale for ${input?.cardId || "unknown card"}`;
  }
  async generateMarketSummary(input: any): Promise<string> {
    if (!env.AZURE_OPENAI_API_KEY) return "[Azure OpenAI not configured]";
    // TODO: Integrate with Azure OpenAI SDK
    return `Azure market summary for ${input?.segment || "unknown segment"}`;
  }
  async generateAlertExplanation(input: any): Promise<string> {
    if (!env.AZURE_OPENAI_API_KEY) return "[Azure OpenAI not configured]";
    // TODO: Integrate with Azure OpenAI SDK
    return `Azure alert explanation for ${input?.alertId || "unknown alert"}`;
  }
}
