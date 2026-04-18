"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuditLogService = void 0;
const audit_log_repository_1 = require("./audit-log.repository");
const uuid_1 = require("uuid");
class AuditLogService {
    constructor(repo = new audit_log_repository_1.InMemoryAuditLogRepository()) {
        this.repo = repo;
    }
    async log(action, actor, entityId, entityType, metadata) {
        const entry = {
            id: (0, uuid_1.v4)(),
            action,
            actor,
            entityId,
            entityType,
            timestamp: new Date().toISOString(),
            metadata,
        };
        await this.repo.add(entry);
    }
    async list(params) {
        return this.repo.list(params);
    }
}
exports.AuditLogService = AuditLogService;
