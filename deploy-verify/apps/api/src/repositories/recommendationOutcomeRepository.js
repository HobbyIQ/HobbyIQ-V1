"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recommendationOutcomeRepository = void 0;
// src/repositories/recommendationOutcomeRepository.ts
const uuid_1 = require("uuid");
const mockLearning_1 = require("../data/mockLearning");
const outcomes = [...mockLearning_1.mockRecommendationOutcomes];
exports.recommendationOutcomeRepository = {
    add(outcome) {
        const o = { ...outcome, id: (0, uuid_1.v4)() };
        outcomes.push(o);
        return o;
    },
    getByRecommendation(recommendationId) {
        return outcomes.filter(o => o.recommendationId === recommendationId);
    },
    getRecent(limit = 10) {
        return outcomes.slice(-limit);
    },
    getAll() {
        return [...outcomes];
    },
};
