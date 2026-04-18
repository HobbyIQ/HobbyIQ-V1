import { FeatureFlagKey } from './feature-flag.types';
import { FeatureFlagRepository, InMemoryFeatureFlagRepository } from './feature-flag.repository';

export class FeatureFlagService {
  constructor(private repo: FeatureFlagRepository = new InMemoryFeatureFlagRepository()) {}

  async isEnabled(key: FeatureFlagKey, userId?: string): Promise<boolean> {
    const flag = await this.repo.getFlag(key, userId);
    return !!flag?.enabled;
  }

  async setFlag(key: FeatureFlagKey, enabled: boolean, userId?: string) {
    await this.repo.setFlag({ key, enabled, userId });
  }

  async listFlags() {
    return this.repo.listFlags();
  }
}
