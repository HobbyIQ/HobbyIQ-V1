"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recencyWeight = recencyWeight;
function recencyWeight(daysSinceSale) {
    return Math.exp(-daysSinceSale / 14);
}
