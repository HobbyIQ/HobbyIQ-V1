import { AuditLogEntry, AuditAction } from './audit-log.types';
import { AuditLogRepository, InMemoryAuditLogRepository } from './audit-log.repository';
import { v4 as uuidv4 } from 'uuid';

export class AuditLogService {
  constructor(private repo: AuditLogRepository = new InMemoryAuditLogRepository()) {}

  async log(action: AuditAction, actor: string, entityId?: string, entityType?: string, metadata?: Record<string, unknown>) {
    const entry: AuditLogEntry = {
      id: uuidv4(),
      action,
      actor,
      entityId,
      entityType,
      timestamp: new Date().toISOString(),
      metadata,
    };
    await this.repo.add(entry);
  }

  async list(params?: { entityId?: string; action?: string; actor?: string; }) {
    return this.repo.list(params);
  }
}
