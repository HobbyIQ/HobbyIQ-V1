#!/usr/bin/env node
// CF-BACKFILL-CATALOG-DRIVEN-CANONICALIZE (Drew, 2026-07-31).
//
// Fixes sold_comps rows that are at the wrong set slug by consulting
// CH's card_catalog as ground truth. For each (cardNumber, year), the
// catalog tells us what product family the card ACTUALLY belongs to.
//
// Three cases:
//   1. Catalog has ONE distinct set for the key → auto-assign
//   2. Catalog has multiple sets but all normalize to same canonical
//      slug → auto-assign the shared canonical
//   3. Cross-family collision (e.g. Bowman Chrome + Bowman Sapphire) →
//      use the sold_comps row's setName to pick between candidates;
//      skip if setName is generic/ambiguous
//
// Safe: no cardNumber-prefix guessing, no blanket regex. Every
// assignment is grounded in CH's actual catalog data.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   BACKFILL_MODE              dry | apply  (default dry)
//   BACKFILL_CONCURRENCY       default 8

const { CosmosClient } = require("@azure/cosmos");

// Accept either BACKFILL_MODE=apply|dry OR BACKFILL_APPLY=true|false
// (workflow dispatch passes BACKFILL_APPLY; local dev uses BACKFILL_MODE).
const MODE = (
  process.env.BACKFILL_APPLY === "true" ? "apply" : (process.env.BACKFILL_MODE || "dry")
).toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.BACKFILL_CONCURRENCY || 8));

// Mirror of prod normalizeSetKey (short list of the most-common patterns).
// If a set text doesn't match, we return null and skip the row.
function normalizeSetToCanonical(setText) {
  const s = String(setText || "").toLowerCase();
  if (!s) return null;
  // Sapphire first — distinct product
  if (/bowman chrome sapphire|bowman sapphire/.test(s)) return "bowman-chrome-sapphire";
  if (/topps chrome sapphire/.test(s)) return "topps-chrome-sapphire";
  // Bowman family
  if (/bowman chrome draft|bowman draft chrome/.test(s)) return "bowman-chrome"; // collapse subset
  if (/bowman chrome/.test(s)) return "bowman-chrome";
  if (/chrome prospect/.test(s)) return "bowman-chrome";
  if (/bowman platinum/.test(s)) return "bowman-platinum";
  if (/bowman sterling/.test(s)) return "bowman-sterling";
  if (/bowman draft/.test(s)) return "bowman-draft";
  if (/bowman mega/.test(s)) return "bowman-mega";
  if (/bowman heritage/.test(s)) return "bowman-heritage";
  if (/bowman inception/.test(s)) return "bowman-inception";
  if (/bowman transcendent/.test(s)) return "bowman-transcendent";
  if (/\bbowman\b/.test(s)) return "bowman";
  // Topps family — Chrome Platinum + Update etc. first
  if (/topps chrome platinum/.test(s)) return "topps-chrome-platinum";
  if (/topps chrome update|chrome update/.test(s)) return "topps-chrome"; // collapse subset
  if (/topps chrome black/.test(s)) return "topps-chrome-black";
  if (/topps chrome/.test(s)) return "topps-chrome";
  if (/topps heritage/.test(s)) return "topps-heritage";
  if (/topps finest|^finest\b/.test(s)) return "topps-finest";
  if (/topps pristine/.test(s)) return "topps-pristine";
  if (/topps transcendent/.test(s)) return "topps-transcendent";
  if (/topps dynasty/.test(s)) return "topps-dynasty";
  if (/topps tribute/.test(s)) return "topps-tribute";
  if (/topps museum/.test(s)) return "topps-museum-collection";
  if (/topps stadium/.test(s)) return "topps-stadium-club";
  if (/topps allen|allen.*ginter/.test(s)) return "topps-allen-ginter";
  if (/topps gypsy/.test(s)) return "topps-gypsy-queen";
  if (/topps archives/.test(s)) return "topps-archives";
  if (/topps inception/.test(s)) return "topps-inception";
  if (/topps five star/.test(s)) return "topps-five-star";
  if (/topps definitive/.test(s)) return "topps-definitive";
  if (/topps big league/.test(s)) return "topps-big-league";
  if (/\btopps\b/.test(s)) return "topps";
  // Panini
  if (/donruss champions/.test(s)) return "donruss-champions";
  if (/panini prizm|^prizm/.test(s)) return "panini-prizm";
  if (/panini select/.test(s)) return "panini-select";
  if (/panini mosaic/.test(s)) return "panini-mosaic";
  if (/panini donruss optic|donruss optic|panini optic/.test(s)) return "panini-optic";
  if (/panini donruss|donruss/.test(s)) return "panini-donruss";
  if (/panini contenders/.test(s)) return "panini-contenders";
  if (/panini immaculate/.test(s)) return "panini-immaculate";
  if (/panini flawless/.test(s)) return "panini-flawless";
  if (/national treasures/.test(s)) return "panini-national-treasures";
  if (/panini absolute/.test(s)) return "panini-absolute";
  if (/panini chronicled|panini chronicles/.test(s)) return "panini-chronicles";
  if (/panini illusions/.test(s)) return "panini-illusions";
  if (/panini prestige/.test(s)) return "panini-prestige";
  if (/panini diamond kings/.test(s)) return "panini-diamond-kings";
  if (/panini phoenix/.test(s)) return "panini-phoenix";
  if (/panini/.test(s)) return "panini";
  // Others
  if (/upper deck/.test(s)) return "upper-deck";
  if (/fleer/.test(s)) return "fleer";
  return null;
}

