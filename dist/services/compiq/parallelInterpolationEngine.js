"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parallelInterpolation = parallelInterpolation;
function parallelInterpolation(comps, parallelCatalog, targetParallel) {
    // Find nearby parallels and use their weighted FMV
    const nearby = Object.keys(parallelCatalog)
        .filter(p => p !== targetParallel)
        .map(p => ({
        parallel: p,
        fmv: parallelCatalog[p].fmv,
        weight: parallelCatalog[p].weight || 1
    }));
    const totalWeight = nearby.reduce((a, b) => a + b.weight, 0) || 1;
    const estimatedValue = nearby.reduce((sum, n) => sum + n.fmv * n.weight, 0) / totalWeight;
    return { estimatedValue: Math.round(estimatedValue), used: true };
}
