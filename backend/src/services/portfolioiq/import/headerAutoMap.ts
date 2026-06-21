// CF-IMPORT-BE (2026-06-21) — header auto-map for arbitrary sheets.
//
// Maps common spreadsheet header variations to the canonical column keys
// from CF-EXPORT-BE's EXPORT_COLUMNS. Returns a *proposed* mapping the
// user can override during the reconciliation step — never silently
// commits a guessed mapping.

import { EXPORT_COLUMNS, type ExportColumn } from "../exportHoldings.service.js";

/**
 * Synonym table: lowercase normalized header → canonical column header.
 * Both sides are matched case-insensitively + with whitespace/punctuation
 * normalized. Add entries here as users surface new variations.
 */
const SYNONYMS: Record<string, string> = {
  // playerName
  "player": "playerName",
  "playername": "playerName",
  "name": "playerName",
  "player name": "playerName",
  // cardYear
  "year": "cardYear",
  "yr": "cardYear",
  "cardyear": "cardYear",
  "card year": "cardYear",
  "season": "cardYear",
  // product / brand / release
  "brand": "product",
  "set": "product",
  "release": "product",
  "product line": "product",
  // cardTitle
  "title": "cardTitle",
  "cardtitle": "cardTitle",
  "card": "cardTitle",
  "description": "cardTitle",
  // cardNumber
  "cardnumber": "cardNumber",
  "card number": "cardNumber",
  "card #": "cardNumber",
  "#": "cardNumber",
  "number": "cardNumber",
  // parallel
  "variant": "parallel",
  "color": "parallel",
  "refractor": "parallel",
  // serialNumber
  "serial": "serialNumber",
  "serialnumber": "serialNumber",
  "serial number": "serialNumber",
  "serial #": "serialNumber",
  "print run": "serialNumber",
  "numbered": "serialNumber",
  // isAuto
  "auto": "isAuto",
  "autograph": "isAuto",
  "isauto": "isAuto",
  "signed": "isAuto",
  // grade
  "grade": "gradeValue",
  "gradevalue": "gradeValue",
  "gradecompany": "gradeCompany",
  "grader": "gradeCompany",
  "grading company": "gradeCompany",
  "cert": "certNumber",
  "certificate": "certNumber",
  "certnumber": "certNumber",
  "cert number": "certNumber",
  "certificate number": "certNumber",
  // quantity
  "qty": "quantity",
  "qnty": "quantity",
  "count": "quantity",
  "copies": "quantity",
  // purchasePrice
  "price": "purchasePrice",
  "paid": "purchasePrice",
  "cost": "purchasePrice",
  "purchase price": "purchasePrice",
  "purchaseprice": "purchasePrice",
  "buy price": "purchasePrice",
  // totalCostBasis
  "total cost": "totalCostBasis",
  "totalcost": "totalCostBasis",
  "total cost basis": "totalCostBasis",
  "totalcostbasis": "totalCostBasis",
  "basis": "totalCostBasis",
  // purchaseDate
  "date": "purchaseDate",
  "purchase date": "purchaseDate",
  "purchasedate": "purchaseDate",
  "acquired": "purchaseDate",
  "acquired date": "purchaseDate",
  "bought": "purchaseDate",
  // purchaseSource
  "source": "purchaseSource",
  "seller": "purchaseSource",
  "from": "purchaseSource",
  "purchase source": "purchaseSource",
  "purchasesource": "purchaseSource",
  // listingPrice
  "asking": "listingPrice",
  "asking price": "listingPrice",
  "ask": "listingPrice",
  "list price": "listingPrice",
  "listingprice": "listingPrice",
  // listingUrl
  "url": "listingUrl",
  "listing url": "listingUrl",
  "link": "listingUrl",
  "listingurl": "listingUrl",
  // fairMarketValue
  "fmv": "fairMarketValue",
  "value": "fairMarketValue",
  "market value": "fairMarketValue",
  "fairmarketvalue": "fairMarketValue",
  "current value": "fairMarketValue",
  // notes
  "note": "notes",
  "comment": "notes",
  "comments": "notes",
  "memo": "notes",
};

/**
 * Round-trip detection: a sheet that has `holdingId` OR `cardsightCardId`
 * in its headers (any case) is treated as a round-trip-schema file —
 * import uses strict parsing + skips auto-map.
 */
const ROUND_TRIP_ANCHOR_HEADERS = new Set(["holdingid", "cardsightcardid"]);

export interface AutoMapResult {
  /** True when the file looks like CF-EXPORT-BE's own output (carries holdingId or cardsightCardId). */
  isRoundTrip: boolean;
  /** Mapping from raw sheet header → canonical column header (or null when no map proposed). */
  mapping: Record<string, string | null>;
  /** Sheet headers we couldn't auto-map. User selects manually in the reconciliation step. */
  unmapped: string[];
  /** Canonical columns the sheet doesn't appear to cover. Informational — most aren't required to import. */
  missingCanonical: string[];
}

/**
 * Auto-map a sheet's headers to canonical columns. Returns a proposed
 * mapping; the caller is expected to allow user override before the
 * resolve+commit phase.
 */
export function autoMapHeaders(headers: ReadonlyArray<string>): AutoMapResult {
  // Round-trip detection
  const normalizedHeaders = headers.map(normalize);
  const isRoundTrip = normalizedHeaders.some((h) => ROUND_TRIP_ANCHOR_HEADERS.has(h));

  // Canonical headers (case-sensitive — these go straight back into the import)
  const canonicalByLower: Map<string, string> = new Map(
    EXPORT_COLUMNS.map((c: ExportColumn) => [c.header.toLowerCase(), c.header]),
  );

  const mapping: Record<string, string | null> = {};
  const unmapped: string[] = [];
  const coveredCanonical = new Set<string>();

  for (const original of headers) {
    const norm = normalize(original);
    // Exact canonical match (case-insensitive)
    const canonicalDirect = canonicalByLower.get(norm);
    if (canonicalDirect) {
      mapping[original] = canonicalDirect;
      coveredCanonical.add(canonicalDirect);
      continue;
    }
    // Synonym match
    const synonymTarget = SYNONYMS[norm];
    if (synonymTarget) {
      mapping[original] = synonymTarget;
      coveredCanonical.add(synonymTarget);
      continue;
    }
    // No proposal
    mapping[original] = null;
    unmapped.push(original);
  }

  const missingCanonical = EXPORT_COLUMNS
    .map((c) => c.header)
    .filter((h) => !coveredCanonical.has(h));

  return { isRoundTrip, mapping, unmapped, missingCanonical };
}

/** Normalize a header for comparison: lowercase, trim, collapse internal whitespace, drop trailing punctuation. */
function normalize(h: string): string {
  return String(h).toLowerCase().trim().replace(/\s+/g, " ").replace(/[:.]$/, "");
}
