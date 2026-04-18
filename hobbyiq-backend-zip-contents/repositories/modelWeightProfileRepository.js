"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.modelWeightProfileRepository = void 0;
// src/repositories/modelWeightProfileRepository.ts
const uuid_1 = require("uuid");
const mockLearning_1 = require("../data/mockLearning");
const profiles = [...mockLearning_1.mockWeightProfiles];
exports.modelWeightProfileRepository = {
    add(profile) {
        const p = { ...profile, id: (0, uuid_1.v4)() };
        profiles.push(p);
        return p;
    },
    getBySegment(segment) {
        return profiles.filter(p => p.marketSegment === segment);
    },
    getActiveBySegment(segment) {
        // Return latest approved profile for segment
        return profiles.filter(p => p.marketSegment === segment && p.approved)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    },
    getAll() {
        return [...profiles];
    },
};
