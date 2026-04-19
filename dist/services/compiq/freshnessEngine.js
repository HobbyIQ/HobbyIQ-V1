"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFreshnessScore = getFreshnessScore;
// Freshness Engine
function getFreshnessScore(comps) {
    if (!comps || comps.length === 0) {
        return { freshnessScore: 0, freshnessTier: 'low', notes: ['No comps available'] };
    }
    const now = Date.now();
    const compDates = comps.map(c => new Date(c.date).getTime());
    const newest = Math.max(...compDates);
    const oldest = Math.min(...compDates);
    const daysSinceNewest = (now - newest) / (1000 * 60 * 60 * 24);
    const comps7d = comps.filter(c => (now - new Date(c.date).getTime()) <= 7 * 24 * 60 * 60 * 1000).length;
    const comps14d = comps.filter(c => (now - new Date(c.date).getTime()) <= 14 * 24 * 60 * 60 * 1000).length;
    let freshnessScore = 0.2;
    let freshnessTier = 'low';
    let notes = [];
    if (comps7d >= 3) {
        freshnessScore = 1;
        freshnessTier = 'high';
        notes.push('3+ comps in last 7 days');
    }
    else if (comps14d >= 2) {
        freshnessScore = 0.7;
        freshnessTier = 'medium';
        notes.push('2+ comps in last 14 days');
    }
    else if (daysSinceNewest < 30) {
        freshnessScore = 0.4;
        freshnessTier = 'medium';
        notes.push('Recent comp within 30 days');
    }
    else {
        notes.push('No recent comps in last 30 days');
    }
    return { freshnessScore, freshnessTier, notes };
}
