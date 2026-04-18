import { FeatureFlag, FeatureFlagKey } from './feature-flag.types';

export interface FeatureFlagRepository {
  getFlag(key: FeatureFlagKey, userId?: string): Promise<FeatureFlag | null>;
  setFlag(flag: FeatureFlag): Promise<void>;
  listFlags(): Promise<FeatureFlag[]>;
}

export class InMemoryFeatureFlagRepository implements FeatureFlagRepository {
  private flags: FeatureFlag[] = [];
  async getFlag(key: FeatureFlagKey, userId?: string) {
    return this.flags.find(f => f.key === key && (!userId || f.userId === userId)) || null;
  }
  async setFlag(flag: FeatureFlag) {
    this.flags = this.flags.filter(f => f.key !== flag.key || f.userId !== flag.userId);
    this.flags.push(flag);
  }
  async listFlags() {
    return this.flags;
  }
}
