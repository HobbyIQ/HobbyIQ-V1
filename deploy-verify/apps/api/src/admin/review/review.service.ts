import { ReviewItem } from './review.dto';

export class ReviewService {
  async listReviewItems(type?: string): Promise<ReviewItem[]> {
    // TODO: Implement real review item fetching
    return [
      { id: '1', type: 'unmatched_ebay', reason: 'No portfolio match', data: {}, status: 'pending' },
      { id: '2', type: 'manual_review_import', reason: 'Manual review required', data: {}, status: 'pending' },
    ];
  }
}
