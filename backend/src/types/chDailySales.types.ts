// CF-CH-DAILY-EXPORT-INGEST (Drew, 2026-07-16). Types for the CardHedge
// /v1/download/daily-price-export/{file_date} bulk CSV file.
//
// The file is one row per individual sale CH ingested that day (raw +
// graded, cross-sport). ~78k rows / ~40 MB uncompressed CSV per day at
// current scale. Elite/Enterprise tier only.
//
// Field enumeration lifted verbatim from the CSV header:
//   price_history_id,source,description,price,listing_url,image_url,
//   pop,sale_date,sale_type,card_id,card_description,number,player,
//   grade,grader,group,card_set,card_set_type,variant,year,
//   created_at,updated_at

/** One sale row from the daily CSV, typed. */
export interface CHDailySaleRow {
  /** Bubble-style unique id; use as Cosmos doc id for idempotency. */
  price_history_id: string;
  /** Origin marketplace ("ebay", etc.). */
  source: string;
  /** Free-text sale description (title line from the source listing). */
  description: string;
  /** Sale price in USD. */
  price: number;
  /** Original listing URL (eBay item URL, etc.). Empty string when absent. */
  listing_url: string;
  /** Listing thumbnail image URL. */
  image_url: string;
  /** Population count on CH's side. 0 when unknown. */
  pop: number;
  /** ISO 8601 timestamp of the sale. */
  sale_date: string;
  /** "Auction" | "BIN" | "" (empty when CH couldn't classify). */
  sale_type: string;
  /** CH card_id — the join key for our comp pool. */
  card_id: string;
  /** CH's canonical card description ("Player Year Set"). */
  card_description: string;
  /** Card number ("BCP-1", "133", etc.). */
  number: string;
  /** Player name as CH normalizes it. */
  player: string;
  /** Grade string ("10", "9.5", "Raw"). */
  grade: string;
  /** Grader string ("PSA", "BGS", "SGC", "CGC", "Raw"). */
  grader: string;
  /** Category ("Baseball", "Basketball", "Football", "Multi-Sport", etc.). */
  group: string;
  /** Full set name ("1993 Topps Baseball"). */
  card_set: string;
  /** Set type ("Topps Baseball", "Topps Chrome", etc.). */
  card_set_type: string;
  /** Variant / parallel ("Base", "Refractor", "Gold", etc.). */
  variant: string;
  /** 4-digit year as a number. */
  year: number;
  /** ISO 8601 timestamp CH ingested the row. */
  created_at: string;
  /** ISO 8601 timestamp of the last CH-side update to the row. */
  updated_at: string;
}

/**
 * The 22 header columns, in order. Used by the parser + as pinning
 * evidence — if CH changes the header, the parser fails loudly instead
 * of silently mis-mapping fields.
 */
export const CH_DAILY_SALES_HEADER: readonly string[] = [
  "price_history_id",
  "source",
  "description",
  "price",
  "listing_url",
  "image_url",
  "pop",
  "sale_date",
  "sale_type",
  "card_id",
  "card_description",
  "number",
  "player",
  "grade",
  "grader",
  "group",
  "card_set",
  "card_set_type",
  "variant",
  "year",
  "created_at",
  "updated_at",
];
