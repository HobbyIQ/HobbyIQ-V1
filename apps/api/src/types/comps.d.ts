/**
 * Raw listing as returned by Apify eBay sold data actor.
 * Flexible, untyped, for ingestion and normalization.
 */
export interface RawApifyListing {
    [key: string]: any;
}
/**
 * Normalized sold comp, unified schema for pricing logic.
 */
export interface NormalizedComp {
    title: string;
    playerName: string | null;
    cardSet: string | null;
    year: number | null;
    parallel: string | null;
    cardNumber: string | null;
    grade: string | null;
    grader: string | null;
    isAuto: boolean;
    isNumbered: boolean;
    serialNumber: string | null;
    price: number;
    shipping: number;
    totalPrice: number;
    soldDate: string | null;
    source: string;
    sourceUrl: string | null;
    imageUrl: string | null;
    matchScore: number;
}
/**
 * Grade bucket summary for a group of comps (e.g., RAW, PSA 9, PSA 10).
 */
export interface GradeBucket {
    label: string;
    compCount: number;
    fmv: number;
    low: number;
    high: number;
}
/**
 * FMV summary for a comp search.
 */
export interface FmvSummary {
    fmv: number;
    low: number;
    high: number;
    compCount: number;
    confidence: "Low" | "Medium" | "High";
    confidenceDetails?: {
        score: number;
        compCount: number;
        avgMatch: number;
        avgRecency: number;
        gradeConsistency: number;
        parallelConsistency: number;
    };
    methodology: string;
}
/**
 * API response for a comp search.
 */
export interface CompSearchResponse {
    query: string;
    summary: FmvSummary;
    buckets: GradeBucket[];
    comps: NormalizedComp[];
}
//# sourceMappingURL=comps.d.ts.map