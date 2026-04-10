import type { PlayerPerformanceProvider, PlayerPerformanceResult } from "../types/providers.js";

export class MockPlayerPerformanceProvider implements PlayerPerformanceProvider {
  async getPerformance(playerId: string): Promise<PlayerPerformanceResult> {
    // Return mock player performance
    return {
      playerId,
      stats: { points: Math.floor(Math.random() * 30), assists: Math.floor(Math.random() * 10) },
      notes: "Mock player performance."
    };
  }

  async health(): Promise<{ status: string; details?: any }> {
    return { status: "ok", details: "Mock provider always healthy" };
  }
}
