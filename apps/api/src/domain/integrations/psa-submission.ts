export interface PsaSubmission {
  submissionId: string;
  userId: string;
  externalSubmissionId: string;
  status: string;
  serviceLevel?: string | null;
  shippedToPsaAt?: string | null;
  receivedByPsaAt?: string | null;
  gradesReadyAt?: string | null;
  orderTotal?: number | null;
  rawJson: Record<string, unknown>;
  lastSyncedAt: string;
  createdAt: string;
  updatedAt: string;
}
