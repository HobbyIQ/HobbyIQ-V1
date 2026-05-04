// CompIQ estimate test fixtures for realistic baseball card scenarios

export const strongBuyPayload = {
  subject: {
    playerName: "Elly De La Cruz",
    cardYear: 2023,
    brand: "Bowman Chrome",
    product: "Prospect Auto",
    parallel: "Orange",
    gradeCompany: "PSA",
    gradeValue: 10,
    isAuto: true
  },
  comps: [
    { id: "c1", price: 5000, date: "2026-04-01", source: "ebay", gradeCompany: "PSA", gradeValue: 10, isAuto: true },
    { id: "c2", price: 5100, date: "2026-03-28", source: "ebay", gradeCompany: "PSA", gradeValue: 10, isAuto: true },
    { id: "c3", price: 5200, date: "2026-03-20", source: "ebay", gradeCompany: "PSA", gradeValue: 10, isAuto: true }
  ],
  context: {
    activeListings: 1,
    soldCount30d: 50,
    avgDaysToSell: 1,
    rankingTrend: "up",
    volatilityIndex: 1
  }
};

export const holdPayload = {
  subject: {
    playerName: "Sebastian Walcott",
    cardYear: 2023,
    brand: "Bowman Chrome",
    product: "Base",
    gradeCompany: "BGS",
    gradeValue: 9.5,
    isAuto: false
  },
  comps: [
    { id: "c1", price: 400, date: "2026-04-01", source: "ebay", gradeCompany: "BGS", gradeValue: 9.5 },
    { id: "c2", price: 420, date: "2026-03-28", source: "ebay", gradeCompany: "BGS", gradeValue: 9.5 },
    { id: "c3", price: 410, date: "2026-03-20", source: "ebay", gradeCompany: "BGS", gradeValue: 9.5 }
  ],
  context: {
    activeListings: 5,
    soldCount30d: 5,
    avgDaysToSell: 8,
    rankingTrend: "flat",
    volatilityIndex: 40
  }
};

export const sellPayload = {
  subject: {
    playerName: "Max Clark",
    cardYear: 2023,
    brand: "Bowman Chrome",
    product: "Refractor",
    parallel: "Blue Wave",
    gradeCompany: "PSA",
    gradeValue: 9,
    isAuto: false
  },
  comps: [
    { id: "c1", price: 10, date: "2026-04-01", source: "ebay", gradeCompany: "PSA", gradeValue: 9 },
    { id: "c2", price: 9, date: "2026-03-28", source: "ebay", gradeCompany: "PSA", gradeValue: 9 },
    { id: "c3", price: 8, date: "2026-03-20", source: "ebay", gradeCompany: "PSA", gradeValue: 9 }
  ],
  context: {
    activeListings: 100,
    soldCount30d: 0,
    avgDaysToSell: 90,
    rankingTrend: "down",
    volatilityIndex: 100
  }
};

export const passPayload = {
  subject: {
    playerName: "Blake Burke",
    cardYear: 2023,
    brand: "Bowman Chrome",
    product: "Base",
    gradeCompany: "Raw",
    isAuto: false
  },
  comps: [
    { id: "c1", price: 50, date: "2026-04-01", source: "ebay", gradeCompany: "Raw" },
    { id: "c2", price: 55, date: "2026-03-28", source: "ebay", gradeCompany: "Raw" },
    { id: "c3", price: 60, date: "2026-03-20", source: "ebay", gradeCompany: "Raw" }
  ],
  context: {
    activeListings: 40,
    soldCount30d: 0,
    avgDaysToSell: 30,
    rankingTrend: "down",
    volatilityIndex: 95
  }
};

export const sparseCompsPayload = {
  subject: {
    playerName: "Unknown Prospect",
    cardYear: 2024,
    brand: "Bowman Chrome",
    product: "Base",
    gradeCompany: "Raw",
    isAuto: false
  },
  comps: [],
  context: {
    activeListings: 0,
    soldCount30d: 0,
    avgDaysToSell: 0,
    rankingTrend: "flat",
    volatilityIndex: 50
  }
};
