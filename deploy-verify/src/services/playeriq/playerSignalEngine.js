"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPlayerSignal = getPlayerSignal;
function getPlayerSignal(payload) {
    // Mock: always positive
    return { playerSignal: 'positive', score: 80, reasons: ['Recent performance up'] };
}
