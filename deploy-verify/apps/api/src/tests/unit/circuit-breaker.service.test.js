"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const circuit_breaker_service_1 = require("../../services/reliability/circuit-breaker.service");
describe('CircuitBreakerService', () => {
    it('should open after failures', async () => {
        const breaker = new circuit_breaker_service_1.CircuitBreakerService({ failureThreshold: 2, cooldownMs: 100, halfOpenAttempts: 1 });
        let fail = 0;
        await expect(breaker.execute(() => { fail++; throw new Error('fail'); })).rejects.toThrow();
        await expect(breaker.execute(() => { fail++; throw new Error('fail'); })).rejects.toThrow();
        expect(breaker.getState()).toBe('OPEN');
    });
});
