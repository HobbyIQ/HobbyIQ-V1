#!/usr/bin/env node
/**
 * CF-RESLUG-SETKEY-SEGMENT (Drew, 2026-08-16: "Keep going and see if we have
 * them if not get them").
 *
 * Moves sold_comps rows from a setKey we should never have written onto the
 * one the CHECKLIST actually uses — by swapping that ONE segment of the slug
 * and nothing else.
 *
 * WHY THIS EXISTS. Chasing the last four "missing checklists" found that three
 * of them were not missing. We already owned the checklist; the sales were
 * filed under a key it does not use, so the two could never meet:
 *
 *     2026 bowman-mega       23,046 comps      10 checklist rows
 *     2026 bowman-chrome-mega-box     —      1,236 checklist rows
 *
 *     1987 panini-donruss    16,776 comps     267 checklist rows
 *     1987 donruss                    —      1,313 checklist rows
 *
 * Fetching would have re-downloaded checklists we had. The fix is to correct
 * the key, and every stranded sale arrives at a checklist that was there the
 * whole time.
 *
 * VERIFIED BEFORE MOVING, NOT ASSUMED. A plausible-looking key is exactly how
 * bowman-draft-chrome fooled me — 23,899 rows, ZERO of them checklist-backed.
 * So each mapping here was tested by asking whether the card numbers the SALES
 * reference actually appear in the TARGET checklist:
 *
 *     bowman-mega    -> bowman-chrome-mega-box   157/157 numbers   100.0%
 *     panini-donruss -> donruss (pre-2009)       404/412 numbers    98.1%
 *
 * The eight 1987 misses are parser debris ("rookie", "pf-wax-full-boxes-one"),
 * not cards. A mapping that cannot clear this bar does not belong in the table.
 *
 * SEGMENT SWAP, NOT RE-DERIVE. The Draft re-slug re-derived each row through
 * the generator and turned `gold-refractor` into `refractor` — a full re-derive
 * is only as good as the title text, and vendor titles routinely omit the
 * parallel that the existing slug already captured correctly. Caught in dry run
 * that time. Here only field 3 changes; the parallel, auto and serial segments
 * are carried across untouched, so a row can lose nothing it already knew.
 *
 * REVERSIBLE. The prior slug is stamped to /hobbyiqCardIdBefore. hobbyiqCardId
 * is not the partition key (/cardId is), so this is a patch — never a delete
 * and reinsert.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." \
 *   node backend/scripts/reslug-setkey-segment.cjs [--apply] [--limit=N]
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

// Concurrent patches in flight. 12 keeps the job latency-bound without pushing
// sold_comps into sustained throttling.
const POOL = Math.max(1, Number(arg("pool", "12")));

/**
 * from -> to, with the year window the move is valid in.
 *
 * `years` is not decoration. Donruss is only wrong as panini-donruss BEFORE
 * Panini acquired the brand in 2009; the same key is correct for 2015. A
 * yearless rule would corrupt the modern product to repair the vintage one.
 */
const MOVES = [
  {
    sport: "baseball", from: "bowman-mega", to: "bowman-chrome-mega-box",
    years: [2024, 2026],
    // Not a parser bug — normalizeSetKey already returns bowman-chrome-mega-box
    // for every spelling of "Bowman Mega" as of CF-BOWMAN-MEGA-BOX-DISTINCT
    // (2026-08-12). These rows were slugged BEFORE that fix and never
    // re-derived. Stale data, not live behaviour.
    why: "stale rows predating CF-BOWMAN-MEGA-BOX-DISTINCT",
  },
  {
    sport: "baseball", from: "panini-donruss", to: "donruss",
    years: [1981, 2008],
    // Live parser bug, fixed alongside this script by
    // CF-PANINI-IS-ANACHRONISTIC-BEFORE-2009. Without that fix this script
    // would be swimming upstream: new ingests would keep writing the old key.
    why: "Panini did not own Donruss until 2009",
  },
];

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1);
  }
  const APPLY = has("apply");
  const LIMIT = Number(arg("limit", "0")) || Infinity;

  const sold = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("sold_comps");

  console.log(`[reslug-setkey] mode=${APPLY ? "APPLY" : "DRY-RUN"}\n`);

  let moved = 0, skipped = 0, failed = 0, seen = 0;
  for (const m of MOVES) {
    for (let year = m.years[0]; year <= m.years[1] && seen < LIMIT; year++) {
      const prefix = `hiq:${m.sport}:${year}:${m.from}:`;
      const iter = sold.items.query({
        query: "SELECT c.id, c.cardId, c.hobbyiqCardId FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)",
        parameters: [{ name: "@p", value: prefix }],
      }, { maxItemCount: 1000 });

      let yearMoved = 0;
      while (iter.hasMoreResults() && seen < LIMIT) {
        const { resources } = await iter.fetchNext();
        // Build this page's work, then run it CONCURRENTLY. Patching one row
        // at a time put the full 173,741-row job at roughly three hours, and
        // almost all of that was idle time waiting on a round trip — the wall
        // clock here is latency, not RUs.
        const work = [];
        for (const r of resources || []) {
          if (seen >= LIMIT) break;
          seen++;
          const parts = String(r.hobbyiqCardId).split(":");
          // hiq:sport:year:setKey:number:parallel:auto[:extra]
          if (parts.length < 7 || parts[3] !== m.from) { skipped++; continue; }
          parts[3] = m.to;
          const next = parts.join(":");
          if (next === r.hobbyiqCardId) { skipped++; continue; }
          work.push({ r, next });
        }
        if (!APPLY) { moved += work.length; yearMoved += work.length; continue; }

        // A POOL, not Promise.all over the whole page. Unbounded fan-out just
        // trades one kind of waiting for 429s, and a throttled patch that
        // exhausts its retries is a row silently left behind.
        let cursor = 0;
        await Promise.all(Array.from({ length: POOL }, async () => {
          while (cursor < work.length) {
            const { r, next } = work[cursor++];
            try {
              await sold.item(r.id, r.cardId).patch([
                { op: "add", path: "/hobbyiqCardIdBefore", value: r.hobbyiqCardId },
                { op: "set", path: "/hobbyiqCardId", value: next },
              ]);
              moved++; yearMoved++;
            } catch (e) {
              failed++;
              if (failed <= 3) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 70)}`);
            }
          }
        }));
      }
      // Reported per YEAR, not per batch. A carriage-return ticker collapses to
      // nothing in a CI log, writing thousands of lines nobody reads.
      if (yearMoved) {
        console.log(`  ${year}  ${m.from} -> ${m.to}  ${String(yearMoved).padStart(7)}  (total ${moved.toLocaleString()})`);
      }
    }
    console.log(`  (${m.from}: ${m.why})\n`);
  }

  console.log(`\nmoved=${moved} skipped=${skipped} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
