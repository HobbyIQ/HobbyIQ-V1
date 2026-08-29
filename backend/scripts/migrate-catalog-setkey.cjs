#!/usr/bin/env node
/**
 * CF-MIGRATE-CATALOG-SETKEY (Drew, 2026-08-16: "fix it all").
 *
 * Companion to reslug-setkey-segment.cjs. That script moved the COMPS off a
 * wrong setKey; this one moves the CATALOG rows that describe them, so the two
 * actually meet.
 *
 * WHY BOTH HALVES ARE REQUIRED. Re-slugging 150,695 pre-2009 Donruss comps onto
 * `donruss` while their checklist rows stayed on `panini-donruss` would leave
 * the sales pointing at a key with nothing behind it — a regression dressed as
 * a fix. Coverage is a join, and a join needs both sides.
 *
 * MIGRATE, NEVER DROP. The obvious cleanup — delete the stale rows — would have
 * destroyed data. Measured before touching anything:
 *
 *     year   panini-donruss   donruss   card numbers ONLY in panini-donruss
 *     1990        383            883         9
 *     1998        385            457       102
 *     2001        598             41       558
 *     2003        876             74       802
 *
 * For 2001 and 2003 the "stale" key is the RICHER one. Deleting it would have
 * thrown away 802 real card numbers to tidy a naming problem. Every one of
 * those is MOVED to the new key; nothing is dropped.
 *
 * ONE WAY TO MOVE (D5 PR 4). This used to create-if-absent and leave the
 * original in place, so every migrated row became a duplicate identity, and a
 * 409 let whatever already sat at the destination win regardless of
 * provenance — a DERIVED row beating a CHECKLIST one, the exact failure
 * cardCatalog.service documents under CF-THE-CLEANEST-ONE-WINS. Now the move
 * is catalogRowOps.moveCatalogRow: copy to the new slug with the searchable
 * fields rebuilt, re-point the sales still at the old slug (normalizedSetKey
 * follows), retire the old slug's graded children, delete the old row LAST. A
 * row already at the destination is decided by authority (checklist > vendor >
 * derived; then vendorIds, sales, confidence): moved / folded (its vendorIds
 * unioned) / replaced.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/migrate-catalog-setkey.cjs [--apply] [--pool=12]
 *
 * Defaults to DRY-RUN (every read, no write; the counts are what a run would do).
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { moveCatalogRow } = require(path.join(backend, "dist", "services", "catalog", "catalogRowOps.service.js"));

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
const has = (n) => process.argv.includes(`--${n}`);
const POOL = Math.max(1, Number(arg("pool", "12")));

// Mirrors MOVES in reslug-setkey-segment.cjs. Kept as data in both places
// rather than shared: these are one-off corrections, and a shared table would
// imply an ongoing contract between a comps script and a catalog script that
// run at different times for different reasons.
const MOVES = [
  { from: "panini-donruss", to: "donruss", years: [1900, 2008] },
  { from: "bowman-mega", to: "bowman-chrome-mega-box", years: [2024, 2026] },
];

/** Swap ONE segment of a hiq: slug. Same discipline as the comps re-slug: a
 *  full re-derive loses the parallel whenever the source text omits it. */
function swapSetKey(slug, from, to) {
  const parts = String(slug).split(":");
  if (parts.length < 5 || parts[3] !== from) return null;
  parts[3] = to;
  return parts.join(":");
}

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const APPLY = has("apply");
  const db = new CosmosClient(process.env.COSMOS_CONNECTION_STRING).database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  console.log(`[migrate-catalog] mode=${APPLY ? "APPLY" : "DRY-RUN"} pool=${POOL}\n`);

  let moved = 0, folded = 0, replaced = 0, skipped = 0, failed = 0;
  for (const m of MOVES) {
    const iter = cat.items.query({
      query: `SELECT * FROM c WHERE c.setKey=@from AND c.year >= @lo AND c.year <= @hi
                AND STARTSWITH(c.id, 'hiq:')`,
      parameters: [
        { name: "@from", value: m.from },
        { name: "@lo", value: m.years[0] },
        { name: "@hi", value: m.years[1] },
      ],
    }, { maxItemCount: 500 });

    let moveRows = 0;
    while (iter.hasMoreResults()) {
      const { resources } = await iter.fetchNext();
      const work = [];
      for (const doc of resources || []) {
        const nextId = swapSetKey(doc.id, m.from, m.to);
        if (!nextId) { skipped++; continue; }
        work.push({ doc, nextId });
      }

      let cursor = 0;
      await Promise.all(Array.from({ length: POOL }, async () => {
        while (cursor < work.length) {
          const { doc, nextId } = work[cursor++];
          try {
            const r = await moveCatalogRow(cat, doc, nextId, { setKey: m.to, migratedFromSetKey: m.from }, {
              reason: `setKey migration ${m.from} -> ${m.to}`,
              repointNormalizedSetKey: true,
              dryRun: !APPLY,
              salesContainer: pool,
            });
            if (r.action === "move") moved++;
            else if (r.action === "fold") folded++;
            else if (r.action === "replace") replaced++;
            moveRows++;
          } catch (e) {
            failed++;
            if (failed <= 3) console.log(`   move failed ${nextId}: ${String(e.message).slice(0, 70)}`);
          }
        }
      }));
      process.stderr.write(`\r${m.from} -> ${m.to}  moved=${moved} folded=${folded} replaced=${replaced} failed=${failed}   `);
    }
    process.stderr.write("\n");
    console.log(`  ${m.from} -> ${m.to}: ${moveRows.toLocaleString()} rows`);
  }

  console.log(`\nmoved=${moved} folded=${folded} replaced=${replaced} skipped=${skipped} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
