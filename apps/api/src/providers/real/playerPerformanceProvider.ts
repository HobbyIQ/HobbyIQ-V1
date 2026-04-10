import type { PlayerPerformanceProvider, PlayerPerformanceResult } from "../../types/providers";

export class RealPlayerPerformanceProvider implements PlayerPerformanceProvider {
  async getPerformance(playerId: string): Promise<PlayerPerformanceResult> {
    // TODO: Integrate with real player performance API
    throw new Error("RealPlayerPerformanceProvider not implemented");
  }

  async health(): Promise<{ status: string; details?: any }> {
    // TODO: Implement real health check (e.g., test player performance API credentials)
    return { status: "unhealthy", details: "Not implemented" };
  }
}
