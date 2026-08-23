// Move sales off superseded catalog slugs and onto the card that survived.
//
// WHY THIS MUST RUN WITH THE CONSOLIDATION, NOT AFTER IT SOMEDAY.
// consolidate-draft-chrome-overlap marks a duplicate chrome row
// supersededBy its draft twin. That fixes the catalog and, on its own, makes
// pricing WORSE: 7,140 sales across 197 slugs stay filed under the row we just
// retired, so the surviving card looks like it has no comps. That is the
// "the comp disappeared" bug, at scale. Superseding without repointing is a
// half-finished operation.
//
// WHAT IT DOES. For every catalog row carrying supersededBy, rewrite the
// hobbyiqCardId of its sales to the surviving slug. Nothing else on the sale
// changes — not price, not date, not source. The sale is the same sale; only
// our name for the card changes.
//
// SAFETY.
//   - Report-only by default. APPLY=true writes.
//   - The target must be a CANONICAL slug. A supersededBy pointing at a vendor
//     id would move sales onto an identity nothing else resolves.
//   - Never repoints onto a target that is ITSELF superseded — that would
//     chain sales through a retired card into another one.
//   - sold_comps is partitioned by /cardId, so a row missing it cannot be
//     written and is counted separately rather than silently failing.
//   - PATCH + a small pool, not read-then-replace in series. Measured at ~16
//     RU/s against an 8,000 RU/s ceiling, so throughput was never the limit —
//     round trips were.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/repoint-comps-to-surviving-slug.cjs
//     YEAR=2024        catalog year to sweep (default 2024)
//     SETKEY=bowman-chrome   the superseded side (default bowman-chrome)
//     APPLY=true       perform the writes
//     CONCURRENCY=8    parallel writers (default 8)
//     REASON=...       only follow marks carrying this supersededReason
//     PACE_MS=0        optional delay between writes
const { CosmosClient } = require("@azure/cosmos");

