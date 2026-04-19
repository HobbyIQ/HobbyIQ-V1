"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateCardValues = estimateCardValues;
// Example fallback logic for demo; replace with real pricing engine
function estimateCardValues(parsed) {
    const warnings = [...parsed.warnings];
    // Fallback: If missing player/set/parallel, cannot estimate
    if (!parsed.player || !parsed.cardSet || !parsed.parallel) {
        warnings.push("Insufficient data for valuation");
        return {
            rawPrice: null,
            adjustedRaw: null,
            estimatedPsa9: null,
            estimatedPsa10: null,
            warnings,
        };
    }
    // Fallback: simple mock logic (replace with real comps lookup)
    let base = 50;
    if (parsed.parallel?.includes("gold"))
        base = 500;
    else if (parsed.parallel?.includes("silver"))
        base = 120;
    else if (parsed.parallel?.includes("auto"))
        base = 300;
    // Add some variability for demo
    const rawPrice = base;
    const adjustedRaw = Math.round(base * 0.95);
    const estimatedPsa9 = Math.round(base * 2.1);
    const estimatedPsa10 = Math.round(base * 3.5);
    return {
        rawPrice,
        adjustedRaw,
        estimatedPsa9,
        estimatedPsa10,
        warnings,
    };
}
