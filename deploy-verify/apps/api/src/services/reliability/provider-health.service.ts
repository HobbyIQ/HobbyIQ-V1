import { loadProviderConfig, ProviderConfig } from '../../config/provider.config';

export interface ProviderHealthStatus {
  ebay: {
    authConfigured: boolean;
    syncEnabled: boolean;
    dryRun: boolean;
  };
  psa: {
    authConfigured: boolean;
    syncEnabled: boolean;
    dryRun: boolean;
  };
  redis: {
    reachable: boolean;
  };
  queue: {
    reachable: boolean;
  };
  encryption: {
    keyConfigured: boolean;
  };
}

export class ProviderHealthService {
  constructor(private config: ProviderConfig = loadProviderConfig()) {}

  async getStatus(): Promise<ProviderHealthStatus> {
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
