import { ImportRow } from '../../domain/intake/import-row';

export class DedupeMergeService {
  static shouldMerge(existing: any, incoming: ImportRow): boolean {
    // Example: merge if entityKey matches exactly
    return existing && existing.entityKey === incoming.rawJson.entityKey;
  }
}
