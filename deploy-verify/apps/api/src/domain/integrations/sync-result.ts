import { SyncRunStatus } from './sync-run';

export interface SyncResult {
  status: SyncRunStatus;
  created: number;
  updated: number;
  matched: number;
  errors: Array<{ code: string; message: string; context?: Record<string, unknown> }>;
}
