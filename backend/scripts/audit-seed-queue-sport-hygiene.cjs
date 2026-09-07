#!/usr/bin/env node
/**
 * CF-THE-ACQUISITION-QUEUE-MUST-ONLY-CARRY-CELLS-A-SOURCE-CAN-SERVE (2026-09-07).
 *
 * `catalog_seed_queue` is a WORK LIST. Each row is `seed:{sport}:{year}:{setKey}`
 * — a cell somebody should go and buy a checklist for. A bad entry on it is not
 * cosmetic: it is wasted acquisition effort against a product that does not
 * exist, and a human reading it goes looking for a 1952 Bowman FOOTBALL
 * checklist no publisher will ever serve.
 *
 * The 2026-09-07 auto-seed census found how they get there: 32,044 card_catalog
 * rows from `ingest-auto-seed` carry a sport with ZERO checklist backing in
 * their product-year. The retire lane compares twins within (sport, year,
 * setKey), so a wrong-sport row finds no twin BY CONSTRUCTION, parks as
 * `identityUnverified`, and its cell lands here. This measures the resulting
 * pollution and names the rows.
 *
 * ── WHAT IT MEASURES ───────────────────────────────────────────────────────
 *
 * For every queue entry, ask the catalog which sports hold STRICT CHECKLIST
 * rows for that (year, setKey) — the SAME question, through the SAME shipped
 * predicate, as the retire lane's probe (scripts/lib/sport-contamination.cjs).
 * Two copies of one rule is how two readings of one product begin to disagree.
 *
 *   CONTAMINATED  exactly one OTHER sport holds the checklist. The cell names a
 *                 product that does not exist in the sport asked for, and the
 *                 checklist for the real card is already in hand.
 *   AMBIGUOUS     several other sports hold it. We will not guess which.
 *   SERVABLE      the asking sport holds it (already covered — a different
 *                 hygiene question, reported not purged), or NO sport holds it,
 *                 which is the honest gap this queue exists for.
 *
 * ABSENCE OF CHECKLIST COVERAGE IS NOT ABSENCE OF THE PRODUCT. An unattested
 * cell is NEVER on the purge list: that is setSportAuthority's founding lesson,
 * and it is the queue's actual job.
 *
 * ── THE COST, AND WHY THE PROJECTION IS TWO COLUMNS ────────────────────────
 *
 * The queue is 9,988 rows over ~9k distinct (year, setKey) cells, not the few
 * hundred its header's "a thousand users collapse into ONE row" argument
 * suggests. So the per-cell read is the whole cost of this audit, and it is
 * shaped accordingly:
 *
 *   SELECT c.sport, c.source     two columns, no id, no card fields
 *
 * That is all the question needs — which sports hold checklist rows — and a
 * projection that also pulled cardNumber/playerName/parallel would move
 * several times the bytes for nothing. The retire lane's probe DOES pull those
 * because it must answer the twin question too; this one must not.
 *
 * `--limit=n` bounds a probe, `--conc=n` sizes the fan-out, and progress is
 * printed as it goes: a long read with no output is indistinguishable from a
 * hang, which is the lesson the retire lane wrote 148 minutes of silence to
 * learn (CF-NARRATE-THE-BOUNDARY-YOU-CANNOT-EXPLAIN).
 *
 * ── REPORT ONLY. THERE IS NO APPLY PATH. ───────────────────────────────────
 *
 * This script cannot write to Cosmos and has no flag that makes it. It emits a
 * PURGE LIST for a human and for the drainer's own maintenance vocabulary, and
 * that vocabulary is `markSeedStatus`-shaped, NOT a delete:
 * drainCatalogSeedQueue marks an unservable seed `unavailable` with a reason
 * and leaves it visible as real demand we cannot yet serve. A wrong-sport cell
 * is a stronger statement than `unavailable` — the demand itself is misfiled —
 * so the list carries the true sport alongside, and the decision to act on it
 * is Drew's, not this script's.
 *
 *   node scripts/audit-seed-queue-sport-hygiene.cjs
 *   node scripts/audit-seed-queue-sport-hygiene.cjs --purge-list=out.json
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));
const { classifySportContamination } = require(path.join(__dirname, "lib", "sport-contamination.cjs"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const PURGE_LIST = arg("purge-list", "");
const LIMIT = Number(arg("limit", 0));

/** The checklist predicate, mirrored from retire-self-derived-identities.cjs
 *  so this audit measures with the SAME gate the repair applies with. An audit
 *  that measures with different gates than the repair applies is not an audit
 *  of that repair (setSportAuthority's opening argument). */
