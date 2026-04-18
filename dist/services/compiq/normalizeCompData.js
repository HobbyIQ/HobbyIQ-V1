"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeComps = normalizeComps;
function normalizeComps(comps) {
    return comps.map(c => ({ ...c, normalized: true }));
}
