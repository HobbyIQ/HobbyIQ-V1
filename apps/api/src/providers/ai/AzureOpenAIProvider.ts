// src/providers/ai/AzureOpenAIProvider.ts
import type { AIProvider } from "./AIProvider";
import { env } from "../../config/env";

export class AzureOpenAIProvider implements AIProvider {
  // TODO: Wire up Azure OpenAI SDK client here for production
  // import { OpenAIClient } from "@azure/openai"; // Example
  // const client = new OpenAIClient(...)
  getProviderMode() { return "azure"; }
  getPromptVersion() { return "v1.0.0-azure"; }
  async generateRationale(input: any) {
    if (!env.AZURE_OPENAI_API_KEY) return {
      output: "[Azure OpenAI not configured]",
      providerMode: this.getProviderMode(),
      promptVersion: this.getPromptVersion(),
    };
    // TODO: Integrate with Azure OpenAI SDK
    return {
      output: `Azure rationale for ${input?.cardId || "unknown card"}`,
      providerMode: this.getProviderMode(),
      promptVersion: this.getPromptVersion(),
    };
  }
  async generateMarketSummary(input: any) {
    if (!env.AZURE_OPENAI_API_KEY) return {
      output: "[Azure OpenAI not configured]",
      providerMode: this.getProviderMode(),
      promptVersion: this.getPromptVersion(),
    };
    // TODO: Integrate with Azure OpenAI SDK
    return {
      output: `Azure market summary for ${input?.segment || "unknown segment"}`,
      providerMode: this.getProviderMode(),
      promptVersion: this.getPromptVersion(),
    };
  }
  async generateAlertExplanation(input: any) {
    if (!env.AZURE_OPENAI_API_KEY) return {
      output: "[Azure OpenAI not configured]",
      providerMode: this.getProviderMode(),
      promptVersion: this.getPromptVersion(),
    };
    // TODO: Integrate with Azure OpenAI SDK
    return {
      output: `Azure alert explanation for ${input?.alertId || "unknown alert"}`,
      providerMode: this.getProviderMode(),
      promptVersion: this.getPromptVersion(),
    };
  }
}
