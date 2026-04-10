import type { SupplyProvider, SupplyResult } from "../types/providers.js";

export class MockSupplyProvider implements SupplyProvider {
  async getSupply(cardId: string): Promise<SupplyResult> {
    // Return mock supply
    return {
      cardId,
      supply: Math.floor(Math.random() * 1000),
      notes: "Mock supply value."
    };
  }

  async health(): Promise<{ status: string; details?: any }> {
    return { status: "ok", details: "Mock provider always healthy" };
  }
}
