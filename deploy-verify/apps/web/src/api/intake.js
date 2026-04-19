"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.importManual = importManual;
exports.importCsv = importCsv;
exports.getBatch = getBatch;
exports.reconcileBatch = reconcileBatch;
exports.getDiagnostics = getDiagnostics;
// Intake API module for HobbyIQ web
const axios_1 = __importDefault(require("axios"));
async function importManual(rows) {
    const res = await axios_1.default.post('/api/intake/manual', { rows });
    return res.data;
}
async function importCsv(rows) {
    const res = await axios_1.default.post('/api/intake/csv', { rows });
    return res.data;
}
async function getBatch(batchId) {
    const res = await axios_1.default.get(`/api/intake/batch/${batchId}`);
    return res.data;
}
async function reconcileBatch(batchId) {
    const res = await axios_1.default.post(`/api/intake/reconcile/${batchId}`);
    return res.data;
}
async function getDiagnostics(batchId) {
    const res = await axios_1.default.get(`/api/intake/diagnostics/${batchId}`);
    return res.data;
}
