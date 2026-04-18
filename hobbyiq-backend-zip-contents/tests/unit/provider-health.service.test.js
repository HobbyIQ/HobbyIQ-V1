"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const provider_health_service_1 = require("../../services/reliability/provider-health.service");
describe('ProviderHealthService', () => {
    it('should report config status', async () => {
        const service = new provider_health_service_1.ProviderHealthService();
        const status = await service.getStatus();
        expect(status.ebay).toBeDefined();
        expect(status.psa).toBeDefined();
        expect(status.redis).toBeDefined();
        expect(status.queue).toBeDefined();
        expect(status.encryption).toBeDefined();
    });
});
