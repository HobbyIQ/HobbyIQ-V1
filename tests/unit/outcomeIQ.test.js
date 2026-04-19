"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const supertest_1 = __importDefault(require("supertest"));
const server_1 = __importDefault(require("../../src/server"));
describe('POST /api/brain/card-outlook', () => {
    it('should return outcome scenarios for a valid payload', async () => {
        const res = await (0, supertest_1.default)(server_1.default)
            .post('/api/brain/card-outlook')
            .send({
            player: 'Josiah Hartshorn',
            cardSet: 'Bowman Chrome',
            year: 2025,
            product: 'Bowman',
            parallel: 'Gold Shimmer',
            grade: 'raw',
            currentEstimatedValue: 387,
            events: ['promotion', 'performance_hot']
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.summary).toBeDefined();
        expect(res.body.scenarios).toBeInstanceOf(Array);
        expect(res.body.scenarios.length).toBeGreaterThan(0);
    });
    it('should fallback to baseline scenario if events missing', async () => {
        const res = await (0, supertest_1.default)(server_1.default)
            .post('/api/brain/card-outlook')
            .send({
            player: 'Josiah Hartshorn',
            cardSet: 'Bowman Chrome',
            year: 2025,
            product: 'Bowman',
            parallel: 'Gold Shimmer',
            grade: 'raw',
            currentEstimatedValue: 387
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.scenarios).toBeInstanceOf(Array);
        expect(res.body.scenarios.length).toBeGreaterThan(0);
    });
});
