// CF-VENDOR-CLEANING (Drew, 2026-08-01). Every vendor cleans its own
// data BEFORE it enters our unified sold_comps pool. This module
// defines the shared contract: raw vendor input → CleaningResult
// (cleaned row + optional flags, OR rejection with reason).
//
// Rationale: Drew's principle "pool clean data into our own database
// cleanly". Vendor-specific validation (fuzzy-match rejection, price
// sanity, title-parse) belongs at the vendor boundary — NOT scattered
// inside the unified recordSoldComp path. This keeps sold_comps
// receiving only pre-validated rows.

import type { RecordSoldCompInput } from "../portfolioiq/soldCompsStore.service.js";

export interface CleaningContext {
  /** Player name we THINK this sale is for (from CH catalog / user
   *  query). Used for fuzzy-match rejection at cleaning time. */
  queriedPlayerName?: string | null;
  /** CardNumber we THINK this sale is for. Same purpose. */
  queriedCardNumber?: string | null;
  /** Year we THINK this sale is for. Used for slug composition. */
  queriedYear?: number | null;
  /** Set/product name we THINK this sale is for. Used for slug. */
  queriedSetName?: string | null;
}

export interface CleaningRejection {
  category: "fuzzy-match" | "duplicate" | "invalid" | "quarantine" | "empty";
  reason: string;
}

export interface CleaningFlag {
  kind: "priceOutlier" | "unverified" | "titleMismatch" | "lowConfidence" | "badActor";
  detail?: string;
}

export interface CleaningResult {
  /** Present when cleaning succeeded — safe to hand to recordSoldComp. */
  cleaned?: RecordSoldCompInput;
  /** Present when cleaning rejected the row entirely — do NOT persist. */
  rejected?: CleaningRejection;
  /** Warnings that pass cleaning but need downstream awareness (persisted
   *  as boolean flags on the row via recordSoldComp's post-write path). */
  flags: CleaningFlag[];
}

export interface VendorCleaner<RawT> {
  vendorName: string;
  clean(raw: RawT, context: CleaningContext): Promise<CleaningResult>;
}
