"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const supertest_1 = __importDefault(require("supertest"));
const server_1 = __importDefault(require("../../src/server"));
describe('POST /api/brain/card-decision', () => {
    it('should return a recommendation for a valid payload', async () => {
        const res = await (0, supertest_1.default)(server_1.default)
            .post('/api/brain/card-decision')
            .send({
            player: 'Josiah Hartshorn',
            cardSet: 'Bowman Chrome',
            year: 2025,
            product: 'Bowman',
            parallel: 'Gold Shimmer',
            grade: 'raw',
            askingPrice: 375,
            userIntent: 'buy'
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.summary).toBeDefined();
        expect(res.body.summary.recommendation).toBeDefined();
    });
    it('should fail validation for missing fields', async () => {
        const res = await (0, supertest_1.default)(server_1.default)
            .post('/api/brain/card-decision')
            .send({ player: 'Josiah Hartshorn' });
        expect(res.statusCode).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBeDefined();
    });
});
