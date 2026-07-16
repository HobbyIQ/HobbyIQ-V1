#!/usr/bin/env node
// CF-EBAY-SOLD-COMPS-FOUNDATION (2026-07-12).
//
// Retro-enrich Drew's existing ebay ledger sale entries with Browse item
// specifics. Every sale we complete becomes a first-class sold-comp for
// future market-comp queries — this script pulls that snapshot for the
// entries that pre-date the enrichment landing.

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const USER_ID = "user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4";

async function main() {
  const distSvc = path.resolve(
    __dirname,
    "..",
    "dist",
    "services",
    "portfolioiq",
    "ebaySaleEnrichment.service.js",
  );
  const { backfillSalesEnrichment } = await import(pathToFileURL(distSvc).href);

  console.log("▶ Running sale enrichment backfill for", USER_ID);
  const summary = await backfillSalesEnrichment(USER_ID);
  console.log();
  console.log("  processed:         ", summary.processed);
  console.log("  enriched:          ", summary.enriched);
  console.log("  already-enriched:  ", summary.alreadyEnriched);
  console.log("  browse-404:        ", summary.browse404);
  console.log("  missing-listing-id:", summary.missingListingId);
  console.log("  errors:            ", summary.errors);
}
main().catch((e) => { console.error(e); process.exit(1); });
