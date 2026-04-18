"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNewsSignal = getNewsSignal;
function getNewsSignal(payload) {
    return { newsSignal: 'positive', impactScore: 70, decayDays: 2, sourceCount: 3 };
}
