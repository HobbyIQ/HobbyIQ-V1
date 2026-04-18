"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const retry_policy_service_1 = require("../../services/reliability/retry-policy.service");
describe('RetryPolicyService', () => {
    it('should retry and eventually succeed', async () => {
        let attempts = 0;
        const retry = new retry_policy_service_1.RetryPolicyService({ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 });
        const result = await retry.execute(async () => {
            attempts++;
            if (attempts < 2)
                throw new Error('fail');
            return 'ok';
        });
        expect(result).toBe('ok');
        expect(attempts).toBe(2);
    });
});
