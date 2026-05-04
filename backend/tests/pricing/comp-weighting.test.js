"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const pricing_mappers_1 = require("../../src/modules/compiq/services/pricing/utils/pricing.mappers");
describe('computeFinalCompWeight', () => {
    it('returns 0 for all-zero input', () => {
        const comp = {
            id: 'c', price: 0, date: '', source: '', normalized: true,
            recencyScore: 0, similarityScore: 0, provenanceScore: { finalTrustScore: 0 }, compStrengthScore: 0, auctionQualityScore: 0, timeToSellScore: 0, listingQualityScore: 0
        };
        expect((0, pricing_mappers_1.computeFinalCompWeight)(comp, 0)).toBe(0);
    });
    it('clamps to 100 for high input', () => {
        const comp = {
            id: 'c', price: 0, date: '', source: '', normalized: true,
            recencyScore: 100, similarityScore: 100, provenanceScore: { finalTrustScore: 100 }, compStrengthScore: 100, auctionQualityScore: 100, timeToSellScore: 100, listingQualityScore: 100
        };
        expect((0, pricing_mappers_1.computeFinalCompWeight)(comp, 100)).toBe(100);
    });
});
