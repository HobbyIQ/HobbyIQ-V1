import { AuditLogEntry } from './audit-log.types';

export interface AuditLogRepository {
  add(entry: AuditLogEntry): Promise<void>;
  list(params?: { entityId?: string; action?: string; actor?: string; }): Promise<AuditLogEntry[]>;
}

export class InMemoryAuditLogRepository implements AuditLogRepository {
  private logs: AuditLogEntry[] = [];
  async add(entry: AuditLogEntry) {
    this.logs.push(entry);
  }
  async list(params?: { entityId?: string; action?: string; actor?: string; }) {
    return this.logs.filter(l =>
      (!params?.entityId || l.entityId === params.entityId) &&
      (!params?.action || l.action === params.action) &&
      (!params?.actor || l.actor === params.actor)
    );
  }
}
