export async function getPlayerSummary(player: string) {
  // Mocked data
  return {
    success: true,
    player,
    summary: {
      recentPerformance: 'hot',
      outlook: 'positive',
      last10: '7-for-24, 2 HR',
      news: 'Promotion expected',
      marketValue: 387
    }
  };
}
