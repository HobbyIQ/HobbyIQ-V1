export interface RetryPolicyOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export class RetryPolicyService {
  constructor(private options: RetryPolicyOptions) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let delay = this.options.baseDelayMs;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        attempt++;
        if (attempt > this.options.maxRetries) throw err;
        await new Promise(res => setTimeout(res, delay));
        delay = Math.min(delay * 2, this.options.maxDelayMs);
      }
    }
  }
}
