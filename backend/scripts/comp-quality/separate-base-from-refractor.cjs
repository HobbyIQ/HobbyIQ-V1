// Undo CF-CHROME-AUTO-BASE-IS-REFRACTOR on rows written while it was live.
//
// THE DEFECT. That rule upgraded parallel "Base" to "Refractor" for CPA-/TCPA-/
// CRA- autographs on chrome set keys, to stop a /499 pool being "split in half".
// It cited Drew's own words as justification — "a base does not equal a
// refractor" — and merged them anyway. Drew, 2026-08-23: "base is a refractor
// is wrong". The rule is removed in hobbyIqCardId.service.ts; this repairs the
// rows it already wrote.
//
// WHY THIS IS EXACTLY RECOVERABLE AND NOT A GUESS. sold_comps keeps the vendor's
// own `parallel` field alongside the computed slug. Every affected row still
// says parallel="Base" while its slug reads ":refractor:". We are not inferring
// what the card was — the row has been carrying the answer the whole time. The
// selector IS the evidence:
//
//     LOWER(c.parallel) = "base"  AND  CONTAINS(hobbyiqCardId, ":refractor:")
//     AND cardNumber starts CPA-/TCPA-/CRA-
//
// Measured 2026-08-23: 6,908 rows across 1,193 slugs.
//     bowman-chrome 4,245   bowman 1,230   topps-chrome 922   bowman-draft 511
//
// THE DESTINATION MUST EXIST, same as every other refile in this directory. A
// sale moved onto a base slug with no catalog row is an orphan — it satisfies
// the letter of the fix and still shows an empty comps panel. Rows whose base
// card we do not hold are REPORTED as a catalog gap, never moved, because the
// standing invariant (Drew, 2026-08-23) is "1 card in a catalog will hold all
// the sales for the card" — which requires the card to exist first.
//
// Usage:
//   COSMOS_CONNECTION_STRING=... node scripts/comp-quality/separate-base-from-refractor.cjs
//     APPLY=true        perform the writes (default: report only)
//     CONCURRENCY=6
const { CosmosClient } = require("@azure/cosmos");

const APPLY = process.env.APPLY === "true";
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

const PARALLEL_SEG = 5; // hiq : sport : year : setKey : cardNumber : parallel : auto

/** Swap only the parallel segment. Everything else about the row's identity —
 *  set, number, auto flag, print-run suffix — was never in question. */
function toBaseSlug(slug) {
  const p = String(slug).split(":");
  if (p[0] !== "hiq" || p.length <= PARALLEL_SEG) return null;
  if (p[PARALLEL_SEG] !== "refractor") return null;
  p[PARALLEL_SEG] = "base";
  return p.join(":");
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error("FATAL: COSMOS_CONNECTION_STRING not set. Refusing to report a zero that only means 'no credentials'.");
    process.exit(1);
  }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  }).database("hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");
  console.log(`mode: ${APPLY ? "APPLY — WILL REWRITE SLUGS" : "report only"}\n`);

  const { resources: rows } = await sold.items.query({
    query: `SELECT c.id, c.cardId, c.hobbyiqCardId, c.parallel, c.cardNumber, c.title, c.price FROM c
            WHERE LOWER(c.parallel) = "base"
              AND CONTAINS(c.hobbyiqCardId, ":refractor:")
              AND RegexMatch(UPPER(c.cardNumber), "^(CPA|TCPA|CRA)")`,
  }).fetchAll();
  console.log(`rows whose own parallel says Base but whose slug says refractor: ${rows.length}`);

  const moves = [];
  let unslugged = 0;
  for (const r of rows) {
    const to = toBaseSlug(r.hobbyiqCardId);
    if (!to) { unslugged++; continue; }
    moves.push({ r, to });
  }
  console.log(`  slug not in the expected shape (left alone): ${unslugged}`);

  // THE DESTINATION MUST EXIST.
  const wanted = [...new Set(moves.map((m) => m.to))];
  const exists = new Set();
  for (let i = 0; i < wanted.length; i += 60) {
    const ch = wanted.slice(i, i + 60);
    const qp = ch.map((s, k) => ({ name: `@s${k}`, value: s }));
    const { resources } = await cat.items.query({
      query: `SELECT c.id FROM c WHERE c.id IN (${qp.map((p) => p.name).join(", ")})`,
      parameters: qp,
    }).fetchAll();
    for (const x of resources) exists.add(x.id);
  }
  console.log(`  distinct base destinations needed : ${wanted.length}`);
  console.log(`  present in the catalog            : ${exists.size}`);

  const movable = moves.filter((m) => exists.has(m.to));
  const gaps = moves.filter((m) => !exists.has(m.to));
  console.log(`  MOVABLE                           : ${movable.length}`);
  console.log(`  blocked, no base card in catalog  : ${gaps.length}   (catalog gap, not a filing error)`);

  const gapBySet = new Map();
  for (const g of gaps) {
    const k = String(g.to).split(":").slice(2, 4).join(" ");
    gapBySet.set(k, (gapBySet.get(k) || 0) + 1);
  }
  if (gapBySet.size) {
    console.log("\n  where the catalog gaps are (these need a checklist, not a repoint):");
    for (const [k, n] of [...gapBySet].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`     ${String(n).padStart(6)}  ${k}`);
    }
  }

  const byPair = new Map();
  for (const m of movable) {
    const k = String(m.r.hobbyiqCardId).split(":").slice(2, 4).join(" ");
    byPair.set(k, (byPair.get(k) || 0) + 1);
  }
  console.log("\nwhat would move, by year+set:");
  for (const [k, n] of [...byPair].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
    console.log(`   ${String(n).padStart(6)}  ${k}`);
  }

  if (!APPLY) { console.log("\nReport only — nothing written. Re-run with APPLY=true."); return; }

  let moved = 0, skipped = 0, failed = 0, unaddressable = 0, cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= movable.length) return;
      const { r, to } = movable[i];
      if (typeof r.cardId !== "string" || !r.cardId) { unaddressable++; continue; }
      try {
        await sold.item(r.id, r.cardId).patch({
          operations: [
            { op: "set", path: "/hobbyiqCardId", value: to },
            { op: "set", path: "/repointedFrom", value: r.hobbyiqCardId },
            { op: "set", path: "/repointedReason", value: "row's own parallel says Base; CF-CHROME-AUTO-BASE-IS-REFRACTOR merged it into refractor and that rule is removed" },
            { op: "set", path: "/repointedAt", value: new Date().toISOString() },
          ],
          // Assert the row is still where we found it, so a re-run skips
          // rather than rewrites and a concurrent sweep cannot double-move it.
          condition: `FROM c WHERE c.hobbyiqCardId = "${String(r.hobbyiqCardId).replace(/"/g, "")}"`,
        });
        moved++;
        if (moved % 1000 === 0) process.stdout.write(`  ...${moved}/${movable.length}\n`);
      } catch (e) {
        if (e && (e.code === 412 || e.code === 404)) { skipped++; continue; }
        failed++;
        if (failed <= 3) console.log(`  write failed ${r.id}: ${e.code} ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\nSEPARATED: ${moved}   skipped: ${skipped}   unaddressable: ${unaddressable}   failed: ${failed}`);
  if (failed) process.exit(4);
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message || String(e)); process.exit(3); });
