import { RetryPolicyService } from '../../services/reliability/retry-policy.service';

describe('RetryPolicyService', () => {
  it('should retry and eventually succeed', async () => {
    let attempts = 0;
    const retry = new RetryPolicyService({ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 });
    const result = await retry.execute(async () => {
      attempts++;
      if (attempts < 2) throw new Error('fail');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });
});
