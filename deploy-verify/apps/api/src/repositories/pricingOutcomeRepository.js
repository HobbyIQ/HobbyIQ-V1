"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pricingOutcomeRepository = void 0;
// src/repositories/pricingOutcomeRepository.ts
const uuid_1 = require("uuid");
const mockLearning_1 = require("../data/mockLearning");
const outcomes = [...mockLearning_1.mockPricingOutcomes];
exports.pricingOutcomeRepository = {
    add(outcome) {
        const o = { ...outcome, id: (0, uuid_1.v4)() };
        outcomes.push(o);
        return o;
    },
    getBySnapshot(snapshotId) {
        return outcomes.filter(o => o.snapshotId === snapshotId);
    },
    getRecent(limit = 10) {
        return outcomes.slice(-limit);
    },
    getAll() {
        return [...outcomes];
    },
};
