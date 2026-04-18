import { ProviderHealthService } from '../../services/reliability/provider-health.service';

describe('ProviderHealthService', () => {
  it('should report config status', async () => {
    const service = new ProviderHealthService();
    const status = await service.getStatus();
    expect(status.ebay).toBeDefined();
    expect(status.psa).toBeDefined();
    expect(status.redis).toBeDefined();
    expect(status.queue).toBeDefined();
    expect(status.encryption).toBeDefined();
  });
});
