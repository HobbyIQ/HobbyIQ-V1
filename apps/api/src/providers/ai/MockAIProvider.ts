// src/providers/ai/MockAIProvider.ts
import type { AIProvider } from "./AIProvider";

export class MockAIProvider implements AIProvider {
  getProviderMode() { return "mock"; }
  getPromptVersion() { return "v1.0.0-mock"; }
  async generateRationale(input: any) {
    return `Mock rationale for ${input?.cardId || "unknown card"}`;
  }
  async generateMarketSummary(input: any) {
    return `Mock market summary for ${input?.segment || "unknown segment"}`;
  }
  async generateAlertExplanation(input: any) {
    return `Mock alert explanation for ${input?.alertId || "unknown alert"}`;
  }
}
