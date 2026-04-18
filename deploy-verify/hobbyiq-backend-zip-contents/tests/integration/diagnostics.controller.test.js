"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const supertest_1 = __importDefault(require("supertest"));
const express_1 = __importDefault(require("express"));
const diagnostics_controller_1 = __importDefault(require("../../admin/diagnostics/diagnostics.controller"));
describe('DiagnosticsController', () => {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use('/admin/diagnostics', diagnostics_controller_1.default);
    it('should return diagnostics overview', async () => {
        const res = await (0, supertest_1.default)(app).get('/admin/diagnostics/overview');
        expect(res.status).toBe(200);
        expect(res.body.providers).toBeDefined();
    });
});
