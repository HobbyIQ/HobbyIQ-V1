#!/usr/bin/env node
// CF-RECOVER-CHROME-COLLAPSE-DAMAGE (Drew, 2026-07-31).
//
// The 2026-07-31 chrome-collapse apply run had a too-broad cardNumber
// prefix override that reclassified ~184 rows into the wrong product
// family (CPA-XX Topps Chrome Platinum → bowman-chrome, TC-XX Donruss
// Champions → topps-chrome, FCA-XX Topps Finest → bowman-chrome).
//
// This script recovers by re-canonicalizing every row marked with
// __canonicalizedChromeAt using ONLY the setName field (unchanged by
// the bad apply) and the safe set-string collapse. No cardNumber
// override. Idempotent: rows that were already correct stay correct.
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   RECOVER_MODE               dry | apply (default dry)
//   RECOVER_CONCURRENCY        default 8

const { CosmosClient } = require("@azure/cosmos");

const MODE = (process.env.RECOVER_MODE || "dry").toLowerCase();
const CONCURRENCY = Math.max(1, Number(process.env.RECOVER_CONCURRENCY || 8));

// Set-string canonicalization ONLY (safe rules — no cardNumber prefix override).
// Mirrors the trimmed normalizeSetKey collapse rules that are now the ONLY chrome
// canonicalization: bowman-chrome-draft → bowman-chrome, topps-chrome-update → topps-chrome.
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Approximate normalizeSetKey — matches enough of the production regexes
// to recover correctly for the affected rows. Includes: sapphire (preserved),
// bowman-chrome (with draft collapse), bowman-draft (paper), bowman-paper,
// bowman-sterling, bowman, topps-chrome (with update collapse), topps-finest,
// topps-heritage, topps-chrome-platinum (Topps Chrome Platinum is its own product,
// NOT collapsed to topps-chrome per Drew's guidance), plain topps,
// panini-* variants, donruss-champions, etc.
function normalizeSetKey(setName) {
  const s = slugify(setName);
  // Sapphire — distinct product line, preserved
  if (/(bowman-chrome-sapphire|bowman-sapphire)/.test(s)) return "bowman-chrome-sapphire";
  if (/topps-chrome-sapphire/.test(s)) return "topps-chrome-sapphire";
  // Bowman family
  if (/bowman-(chrome-draft|draft-chrome)/.test(s)) return "bowman-chrome";
  if (/bowman-chrome/.test(s)) return "bowman-chrome";
  if (/chrome-prospects?(-autographs?)?/.test(s)) return "bowman-chrome";
  if (/bowman-draft-paper/.test(s)) return "bowman-draft-paper";
  if (/bowman-draft/.test(s)) return "bowman-draft";
  if (/bowman-paper/.test(s)) return "bowman-paper";
  if (/bowman-sterling/.test(s)) return "bowman-sterling";
  if (/bowman/.test(s)) return "bowman";
  // Topps family — Chrome Platinum is a distinct line, matched first
  if (/topps-chrome-platinum/.test(s)) return "topps-chrome-platinum";
  if (/topps-chrome-update/.test(s)) return "topps-chrome";
  if (/topps-chrome/.test(s)) return "topps-chrome";
  if (/topps-heritage/.test(s)) return "topps-heritage";
  if (/topps-finest/.test(s)) return "topps-finest";
  if (/topps-pristine/.test(s)) return "topps-pristine";
  if (/topps-transcendent/.test(s)) return "topps-transcendent";
  if (/topps-dynasty/.test(s)) return "topps-dynasty";
  if (/topps-tribute/.test(s)) return "topps-tribute";
  if (/topps-museum/.test(s)) return "topps-museum-collection";
  if (/topps-stadium-club/.test(s)) return "topps-stadium-club";
  if (/topps-allen-ginter|allen-(and-)?ginter/.test(s)) return "topps-allen-ginter";
  if (/topps-gypsy-queen/.test(s)) return "topps-gypsy-queen";
  if (/topps-archives/.test(s)) return "topps-archives";
  if (/topps/.test(s)) return "topps";
  // Panini
  if (/panini-prizm|prizm/.test(s)) return "panini-prizm";
  if (/panini-select/.test(s)) return "panini-select";
  if (/panini-mosaic/.test(s)) return "panini-mosaic";
  if (/panini-donruss-optic|donruss-optic|panini-optic/.test(s)) return "panini-optic";
  if (/donruss-champions/.test(s)) return "donruss-champions";
  if (/panini-donruss|donruss/.test(s)) return "panini-donruss";
  if (/panini-contenders/.test(s)) return "panini-contenders";
  if (/panini-immaculate/.test(s)) return "panini-immaculate";
  if (/panini-flawless/.test(s)) return "panini-flawless";
  if (/national-treasures/.test(s)) return "panini-national-treasures";
  if (/panini-absolute/.test(s)) return "panini-absolute";
  if (/panini-chronicled|panini-chronicles/.test(s)) return "panini-chronicles";
  if (/panini-illusions/.test(s)) return "panini-illusions";
  if (/panini-prestige/.test(s)) return "panini-prestige";
  if (/panini-diamond-kings/.test(s)) return "panini-diamond-kings";
  if (/panini-phoenix/.test(s)) return "panini-phoenix";
  if (/panini/.test(s)) return "panini";
  // Other
  if (/finest/.test(s)) return "topps-finest";
  return s;
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

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(1); }
  const c = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const sc = c.database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[recover-chrome-collapse-damage]  mode=${MODE}  concurrency=${CONCURRENCY}`);

  const { resources: rows } = await sc.items.query({
    query: `SELECT * FROM c WHERE IS_DEFINED(c.__canonicalizedChromeAt)`
  }).fetchAll();
  console.log(`Marked rows: ${rows.length}`);

  // Only recover when the true set is a DISTINCT product line (not a
  // paper/chrome cousin). "2026 Bowman Baseball" seller text on a
  // CPA-EHA card is a mistype — real card is Bowman Chrome — so keep
  // bowman-chrome. But Topps Chrome Platinum, Donruss Champions,
  // Topps Finest are truly different products — recover those.
  const DISTINCT_PRODUCTS_TO_RECOVER = new Set([
    "donruss-champions",
    "topps-chrome-platinum",
    "topps-finest",
    "topps-heritage",
    "topps-pristine",
    "topps-transcendent",
    "topps-dynasty",
    "topps-tribute",
    "topps-museum-collection",
    "topps-stadium-club",
    "topps-allen-ginter",
    "topps-gypsy-queen",
    "topps-archives",
    "bowman-sterling",
    "bowman-chrome-sapphire",
    "topps-chrome-sapphire",
    "panini-prizm",
    "panini-select",
    "panini-mosaic",
    "panini-optic",
    "panini-donruss",
    "panini-contenders",
    "panini-immaculate",
    "panini-flawless",
    "panini-national-treasures",
    "panini-absolute",
    "panini-chronicles",
    "panini-illusions",
    "panini-prestige",
    "panini-diamond-kings",
    "panini-phoenix",
    "panini",
    "upper-deck",
    "fleer",
  ]);

  const transitions = {};
  const skipped = {};
  const inFlight = [];
  let rewritten = 0, unchanged = 0, errored = 0, keptAsIs = 0;
  for (const r of rows) {
    const oldSlug = r.hobbyiqCardId;
    if (typeof oldSlug !== "string" || !oldSlug.startsWith("hiq:")) { unchanged++; continue; }
    const parts = oldSlug.split(":");
    if (parts.length < 6) { unchanged++; continue; }
    const currentSet = parts[3];
    const correctSet = normalizeSetKey(r.setName || "");
    if (!correctSet || correctSet === currentSet) { unchanged++; continue; }
    // Skip if the "correct set" isn't a distinct product — the override
    // may have been the right call (seller mistyped set name).
    if (!DISTINCT_PRODUCTS_TO_RECOVER.has(correctSet)) {
      keptAsIs++;
      const k = `${currentSet}  ←KEEP←  ${correctSet}   (setName=${(r.setName || '').slice(0,40)})`;
      skipped[k] = (skipped[k] || 0) + 1;
      continue;
    }
    const key = `${currentSet}  →  ${correctSet}   (setName=${(r.setName || '').slice(0,40)})`;
    transitions[key] = (transitions[key] || 0) + 1;
    parts[3] = correctSet;
    const newSlug = parts.join(":");
    if (MODE === "apply") {
      r.hobbyiqCardId = newSlug;
      r.__recoveredChromeAt = new Date().toISOString();
      inFlight.push(
        withRetry(() => sc.items.upsert(r))
          .then(() => { rewritten++; })
          .catch(e => { errored++; console.error("  upsert err:", e?.message?.slice(0,80)); })
      );
      if (inFlight.length >= CONCURRENCY) {
        await Promise.race(inFlight);
        for (let i = inFlight.length - 1; i >= 0; i--) {
          const s = await Promise.race([inFlight[i], Promise.resolve("PENDING")]);
          if (s !== "PENDING") inFlight.splice(i, 1);
        }
      }
    } else {
      rewritten++;
    }
  }
  await Promise.allSettled(inFlight);

  console.log(`\ntotal marked=${rows.length}  would-change=${rewritten}  unchanged=${unchanged}  kept-as-is=${keptAsIs}  errored=${errored}`);
  console.log(`\nRecovery transitions applied (top 30):`);
  Object.entries(transitions).sort((a,b) => b[1] - a[1]).slice(0, 30).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  });
  console.log(`\nSkipped (chrome-override kept as more accurate than raw setName) (top 15):`);
  Object.entries(skipped).sort((a,b) => b[1] - a[1]).slice(0, 15).forEach(([k, n]) => {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
