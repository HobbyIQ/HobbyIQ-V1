#!/usr/bin/env node
/**
 * CF-CATALOG-DUPLICATES (Drew, 2026-08-20: "eric hartman shows the same card
 * twice ... lets fix it and dedupe and unify").
 *
 * Counts catalog rows that describe the SAME physical card, and separates the
 * reasons — because they need different fixes.
 *
 * GRADE VARIANTS ARE NOT DUPLICATES and are excluded up front. card_catalog
 * runs a deliberate grade explode (one row per card per grade, identity in
 * `parentSlug`) so that every grade is available to users. That is a product
 * requirement, not a defect. Only rows that collide AFTER collapsing grade are
 * counted here.
 *
 * WHAT THE ERIC HARTMAN CASE SHOWED. 32 of his 396 identities carry more than
 * one row, by three mechanisms:
 *
 *   1. SAME SLUG, MANY ROWS. 21 rows for 2026 bowman cpa-eha, one slug. The
 *      catalog id is `cardhedge::<vendor-record-id>::<hash>` — scoped to the
 *      VENDOR RECORD, not the card, so every vendor listing mints another row.
 *      Cardsight does the same.
 *
 *   2. SAME CARD, DIFFERENT setKey. bcp-102 on bowman-chrome AND bowman;
 *      bp-102 on bowman-paper AND bowman. This is the split repaired on the
 *      COMPS side today (bowman-paper -> bowman, 23,249 comps; bowman-chrome ->
 *      bowman, 70,619). The catalog has the same disease and was never touched.
 *
 *   3. ingest-auto-seed INVENTING BOTH SIDES — self-seeded rows on both keys of
 *      a split we have not resolved. Our own guesses, duplicated.
 *
 * WHY IT MATTERS BEYOND TIDINESS. A duplicated card shows twice in search, and
 * a card split across setKeys splits its comp pool — the same root cause as the
 * CPA-MG auto that priced at $6.90 against $187 paid.
 *
 * READ-ONLY. Deleting catalog rows is destructive and irreversible, and the
 * catalog is the moat. This reports; a repair is authored separately and should
 * prefer marking a survivor over deleting losers.
 *
 * Usage:
 *   COSMOS_CONNECTION_STRING="..." node backend/scripts/audit-catalog-duplicates.cjs \
 *     [--family=bowman] [--years=2023-2026] [--top=15]
 */

const path = require("path");
const backend = path.join(__dirname, "..");
const { CosmosClient } = require(path.join(backend, "node_modules/@azure/cosmos"));

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const FAMILY = arg("family", "bowman");
const [Y0, Y1] = arg("years", "2023-2026").split("-").map(Number);
const TOP = Number(arg("top", "15"));
const REFRESH_PAGES = Number(arg("refreshPages", "400"));
// A Cosmos auth token is minted when the iterator opens and expires under a
// long scan. Page count is the WRONG unit for that: 400 pages is 800k rows,
// and at a throttled RU ceiling one leg can outlive the token — which killed
// a 10-hour trend scan with a 403. Elapsed time is what the token cares about.
const LEG_MAX_MS = Number(arg("legMaxMinutes", "20")) * 60_000;

/** A graded explode row — legitimate, excluded from the duplicate count. */
const GRADE_TAIL = /:(psa|bgs|sgc|cgc|ace|tag|hga)-[0-9]{1,2}(-[0-9])?(-black)?$|:raw$/i;

const norm = (s) => String(s ?? "").toLowerCase().trim();
const numKey = (n) => norm(n).replace(/[^a-z0-9]/g, "");

const newClient = () => new CosmosClient(process.env.COSMOS_CONNECTION_STRING);

