// sampleComps.js - Mock comp data for HobbyIQ Pricing Engine Phase 1
// Test fixture: exact direct comp case
const directComps = [
  // Gold /50 - strong direct comps
  {
    source: 'mock',
    listingTitle: '2025 Bowman Chrome Josiah Hartshorn Gold Auto /50',
    salePrice: 1200,
    acceptedPrice: 1200,
    rawPrice: 1200,
    shipping: 0,
    tax: 0,
    totalPrice: 1200,
    soldDate: '2026-04-10',
    playerName: 'Josiah Hartshorn',
    year: 2025,
    brand: 'Bowman',
    product: 'Chrome',
    parallel: 'Gold',
    serial: '50',
    gradeCompany: 'PSA',
    gradeValue: '10',
    autoFlag: true,
    notes: '',
    imageUrl: '',
    listingUrl: '',
    confidenceFlags: [],
    normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-gold_50',
    parallelBucket: 'gold_50',
    importedAt: '2026-04-11'
  },
  {
    source: 'mock',
    listingTitle: '2025 Bowman Chrome Josiah Hartshorn Gold Auto /50',
    salePrice: 1250,
    acceptedPrice: 1250,
    rawPrice: 1250,
    shipping: 0,
    tax: 0,
    totalPrice: 1250,
    soldDate: '2026-04-12',
    playerName: 'Josiah Hartshorn',
    year: 2025,
    brand: 'Bowman',
    product: 'Chrome',
    parallel: 'Gold',
    serial: '50',
    gradeCompany: 'PSA',
    gradeValue: '10',
    autoFlag: true,
    notes: '',
    imageUrl: '',
    listingUrl: '',
    confidenceFlags: [],
    normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-gold_50',
    parallelBucket: 'gold_50',
    importedAt: '2026-04-13'
  },
  // Orange /25 - only 1 direct comp, but gold/red nearby (sparse comp fallback case)
  {
    source: 'mock',
    listingTitle: '2025 Bowman Chrome Josiah Hartshorn Orange Auto /25',
    salePrice: 2200,
    acceptedPrice: 2200,
    rawPrice: 2200,
    shipping: 0,
    tax: 0,
    totalPrice: 2200,
    soldDate: '2026-04-10',
    playerName: 'Josiah Hartshorn',
    year: 2025,
    brand: 'Bowman',
    product: 'Chrome',
    parallel: 'Orange',
    serial: '25',
    gradeCompany: 'PSA',
    gradeValue: '10',
    autoFlag: true,
    notes: '',
    imageUrl: '',
    listingUrl: '',
    confidenceFlags: [],
    normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-orange_25',
    parallelBucket: 'orange_25',
    importedAt: '2026-04-11'
  },
  // Red /5 - sparse data (sparse comp fallback case)
  {
    source: 'mock',
    listingTitle: '2025 Bowman Chrome Josiah Hartshorn Red Auto /5',
    salePrice: 5000,
    acceptedPrice: 5000,
    rawPrice: 5000,
    shipping: 0,
    tax: 0,
    totalPrice: 5000,
    soldDate: '2026-03-01',
    playerName: 'Josiah Hartshorn',
    year: 2025,
    brand: 'Bowman',
    product: 'Chrome',
    parallel: 'Red',
    serial: '5',
    gradeCompany: 'PSA',
    gradeValue: '10',
    autoFlag: true,
    notes: '',
    imageUrl: '',
    listingUrl: '',
    confidenceFlags: [],
    normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-red_5',
    parallelBucket: 'red_5',
    importedAt: '2026-04-11'
  },
  // Refractor /499 - broad evidence (exact direct comp case)
  {
    source: 'mock',
    listingTitle: '2025 Bowman Chrome Josiah Hartshorn Refractor Auto /499',
    salePrice: 400,
    acceptedPrice: 400,
    rawPrice: 400,
    shipping: 0,
    tax: 0,
    totalPrice: 400,
    soldDate: '2026-04-10',
    playerName: 'Josiah Hartshorn',
    year: 2025,
    brand: 'Bowman',
    product: 'Chrome',
    parallel: 'Refractor',
    serial: '499',
    gradeCompany: 'PSA',
    gradeValue: '10',
    autoFlag: true,
    notes: '',
    imageUrl: '',
    listingUrl: '',
    confidenceFlags: [],
    normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-refractor_499',
    parallelBucket: 'refractor_499',
    importedAt: '2026-04-11'
  },
  // Outlier comp (outlier filtering case)
  {
    source: 'mock',
    listingTitle: '2025 Bowman Chrome Josiah Hartshorn Gold Auto /50',
    salePrice: 3000,
    acceptedPrice: 3000,
    rawPrice: 3000,
    shipping: 0,
    tax: 0,
    totalPrice: 3000,
    soldDate: '2026-04-14',
    playerName: 'Josiah Hartshorn',
    year: 2025,
    brand: 'Bowman',
    product: 'Chrome',
    parallel: 'Gold',
    serial: '50',
    gradeCompany: 'PSA',
    gradeValue: '10',
    autoFlag: true,
    notes: 'outlier',
    imageUrl: '',
    listingUrl: '',
    confidenceFlags: [],
    normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-gold_50',
    parallelBucket: 'gold_50',
    importedAt: '2026-04-15'
  }
];