const YEAR = Number(process.env.YEAR || 2024);
const SETKEY = String(process.env.SETKEY || "bowman-chrome");
const APPLY = process.env.APPLY === "true";
// Must match what consolidate-draft-chrome-overlap.cjs writes. Following any
// other pass's marks is what caused the 2026-08-23 revert.
const KEEP = String(process.env.KEEP || "bowman-draft");
const { SUPERSEDE_MARKER } = require("./consolidate-draft-chrome-overlap.cjs");
const REASON = String(process.env.REASON || SUPERSEDE_MARKER);
// Zero by default: with patch + a pool this runs at ~0.2% of the container's
// 8,000 RU/s ceiling. The sleep was protecting against a limit we never reached.
const PACE_MS = Number(process.env.PACE_MS || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isCanonical = (s) => String(s || "").startsWith("hiq:");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const db = new CosmosClient(conn).database("hobbyiq");
  const cat = db.container("card_catalog");
  const sold = db.container("sold_comps");
  console.log(`mode: ${APPLY ? "APPLY — WILL REWRITE hobbyiqCardId" : "report only"}   year=${YEAR} setKey=${SETKEY}\n`);

  // 1. The retired -> surviving map.
  const { resources: rows } = await cat.items.query({
    // ONLY marks this operation made. CF-REPOINT-OWN-MARKS-ONLY (2026-08-23):
    // the first version selected every row carrying supersededBy for the
    // year+setKey, with no filter on who set it. card_catalog holds marks from
    // other passes — CF-DEDUPE-CATALOG-ROWS among them — pointing in directions
    // the draft/chrome twin rule never vouched for, and the repoint followed
    // all of them. 5,969 sales moved on that basis, including 625 sapphire
    // sales onto chrome cards: a separate product with its own checklist, so
    // those comps were pricing a different card. All were reverted from their
    // repointedFrom stamp; see revert-foreign-supersede-repoints.cjs.
    //
    // A repoint may only follow a supersede decision whose reasoning it can
    // point at. Provenance is the filter.
    query: `SELECT c.id, c.supersededBy FROM c
            WHERE c.year=@y AND c.setKey=@sk AND IS_DEFINED(c.supersededBy) AND c.supersededBy != null
              AND CONTAINS(c.supersededReason, @reason)`,
    parameters: [{ name: "@y", value: YEAR }, { name: "@sk", value: SETKEY }, { name: "@reason", value: REASON }],
  }).fetchAll();

  const map = new Map();
  let skippedTarget = 0;
  for (const r of rows) {
    if (!isCanonical(r.id) || !isCanonical(r.supersededBy)) { skippedTarget++; continue; }
    if (r.id === r.supersededBy) { skippedTarget++; continue; }
    map.set(r.id, r.supersededBy);
  }
  // A target that is itself retired would chain sales onward. Drop those pairs.
  const retired = new Set(rows.map((r) => r.id));
  let chained = 0;
  for (const [from, to] of [...map]) {
    if (retired.has(to)) { map.delete(from); chained++; }
  }
  console.log(`superseded rows: ${rows.length}   usable mappings: ${map.size}   unusable target: ${skippedTarget}   chained target: ${chained}`);
  if (map.size === 0) { console.log("nothing to do."); return; }

  // 2. Sales sitting on the retired slugs.
  const froms = [...map.keys()];
  const found = [];
  for (let i = 0; i < froms.length; i += 30) {
    const chunk = froms.slice(i, i + 30);
    const params = chunk.map((s, n) => ({ name: `@s${n}`, value: s }));
    const { resources } = await sold.items.query({
      query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.price FROM c
              WHERE c.hobbyiqCardId IN (${params.map((p) => p.name).join(", ")})`,
      parameters: params,
    }).fetchAll();
    found.push(...resources);
    await sleep(200);
  }
  console.log(`sales sitting on retired slugs: ${found.length}`);
  if (found.length === 0) { console.log("nothing stranded."); return; }

  if (!APPLY) {
    const bySlug = new Map();
    for (const r of found) bySlug.set(r.hobbyiqCardId, (bySlug.get(r.hobbyiqCardId) || 0) + 1);
    console.log("\ntop slugs by stranded sales:");
    for (const [s, n] of [...bySlug.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  ${String(n).padStart(5)}  ${s.slice(4, 60)}`);
      console.log(`         -> ${String(map.get(s)).slice(4, 60)}`);
    }
    console.log(`\nReport only — nothing written. Re-run with APPLY=true.`);
    return;
  }

  // 3. Repoint.
  // CF-REPOINT-USE-PATCH (2026-08-22). The first version did read-then-replace,
  // one row at a time, behind a 120ms sleep — about 1 write/second, which put
  // 7,255 rows at roughly 75 minutes. Measured while it ran: ~16 RU/s against
  // an 8,000 RU/s ceiling, and no 429s. It was never throughput-bound; it was
  // two Azure round trips per row, serialised, from a laptop. More RU would
  // have bought nothing.
  //
  // So: PATCH — one round trip, sending only the fields that change — through
  // a small concurrency pool. Still a rounding error against the ceiling, but
  // roughly 20x the wall-clock, which is what makes sweeping the remaining
  // years practical.
  //
  // The condition asserts the row is STILL on the retired slug, so a row
  // already moved fails its precondition rather than being rewritten. That is
  // what makes re-running safe.
  let moved = 0, unaddressable = 0, failed = 0, skipped = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= found.length) return;
      const r = found[i];
      const pk = typeof r.cardId === "string" && r.cardId ? r.cardId : null;
      if (!pk) { unaddressable++; continue; }
      const to = map.get(r.hobbyiqCardId);
      if (!to) { skipped++; continue; }
      try {
        await sold.item(r.id, pk).patch({
          operations: [
            { op: "set", path: "/hobbyiqCardId", value: to },
            { op: "set", path: "/repointedFrom", value: r.hobbyiqCardId },
            { op: "set", path: "/repointedReason", value: `catalog row superseded (${SETKEY} overlap); sale follows the surviving card` },
            { op: "set", path: "/repointedAt", value: new Date().toISOString() },
          ],
          condition: `FROM c WHERE c.hobbyiqCardId = "${String(r.hobbyiqCardId).replace(/"/g, "")}"`,
        });
        moved++;
        if (moved % 500 === 0) process.stdout.write(`  ...${moved}/${found.length}
`);
      } catch (e) {
        // Precondition failed / gone = someone already moved it. Not an error.
        if (e && (e.code === 412 || e.code === 404)) { skipped++; continue; }
        failed++;
        if (failed <= 3) console.log(`  write failed ${r.id}: ${e.message}`);
      }
      if (PACE_MS > 0) await sleep(PACE_MS);
    }
  }

  const CONCURRENCY = Number(process.env.CONCURRENCY || 8);
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`
MOVED: ${moved}   skipped (already moved): ${skipped}   unaddressable (no cardId): ${unaddressable}   failed: ${failed}`);
  if (failed) process.exit(4);
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  process.exit(3);
});
