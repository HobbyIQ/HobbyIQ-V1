export class FixtureSeedService {
  async seedAll() {
    // TODO: Implement real fixture seeding for demo/test data
    return {
      hotProspects: 10,
      thinMarketCards: 5,
      overheatedCards: 3,
      safeLiquidCards: 7,
      ownedPositions: 12,
      ebayInventory: 8,
      psaCerts: 6,
      alertHistory: 15,
      performanceHistory: 20,
      learningExamples: 10,
    };
  }
}