// Rising market case
const risingComps = [
  {
    source: 'mock', listingTitle: '2025 Bowman Chrome Josiah Hartshorn Gold Auto /50', salePrice: 1000, soldDate: '2026-03-01', playerName: 'Josiah Hartshorn', year: 2025, brand: 'Bowman', product: 'Chrome', parallel: 'Gold', serial: '50', gradeCompany: 'PSA', gradeValue: '10', autoFlag: true, notes: '', normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-gold_50', parallelBucket: 'gold_50', importedAt: '2026-03-02'
  },
  {
    source: 'mock', listingTitle: '2025 Bowman Chrome Josiah Hartshorn Gold Auto /50', salePrice: 1100, soldDate: '2026-03-15', playerName: 'Josiah Hartshorn', year: 2025, brand: 'Bowman', product: 'Chrome', parallel: 'Gold', serial: '50', gradeCompany: 'PSA', gradeValue: '10', autoFlag: true, notes: '', normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-gold_50', parallelBucket: 'gold_50', importedAt: '2026-03-16'
  },
  {
    source: 'mock', listingTitle: '2025 Bowman Chrome Josiah Hartshorn Gold Auto /50', salePrice: 1200, soldDate: '2026-04-01', playerName: 'Josiah Hartshorn', year: 2025, brand: 'Bowman', product: 'Chrome', parallel: 'Gold', serial: '50', gradeCompany: 'PSA', gradeValue: '10', autoFlag: true, notes: '', normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-gold_50', parallelBucket: 'gold_50', importedAt: '2026-04-02'
  }
];

// Falling market case
const fallingComps = [
  {
    source: 'mock', listingTitle: '2025 Bowman Chrome Josiah Hartshorn Gold Auto /50', salePrice: 1300, soldDate: '2026-03-01', playerName: 'Josiah Hartshorn', year: 2025, brand: 'Bowman', product: 'Chrome', parallel: 'Gold', serial: '50', gradeCompany: 'PSA', gradeValue: '10', autoFlag: true, notes: '', normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-gold_50', parallelBucket: 'gold_50', importedAt: '2026-03-02'
  },
  {
    source: 'mock', listingTitle: '2025 Bowman Chrome Josiah Hartshorn Gold Auto /50', salePrice: 1200, soldDate: '2026-03-15', playerName: 'Josiah Hartshorn', year: 2025, brand: 'Bowman', product: 'Chrome', parallel: 'Gold', serial: '50', gradeCompany: 'PSA', gradeValue: '10', autoFlag: true, notes: '', normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-gold_50', parallelBucket: 'gold_50', importedAt: '2026-03-16'
  },
  {
    source: 'mock', listingTitle: '2025 Bowman Chrome Josiah Hartshorn Gold Auto /50', salePrice: 1100, soldDate: '2026-04-01', playerName: 'Josiah Hartshorn', year: 2025, brand: 'Bowman', product: 'Chrome', parallel: 'Gold', serial: '50', gradeCompany: 'PSA', gradeValue: '10', autoFlag: true, notes: '', normalizedCardKey: '2025-Bowman-Chrome-Josiah Hartshorn-gold_50', parallelBucket: 'gold_50', importedAt: '2026-04-02'
  }
];

module.exports = [
  ...directComps,
  ...risingComps,
  ...fallingComps
];
