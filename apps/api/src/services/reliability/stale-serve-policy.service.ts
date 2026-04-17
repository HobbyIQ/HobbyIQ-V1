export class StaleServePolicyService {
  static shouldServeStale(lastUpdated: string, maxAgeMinutes: number): boolean {
    const updated = new Date(lastUpdated).getTime();
    const now = Date.now();
    return now - updated < maxAgeMinutes * 60 * 1000;
  }
}
