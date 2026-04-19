"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProviderHealthService = void 0;
const provider_config_1 = require("../../config/provider.config");
class ProviderHealthService {
    constructor(config = (0, provider_config_1.loadProviderConfig)()) {
        this.config = config;
    }
    async getStatus() {
        // TODO: Implement real health checks for Redis/queue
        return {
            ebay: {
                authConfigured: this.config.ebay.authConfigured,
                syncEnabled: this.config.ebay.syncEnabled,
                dryRun: this.config.ebay.dryRun,
            },
            psa: {
                authConfigured: this.config.psa.authConfigured,
                syncEnabled: this.config.psa.syncEnabled,
                dryRun: this.config.psa.dryRun,
            },
            redis: {
                reachable: this.config.redis.enabled,
            },
            queue: {
                reachable: this.config.queue.enabled,
            },
            encryption: {
                keyConfigured: this.config.encryption.keyConfigured,
            },
        };
    }
}
exports.ProviderHealthService = ProviderHealthService;
