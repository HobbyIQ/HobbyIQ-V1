export interface IntakeConfig {
  intakeEnabled: boolean;
  csvImportEnabled: boolean;
  manualImportEnabled: boolean;
  ebayImportEnabled: boolean;
  psaImportEnabled: boolean;
  fuzzyMatchThreshold: number;
  autoMergeExactMatches: boolean;
  requireManualReviewForLowConfidence: boolean;
  maxRowsPerImportBatch: number;
}

export const intakeConfig: IntakeConfig = {
  intakeEnabled: process.env.INTAKE_ENABLED === 'true',
  csvImportEnabled: process.env.INTAKE_CSV_IMPORT_ENABLED === 'true',
  manualImportEnabled: process.env.INTAKE_MANUAL_IMPORT_ENABLED === 'true',
  ebayImportEnabled: process.env.INTAKE_EBAY_IMPORT_ENABLED === 'true',
  psaImportEnabled: process.env.INTAKE_PSA_IMPORT_ENABLED === 'true',
  fuzzyMatchThreshold: Number(process.env.INTAKE_FUZZY_MATCH_THRESHOLD ?? 0.85),
  autoMergeExactMatches: process.env.INTAKE_AUTO_MERGE_EXACT_MATCHES === 'true',
  requireManualReviewForLowConfidence: process.env.INTAKE_REQUIRE_MANUAL_REVIEW_LOW_CONFIDENCE === 'true',
  maxRowsPerImportBatch: Number(process.env.INTAKE_MAX_ROWS_PER_BATCH ?? 1000),
};
