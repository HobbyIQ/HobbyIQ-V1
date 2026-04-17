"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.promptExperimentRunRepository = void 0;
// src/repositories/promptExperimentRunRepository.ts
const uuid_1 = require("uuid");
const mockLearning_1 = require("../data/mockLearning");
const runs = [...mockLearning_1.mockPromptExperimentRuns];
exports.promptExperimentRunRepository = {
    add(run) {
        const r = { ...run, id: (0, uuid_1.v4)() };
        runs.push(r);
        return r;
    },
    getRecent(limit = 10) {
        return runs.slice(-limit);
    },
    getAll() {
        return [...runs];
    },
};
