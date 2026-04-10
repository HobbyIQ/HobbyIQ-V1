import type { RawApifyListing, NormalizedComp } from "../../types/comps.js";
export declare const PARALLELS: string[];
/**
 * Detects the first matching parallel/variant in the title. Case-insensitive, flexible spacing.
 */
export declare function detectParallel(title: string): string | null;
export declare function normalizeComp(raw: RawApifyListing): NormalizedComp | null;
export declare function normalizeComps(rawItems: RawApifyListing[], query?: string): NormalizedComp[];
//# sourceMappingURL=normalize.d.ts.map