import { CompIQSoldListing } from "./types";

// Normalize a raw Apify eBay sold record to CompIQSoldListing
export function normalizeApifySoldRecord(raw: any): CompIQSoldListing | null {
  if (!raw) return null;
  // Basic validation
  const price = Number(raw.soldPrice || raw.price);
  if (!raw.title || !price || !raw.soldDate) return null;
  // Filter out obviously bad comps
  if (price < 2 || price > 100000) return null;
  // Only allow recent sales (last 2 years)
  const twoYearsAgo = Date.now() - 1000 * 60 * 60 * 24 * 730;
  if (new Date(raw.soldDate).getTime() < twoYearsAgo) return null;
  // Filter out lots, breaks, mystery, etc.
  const badWords = ['lot', 'break', 'mystery', 'bulk', 'bundle', 'box', 'case'];
  const title = raw.title.toLowerCase();
  if (badWords.some((w) => title.includes(w))) return null;
  return {
    title: raw.title,
    soldPrice: price,
    soldDate: new Date(raw.soldDate).toISOString(),
    rawTitle: raw.title,
    source: "eBay",
    url: raw.url || raw.listingUrl || undefined
  };
}

export function normalizeApifySoldRecords(raws: any[]): CompIQSoldListing[] {
  return (raws || [])
    .map(normalizeApifySoldRecord)
    .filter((x): x is CompIQSoldListing => !!x);
}
