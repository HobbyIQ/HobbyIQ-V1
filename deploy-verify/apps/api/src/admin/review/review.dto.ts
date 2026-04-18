// Review DTOs
export interface ReviewItem {
  id: string;
  type: string;
  reason: string;
  data: any;
  status: 'pending' | 'reviewed' | 'resolved';
}
