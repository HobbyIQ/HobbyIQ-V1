"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RetryPolicyService = void 0;
class RetryPolicyService {
    constructor(options) {
        this.options = options;
    }
    async execute(fn) {
        let attempt = 0;
        let delay = this.options.baseDelayMs;
        while (true) {
            try {
                return await fn();
            }
            catch (err) {
                attempt++;
                if (attempt > this.options.maxRetries)
                    throw err;
                await new Promise(res => setTimeout(res, delay));
                delay = Math.min(delay * 2, this.options.maxDelayMs);
            }
        }
    }
}
exports.RetryPolicyService = RetryPolicyService;
