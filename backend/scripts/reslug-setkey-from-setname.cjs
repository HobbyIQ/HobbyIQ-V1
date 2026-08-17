#!/usr/bin/env node
/**
 * CF-ULTRA-IS-NOT-FLEER repair (Drew, 2026-08-17).
 *
 * Re-derives the setKey segment of hobbyiqCardId from the row's own vendor
 * setName, for rows currently sitting on a given setKey.
 *
 * WHY. normalizeSetKey had no `ultra` rule, so "1995-96 Fleer Ultra" fell
 * through to the bare-fleer catch-all and every Ultra card filed as Fleer.
 * 55,373 of 352,825 sold_comps rows on a `fleer` setKey carry "Ultra" in their
 * own title or setName. Fleer and Ultra are different cards at the same
 * numbers — 1995-96 Fleer #25 is Will Perdue, Ultra #25 is Michael Jordan — so
 * the collapse pooled unrelated sales. The vocabulary is fixed; this moves the
 * rows it already mis-filed.
 *
 * DERIVED THROUGH THE SHIPPED RESOLVER. setKey comes from resolveSetKeyForSlug
 * out of dist/, the same function ingest uses, so a repaired row cannot
 * disagree with a freshly ingested one.
 *
 * ONLY-IMPROVE, ENFORCED. A row moves only when the re-derived key is
 * genuinely different and genuinely better — not year-prefixed, not a bare
 * manufacturer, not "unknown". Rows whose setName is only "fleer" while the
 * TITLE says Ultra are LEFT ALONE on purpose: the title is untrusted parser
 * input, and guessing from it would move rows on evidence we would not accept
 * at ingest.
 *
 * Only field 3 changes. Parallel, auto and serial segments carry across
 * untouched, so a row cannot lose specificity it already had, and
 * hobbyiqCardIdBefore records the original so the pass is reversible.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/reslug-setkey-from-setname.cjs \
 *     --from=fleer [--to=ultra] [--apply] [--pool=12] [--limit=N]
 *
 *   --to  optional guard: only move rows that re-derive to exactly this key.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { resolveSetKeyForSlug } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);
const FROM = arg("from", "");
const TO = arg("to", "");
const POOL = Math.max(1, Number(arg("pool", "12")));
const LIMIT = Number(arg("limit", "0")) || Infinity;
const APPLY = has("apply");

const BARE_MANUFACTURER = new Set(["panini", "fleer", "unknown", ""]);
const isYearPrefixed = (k) => /^(19|20)\d{2}-/.test(k);
const isUseless = (k) => BARE_MANUFACTURER.has(k) || isYearPrefixed(k);

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  if (!FROM) { console.error("need --from=<current setKey>"); process.exit(2); }

  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[reslug-setkey] from=${FROM}${TO ? ` to=${TO}` : ""} mode=${APPLY ? "APPLY" : "DRY-RUN"} pool=${POOL}\n`);

  const iter = sold.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.setName, c.sport
            FROM c WHERE CONTAINS(c.hobbyiqCardId, @seg)`,
    parameters: [{ name: "@seg", value: `:${FROM}:` }],
  }, { maxItemCount: 1000 });

  let scanned = 0, moved = 0, noSetName = 0, notBetter = 0, failed = 0;
  const destinations = new Map();

  while (iter.hasMoreResults() && scanned < LIMIT) {
    const { resources } = await iter.fetchNext();
    const work = [];
    for (const r of resources || []) {
      if (scanned >= LIMIT) break;
      scanned++;
      const parts = String(r.hobbyiqCardId).split(":");
      // hiq:sport:year:setKey:cardNumber:parallel:auto[:printRun]
      if (parts.length < 7 || parts[3] !== FROM) continue;
      if (!r.setName) { noSetName++; continue; }

      const year = Number(parts[2]) || 0;
      const next = resolveSetKeyForSlug(parts[1], String(r.setName), year);
      if (!next || next === parts[3] || isUseless(next)) { notBetter++; continue; }
      if (TO && next !== TO) { notBetter++; continue; }

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
          if (failed <= 5) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 80)}`);
        }
      }
    }));
    if (scanned % 25000 < 1000) process.stderr.write(`\r  scanned=${scanned} moved=${moved}    `);
  }
  process.stderr.write("\n");

  console.log("\nwhere the rows went:");
  [...destinations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, v]) => console.log(`   ${String(v).padStart(7)}  ${k}`));
  console.log(`\nscanned=${scanned} moved=${moved} noSetName=${noSetName} leftAlone=${notBetter} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
