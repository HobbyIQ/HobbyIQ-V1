#!/usr/bin/env node
/**
 * CF-BOWMAN-DRAFT-CONSOLIDATION (Drew, 2026-08-18).
 *
 * Pulls stray Bowman Draft catalog rows onto `bowman-draft`, the key the
 * CHECKLISTS actually use.
 *
 * WHY THE CATALOG AND NOT THE COMPS. persistVendorSalesToPool calls
 * adoptResolvedSlug(), which rebinds a comp's slug to the catalog's canonical
 * form. Re-slugging comps while the catalog still disagrees just invites them
 * to be pulled back. The catalog is the authority, so the catalog moves first.
 *
 * WHY bowman-draft AND NOT bowman-draft-chrome. This was nearly reversed.
 * Counting BDC- numbered rows BY SOURCE settles it — total rows flatter a key
 * that only vendors write:
 *
 *   bowman-draft         65,957 BDC- rows  ~49,500 CHECKLIST-backed
 *                                          (checklistcenter 17,559,
 *                                           checklistcenter-graded 16,788,
 *                                           bccp 5,596, bccp-graded 4,788,
 *                                           checklistcenter-html 4,786)
 *   bowman-draft-chrome  14,373 BDC- rows       0 checklist-backed
 *                                          (cardhedge-graded 13,668,
 *                                           cardhedge 701)
 *   bowman-chrome        25,689 BDC- rows       0 checklist-backed
 *                                          (bccp 7,466, ingest-auto-seed 6,934,
 *                                           bccp-graded 6,144, explode 3,211,
 *                                           sold-comps-stub 1,934)
 *
 * `bowman-draft-chrome` is a CardHedge artifact, not a product. Moving the
 * checklist-backed rows onto it would have pushed ~49,500 real rows onto a key
 * no checklist uses. This confirms the 2026-08-16 CF-MATCH-THE-CATALOG call
 * rather than reversing it, so hobbyIqCardId.service.ts needs NO change: the
 * resolver already maps Draft Chrome to bowman-draft. Only the data is wrong.
 *
 * WHAT MOVES, AND WHY THOSE EXACTLY:
 *   ALL of setKey=bowman-draft-chrome (25,197 rows). The key itself is the
 *   artifact, so every row on it belongs elsewhere — BDC- 14,373, CPA- 6,961,
 *   BIA- 783, PP- 442, DPPA- 270, BDN- 214 ... all Bowman Draft subsets.
 *
 *   ONLY the BDC- subset of setKey=bowman-chrome (25,689 rows). Bowman Chrome
 *   legitimately holds BCP- and its own CPA- autographs, so the whole key must
 *   NOT move — BDC- is the prefix that is unambiguously Draft.
 *
 * Sapphire and Mega Box keep their own keys: they are real distinct products,
 * not artifacts, even though they also carry BDC- numbers.
 *
 * setKey, parentSetKey and the setKey SEGMENT of hobbyiqCardId are updated
 * together, because a row whose slug disagrees with its own setKey is exactly
 * the defect this is repairing. setKeyBefore records the original.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/consolidate-bowman-draft-catalog.cjs \
 *     [--apply] [--pool=12] [--limit=N]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const APPLY = process.argv.includes("--apply");
const POOL = Math.max(1, Number(arg("pool", "12")));
const LIMIT = Number(arg("limit", "0")) || Infinity;

const TARGET = "bowman-draft";
const PARENT = "bowman";

async function main() {
  if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const cat = new CosmosClient(process.env.COSMOS_CONNECTION_STRING)
    .database(process.env.COSMOS_DATABASE || "hobbyiq").container("card_catalog");

  console.log(`[consolidate-bowman-draft] mode=${APPLY ? "APPLY" : "DRY-RUN"} target=${TARGET}\n`);

  const iter = cat.items.query(
    `SELECT c.id, c.cardId, c.setKey, c.cardNumber, c.hobbyiqCardId, c.source
       FROM c
      WHERE c.setKey = "bowman-draft-chrome"
         OR (c.setKey = "bowman-chrome" AND STARTSWITH(c.cardNumber, "BDC-"))`,
    { maxItemCount: 1000 },
  );

  const from = new Map(), bySource = new Map();
  let scanned = 0, moved = 0, failed = 0, slugFixed = 0;

  while (iter.hasMoreResults() && scanned < LIMIT) {
    const { resources } = await iter.fetchNext();
    const work = [];
    for (const r of resources || []) {
      if (scanned >= LIMIT) break;
      scanned++;
      if (r.setKey === TARGET) continue;
      from.set(r.setKey, (from.get(r.setKey) || 0) + 1);
      bySource.set(r.source || "(none)", (bySource.get(r.source || "(none)") || 0) + 1);
      work.push(r);
    }

    let cursor = 0;
    await Promise.all(Array.from({ length: POOL }, async () => {
      while (cursor < work.length) {
        const r = work[cursor++];
        // Keep the slug's setKey segment in step with the field.
        let nextSlug = null;
        const p = String(r.hobbyiqCardId ?? "").split(":");
        if (p.length >= 7 && p[3] !== TARGET) { p[3] = TARGET; nextSlug = p.join(":"); }

        if (!APPLY) { moved++; if (nextSlug) slugFixed++; continue; }
        const ops = [
          { op: "add", path: "/setKeyBefore", value: r.setKey },
          { op: "set", path: "/setKey", value: TARGET },
          { op: "set", path: "/parentSetKey", value: PARENT },
        ];
        if (nextSlug) ops.push({ op: "set", path: "/hobbyiqCardId", value: nextSlug });
        try {
          // card_catalog partitions on /cardId; pre-cardId rows carry the
          // empty-object key, so pass undefined rather than a made-up value.
          await cat.item(r.id, r.cardId === undefined ? undefined : r.cardId).patch(ops);
          moved++;
          if (nextSlug) slugFixed++;
        } catch (e) {
          failed++;
          if (failed <= 5) console.log(`   patch failed ${r.id}: ${String(e.message).slice(0, 90)}`);
        }
      }
    }));
    if (scanned % 5000 < 1000) process.stderr.write(`\r  scanned=${scanned} moved=${moved}   `);
  }
  process.stderr.write("\n");

  console.log("\nmoved FROM:");
  for (const [k, v] of [...from.entries()].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(7)}  ${k}`);
  // NOT "checklist sources should be absent" — bccp IS a checklist source and
  // ~13,610 of its rows move here. That is correct: a BDC- number on
  // bowman-chrome is mis-filed no matter who scraped it, because BDC- is
  // unambiguously Draft. What must stay put is the ~49,500 checklist-backed
  // BDC- rows ALREADY on bowman-draft, and the query never selects those.
  console.log("\nby source:");
  for (const [k, v] of [...bySource.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ${String(v).padStart(7)}  ${k}`);
  console.log(`\nscanned=${scanned} moved=${moved} slugSegmentFixed=${slugFixed} failed=${failed}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
