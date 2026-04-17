// Determines if a material change has occurred and triggers refresh
export interface ChangeDetectionService {
  shouldTriggerRefresh(event: MarketDataEvent, lastSnapshot: any): Promise<ChangeDetectionResult>;
}

export interface ChangeDetectionResult {
  shouldRefresh: boolean;
  priority: 'high' | 'medium' | 'low';
  reasonCodes: string[];
  affectedDependencies: string[];
}
