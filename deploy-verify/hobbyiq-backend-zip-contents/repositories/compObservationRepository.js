"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compObservationRepository = void 0;
// src/repositories/compObservationRepository.ts
const uuid_1 = require("uuid");
const compObservations = [];
exports.compObservationRepository = {
    add(observation) {
        const obs = { ...observation, id: (0, uuid_1.v4)() };
        compObservations.push(obs);
        return obs;
    },
    getByCard(cardId) {
        return compObservations.filter(o => o.cardId === cardId);
    },
    getRecent(limit = 10) {
        return compObservations.slice(-limit);
    },
    getAll() {
        return [...compObservations];
    },
};
