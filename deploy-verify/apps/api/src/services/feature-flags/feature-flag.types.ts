export type FeatureFlagKey =
  | 'ebay_sync_enabled'
  | 'psa_sync_enabled'
  | 'learning_enabled'
  | 'portfolio_alerts_enabled'
  | 'dailyiq_alerts_enabled'
  | 'admin_diagnostics_enabled'
  | 'demo_seed_tools_enabled'
  | 'dry_run_alerts_enabled'
  | 'dry_run_learning_enabled'
  | 'beta_cohort_features';

export interface FeatureFlag {
  key: FeatureFlagKey;
  enabled: boolean;
  userId?: string;
}
