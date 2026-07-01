/**
 * Public API for the player-trend layer.
 *
 * Consumers import from here — NEVER directly from a provider file. This
 * lets the eBay-direct migration happen with a single-file swap in the
 * selection block below.
 *
 * Provider selection is env-gated so we can A/B-test or roll back without
 * a code change once the eBay provider exists:
 *   PLAYER_TREND_PROVIDER=cardhedge  (default; only supported today)
 *   PLAYER_TREND_PROVIDER=ebay       (future; unimplemented — stub returns null)
 */

import { cardHedgePlayerTrendProvider } from "./cardHedgeProvider.js";
import type { PlayerTrendProvider, PlayerTrendSnapshot } from "./playerTrend.types.js";

export type {
  NormalizedWeeklySales,
  PlayerMomentumSignal,
  PlayerTrendProvider,
  PlayerTrendSnapshot,
} from "./playerTrend.types.js";
export { computeMomentumFromNormalizedWeeks } from "./momentum.compute.js";

/**
 * eBay-direct provider — placeholder. Migration lands here.
 * Until implemented, always returns null so if someone flips the flag
 * early the engine gracefully falls back to "no signal" rather than
 * priced-wrong.
 */
const ebayDirectPlayerTrendProvider: PlayerTrendProvider = {
  name: "ebay-direct-stub",
  async getPlayerTrendSnapshot(): Promise<PlayerTrendSnapshot | null> {
    return null;
  },
};

function resolveProvider(): PlayerTrendProvider {
  const configured = String(process.env.PLAYER_TREND_PROVIDER ?? "cardhedge")
    .trim()
    .toLowerCase();
  switch (configured) {
    case "ebay":
    case "ebay-direct":
      return ebayDirectPlayerTrendProvider;
    case "cardhedge":
    case "":
      return cardHedgePlayerTrendProvider;
    default:
      // Unknown provider name — fail closed (no signal) instead of loudly
      // throwing during a request. Log so we can see the misconfig.
      console.warn(
        `[playerTrend] unknown PLAYER_TREND_PROVIDER=${configured}, falling back to cardhedge`,
      );
      return cardHedgePlayerTrendProvider;
  }
}

/**
 * Public entry point. Returns null when the provider has no data OR the
 * player name is empty/whitespace. Never throws — callers can safely
 * consume the result and skip the projection path on null.
 *
 * Read each call so test-time env stubs flip immediately without needing
 * a module reload.
 */
export async function getPlayerTrendSnapshot(
  playerName: string,
  weeksBack: number = 8,
): Promise<PlayerTrendSnapshot | null> {
  const provider = resolveProvider();
  return provider.getPlayerTrendSnapshot(playerName, weeksBack);
}
