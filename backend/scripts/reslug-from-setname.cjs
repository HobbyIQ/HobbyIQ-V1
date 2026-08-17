#!/usr/bin/env node
/**
 * CF-RESLUG-FROM-SETNAME (Drew, 2026-08-16: "fix it all").
 *
 * Repairs comps whose setKey segment is a YEAR-PREFIXED ONE-OFF
 * ("2025-panini-rookies-stars-football") or a bare manufacturer ("panini"), by
 * re-deriving that segment from the row's own vendor setName through the
 * shipped normalizeSetKey.
 *
 * WHY THEY EXIST. normalizeSetKey had no rule for several real Panini products,
 * so it fell through to slugify and returned the whole vendor string as a key.
 * Two harms at once: the year is duplicated into a segment the slug already
 * carries, and one product fragments across as many keys as sellers have
 * phrasings. Rookies & Stars is the instructive case — a rule for it DID exist
 * and never fired, because slugify drops "&" and emits "rookies-stars" while
 * the vocabulary was written for "rookies-and-stars".
 *
 * SELECTION IS INDEX-FRIENDLY. A year-prefixed key always repeats the year that
 * is already in segment 3, so the rows are reachable by
 * STARTSWITH(c.hobbyiqCardId, 'hiq:<sport>:<year>:<year>-') rather than by
 * scanning 9.7M rows and testing each one.
 *
 * ONLY-IMPROVE, ENFORCED. A row is written only when the re-derived key is
 * strictly better: different, not itself year-prefixed, and not a bare
 * manufacturer. Anything else is left exactly as it is. A confidently-wrong key
 * is invisible to every future sweep, which is worse than the null we started
 * with.
 *
 * SEGMENT SWAP. Only field 3 changes; parallel, auto and serial segments are
 * carried across untouched, so a row cannot lose specificity it already had.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/reslug-from-setname.cjs [--apply] [--pool=12]
 *
 * Requires a build: normalizeSetKey is read from dist/.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { normalizeSetKey } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);
const POOL = Math.max(1, Number(arg("pool", "12")));

const SPORTS = ["football", "basketball", "baseball", "hockey", "soccer"];
const YEARS = [];
for (let y = 2009; y <= 2026; y++) YEARS.push(y);

/** A key that is a bare manufacturer names a COMPANY, not a product, so it can
 *  never join a checklist. Topps and Bowman are excluded on purpose: those are
 *  genuine flagship products as well as companies. */
const BARE_MANUFACTURER = new Set(["panini", "unknown", ""]);

const isYearPrefixed = (k) => /^(19|20)\d{2}-/.test(k);
const isUseless = (k) => BARE_MANUFACTURER.has(k) || isYearPrefixed(k);

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const APPLY = has("apply");
  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[reslug-from-setname] mode=${APPLY ? "APPLY" : "DRY-RUN"} pool=${POOL}\n`);

  let moved = 0, noSetName = 0, notBetter = 0, failed = 0;
  const destinations = new Map();

  for (const sport of SPORTS) {
    for (const year of YEARS) {
      // Both broken shapes for this sport/year.
      const prefixes = [`hiq:${sport}:${year}:${year}-`, `hiq:${sport}:${year}:panini:`];
      for (const prefix of prefixes) {
        const iter = sold.items.query({
          query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.setName, c.title
                  FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)`,
          parameters: [{ name: "@p", value: prefix }],
        }, { maxItemCount: 1000 });

        while (iter.hasMoreResults()) {
          const { resources } = await iter.fetchNext();
          const work = [];
          for (const r of resources || []) {
            const parts = String(r.hobbyiqCardId).split(":");
            if (parts.length < 7) continue;
            // The vendor setName is the only field carrying the product; the
            // slug segment we are replacing is precisely the thing that lost it.
            const src = r.setName || r.title;
            if (!src) { noSetName++; continue; }
            const next = normalizeSetKey(String(src));
            if (!next || next === parts[3] || isUseless(next)) { notBetter++; continue; }
            parts[3] = next;
            work.push({ r, next: parts.join(":"), key: next });
          }

          let cursor = 0;
          await Promise.all(Array.from({ length: POOL }, async () => {
            while (cursor < work.length) {
              const { r, next, key } = work[cursor++];
              destinations.set(key, (destinations.get(key) || 0) + 1);
              if (!APPLY) { moved++; continue; }
              try {
                await sold.item(r.id, r.cardId).patch([
                  { op: "add", path: "/hobbyiqCardIdBefore", value: r.hobbyiqCardId },
                  { op: "set", path: "/hobbyiqCardId", value: next },
                ]);
                moved++;
              } catch (e) {
                failed++;
                if (failed <= 3) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 70)}`);
              }
            }
          }));
        }
      }
    }
    process.stderr.write(`\r${sport} done — moved=${moved}          `);
  }
  process.stderr.write("\n");

  console.log("\nwhere the rows went:");
  [...destinations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, v]) => console.log(`   ${String(v).padStart(7)}  ${k}`));

  console.log(`\nmoved=${moved} noSetName=${noSetName} leftAlone=${notBetter} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
