// CF-CATALOG-DRIVEN-REPAIR (Drew, 2026-08-08). Retro-unlock sold_comps
// rows that failed to get a hobbyiqCardId because sport was null and
// couldn't be inferred from title text. Now that card_catalog has
// authoritative (year, setName, cardNumber) → sport mappings for the
// sets we just seeded, look each unmatched row up in the catalog to
// recover its sport, then compute + patch the hobbyiqCardId.
//
// Steps per row:
//   1. Skip if hobbyiqCardId already set
//   2. Skip if cardYear/setName/cardNumber not all present
//   3. Query card_catalog: WHERE year=X AND lower(setName)=Y AND cardNumber=Z
//      - 0 matches → skip (no catalog coverage yet, needs seed)
//      - >1 matches with different sports → skip (ambiguous, log)
//      - 1 match, or all matches share same sport → use that sport
//   4. Compute hobbyiqCardId from row + resolved sport
//   5. Patch sold_comps: add sport + hobbyiqCardId
//
// Env:
//   COSMOS_CONNECTION_STRING   required
//   APPLY=true                 write patches (else dry-run)

const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const fs = require("fs");

const APPLY = process.env.APPLY === "true";

function loadHelpers() {
  const slugP = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "hobbyIqCardId.service.js");
  const storeP = path.resolve(__dirname, "..", "dist", "services", "portfolioiq", "soldCompsStore.service.js");
  if (!fs.existsSync(slugP)) throw new Error(`slug helper missing at ${slugP} — run \`npm run build\`.`);
  if (!fs.existsSync(storeP)) throw new Error(`store helper missing at ${storeP} — run \`npm run build\`.`);
  return {
    computeHobbyIqCardId: require(slugP).computeHobbyIqCardId,
    extractPrintRunFromTitle: require(storeP).extractPrintRunFromTitle,
  };
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("COSMOS_CONNECTION_STRING required"); process.exit(2); }
  const client = new CosmosClient(conn);
  const sc = client.database("hobbyiq").container("sold_comps");
  const cat = client.database("hobbyiq").container("card_catalog");
  const { computeHobbyIqCardId, extractPrintRunFromTitle } = loadHelpers();

  console.log(`[repair-via-catalog] apply=${APPLY}`);

  const startMs = Date.now();
  const { resources: unmatched } = await sc.items.query({
    query: `SELECT c.id, c.cardId, c.cardYear, c.setName, c.cardNumber, c.parallel, c.isAuto, c.title, c.sport
            FROM c
            WHERE (NOT IS_DEFINED(c.hobbyiqCardId) OR c.hobbyiqCardId = null OR c.hobbyiqCardId = "")`,
  }).fetchAll();
  console.log(`Fetched ${unmatched.length} unmatched rows in ${((Date.now()-startMs)/1000).toFixed(1)}s`);

  // Bucket rows by (year|setLower|cardNumberUpper) so we batch catalog
  // lookups: one query per distinct identity, not per row. Cuts RU cost
  // by ~10-100× when the same set has many unmatched rows.
  const buckets = new Map();
  const skipMissingFields = { noYear: 0, noSet: 0, noNumber: 0 };
  for (const row of unmatched) {
    const y = row.cardYear;
    const s = String(row.setName || "").trim();
    const n = String(row.cardNumber || "").trim();
    if (typeof y !== "number") { skipMissingFields.noYear++; continue; }
    if (!s) { skipMissingFields.noSet++; continue; }
    if (!n) { skipMissingFields.noNumber++; continue; }
    const key = `${y}|${s.toLowerCase()}|${n.toUpperCase()}`;
    if (!buckets.has(key)) buckets.set(key, { year: y, setName: s, cardNumber: n, rows: [] });
    buckets.get(key).rows.push(row);
  }
  console.log(`Identity buckets: ${buckets.size} distinct (year, setName, cardNumber) combos`);
  console.log(`Row-level skips (missing fields): year=${skipMissingFields.noYear} set=${skipMissingFields.noSet} number=${skipMissingFields.noNumber}`);

  // Resolve each bucket's sport via card_catalog
  let bucketsResolved = 0, bucketsAmbiguous = 0, bucketsMissing = 0;
  let rowsToPatch = 0;
  const patchQueue = [];
  let bidx = 0;
  for (const [key, b] of buckets) {
    bidx++;
    if (bidx % 25 === 0) console.log(`  resolving bucket ${bidx}/${buckets.size}...`);
    const { resources: hits } = await cat.items.query({
      query: `SELECT c.sport FROM c WHERE c.cardYear = @y AND (LOWER(c.setName) = @s OR LOWER(c.setName) = @sAlt) AND UPPER(c.cardNumber) = @n`,
      parameters: [
        { name: "@y", value: b.year },
        { name: "@s", value: b.setName.toLowerCase() },
        { name: "@sAlt", value: b.setName.toLowerCase().replace(/^\d{4}\s+/, "") }, // some catalog rows include year prefix
        { name: "@n", value: b.cardNumber.toUpperCase() },
      ],
    }).fetchAll();
    if (hits.length === 0) { bucketsMissing++; continue; }
    const uniqueSports = [...new Set(hits.map(h => h.sport).filter(Boolean))];
    if (uniqueSports.length === 0) { bucketsMissing++; continue; }
    if (uniqueSports.length > 1) {
      bucketsAmbiguous++;
      if (bucketsAmbiguous <= 5) console.log(`    ambiguous: ${key} → sports [${uniqueSports.join(",")}]`);
      continue;
    }
    const sport = uniqueSports[0];
    bucketsResolved++;
    for (const row of b.rows) {
      const slug = computeHobbyIqCardId({
        sport,
        year: row.cardYear,
        setKey: row.setName,
        cardNumber: row.cardNumber,
        parallel: row.parallel || "Base",
        isAuto: row.isAuto ?? false,
        printRun: extractPrintRunFromTitle ? extractPrintRunFromTitle(row.title) : null,
      });
      patchQueue.push({ id: row.id, cardId: row.cardId, sport, slug });
      rowsToPatch++;
    }
  }

  console.log(`\n=== BUCKET RESOLUTION ===`);
  console.log(`  resolved (1 sport):   ${bucketsResolved}`);
  console.log(`  ambiguous (multi):    ${bucketsAmbiguous}`);
  console.log(`  missing from catalog: ${bucketsMissing}`);
  console.log(`  rows queued to patch: ${rowsToPatch}`);

  if (!APPLY) {
    console.log(`\n[dry-run] no writes. Rerun with APPLY=true.`);
    if (patchQueue.length > 0) {
      console.log(`\n=== SAMPLE PATCHES (5) ===`);
      patchQueue.slice(0, 5).forEach(p => console.log(`  id=${p.id.slice(0, 40)}...  sport=${p.sport}  slug=${p.slug}`));
    }
    return;
  }

  // Concurrent patches with 429 backoff, mirrors backfill-hobbyiq-cardid.mjs
  console.log(`\nApplying ${patchQueue.length} patches...`);
  let written = 0, errored = 0;
  const CONCURRENCY = 16;
  for (let i = 0; i < patchQueue.length; i += CONCURRENCY) {
    const chunk = patchQueue.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(async (p) => {
      const MAX = 4;
      for (let a = 0; a < MAX; a++) {
        try {
          await sc.item(p.id, p.cardId).patch([
            { op: "add", path: "/sport", value: p.sport },
            { op: "add", path: "/hobbyiqCardId", value: p.slug },
          ]);
          return;
        } catch (err) {
          const code = err?.code ?? err?.statusCode;
          if (code === 429 && a < MAX - 1) {
            const wait = Number(err?.retryAfterInMs ?? (100 * Math.pow(2, a)));
            await new Promise(r => setTimeout(r, wait));
            continue;
          }
          throw err;
        }
      }
    }));
    for (const r of results) {
      if (r.status === "fulfilled") written++;
      else { errored++; if (errored <= 3) console.warn(`  patch failed: ${r.reason?.message ?? r.reason}`); }
    }
    if ((i + chunk.length) % 100 === 0) console.log(`  ...${written}/${patchQueue.length} written`);
  }

  console.log(`\n=== APPLY SUMMARY ===`);
  console.log(`  written: ${written.toLocaleString()}`);
  console.log(`  errored: ${errored.toLocaleString()}`);
  console.log(`  pool delta: ${unmatched.length} → ${unmatched.length - written} unmatched`);
}

main().catch(e => { console.error("FAILED:", e?.message || e); process.exit(1); });
