export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenAttempts: number;
}

export class CircuitBreakerService {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private halfOpenAttempts = 0;

  constructor(private options: CircuitBreakerOptions) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (this.state === 'OPEN') {
      if (now - this.lastFailureTime > this.options.cooldownMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenAttempts = 0;
      } else {
        throw new Error('Circuit breaker is OPEN');
      }
    }
    try {
      const result = await fn();
      this.reset();
      return result;
    } catch (err) {
      this.failureCount++;
      this.lastFailureTime = now;
      if (this.state === 'HALF_OPEN') {
        this.halfOpenAttempts++;
        if (this.halfOpenAttempts >= this.options.halfOpenAttempts) {
          this.state = 'OPEN';
        }
      } else if (this.failureCount >= this.options.failureThreshold) {
        this.state = 'OPEN';
      }
      throw err;
    }
  }

  private reset() {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
  }

  getState() {
    return this.state;
  }
}
