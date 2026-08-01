// CF-VENDOR-CLEANING-INDEX (Drew, 2026-08-01). Aggregator + shared
// helper. Every vendor cleaner exports its own `clean()` function;
// callers should import the specific vendor cleaner and invoke it
// before handing the result to recordSoldComp.
//
// Also exposes `applyFlagsToInput` so the post-cleaning flag stamps
// (unverified / titleMismatch / etc.) can be forwarded to
// recordSoldComp's write path.

export { cardsightCleaner } from "./cardsight.cleaner.js";
export { cardhedgeCleaner } from "./cardhedge.cleaner.js";
export { ebayUserPurchaseCleaner } from "./ebayUserPurchase.cleaner.js";
export { manualEntryCleaner } from "./manualEntry.cleaner.js";
export type * from "./types.js";

import type { CleaningFlag } from "./types.js";
import type { RecordSoldCompInput } from "../portfolioiq/soldCompsStore.service.js";

/** Merge cleaning flags into a payload that recordSoldComp can persist. */
export function flagsToWriteMetadata(flags: CleaningFlag[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const at = new Date().toISOString();
  for (const f of flags) {
    switch (f.kind) {
      case "unverified":
        out.__cardsightUnverified = true;
        break;
      case "priceOutlier":
        out.__priceOutlier = true;
        out.__priceOutlierAt = at;
        if (f.detail) out.__priceOutlierReason = f.detail;
        break;
      case "titleMismatch":
        out.__titleMismatch = true;
        if (f.detail) out.__titleMismatchReason = f.detail;
        break;
      case "lowConfidence":
        out.__lowConfidence = true;
        break;
      case "badActor":
        out.__badActorSeller = true;
        out.__badActorSellerAt = at;
        break;
    }
  }
  return out;
}

/** Convenience: run a cleaner and log rejections centrally. */
export type CleanedForWrite = { input: RecordSoldCompInput; flagsMeta: Record<string, unknown> } | { rejected: true; category: string; reason: string; vendorName: string };
