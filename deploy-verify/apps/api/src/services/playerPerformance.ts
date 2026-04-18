import { createPlayerPerformanceProvider } from "../providers/factory";
import type { PlayerPerformanceResult } from "../types/providers.js";

const playerPerformanceProvider = createPlayerPerformanceProvider();

export async function getPlayerPerformance(playerId: string): Promise<PlayerPerformanceResult> {
  return playerPerformanceProvider.getPerformance(playerId);
}

export async function playerPerformanceProviderHealth() {
  return playerPerformanceProvider.health();
}
// TODO: Azure Functions/cron integration point for scheduled player performance refresh
