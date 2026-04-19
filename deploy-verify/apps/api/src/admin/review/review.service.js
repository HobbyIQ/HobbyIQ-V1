"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReviewService = void 0;
class ReviewService {
    async listReviewItems(type) {
        // TODO: Implement real review item fetching
        return [
            { id: '1', type: 'unmatched_ebay', reason: 'No portfolio match', data: {}, status: 'pending' },
            { id: '2', type: 'manual_review_import', reason: 'Manual review required', data: {}, status: 'pending' },
        ];
    }
}
exports.ReviewService = ReviewService;
