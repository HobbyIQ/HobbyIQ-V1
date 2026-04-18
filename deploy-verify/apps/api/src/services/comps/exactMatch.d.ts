import type { NormalizedComp } from "../../types/comps.js";
export interface ExactMatchOptions {
    playerName?: string;
    cardSet?: string;
    year?: number;
    cardNumber?: string;
    parallel?: string;
    grade?: string;
    grader?: string;
}
/**
 * Returns true if the comp matches all provided fields exactly (case-insensitive, trimmed).
 */
export declare function isExactMatch(comp: NormalizedComp, opts: ExactMatchOptions): boolean;
/**
 * Filters a list of comps to only those that are exact matches for the given options.
 */
export declare function filterExactMatches(comps: NormalizedComp[], opts: ExactMatchOptions): NormalizedComp[];
//# sourceMappingURL=exactMatch.d.ts.map