// src/providers/ai/AIProvider.ts
export interface AIProvider {
  generateRationale(input: any): Promise<string>;
  generateMarketSummary(input: any): Promise<string>;
  generateAlertExplanation(input: any): Promise<string>;
  getProviderMode(): string;
  getPromptVersion(): string;
}
