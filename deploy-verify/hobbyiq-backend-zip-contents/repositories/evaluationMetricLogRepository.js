"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluationMetricLogRepository = void 0;
// src/repositories/evaluationMetricLogRepository.ts
const uuid_1 = require("uuid");
const mockLearning_1 = require("../data/mockLearning");
const logs = [...mockLearning_1.mockEvaluationMetricLogs];
exports.evaluationMetricLogRepository = {
    add(log) {
        const l = { ...log, id: (0, uuid_1.v4)() };
        logs.push(l);
        return l;
    },
    getByExperiment(experimentId) {
        return logs.filter(l => l.experimentId === experimentId);
    },
    getRecent(limit = 10) {
        return logs.slice(-limit);
    },
    getAll() {
        return [...logs];
    },
};
