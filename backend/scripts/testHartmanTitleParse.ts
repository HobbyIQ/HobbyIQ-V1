#!/usr/bin/env -S npx tsx
// One-off: verify what parseListingIdentity returns for the Hartman
// mis-tagged titles so we can tell whether the ingest bug is still
// live or whether these are pre-#895 rows the backfill missed.
import { parseListingIdentity } from "../src/services/portfolioiq/parseTitleIdentity.service.js";

const TITLES = [
  "Eric Hartman 1st Bowman Auto 2026 Bowman #CPA-EHA Atlanta Braves - Raw",
  "2026 Bowman Eric Hartman Chrome 1st Auto #CPA-EHA Braves Prospect - Raw",
  "2026 Bowman Eric Hartman Chrome Auto #CPA-EHA - Raw",
  "2026 Bowman Eric Hartman #CPA-EHA 1st Chrome Prospect Auto Braves - Raw",
  "2026 Bowman Eric Hartman Chrome Auto Autograph 1st Prospect #CPA-EHA Braves - Raw",
  "2026 Bowman Eric Hartman Braves Chrome Prospect Autographs Auto #CPA-EHA - Raw",
  "2026 Bowman - Chrome Prospect Autographs Eric Hartman #CPA-EHA (AU, RC) - Raw",
  "2026 Bowman Eric Hartman Chrome 1st Auto Atlanta Braves #CPA-EHA - Raw",
  "2026 Bowman Blue Eric Hartman True #CPA-EHA",  // Drew's actual card
];

for (const t of TITLES) {
  const p = parseListingIdentity(t);
  console.log(`"${t}"`);
  console.log(`  → cardNumber=${p.cardNumber} parallel="${p.parallel}" isAuto=${p.isAuto} printRun=${p.printRun}`);
}
