export type AuditAction =
  | 'portfolio_position_created'
  | 'portfolio_position_updated'
  | 'portfolio_position_deleted'
  | 'import_batch_created'
  | 'import_batch_completed'
  | 'import_batch_failed'
  | 'provider_sync_started'
  | 'provider_sync_completed'
  | 'provider_sync_failed'
  | 'admin_op'
  | 'feature_flag_changed'
  | 'learning_run_started'
  | 'learning_run_completed'
  | 'alert_candidate_promoted'
  | 'alert_candidate_suppressed'
  | 'alert_sent'
  | 'reconciliation_decision';

export interface AuditLogEntry {
  id: string;
  action: AuditAction;
  actor: string;
  entityId?: string;
  entityType?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}
