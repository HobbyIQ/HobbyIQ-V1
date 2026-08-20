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
 * MIGRATE, NEVER DELETE. The obvious cleanup — drop the stale rows — would have
 * destroyed data. Measured before touching anything:
 *
 *     year   panini-donruss   donruss   card numbers ONLY in panini-donruss
 *     1990        383            883         9
 *     1998        385            457       102
 *     2001        598             41       558
 *     2003        876             74       802
 *
 * For 2001 and 2003 the "stale" key is the RICHER one. Deleting it would have
 * thrown away 802 real card numbers to tidy a naming problem.
 *
 * CREATE-IF-ABSENT. A destination row that already exists is left untouched.
 * Catalog rows carry a source and a confidence, and the existing row may be
 * better sourced than the one being migrated — see the source-priority dedup in
 * the catalog. This script's job is to fill holes, not to relitigate provenance.
 *
 * NON-DESTRUCTIVE. Originals stay. They become redundant rather than wrong, and
 * leaving them costs storage only; removing them is a separate, reversible
 * decision that wants its own evidence.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/migrate-catalog-setkey.cjs [--apply] [--pool=12]
 *
 * Defaults to DRY-RUN.
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

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
  const cat = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  console.log(`[migrate-catalog] mode=${APPLY ? "APPLY" : "DRY-RUN"} pool=${POOL}\n`);

  let created = 0, existed = 0, skipped = 0, failed = 0;
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

    let moveCreated = 0;
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
          // The partition key is /cardId, and for these rows it mirrors the id.
          // Keep that invariant: a migrated row whose cardId still pointed at
          // the old slug would be unreachable by the lookup path that reads it.
          const nextCardId = doc.cardId === doc.id ? nextId : doc.cardId;
          if (!APPLY) { moveCreated++; created++; continue; }
          try {
            // Create-if-absent. A 409 means the destination already exists and
            // is left exactly as it is.
            const next = {
              ...doc,
              id: nextId,
              cardId: nextCardId,
              hobbyiqCardId: doc.hobbyiqCardId
                ? (swapSetKey(doc.hobbyiqCardId, m.from, m.to) ?? doc.hobbyiqCardId)
                : doc.hobbyiqCardId,
              setKey: m.to,
              migratedFromSetKey: m.from,
            };
            delete next._rid; delete next._self; delete next._etag;
            delete next._attachments; delete next._ts;
            await cat.items.create(next);
            created++; moveCreated++;
          } catch (e) {
            if (e.code === 409) { existed++; continue; }
            failed++;
            if (failed <= 3) console.log(`   create failed ${nextId}: ${String(e.message).slice(0, 70)}`);
          }
        }
      }));
      process.stderr.write(`\r${m.from} -> ${m.to}  created=${created} existed=${existed} failed=${failed}   `);
    }
    process.stderr.write("\n");
    console.log(`  ${m.from} -> ${m.to}: ${moveCreated.toLocaleString()} rows`);
  }

  console.log(`\ncreated=${created} alreadyPresent=${existed} skipped=${skipped} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