async function withRetry(fn, attempts = 5, baseMs = 250) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const is429 = e?.code === 429 || e?.statusCode === 429 || /Too many requests|Request rate/i.test(String(e?.message || ""));
      if (!is429) throw e;
      const wait = baseMs * Math.pow(2, i) + Math.random() * 150;
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function loadCatalogMap(cc) {
  // (year, cardNumber) → { canonical: string, candidates: string[] }
  //   canonical: assigned when all sets collapse to the same slug (auto-safe)
  //   candidates: list of distinct canonical slugs when they DIFFER (needs per-row disambiguation)
  //
  // CF-STAGE1-MULTI-SOURCE-CATALOG (Drew, 2026-08-01). Pull from BOTH
  // cardhedge and cardsight enumerated catalog rows. CS junk rows
  // (persistVendorCatalog side-effect with null number) are filtered
  // by the number-required guard below.
  const rawByKey = new Map(); // (year, cn) → Set of set text strings
  const iter = cc.items.query({
    query: "SELECT * FROM c WHERE c.source IN ('cardhedge', 'cardsight') AND (IS_DEFINED(c.cardNumber) OR IS_DEFINED(c.number))"
  }, { maxItemCount: 1000 });
  let total = 0;
  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const r of resources) {
      total++;
      const cn = String(r.number || r.cardNumber || "").trim().toUpperCase();
      const s = String(r.set || r.setName || "");
      if (!cn || !s) continue;
      const ym = s.match(/(19|20)\d{2}/);
      if (!ym) continue;
      const key = ym[0] + "::" + cn;
      if (!rawByKey.has(key)) rawByKey.set(key, new Set());
      rawByKey.get(key).add(s);
    }
  }
  const canonMap = new Map();
  for (const [k, setStrings] of rawByKey) {
    const canonicals = new Set();
    for (const s of setStrings) {
      const c = normalizeSetToCanonical(s);
      if (c) canonicals.add(c);
    }
    if (canonicals.size === 0) continue;
    if (canonicals.size === 1) canonMap.set(k, { canonical: [...canonicals][0], candidates: null });
    else canonMap.set(k, { canonical: null, candidates: [...canonicals] });
  }
  console.log(`  catalog rows scanned: ${total}`);
  console.log(`  catalog keys built:   ${canonMap.size}`);
  let unamb = 0, amb = 0;
  for (const [, v] of canonMap) { if (v.canonical) unamb++; else amb++; }
  console.log(`    unambiguous:  ${unamb}`);
  console.log(`    cross-family: ${amb}`);
  return canonMap;
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const db = c.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cc = db.container("card_catalog");
  const sc = db.container("sold_comps");

  console.log(`[backfill-catalog-driven]  mode=${MODE}  concurrency=${CONCURRENCY}`);
  console.log("Loading card_catalog into memory...");
  const catalogMap = await loadCatalogMap(cc);

  console.log("\nScanning sold_comps...");
  const iter = sc.items.query({
    query: "SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, 'hiq:')"
  }, { maxItemCount: 500 });

  let examined = 0;
  let matched = 0, ambigResolved = 0, ambigSkipped = 0, notInCatalog = 0;
  let wouldChange = 0, unchanged = 0, errors = 0;
  const transitions = {};
  const inFlight = [];

  while (iter.hasMoreResults()) {
    const { resources } = await iter.fetchNext();
    if (!Array.isArray(resources)) break;
    for (const row of resources) {
      examined++;
      const slug = row.hobbyiqCardId;
      if (typeof slug !== "string" || !slug.startsWith("hiq:")) continue;
      const parts = slug.split(":");
      if (parts.length < 6) continue;
      const cn = String(row.cardNumber || "").trim().toUpperCase();
      const yr = String(row.cardYear || "");
      if (!cn || !yr) continue;
      const key = yr + "::" + cn;
      const entry = catalogMap.get(key);
      if (!entry) { notInCatalog++; continue; }

      // CF-TWO-WITNESS-SAFEGUARD (Drew, 2026-08-01). Naive catalog match
      // was fragile for generic cardNumbers (e.g. "100" appears in every
      // product). Require the sold_comps row's own setName to ALSO
      // normalize to the same canonical — two independent signals must
      // agree. If setName is empty or disagrees, SKIP.
      const rowSetCanon = normalizeSetToCanonical(row.setName || "");
      let canonical;
      if (entry.canonical) {
        if (rowSetCanon === entry.canonical) {
          canonical = entry.canonical;
          matched++;
        } else if (!rowSetCanon) {
          // no witness from the row — cannot safely apply
          ambigSkipped++;
          continue;
        } else {
          // row's setName says something different — conflict, skip
          ambigSkipped++;
          continue;
        }
      } else {
        // cross-family — row setName must match ONE of the candidates
        if (rowSetCanon && entry.candidates.includes(rowSetCanon)) {
          canonical = rowSetCanon;
          ambigResolved++;
        } else {
          ambigSkipped++;
          continue;
        }
      }

      const currentSet = parts[3];
      if (currentSet === canonical) { unchanged++; continue; }
      const tKey = `${currentSet}  →  ${canonical}`;
      transitions[tKey] = (transitions[tKey] || 0) + 1;
      parts[3] = canonical;
      const newSlug = parts.join(":");
      wouldChange++;

      if (MODE === "apply") {
        row.hobbyiqCardId = newSlug;
        row.__catalogCanonicalizedAt = new Date().toISOString();
        inFlight.push(
          withRetry(() => sc.items.upsert(row))
            .catch(e => { errors++; })
        );
        if (inFlight.length >= CONCURRENCY) {
          await Promise.race(inFlight);
          for (let i = inFlight.length - 1; i >= 0; i--) {
            const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
            if (s !== "PENDING") inFlight.splice(i, 1);
          }
        }
      }
    }
    if (examined % 100000 === 0) {
      console.log(`  examined=${examined}  matched=${matched}  ambigResolved=${ambigResolved}  wouldChange=${wouldChange}  notInCatalog=${notInCatalog}`);
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\n=== Done ===`);
  console.log(`  examined:        ${examined}`);
  console.log(`  matched unamb:   ${matched}`);
  console.log(`  ambig resolved:  ${ambigResolved}`);
  console.log(`  ambig skipped:   ${ambigSkipped}  (setName didn't disambiguate)`);
  console.log(`  not in catalog:  ${notInCatalog}`);
  console.log(`  would-change:    ${wouldChange}`);
  console.log(`  unchanged:       ${unchanged}`);
  console.log(`  errors:          ${errors}`);

  console.log(`\nTop 30 transitions:`);
  Object.entries(transitions).sort((a,b) => b[1] - a[1]).slice(0, 30).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(6)}  ${k}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
