"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isExactMatch = isExactMatch;
exports.filterExactMatches = filterExactMatches;
/**
 * Returns true if the comp matches all provided fields exactly (case-insensitive, trimmed).
 */
function isExactMatch(comp, opts) {
    if (opts.playerName && (!comp.playerName || comp.playerName.trim().toLowerCase() !== opts.playerName.trim().toLowerCase()))
        return false;
    if (opts.cardSet && (!comp.cardSet || comp.cardSet.trim().toLowerCase() !== opts.cardSet.trim().toLowerCase()))
        return false;
    if (opts.year && comp.year !== opts.year)
        return false;
    if (opts.cardNumber && (!comp.cardNumber || comp.cardNumber.trim().toLowerCase() !== opts.cardNumber.trim().toLowerCase()))
        return false;
    if (opts.parallel && (!comp.parallel || comp.parallel.trim().toLowerCase() !== opts.parallel.trim().toLowerCase()))
        return false;
    if (opts.grade && (!comp.grade || comp.grade.trim().toLowerCase() !== opts.grade.trim().toLowerCase()))
        return false;
    if (opts.grader && (!comp.grader || comp.grader.trim().toLowerCase() !== opts.grader.trim().toLowerCase()))
        return false;
    return true;
}
/**
 * Filters a list of comps to only those that are exact matches for the given options.
 */
function filterExactMatches(comps, opts) {
    return comps.filter(comp => isExactMatch(comp, opts));
}
