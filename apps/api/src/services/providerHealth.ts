import { compsProviderHealth } from "./comps";
import { supplyProviderHealth } from "./supply";
import { playerPerformanceProviderHealth } from "./playerPerformance";

export async function getAllProviderHealth() {
  return {
    comps: await compsProviderHealth(),
    supply: await supplyProviderHealth(),
    playerPerformance: await playerPerformanceProviderHealth(),
    // Add more providers as needed
  };
}
