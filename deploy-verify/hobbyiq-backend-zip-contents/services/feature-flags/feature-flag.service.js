"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeatureFlagService = void 0;
const feature_flag_repository_1 = require("./feature-flag.repository");
class FeatureFlagService {
    constructor(repo = new feature_flag_repository_1.InMemoryFeatureFlagRepository()) {
        this.repo = repo;
    }
    async isEnabled(key, userId) {
        const flag = await this.repo.getFlag(key, userId);
        return !!flag?.enabled;
    }
    async setFlag(key, enabled, userId) {
        await this.repo.setFlag({ key, enabled, userId });
    }
    async listFlags() {
        return this.repo.listFlags();
    }
}
exports.FeatureFlagService = FeatureFlagService;
