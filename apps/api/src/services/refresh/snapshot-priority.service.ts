// Priority policy for snapshot refreshes
export class SnapshotPriorityService {
  getCardPriority(cardKey: string, context?: Record<string, unknown>): "high" | "medium" | "low" {
    // Expandable: hot cards, manual, etc.
    if (context?.manual) return "high";
    if (context?.hot) return "high";
    if (context?.frequent) return "medium";
    return "low";
  }
  getPlayerPriority(playerId: string, context?: Record<string, unknown>): "high" | "medium" | "low" {
    if (context?.manual) return "high";
    if (context?.hot) return "high";
    if (context?.frequent) return "medium";
    return "low";
  }
}
