import type { CompsProvider, CompResult } from "../types/providers.js";

export class MockCompsProvider implements CompsProvider {
  async getComps(query: string): Promise<CompResult[]> {
    // Return mock comps
    return [
      { cardId: "1", price: 100, date: new Date().toISOString(), source: "mock" },
      { cardId: "2", price: 150, date: new Date().toISOString(), source: "mock" }
    ];
  }

  async health(): Promise<{ status: string; details?: any }> {
    return { status: "ok", details: "Mock provider always healthy" };
  }
}
