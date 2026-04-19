"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.alertOutcomeLogRepository = void 0;
// src/repositories/alertOutcomeLogRepository.ts
const uuid_1 = require("uuid");
const mockLearning_1 = require("../data/mockLearning");
const logs = [...mockLearning_1.mockAlertOutcomeLogs];
exports.alertOutcomeLogRepository = {
    add(log) {
        const l = { ...log, id: (0, uuid_1.v4)() };
        logs.push(l);
        return l;
    },
    getByAlert(alertId) {
        return logs.filter(l => l.alertId === alertId);
    },
    getRecent(limit = 10) {
        return logs.slice(-limit);
    },
    getAll() {
        return [...logs];
    },
};
