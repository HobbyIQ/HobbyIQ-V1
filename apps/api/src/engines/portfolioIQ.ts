// Minimal PortfolioIQ engine for HobbyIQ V1
export function evaluatePortfolio(cards: any[], compResultsMap: Record<string, any>) {
  let totalFMV = 0;
  let totalPaid = 0;
  const results = cards.map(card => {
    const key = (card.player + "|" + card.parallel).toLowerCase().trim();
    const comp = compResultsMap[key] || {};
    const FMV = comp.keyNumbers?.FMV || 0;
    const paid = card.pricePaid || 0;
    totalFMV += FMV;
    totalPaid += paid;
    return {
      ...card,
      FMV,
      ROI: paid ? ((FMV - paid) / paid) * 100 : null,
      compResult: comp
    };
  });
  return {
    totalFMV,
    totalPaid,
    ROI: totalPaid ? ((totalFMV - totalPaid) / totalPaid) * 100 : null,
    cards: results
  };
}