async function scanAll(container, sql, onRow, label) {
  let token, rows = 0, throttles = 0, drained = false;
  while (!drained) {
    const c = newClient().database(process.env.COSMOS_DATABASE || "hobbyiq").container(container);
    const iter = c.items.query(sql, { maxItemCount: 2000, continuationToken: token });
    let legPages = 0, progressed = false;
    const legStart = Date.now();
    while (iter.hasMoreResults()) {
      let page;
      try { page = await iter.fetchNext(); }
      catch (e) {
        if (e?.code !== 429 && e?.code !== 503) throw e;
        throttles++;
        const w = Math.min(60_000, (e.retryAfterInMs ?? 1000) + 1000 * Math.min(throttles, 20));
        process.stderr.write(`\r  ${label} throttled (${throttles}) ${Math.round(w / 1000)}s   `);
        await new Promise((r) => setTimeout(r, w));
        break;
      }
      token = page.continuationToken;
      progressed = true;
      for (const r of page.resources || []) { rows++; onRow(r); }
      legPages++;
      if (rows % 250000 < 2000) process.stderr.write(`\r  ${label} scanned=${rows}   `);
      if (!iter.hasMoreResults()) { drained = true; break; }
      if (legPages >= REFRESH_PAGES || Date.now() - legStart > LEG_MAX_MS) break;
    }
    if (!drained && !progressed && !token) break;
  }
  process.stderr.write("\n");
  return rows;
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn || conn.length < 40) { console.error("FATAL: connection string missing/truncated"); process.exit(1); }
  console.log(`[catalog-duplicates] family=${FAMILY} years=${Y0}-${Y1}\n`);

  // identity -> { rows, slugs:Set, setKeys:Set, sources:Map }
  const idents = new Map();
  let scanned = 0, gradeRows = 0;
  await scanAll("card_catalog", {
    query: `SELECT c.hobbyiqCardId, c.setKey, c.cardNumber, c.playerName, c.parallel,
                   c.printRun, c.isAuto, c.year, c.source, c.sport
             FROM c WHERE STARTSWITH(c.setKey, @f) AND c.year >= @y0 AND c.year <= @y1`,
    parameters: [{ name: "@f", value: FAMILY }, { name: "@y0", value: Y0 }, { name: "@y1", value: Y1 }],
  }, (r) => {
    scanned++;
    if (GRADE_TAIL.test(String(r.hobbyiqCardId || ""))) { gradeRows++; return; }
    const player = norm(r.playerName);
    const num = numKey(r.cardNumber);
    if (!player || !num) return;
    // Identity deliberately EXCLUDES setKey — a card filed under two keys is
    // the defect being measured, so keying on setKey would hide it.
    const k = [r.sport ?? "", r.year, num, player, norm(r.parallel), r.isAuto ? 1 : 0, r.printRun ?? "-"].join("|");
    let e = idents.get(k);
    if (!e) idents.set(k, (e = { rows: 0, slugs: new Set(), setKeys: new Set(), sources: new Map(), sample: null }));
    e.rows++;
    if (r.hobbyiqCardId) e.slugs.add(r.hobbyiqCardId);
    if (r.setKey) e.setKeys.add(r.setKey);
    e.sources.set(r.source, (e.sources.get(r.source) ?? 0) + 1);
    if (!e.sample) e.sample = `${r.year} #${r.cardNumber} ${r.playerName} ${r.parallel ?? ""}`.trim();
  });

  const dupes = [...idents.entries()].filter(([, v]) => v.rows > 1);
  const surplus = dupes.reduce((s, [, v]) => s + (v.rows - 1), 0);

  // Split by cause.
  const sameSlug = dupes.filter(([, v]) => v.slugs.size === 1);
  const multiSetKey = dupes.filter(([, v]) => v.setKeys.size > 1);
  const multiSlugSameKey = dupes.filter(([, v]) => v.slugs.size > 1 && v.setKeys.size === 1);

  console.log(`catalog rows scanned      : ${scanned.toLocaleString()}`);
  console.log(`  grade-explode rows      : ${gradeRows.toLocaleString()}  (legitimate, excluded)`);
  console.log(`distinct card identities  : ${idents.size.toLocaleString()}`);
  console.log(`identities with >1 row    : ${dupes.length.toLocaleString()}`);
  console.log(`SURPLUS rows              : ${surplus.toLocaleString()}   <- what a dedupe would collapse\n`);
  console.log("by cause:");
  console.log(`  SAME slug, many rows        : ${sameSlug.length.toLocaleString()}   vendor-record-scoped ids`);
  console.log(`  SAME card, MANY setKeys     : ${multiSetKey.length.toLocaleString()}   the split — needs unifying, not deleting`);
  console.log(`  many slugs, one setKey      : ${multiSlugSameKey.length.toLocaleString()}\n`);

  // Which setKey pairs collide?
  const pairs = new Map();
  for (const [, v] of multiSetKey) {
    const ks = [...v.setKeys].sort();
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
      const k = `${ks[i]}  <->  ${ks[j]}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  console.log("colliding setKey pairs (cards affected):");
  for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, TOP)) {
    console.log(`   ${String(n).padStart(6)}  ${k}`);
  }

  // Which sources produce surplus rows?
  const srcSurplus = new Map();
  for (const [, v] of dupes) {
    for (const [s, n] of v.sources) srcSurplus.set(s, (srcSurplus.get(s) ?? 0) + n);
  }
  console.log("\nrows inside duplicated identities, by source:");
  for (const [s, n] of [...srcSurplus].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`   ${String(n).padStart(8)}  ${s}`);
  }

  console.log("\nworst identities:");
  for (const [, v] of dupes.sort((a, b) => b[1].rows - a[1].rows).slice(0, 8)) {
    console.log(`   x${String(v.rows).padStart(3)}  ${v.sample}`);
    console.log(`         slugs=${v.slugs.size} setKeys=${[...v.setKeys].join(", ")}`);
  }

  console.log("\nREAD-ONLY. Deleting catalog rows is irreversible and the catalog is the");
  console.log("moat — a repair should UNIFY the setKey split and mark a survivor, not delete.");
  return 0;
}
main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
