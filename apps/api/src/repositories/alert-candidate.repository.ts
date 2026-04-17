import { AlertCandidate } from "../domain/alerts/alert-candidate";

export interface AlertCandidateRepository {
  save(candidate: AlertCandidate): Promise<void>;
  saveMany(candidates: AlertCandidate[]): Promise<void>;
  findRecentByDedupeKey(dedupeKey: string, lookbackMinutes: number): Promise<AlertCandidate[]>;
  listReady(limit: number): Promise<AlertCandidate[]>;
  updateStatus(candidateId: string, status: AlertCandidate["status"]): Promise<void>;
}
