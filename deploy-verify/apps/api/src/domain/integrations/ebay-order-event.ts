export interface EbayOrderEvent {
  orderEventId: string;
  userId: string;
  externalOrderId: string;
  externalListingId?: string | null;
  soldAt?: string | null;
  quantity?: number | null;
  grossAmount?: number | null;
  feesAmount?: number | null;
  netAmount?: number | null;
  matchedPositionId?: string | null;
  entityKey?: string | null;
  rawJson: Record<string, unknown>;
  createdAt: string;
}
