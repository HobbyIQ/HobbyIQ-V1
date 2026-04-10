import type { NormalizedComp, FmvSummary, GradeBucket } from "../../types/comps.js";
import type { ExactMatchOptions } from "./exactMatch.js";
/**
 * Score confidence 0-100 based on comp count, matchScore, recency, and grade consistency.
 */
export interface ConfidenceDetails {
    score: number;
    compCount: number;
    avgMatch: number;
    avgRecency: number;
    gradeConsistency: number;
    parallelConsistency: number;
}
/**
 * Calculate FMV summary and grade buckets for comps.
 */
export declare function calculateFmv(comps: NormalizedComp[], exactMatchOpts?: ExactMatchOptions): {
    summary: FmvSummary;
    buckets: GradeBucket[];
};
//# sourceMappingURL=fmv.d.ts.map