"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RefreshDeduperService = void 0;
const ACTIVE_LOCK_TTL_MS = 60000;
class RefreshDeduperService {
    constructor() {
        this.active = new Map();
    }
    tryAcquire(entityType, entityKey) {
        const key = `${entityType}:${entityKey}`;
        const now = Date.now();
        const existing = this.active.get(key);
        if (existing && now - existing < ACTIVE_LOCK_TTL_MS) {
            return false;
        }
        this.active.set(key, now);
        return true;
    }
    release(entityType, entityKey) {
        this.active.delete(`${entityType}:${entityKey}`);
    }
}
exports.RefreshDeduperService = RefreshDeduperService;
