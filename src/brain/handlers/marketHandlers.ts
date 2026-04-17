// Handlers for best-buys, market-movers, player-summary
import { getBestBuysProvider, getMarketMoversProvider, getPlayerSummaryProvider } from '../../providers/marketProviders';

export async function getBestBuys() {
  // TODO: Replace with real provider
  return getBestBuysProvider();
}

export async function getMarketMovers() {
  // TODO: Replace with real provider
  return getMarketMoversProvider();
}

export async function getPlayerSummary(player: string) {
  // TODO: Replace with real provider
  return getPlayerSummaryProvider(player);
}
