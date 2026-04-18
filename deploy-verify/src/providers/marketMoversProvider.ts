export async function getMarketMovers() {
  // Mocked data
  return {
    success: true,
    marketMovers: [
      {
        player: 'Josiah Hartshorn',
        card: '2025 Bowman Chrome Gold Shimmer',
        move: '+18%',
        reason: 'Promotion, supply tightening'
      },
      {
        player: 'Mason Wynn',
        card: '2024 Topps Chrome Sapphire',
        move: '+12%',
        reason: 'Hot streak, news event'
      }
    ]
  };
}
