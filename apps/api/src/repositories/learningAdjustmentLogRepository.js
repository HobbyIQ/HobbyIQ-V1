"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.learningAdjustmentLogRepository = void 0;
// src/repositories/learningAdjustmentLogRepository.ts
const uuid_1 = require("uuid");
const mockLearning_1 = require("../data/mockLearning");
const logs = [...mockLearning_1.mockLearningAdjustmentLogs];
exports.learningAdjustmentLogRepository = {
    add(log) {
        const l = { ...log, id: (0, uuid_1.v4)() };
        logs.push(l);
        return l;
    },
    getBySegment(segment) {
        return logs.filter(l => l.marketSegment === segment);
    },
    getRecent(limit = 10) {
        return logs.slice(-limit);
    },
    getAll() {
        return [...logs];
    },
};
