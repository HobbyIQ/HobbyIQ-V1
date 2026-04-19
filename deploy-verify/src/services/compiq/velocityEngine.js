"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.velocityEngine = velocityEngine;
function velocityEngine(comps) {
    if (!comps.length)
        return { velocityScore: 0, classification: 'slow' };
    const dates = comps.map(c => c.date).sort((a, b) => a - b);
    const days = (dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24) || 1;
    const salesPerDay = comps.length / days;
    let classification = 'slow';
    if (salesPerDay > 0.2)
        classification = 'normal';
    if (salesPerDay > 0.5)
        classification = 'hot';
    return { velocityScore: salesPerDay, classification };
}
