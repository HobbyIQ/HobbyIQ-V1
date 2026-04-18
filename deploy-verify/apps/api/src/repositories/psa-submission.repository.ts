import { PsaSubmission } from '../domain/integrations/psa-submission';

export interface PsaSubmissionRepository {
  create(submission: PsaSubmission): Promise<PsaSubmission>;
  update(submission: PsaSubmission): Promise<PsaSubmission>;
  upsert(submission: PsaSubmission): Promise<PsaSubmission>;
  findByExternalId(userId: string, externalSubmissionId: string): Promise<PsaSubmission | null>;
  listByUser(userId: string): Promise<PsaSubmission[]>;
}