const SD_SOURCES = [
  "ingest-auto-seed", "sold-comps-stub", "catalog-explode", "tree-builder",
  "sales-derived", "sales-attested", "derived-from", "pool",
  "user-verified", "ebay-user-purchase", "ebay-user-sale", "manual-user-entry",
  "holding-seeded",
];
const CHECKLIST_STEMS = [
  "checklist", "beckett", "cardpedia", "bccp", "cardboardconnection",
  "almanac", "hobbymonitor", "tcdb", "tcgdex", "pokemon-tcg-data", "official-pdf",
];
const norm = (s) => String(s == null ? "" : s).toLowerCase().trim();
function isSelfDerived(source) {
  const s = norm(source).replace(/-graded$/, "");
  if (!s || s === "undefined" || s === "null") return false;
  return SD_SOURCES.some((p) => s.startsWith(p));
}
function isChecklist(source) {
  const s = norm(source).replace(/-graded$/, "");
  if (!s || s === "undefined" || s === "null") return false;
  if (isSelfDerived(s)) return false;
  if (/^(cardhedge|cardsight|ebay)/.test(s)) return false;
  return CHECKLIST_STEMS.some((stem) => s.includes(stem));
}

const f = (n) => Number(n).toLocaleString("en-US");

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } },
  });
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const queue = db.container(process.env.COSMOS_CATALOG_SEED_QUEUE_CONTAINER || "catalog_seed_queue");
  const cat = db.container("card_catalog");

  console.log("audit-seed-queue-sport-hygiene   REPORT ONLY — this script has no write path\n");

  // The whole queue. It is small by construction: the doc id collapses a
  // thousand users missing one release into ONE row (checklistSeedQueue's
  // header), so this is a bounded read and not a corpus sweep.
  const { resources: seeds } = await queue.items.query({
    query: "SELECT c.id, c.sport, c.year, c.setKey, c.setName, c.status, c.requestCount FROM c",
  }, { maxItemCount: -1 }).fetchAll();
  let entries = seeds.filter((s) => s && s.setKey && s.year);
  if (LIMIT > 0) entries = entries.slice(0, LIMIT);
  console.log(`  queue entries read      ${f(seeds.length)}${LIMIT ? `  (capped to ${f(entries.length)})` : ""}`);

  // One cross-sport projection per DISTINCT (year, setKey). Several sports can
  // ask for the same product, and reading it once is the difference between a
  // bounded audit and a per-row sweep.
  const cells = new Map();
  for (const s of entries) {
    const k = `${Number(s.year)}|${norm(s.setKey)}`;
    if (!cells.has(k)) cells.set(k, { year: Number(s.year), setKey: norm(s.setKey), seeds: [] });
    cells.get(k).seeds.push(s);
  }
  console.log(`  distinct (year, setKey) ${f(cells.size)}\n`);

  const byPair = new Map();
  const purge = [];
  const verdicts = new Map();
  let done = 0;
  const T0 = Date.now();

  const list = [...cells.values()];
  const CONC = Number(arg("conc", 24));
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const cell = list.shift();
      if (!cell) return;
      // A PROJECTION, never an aggregate: card_catalog does not return
      // COUNT(1)/GROUP BY at 19.63M rows (the retire lane's own enumeration
      // comment records this at length). The counting happens in memory.
      let rows = [];
      try {
        const r = await cat.items.query({
          query: "SELECT c.sport, c.source FROM c WHERE c.year=@y AND c.setKey=@k",
          parameters: [{ name: "@y", value: cell.year }, { name: "@k", value: cell.setKey }],
        }, { maxItemCount: -1, maxDegreeOfParallelism: -1 }).fetchAll();
        rows = r.resources;
      } catch (e) {
        console.log(`   read failed ${cell.year}|${cell.setKey}: ${String(e && e.message).slice(0, 80)}`);
        continue;
      }
      const counts = new Map();
      for (const x of rows) {
        if (!isChecklist(x.source)) continue;
        const sp = norm(x.sport);
        if (!sp) continue;
        counts.set(sp, (counts.get(sp) || 0) + 1);
      }
      for (const seed of cell.seeds) {
        const asking = norm(seed.sport);
        const v = classifySportContamination({ sport: asking, checklistSportCounts: counts });
        verdicts.set(v.verdict, (verdicts.get(v.verdict) || 0) + 1);
        if (!v.contaminated) continue;
        const pair = v.verdict === "ambiguous"
          ? `${asking}->AMBIGUOUS(${v.candidates.join(",")})`
          : `${asking}->${v.trueSport}`;
        byPair.set(pair, (byPair.get(pair) || 0) + 1);
        purge.push({
          id: seed.id,
          sport: asking,
          year: cell.year,
          setKey: cell.setKey,
          setName: seed.setName || null,
          status: seed.status || null,
          requestCount: Number(seed.requestCount) || 0,
          verdict: v.verdict,
          trueSport: v.trueSport,
          candidateSports: v.candidates,
          // The drainer's maintenance vocabulary: mark, never delete. A seed
          // that cannot be acquired is marked with a REASON and stays visible.
          recommendedStatus: "unavailable",
          reason: v.verdict === "ambiguous"
            ? "sport-ambiguous"
            : `sport-contaminated:checklist-in-${v.trueSport}`,
        });
      }
      // fs.writeSync, not console.log: a buffered write on a pipe whose reader
      // is not draining is exactly the line that does not arrive, and "no
      // progress printed" must mean "no progress", not "progress buffered".
      if (++done % 100 === 0) {
        const rate = done / Math.max(1, (Date.now() - T0) / 1000);
        try {
          fs.writeSync(1, `   ...${done}/${cells.size} cells  ${rate.toFixed(1)}/s  polluted so far ${purge.length}\n`);
        } catch { /* progress is not the work */ }
      }
    }
  }));

  console.log(`\nVERDICTS over ${f(entries.length)} queue entries:`);
  for (const [v, n] of [...verdicts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(f(n)).padStart(8)}  ${v}`);
  }
  console.log(`\n  POLLUTED (contaminated + ambiguous)  ${f(purge.length)}`);
  console.log(`\nBY SPORT PAIR (queue cell's sport -> the sport whose checklist owns the product):`);
  for (const [pair, n] of [...byPair.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(f(n)).padStart(8)}  ${pair}`);
  }

  if (PURGE_LIST) {
    // The shape drainCatalogSeedQueue's markSeed already takes: an id, a
    // status and a reason. Emitting it as data rather than as a write is what
    // keeps this script report-only.
    const out = {
      generatedAt: new Date().toISOString(),
      generatedBy: "audit-seed-queue-sport-hygiene",
      reportOnly: true,
      note: "MARK, NEVER DELETE. Each entry is a markSeedStatus(id, 'unavailable', {reason}) "
        + "candidate — the drainer's own vocabulary for demand it cannot serve. "
        + "Nothing here has been written.",
      queueEntriesRead: entries.length,
      polluted: purge.length,
      bySportPair: Object.fromEntries([...byPair.entries()].sort((a, b) => b[1] - a[1])),
      verdicts: Object.fromEntries(verdicts),
      entries: purge.sort((a, b) => b.requestCount - a.requestCount),
    };
    fs.writeFileSync(PURGE_LIST, JSON.stringify(out, null, 2));
    console.log(`\n  purge list written: ${PURGE_LIST}  (${f(purge.length)} entries, REPORT ONLY)`);
  }

  console.log("\nREPORT ONLY — nothing was written to Cosmos.");
  try { client.dispose && client.dispose(); } catch { /* best effort */ }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
