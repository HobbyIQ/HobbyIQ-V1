"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryAuditLogRepository = void 0;
class InMemoryAuditLogRepository {
    constructor() {
        this.logs = [];
    }
    async add(entry) {
        this.logs.push(entry);
    }
    async list(params) {
        return this.logs.filter(l => (!params?.entityId || l.entityId === params.entityId) &&
            (!params?.action || l.action === params.action) &&
            (!params?.actor || l.actor === params.actor));
    }
}
exports.InMemoryAuditLogRepository = InMemoryAuditLogRepository;
