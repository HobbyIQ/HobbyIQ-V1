"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryFeatureFlagRepository = void 0;
class InMemoryFeatureFlagRepository {
    constructor() {
        this.flags = [];
    }
    async getFlag(key, userId) {
        return this.flags.find(f => f.key === key && (!userId || f.userId === userId)) || null;
    }
    async setFlag(flag) {
        this.flags = this.flags.filter(f => f.key !== flag.key || f.userId !== flag.userId);
        this.flags.push(flag);
    }
    async listFlags() {
        return this.flags;
    }
}
exports.InMemoryFeatureFlagRepository = InMemoryFeatureFlagRepository;
