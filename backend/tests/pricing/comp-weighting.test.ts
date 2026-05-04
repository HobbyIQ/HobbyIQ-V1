
import { computeFinalCompWeight } from '../../src/modules/compiq/services/pricing/utils/pricing.mappers.js';
import { NormalizedComp } from '../../src/modules/compiq/models/comp.types.js';
import { expect } from 'chai';

describe('computeFinalCompWeight', () => {
  it('returns 0 for all-zero input', () => {
    const comp: NormalizedComp = {
      id: 'c', price: 0, date: '', source: '', normalized: true,
      recencyScore: 0, similarityScore: 0, provenanceScore: { finalTrustScore: 0 }, compStrengthScore: 0, auctionQualityScore: 0, timeToSellScore: 0, listingQualityScore: 0
    };
    expect(computeFinalCompWeight(comp, 0)).to.equal(0);
  });

  it('clamps to 100 for high input', () => {
    const comp: NormalizedComp = {
      id: 'c', price: 0, date: '', source: '', normalized: true,
      recencyScore: 100, similarityScore: 100, provenanceScore: { finalTrustScore: 100 }, compStrengthScore: 100, auctionQualityScore: 100, timeToSellScore: 100, listingQualityScore: 100
    };
    expect(computeFinalCompWeight(comp, 100)).to.equal(100);
  });
});
