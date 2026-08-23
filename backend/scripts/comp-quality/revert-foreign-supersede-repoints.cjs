// Undo repoints that followed a supersede mark this operation did not make.
//
// WHAT WENT WRONG. repoint-comps-to-surviving-slug built its retired->surviving
// map from EVERY row carrying supersededBy for a year+setKey:
//
//   WHERE c.year=@y AND c.setKey=@sk AND IS_DEFINED(c.supersededBy)
//
// with no filter on WHO set the mark. card_catalog carries supersede marks from
// several passes — CF-DEDUPE-CATALOG-ROWS among them — pointing in directions
// this operation never validated. The draft/chrome twin rule (same player, same
// parallel, same print run, same slug segments) vouched for the consolidation's
// own marks and for nothing else, but the repoint followed all of them.
//
// Measured after the fact, by slug segment:
//
//   7,264  bowman-chrome          -> bowman-draft            <- intended
//   3,819  bowman-chrome          -> bowman-chrome
//     620  bowman-chrome-sapphire -> bowman-chrome           <- must not happen
//      56  bowman                 -> bowman-chrome
//      16  bowman-chrome-mega-box -> bowman-chrome
//       5  bowman-chrome-sapphire -> bowman-chrome-sapphire
//
// The sapphire rows are the serious ones. Sapphire is a separate product with
// its own checklist; folding its sales into chrome prices a different card.
//
// WHAT THIS DOES. Restores hobbyiqCardId from repointedFrom for every move that
// is not bowman-chrome -> bowman-draft, and clears the repoint stamps. Exact,
// because every row records where it came from. Leaves the intended moves alone.
//
// Reversal is the safe direction here: it restores the state that existed
// before tonight's run rather than making a new judgement about the foreign
// marks, which still need their own review.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/revert-foreign-supersede-repoints.cjs
//     APPLY=true       perform the writes (default: report only)
//     CONCURRENCY=8    parallel writers
const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
const KEEP_FROM = "bowman-chrome";
const KEEP_TO = "bowman-draft";

const seg = (s, i) => {
  const p = String(s || "").split(":");
  return p[0] === "hiq" && p.length > i ? p[i] : null;
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const sold = new CosmosClient(conn).database("hobbyiq").container("sold_comps");
  console.log(`mode: ${APPLY ? "APPLY — WILL RESTORE hobbyiqCardId" : "report only"}\n`);

  const { resources: rows } = await sold.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.repointedFrom FROM c WHERE IS_DEFINED(c.repointedFrom)`,
  }).fetchAll();

  const bad = rows.filter((r) => !(seg(r.repointedFrom, 3) === KEEP_FROM && seg(r.hobbyiqCardId, 3) === KEEP_TO));
  console.log(`repointed rows: ${rows.length}   intended (${KEEP_FROM}->${KEEP_TO}): ${rows.length - bad.length}   to revert: ${bad.length}`);
  if (!bad.length) { console.log("nothing to revert."); return; }

  const pairs = new Map();
  for (const r of bad) pairs.set(`${seg(r.repointedFrom, 3)} -> ${seg(r.hobbyiqCardId, 3)}`, (pairs.get(`${seg(r.repointedFrom, 3)} -> ${seg(r.hobbyiqCardId, 3)}`) || 0) + 1);
  for (const [k, v] of [...pairs].sort((a, b) => b[1] - a[1])) console.log(`   ${String(v).padStart(6)}  ${k}`);

  if (!APPLY) { console.log("\nReport only — nothing written. Re-run with APPLY=true."); return; }

  let done = 0, skipped = 0, failed = 0, unaddressable = 0, cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= bad.length) return;
      const r = bad[i];
      if (typeof r.cardId !== "string" || !r.cardId) { unaddressable++; continue; }
      try {
        await sold.item(r.id, r.cardId).patch({
          operations: [
            { op: "set", path: "/hobbyiqCardId", value: r.repointedFrom },
            { op: "remove", path: "/repointedFrom" },
            { op: "remove", path: "/repointedReason" },
            { op: "remove", path: "/repointedAt" },
            { op: "set", path: "/repointRevertedAt", value: new Date().toISOString() },
            { op: "set", path: "/repointRevertedReason", value: "repoint followed a supersede mark the draft/chrome twin rule never validated" },
          ],
          // Only revert if the row is still where the bad repoint left it.
          condition: `FROM c WHERE c.hobbyiqCardId = "${String(r.hobbyiqCardId).replace(/"/g, "")}"`,
        });
        done++;
        if (done % 500 === 0) process.stdout.write(`  ...${done}/${bad.length}\n`);
      } catch (e) {
        if (e && (e.code === 412 || e.code === 404)) { skipped++; continue; }
        failed++;
        if (failed <= 3) console.log(`  revert failed ${r.id}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\nREVERTED: ${done}   skipped: ${skipped}   unaddressable: ${unaddressable}   failed: ${failed}`);
  if (failed) process.exit(4);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
