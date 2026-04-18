// Orchestrates refresh requests, batching, dedupe, and execution
export interface SnapshotRefreshOrchestrator {
  queueRefreshRequest(request: SnapshotRefreshRequest): Promise<void>;
  processQueue(): Promise<void>;
}

export interface SnapshotRefreshRequest {
  requestId: string;
  entityType: string;
  entityKey: string;
  playerId?: string;
  cardKey?: string;
  reasonCodes: string[];
  requestedAt: Date;
  priority: 'high' | 'medium' | 'low';
  forceRefresh: boolean;
  requestedBy: string;
  dependencyContextJson?: any;
}
