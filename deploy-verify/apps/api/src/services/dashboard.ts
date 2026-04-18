// Mock dashboard service for HobbyIQ
export function getDashboard(userId: string) {
  // Return mock dashboard data
  return {
    userId,
    stats: {
      cards: 10,
      alerts: 2,
      plan: "Dealer Pro"
    }
  };
}
