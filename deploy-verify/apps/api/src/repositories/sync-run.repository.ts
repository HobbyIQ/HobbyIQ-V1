import { SyncRun } from '../domain/integrations/sync-run';

export interface SyncRunRepository {
  save(syncRun: SyncRun): Promise<void>;
  listRecentRuns(userId?: string | null, provider?: string | null, limit?: number): Promise<SyncRun[]>;
}
