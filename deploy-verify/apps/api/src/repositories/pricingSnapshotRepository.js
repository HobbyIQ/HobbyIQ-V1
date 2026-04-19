"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pricingSnapshotRepository = void 0;
// src/repositories/pricingSnapshotRepository.ts
const uuid_1 = require("uuid");
const mockLearning_1 = require("../data/mockLearning");
const snapshots = [...mockLearning_1.mockPricingSnapshots];
exports.pricingSnapshotRepository = {
    add(snapshot) {
        const snap = { ...snapshot, id: (0, uuid_1.v4)() };
        snapshots.push(snap);
        return snap;
    },
    getByCard(cardId) {
        return snapshots.filter(s => s.cardId === cardId);
    },
    getRecent(limit = 10) {
        return snapshots.slice(-limit);
    },
    getUnresolved() {
        // Snapshots with no matching outcome
        return snapshots.filter(s => !snapshots.some(o => o.id === s.id));
    },
    getAll() {
        return [...snapshots];
    },
};
