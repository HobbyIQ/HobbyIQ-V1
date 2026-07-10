// CF-REFERENCE-CATALOG (2026-07-10, Drew — Phase 4). Shared types for the
// reference-catalog Cosmos container. Two document families discriminated
// by `docType`:
//
//   - "parallel" — every parallel row from the Bowman/Topps/Other workbooks
//   - "set"      — every set row from the vintage-set workbook (Phase 3
//                  deliverable, folded in the same container so CompIQ
//                  can consult one repo for all reference lookups)
//
// Schema-versioned so future changes can migrate without a re-ingest.

export const SCHEMA_VERSION = 1;

export type Confidence = "Verified" | "High" | "Medium";

export interface ParallelDoc {
  /** sha1 of `${year}|${productKey}|${cardSetKey}|${parallelKey}`. */
  id: string;
  docType: "parallel";
  /** Cosmos partition key. Slug of the product family (e.g. "bowman-chrome"). */
  productKey: string;
  /** Display product name ("Bowman Chrome"). */
  product: string;
  year: number;
  /** Slug of the card-set name — stable join key back to the workbook. */
  cardSetKey: string;
  /** Display card-set name ("Chrome Prospect Autographs"). */
  cardSet: string;
  /** Slug of the parallel — used for canonical lookups. */
  parallelKey: string;
  /** Display parallel name ("Gold Refractor"). */
  parallel: string;
  /**
   * The parallel's declared print run. Null when Numbered=No OR when
   * the print run is per-card (perCardRun=true). Never zero.
   */
  printRun: number | null;
  /** Numbered column verbatim (Y/Yes → true, else false). */
  numbered: boolean;
  /**
   * Derived: Numbered=Yes AND Print Run blank. Signals a parallel whose
   * print run varies per card — e.g. Bowman Sterling 2005 base parallels
   * where each card in the set has a different serial number tier.
   */
  runVaries: boolean;
  /**
   * Derived: notes contain "PER-CARD" (case-insensitive). Fires on the
   * 1997-2005 Essential Credentials / Stat Line / Aspirations / Status
   * schemes where the print run is per-CARD, not per-parallel. The
   * multiplier model MUST NOT use printRun on these; caller resolves the
   * per-card run from Phase 4b data instead.
   */
  perCardRun: boolean;
  /** Autograph parallel flag (workbook column: Auto = Y). */
  auto: boolean;
  /**
   * Derived: false for products from the unlicensed manufacturers list
   * (Panini*, Leaf Metal/Trinity, TRISTAR, Onyx). Downstream may cap
   * multipliers on unlicensed products.
   */
  licensed: boolean;
  confidence: Confidence;
  notes: string;
  /**
   * Populated by the Phase 2 verification sweep. Null on initial ingest.
   * When present + confidence="Verified", this row was cross-checked
   * against a canonical source (BaseballCardPedia / Cardboard Connection /
   * TCDb / Beckett OPG).
   */
  sourceUrl: string | null;
  schemaVersion: typeof SCHEMA_VERSION;
  updatedAt: string;
}

export interface SetDoc {
  /** sha1 of `${yearText}|${setKey}`. */
  id: string;
  docType: "set";
  /**
   * Slug of the set name — used as Cosmos partition key too so all
   * documents for a given set share a partition regardless of docType.
   */
  productKey: string;
  /**
   * Verbatim year field from the workbook — vintage rows are often
   * multi-year ("1909-11", "1949-52", "1961").
   */
  yearText: string;
  /** Numeric sort year (min year in the range). */
  sortYear: number;
  setName: string;
  manufacturer: string;
  setType: string;
  setSize: number | null;
  format: string;
  notes: string;
  confidence: string;
  schemaVersion: typeof SCHEMA_VERSION;
  updatedAt: string;
}

export type ReferenceDoc = ParallelDoc | SetDoc;

/**
 * Manufacturers whose products are unlicensed (no MLB team logos etc.).
 * Used to derive ParallelDoc.licensed. Case-insensitive substring match
 * against the product string.
 */
export const UNLICENSED_PRODUCT_MARKERS: ReadonlyArray<string> = [
  "panini",       // all Panini baseball products
  "leaf metal",   // Leaf Metal Draft
  "leaf trinity",
  "leaf pro set",
  "leaf ultimate",
  "tristar",
  "onyx",
];

export function isLicensedProduct(product: string): boolean {
  const lower = product.toLowerCase();
  for (const marker of UNLICENSED_PRODUCT_MARKERS) {
    if (lower.includes(marker)) return false;
  }
  return true;
}
