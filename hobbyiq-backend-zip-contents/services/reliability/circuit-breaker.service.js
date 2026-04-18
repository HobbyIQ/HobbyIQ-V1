"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreakerService = void 0;
class CircuitBreakerService {
    constructor(options) {
        this.options = options;
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.lastFailureTime = 0;
        this.halfOpenAttempts = 0;
    }
    async execute(fn) {
        const now = Date.now();
        if (this.state === 'OPEN') {
            if (now - this.lastFailureTime > this.options.cooldownMs) {
                this.state = 'HALF_OPEN';
                this.halfOpenAttempts = 0;
            }
            else {
                throw new Error('Circuit breaker is OPEN');
            }
        }
        try {
            const result = await fn();
            this.reset();
            return result;
        }
        catch (err) {
            this.failureCount++;
            this.lastFailureTime = now;
            if (this.state === 'HALF_OPEN') {
                this.halfOpenAttempts++;
                if (this.halfOpenAttempts >= this.options.halfOpenAttempts) {
                    this.state = 'OPEN';
                }
            }
            else if (this.failureCount >= this.options.failureThreshold) {
                this.state = 'OPEN';
            }
            throw err;
        }
    }
    reset() {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.halfOpenAttempts = 0;
    }
    getState() {
        return this.state;
    }
}
exports.CircuitBreakerService = CircuitBreakerService;
