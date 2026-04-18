import { PortfolioPositionLite } from "../portfolio/portfolio-position-lite";
import { WatchlistItem } from "../alerts/watchlist-item";

export interface DecisionContext {
  entityType: "card" | "player";
  entityKey: string;
  playerId?: string;
  cardKey?: string;
  cardSnapshotJson?: Record<string, unknown>;
  playerSnapshotJson?: Record<string, unknown>;
  priorSnapshotJson?: Record<string, unknown> | null;
  portfolioPosition?: PortfolioPositionLite | null;
  watchlistState?: WatchlistItem | null;
  asOf: string;
}
