import { ProviderHealthService } from '../reliability/provider-health.service';

export interface BetaReadinessReport {
  pass: boolean;
  warnings: string[];
  blockers: string[];
  recommendedActions: string[];
}

export class BetaReadinessService {
  constructor(private providerHealth: ProviderHealthService) {}

  async evaluate(): Promise<BetaReadinessReport> {
    const status = await this.providerHealth.getStatus();
    const warnings: string[] = [];
    const blockers: string[] = [];
    const recommendedActions: string[] = [];
    if (!status.ebay.authConfigured) blockers.push('eBay provider not configured');
    if (!status.psa.authConfigured) blockers.push('PSA provider not configured');
    if (!status.redis.reachable) blockers.push('Redis not reachable');
    if (!status.queue.reachable) warnings.push('Queue not reachable');
    if (!status.encryption.keyConfigured) warnings.push('Encryption key not configured');
    // TODO: Add more checks for snapshot freshness, contract validation, etc.
    return {
      pass: blockers.length === 0,
      warnings,
      blockers,
      recommendedActions,
    };
  }
}
