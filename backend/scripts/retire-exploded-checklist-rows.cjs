#!/usr/bin/env node
/**
 * retire-exploded-checklist-rows.cjs -- a checklist that lists 99,994 card
 * numbers for a 660-card set is not a checklist.
 *
 * CF-EXPLODED-SPINE (Drew, 2026-08-29 "make a checklist and start executing").
 * The spine-wide scan found 140 checklist products -- 11.49M rows, 51.8% of the
 * spine -- whose parallel column is exploded: the old undated `baseballcardpedia`
 * scrape cross-joined every card with every other card's player ("Adam Jones"
 * as a parallel of 2012 Topps #1; 162,763 distinct card numbers on 2025 Topps;
 * "DUO 100A Barry Bonds / Moises Alou" as a rung of 2006 Co-Signers). Sales
 * can resolve onto those slugs, and every derived row with any number and any
 * player in the set reads as "card-confirmed" against them -- the
 * self-confirming trap in a new coat. The dated ladder scrapes
 * (baseballcardpedia-ladders-*) are sane and are NOT touched.
 *
 * MODE=exploded (default): retire every identity row of a (sport, year, setKey,
 *   source) product whose distinct parallel count exceeds PAR_MAX (150) or whose
 *   distinct cardNumber count exceeds NUM_MAX (2,000), restricted to SOURCES
 *   (default: baseballcardpedia -- the undated scrape). The product list is
 *   computed at run time by the same GROUP BY the scan used, so the script and
 *   the measurement cannot disagree.
 * MODE=misparsed: retire the individual rows whose parallel holds player text or
 *   page prose -- has "(" but does not end with ")" and is not a print-run note.
 *
 * Every pointing sale is stamped catalogMatched=false with a reason (the rematch
 * re-resolves it onto whatever clean checklist lands); graded children are
 * deleted (regenerable). Copy nothing: these rows have no clean twin to fold
 * into -- the re-scrape mints the real ones.
 *
 * Env: COSMOS_CONNECTION_STRING; APPLY/BACKFILL_APPLY; MODE; SOURCES; PAR_MAX;
 *      NUM_MAX; SLOT/SLOTS (hash of id); CONCURRENCY=32; RUN_MINUTES=140; LIMIT.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");
const { CosmosClient } = require("@azure/cosmos");
const { reportWrites } = require(path.join(__dirname, "..", "dist", "services", "ops", "writeReconciliation.js"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
// MODE=tail: for sources whose products are only PARTLY exploded (checklistinsider:
//   the real rungs are there on every card, plus a garbage tail -- 3,602
//   "parallels" and 47,546 card numbers on a ~150-card 2025 Bowman basketball),
//   retire only the rows of a flagged product whose (product, parallel) group has
//   fewer than TAIL_MIN rows, or whose parallel is a card line. A rung exists on
//   many cards; a footnote or a joined card line exists on one.
// MODE=playerrung: across EVERY checklist source, retire rows whose parallel
//   equals a player name of the same product -- a roster line the scraper took
//   for a rung ("Jimmy Rollins" x 661 on 2008 Topps; "Adam Jones" on the old
//   2012 Topps scrape). The product's own player list is the oracle.
// MODE=source: retire EVERY identity row of the given SOURCES -- a source that
//   has been superseded by a clean re-ingest (checklist D3: the old
//   checklistcenter ingesters), not an exploded one. Run AFTER the clean rows
//   have landed so the pointing sales re-resolve onto rows that exist.
const MODE = ["misparsed", "tail", "playerrung", "source"].includes(String(process.env.MODE || "").toLowerCase()) ? String(process.env.MODE).toLowerCase() : "exploded";
const foldName = (v) => String(v ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const PARALLEL_WORDS = new Set(["refractor","refractors","xfractor","x-fractor","fractor","prizm","prizms","mojo","wave","shimmer","foil","foilboard","holo","chrome","sapphire","superfractor","printing","plate","plates","black","gold","silver","blue","red","green","orange","purple","pink","yellow","aqua","teal","magenta","fuchsia","bronze","platinum","rainbow","atomic","lava","pattern","laser","crackle","mini","base","parallel","variation","variations","sp","ssp","auto","autograph","autographs","relic","patch","jersey","insert","inserts","checklist","1/1","numbered","border","camo","tie-dye","disco","cracked","ice","optic","velocity","hyper","speckle","sparkle","glitter","neon","negative","sepia","vintage","stock","paper","canvas","gilded","glossy","matte"]);
const PLAYERRUNG_MIN = Number(process.env.PLAYERRUNG_MIN || 5);
const isPersonName = (v) => { const t = foldName(v).split(" ").filter(Boolean); return t.length >= 2 && t.length <= 5 && !t.some((w) => PARALLEL_WORDS.has(w)) && !/^\d/.test(t[0]); };
const SOURCES = String(process.env.SOURCES || (MODE === "tail" ? "checklistinsider-2026-08-27,checklistcenter,bccp" : "baseballcardpedia")).split(",").map((s) => s.trim()).filter(Boolean);
// CF-A-WHOLE-SOURCE-NEEDS-ITS-NAME (2026-08-29): MODE=source retires EVERY row of
// the named sources. Dispatched without SOURCES it fell to the "baseballcardpedia"
// default and reported 13,142,137 rows (1,927 products) -- a dry run, nothing
// written, but one input away from deleting the spine. Name the sources or stop.
if (MODE === "source" && !process.env.SOURCES) { console.error("FATAL: MODE=source retires whole sources -- set SOURCES explicitly (e.g. SOURCES=checklistcenter,checklistcenter-html)"); process.exit(1); }
// CF-DO-NOT-RETIRE-WHAT-WAS-NOT-REPLACED (2026-08-29, source dry run #2: 428
// products / 1,201,383 rows). The CLC re-ingest covered 510 of 547 products;
// retiring every old row would drop checklist coverage for the rest. With
// REPLACED_BY=<source> (the runner's SCOPE input doubles as it for MODE=source);
// MIN_COVERAGE_PCT=<floor> (default 95): a product whose old keys the
// replacement covers below the floor is kept, not retired (D3b).
// only products that exist under the replacement source are retired; the
// others are counted and kept. Default for MODE=source: checklistcenter-2026-08-29.
const REPLACED_BY = MODE === "source" ? String(process.env.REPLACED_BY || (process.env.SCOPE && process.env.SCOPE !== "refractor" ? process.env.SCOPE : "") || "checklistcenter-2026-08-29").trim() : "";
// CF-COVERAGE-IS-MEASURED-ON-KEYS (2026-08-29, D3b). "Present in the
// replacement source" was the guard, and presence is not coverage: the D3
// re-ingest left 2025 Bowman Draft with 3,658 rows under the new label and
// ZERO of the old source's 8,591 keys among them (the merge kept the old row
// on a confidence tie; lib/sourceCoverage.cjs). A product is retired only when
// the replacement covers at least MIN_COVERAGE_PCT of its (cardNumber,
// parallel, printRun) keys on the normalised key; a product under the floor
// is KEPT and printed with its coverage. Same measurement as
// audit-source-coverage -- run that first, read the floor line, then APPLY.
// CF-THE-LABEL-IS-NOT-THE-IDENTITY (2026-08-30, D3c): "covered" is the old
// row's canonical id held by ANY checklist-authority source that is not being
// retired (the merge keeps the earlier checklist row on a tie, so the
// replacement's rows mostly carry bcp / insider / beckett labels);
// COVER_BY=replacement narrows it back to the replacement label alone.
const MIN_COVERAGE_PCT = Number(process.env.MIN_COVERAGE_PCT || 95);
const { measureProductCoverage, coverageLine } = require("./lib/sourceCoverage.cjs");
const PAR_MAX = Number(process.env.PAR_MAX || 150), NUM_MAX = Number(process.env.NUM_MAX || 2000), TAIL_MIN = Number(process.env.TAIL_MIN || 5);
const CARD_LINE = /^\d+[a-z]?\s+[A-Za-z]/;
// CF-AN-INHERITED-SLOTS-IS-NOT-A-CHOSEN-SHARD (#1756, generalised 2026-09-04).
// The runner exports `slots` for EVERY script with a workflow-wide DEFAULT of
// "16", so `process.env.SLOTS ?? 1` NEVER saw undefined and this lane sharded
// itself sixteen ways on a dispatch that asked for no sharding -- sweeping slot
// 0 and leaving fifteen sixteenths untouched, green and honestly reconciled.
// Sharding is now OPT-IN: a non-zero slot, or an explicit SHARD=true for slot 0
// of a real fan-out. Everything else -- including the inherited slot=0 slots=16
// -- sweeps EVERY row. SLOTS binds to 1 when unsharded, so `% SLOTS` and
// `SLOTS === 1` guards below keep working unchanged.
const { runnerShardScope } = require("./lib/runner-shard-scope.cjs");
const SHARD_SCOPE = runnerShardScope({ label: "retire-exploded-checklist-rows" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 32));
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
const RUN_MS = RUN_MINUTES * 60000;
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top: a unit costing more than
 *  this is stopped BEFORE it starts. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 2 * 60 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);
const STARTED = Date.now();
const f = (n) => Number(n).toLocaleString();
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const CHECKLIST_SQL = "(c.source = 'bccp' OR STARTSWITH(c.source,'baseballcardpedia') OR STARTSWITH(c.source,'checklist') OR STARTSWITH(c.source,'beckett') OR STARTSWITH(c.source,'tcgdex') OR STARTSWITH(c.source,'cardboardchecklist'))";

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");
  console.log(`mode=${MODE}  slot ${SLOT}/${SLOTS}  ${APPLY ? "APPLY (deletes)" : "REPORT ONLY"}  budget ${RUN_MS / 60000}m`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  // ---- the product list (exploded mode): computed, not hand-typed
  let products = [];
  if (MODE === "exploded" || MODE === "tail" || MODE === "source") {
    // Grouping by parallel AND cardNumber returned millions of combos on the
    // exploded source and aborted. Group by parallel only (bounded: products x
    // rungs), then count distinct card numbers per product with a subquery --
    // and only for products with more rows than NUM_MAX, since fewer rows
    // cannot hold more numbers.
    const srcSql = SOURCES.map((_, i) => `c.source = @src${i}`).join(" OR ");
    const srcParams = SOURCES.map((s, i) => ({ name: `@src${i}`, value: s }));
    const { resources } = await retry(() => cat.items.query({
      query: `SELECT c.sport AS sp, c.year AS y, c.setKey AS k, c.source AS s, c.parallel AS p, COUNT(1) AS rows FROM c WHERE NOT IS_DEFINED(c.gradeTier) AND (${srcSql}) GROUP BY c.sport, c.year, c.setKey, c.source, c.parallel`,
      parameters: srcParams,
    }, { maxItemCount: 10000 }).fetchAll());
    const agg = new Map();
    for (const r of resources) {
      const key = `${r.sp}|${r.y}|${r.k}|${r.s}`;
      const a = agg.get(key) ?? { sport: r.sp, year: r.y, setKey: r.k, source: r.s, rows: 0, pars: new Set(), nums: new Set(), parCounts: new Map() };
      a.rows += r.rows; a.pars.add(String(r.p ?? "")); agg.set(key, a);
      a.parCounts.set(String(r.p ?? ""), (a.parCounts.get(String(r.p ?? "")) ?? 0) + r.rows);
    }
    let numChecks = 0;
    for (const a of agg.values()) {
      if (a.pars.size > PAR_MAX || a.rows <= NUM_MAX) continue;
      const { resources: cnt } = await retry(() => cat.items.query({
        query: "SELECT VALUE COUNT(1) FROM (SELECT DISTINCT c.cardNumber FROM c WHERE c.sport = @sp AND c.year = @y AND c.setKey = @k AND c.source = @s AND NOT IS_DEFINED(c.gradeTier))",
        parameters: [{ name: "@sp", value: a.sport }, { name: "@y", value: a.year }, { name: "@k", value: a.setKey }, { name: "@s", value: a.source }],
      }).fetchAll());
      a.numCount = Number(cnt[0] ?? 0); numChecks++;
    }
    products = (MODE === "source" ? [...agg.values()] : [...agg.values()].filter((a) => a.pars.size > PAR_MAX || (a.numCount ?? 0) > NUM_MAX)).sort((x, y) => y.rows - x.rows);
    // REPLACED_BY=none: no replacement source -- the rows are vendor-/sale-minted
    // (Drew, 2026-08-30: "GO" on cardsight / cardhedge / pool / sold-comps stubs /
    // tree-builder). Only checklists mint; these have no checklist twin at their id
    // (the ingest's tie-break already replaced the ones that did). Every holding
    // still pointing at one is printed first -- it becomes "unresolved", honestly.
    const NO_REPLACEMENT = REPLACED_BY.toLowerCase() === "none";
    if (MODE === "source" && NO_REPLACEMENT) {
      console.log(`  REPLACED_BY=none: retiring the whole source(s) ${SOURCES.join(",")} -- no coverage guard (vendor-/sale-minted rows have no replacement; only checklists mint)`);
      try {
        const portfolio = db.container("portfolio");
        const { resources: docs } = await retry(() => portfolio.items.query("SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)").fetchAll());
        let pointing = 0, scanned = 0; const ex = [];
        for (const d of docs) for (const [hid, h] of Object.entries(d.holdings ?? {})) {
          const id = String(h.hobbyiqCardId ?? h.cardId ?? ""); if (!id.startsWith("hiq:")) continue; scanned++;
          let row = null; try { row = (await retry(() => cat.item(id, id).read())).resource ?? null; } catch (e) { if (e?.code !== 404) throw e; }
          if (row && SOURCES.includes(String(row.source))) { pointing++; if (ex.length < 20) ex.push(`    ${h.playerName ?? "?"} #${h.cardNumber ?? "?"} -> ${id} [${row.source}] (user ${String(d.userId).slice(0, 13)})`); }
        }
        console.log(`  holdings pointing at a row of these sources: ${f(pointing)} of ${f(scanned)} hiq-identified holdings -- they become unresolved (the acquisition list)`);
        for (const e of ex) console.log(e);
      } catch (e) { console.log(`  holdings report failed: ${String(e?.message ?? e).slice(0, 120)}`); }
    }
    if (MODE === "source" && REPLACED_BY && !NO_REPLACEMENT) {
      const before = products.length, rowsBefore = products.reduce((n, p) => n + (p.rows || 0), 0);
      const keptProducts = [], retiring = [];
      let measured = 0;
      for (const p of products) {
        // per (product, old source): the old source's own keys against the replacement
        const cov = await measureProductCoverage(cat, retry, { sport: p.sport, year: p.year, setKey: p.setKey }, [p.source], REPLACED_BY);
        measured++;
        if (measured % 25 === 0) process.stderr.write(`\r  coverage measured for ${f(measured)}/${f(products.length)} products   `);
        if (cov && cov.pctNorm >= MIN_COVERAGE_PCT) retiring.push(p);
        else keptProducts.push({ p, cov });
      }
      process.stderr.write("\n");
      products = retiring;
      const rowsAfter = products.reduce((n, p) => n + (p.rows || 0), 0);
      console.log(`  replaced-by ${REPLACED_BY} at a ${MIN_COVERAGE_PCT}% key-coverage floor: retiring ${f(products.length)} of ${f(before)} products (${f(rowsAfter)} of ${f(rowsBefore)} rows); KEPT ${f(keptProducts.length)} products / ${f(rowsBefore - rowsAfter)} rows under the floor`);
      for (const { p, cov } of keptProducts.slice(0, 40)) console.log(`    kept [${p.source}] ${cov ? coverageLine(cov) : `${p.year} ${p.setKey} (${p.sport}): ${f(p.rows || 0)} rows, nothing measurable`}`);
      if (keptProducts.length > 40) console.log(`    ... +${f(keptProducts.length - 40)} more kept (audit-source-coverage lists every one)`);
    }
    console.log(`  (${f(agg.size)} products grouped; ${f(numChecks)} distinct-number checks)`);
    const total = products.reduce((s, p) => s + p.rows, 0);
    console.log(`\nexploded products (sources=${SOURCES.join(",")}; >${PAR_MAX} parallels or >${NUM_MAX} card numbers): ${products.length} products, ${f(total)} identity rows`);
    for (const p of products.slice(0, 15)) console.log(`  ${String(f(p.rows)).padStart(10)}  ${p.sport} ${p.year} ${p.setKey} [${p.source}]  parallels=${p.pars.size} numbers=${p.nums.size}`);
    if (products.length > 15) console.log(`  ... +${products.length - 15} more`);
    console.log("");
  }

  let scanned = 0, otherShards = 0, retired = 0, salesUnplaced = 0, gradedDeleted = 0, failed = 0, notReached = 0, kept = 0;
  let stopReason = null;
  const reason = MODE === "exploded" ? "exploded checklist product retired; awaiting a clean checklist" : MODE === "source" ? "superseded by the clean checklistcenter re-ingest" : MODE === "playerrung" ? "player-name parallel retired (a roster line, not a rung)" : "mis-parsed checklist row retired; awaiting a clean checklist";

  const retireRow = async (d) => {
    scanned++;
    try {
      if (!APPLY) { retired++; return; }
      let sToken;
      do {
        const sp = await retry(() => pool.items.query({ query: "SELECT c.id, c.cardId FROM c WHERE c.hobbyiqCardId = @s", parameters: [{ name: "@s", value: d.id }] }, { maxItemCount: 200, continuationToken: sToken }).fetchNext());
        sToken = sp.continuationToken;
        for (const x of sp.resources) {
          await retry(() => pool.item(x.id, x.cardId).patch([
            { op: "set", path: "/catalogMatched", value: false },
            { op: "set", path: "/catalogUnplacedReason", value: reason },
            { op: "set", path: "/catalogUnplacedAt", value: new Date().toISOString() },
          ]));
          salesUnplaced++;
        }
      } while (sToken);
      let gToken;
      do {
        const gp = await retry(() => cat.items.query({ query: "SELECT c.id, c.cardId FROM c WHERE STARTSWITH(c.id, @p) AND IS_DEFINED(c.gradeTier)", parameters: [{ name: "@p", value: d.id + ":" }] }, { maxItemCount: 200, continuationToken: gToken }).fetchNext());
        gToken = gp.continuationToken;
        for (const g of gp.resources) {
          await retry(() => cat.item(g.id, g.cardId ?? g.id).delete()).catch((e) => { if (e.code !== 404) throw e; });
          gradedDeleted++;
        }
      } while (gToken);
      await retry(() => cat.item(d.id, d.cardId ?? d.id).delete()).catch((e) => { if (e.code !== 404) throw e; });
      retired++;
    } catch (e) {
      failed++;
      if (failed <= 5) console.error(`  failed ${String(d.id).slice(0, 70)}: ${String(e.message || e).slice(0, 70)}`);
    }
  };

  const walk = async (query, keep = null) => {
    let token;
    do {
      const page = await retry(() => cat.items.query(query, { maxItemCount: 300, continuationToken: token }).fetchNext());
      token = page.continuationToken;
      const mine = page.resources.filter((d) => shardOf(d.id) === SLOT && (!keep || keep(d)));
      otherShards += page.resources.length - mine.length;
      for (let i = 0; i < mine.length; i += CONCURRENCY) {
        await Promise.all(mine.slice(i, i + CONCURRENCY).map(retireRow));
        const processed = Math.min(i + CONCURRENCY, mine.length);
        if (LIMIT && retired >= LIMIT) { stopReason = "limit"; notReached += mine.length - processed; return; }
        if (Date.now() - STARTED > RUN_MS - RESERVE_MS) { stopReason = "budget"; notReached += mine.length - processed; return; }
      }
      if (scanned && scanned % 5000 < CONCURRENCY) process.stderr.write(`\r  scanned=${f(scanned)} retired=${f(retired)} sales-unplaced=${f(salesUnplaced)} graded=${f(gradedDeleted)}   `);
    } while (token);
  };

  if (MODE === "exploded" || MODE === "source") {
    for (const p of products) {
      if (stopReason) break;
      await walk({
        query: "SELECT c.id, c.cardId FROM c WHERE c.sport = @sp AND c.year = @y AND c.setKey = @k AND c.source = @s AND NOT IS_DEFINED(c.gradeTier)",
        parameters: [{ name: "@sp", value: p.sport }, { name: "@y", value: p.year }, { name: "@k", value: p.setKey }, { name: "@s", value: p.source }],
      });
    }
  } else if (MODE === "playerrung") {
    // every checklist product+source: parallels that equal one of its players
    const { resources: prods } = await retry(() => cat.items.query({ query: `SELECT c.sport AS sp, c.year AS y, c.setKey AS k, c.source AS s, COUNT(1) AS rows FROM c WHERE NOT IS_DEFINED(c.gradeTier) AND ${CHECKLIST_SQL} GROUP BY c.sport, c.year, c.setKey, c.source` }, { maxItemCount: 10000 }).fetchAll());
    console.log(`playerrung: ${f(prods.length)} checklist products to check`);
    let checked = 0, hitProducts = 0;
    for (const p of prods.sort((a, b) => b.rows - a.rows)) {
      if (stopReason) break;
      checked++;
      const params = [{ name: "@sp", value: p.sp }, { name: "@y", value: p.y }, { name: "@k", value: p.k }, { name: "@s", value: p.s }];
      const { resources: pars } = await retry(() => cat.items.query({ query: "SELECT DISTINCT c.parallel AS p FROM c WHERE c.sport = @sp AND c.year = @y AND c.setKey = @k AND c.source = @s AND NOT IS_DEFINED(c.gradeTier) AND IS_DEFINED(c.parallel)", parameters: params }, { maxItemCount: 5000 }).fetchAll());
      if (!pars.length) continue;
      const { resources: players } = await retry(() => cat.items.query({ query: "SELECT DISTINCT c.playerName AS n FROM c WHERE c.sport = @sp AND c.year = @y AND c.setKey = @k AND c.source = @s AND NOT IS_DEFINED(c.gradeTier) AND IS_DEFINED(c.playerName)", parameters: params }, { maxItemCount: 5000 }).fetchAll());
      const names = new Set(players.map((r) => r.n).filter(isPersonName).map(foldName));
      const bad = new Set(pars.map((r) => String(r.p ?? "")).filter((par) => par && names.has(foldName(par))));
      // CF-A-ROSTER-IS-MANY-NAMES (2026-08-29, dry run #2). One or two hits
      // are a mis-parsed ROW whose playerName is a rung ("Die Cut", "Artist's
      // Proof", "Triple Exposure") -- retiring every card on that rung would
      // delete the real parallel. A roster taken for a ladder puts dozens of
      // names in the rung list (2012 Topps: 170). PLAYERRUNG_MIN hits or nothing.
      if (bad.size && bad.size < PLAYERRUNG_MIN) { console.log(`  ${p.sp} ${p.y} ${p.k} [${p.s}]: ${bad.size} hit(s) under the floor of ${PLAYERRUNG_MIN}, kept (${[...bad].slice(0, 3).join(", ")})`); continue; }
      if (!bad.size) continue;
      hitProducts++;
      console.log(`  ${p.sp} ${p.y} ${p.k} [${p.s}]: ${bad.size} player-name parallels (e.g. ${[...bad].slice(0, 3).join(", ")})`);
      await walk({ query: "SELECT c.id, c.cardId, c.parallel FROM c WHERE c.sport = @sp AND c.year = @y AND c.setKey = @k AND c.source = @s AND NOT IS_DEFINED(c.gradeTier)", parameters: params }, (d) => bad.has(String(d.parallel ?? "")));
    }
    console.log(`playerrung: checked ${f(checked)} products, ${f(hitProducts)} carried player-name parallels`);
  } else if (MODE === "tail") {
    // Only the tail of a flagged product goes: a (product, parallel) group with
    // fewer than TAIL_MIN rows, or a card-line parallel. The rungs that exist on
    // every card stay -- they are the checklist.
    for (const p of products) {
      if (stopReason) break;
      const tail = new Set([...p.parCounts.entries()].filter(([par, n]) => n < TAIL_MIN || CARD_LINE.test(par)).map(([par]) => par));
      const tailRows = [...p.parCounts.entries()].filter(([par]) => tail.has(par)).reduce((s, [, n]) => s + n, 0);
      kept += p.rows - tailRows;
      if (!tail.size) continue;
      await walk({
        query: "SELECT c.id, c.cardId, c.parallel FROM c WHERE c.sport = @sp AND c.year = @y AND c.setKey = @k AND c.source = @s AND NOT IS_DEFINED(c.gradeTier)",
        parameters: [{ name: "@sp", value: p.sport }, { name: "@y", value: p.year }, { name: "@k", value: p.setKey }, { name: "@s", value: p.source }],
      }, (d) => tail.has(String(d.parallel ?? "")));
    }
  } else {
    await walk({ query: `SELECT c.id, c.cardId FROM c WHERE NOT IS_DEFINED(c.gradeTier) AND IS_DEFINED(c.parallel) AND CONTAINS(c.parallel, '(') AND NOT ENDSWITH(c.parallel, ')') AND NOT CONTAINS(LOWER(c.parallel), 'print run') AND ${CHECKLIST_SQL}` });
  }
  process.stderr.write("\n");

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);
  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing deleted"}`);
  console.log(`  rows scanned (this slot)   ${f(scanned)}   (+${f(otherShards)} belonging to other slots)`);
  console.log(`  RETIRED                    ${f(retired)}`);
  if (MODE === "tail") console.log(`  kept (real rungs)          ${f(kept)}   <- groups with >= ${TAIL_MIN} rows; the checklist itself`);
  console.log(`  sales stamped unplaced     ${f(salesUnplaced)}   <- the rematch owns them once a clean checklist lands`);
  console.log(`  graded children deleted    ${f(gradedDeleted)}`);
  console.log(`  failed                     ${f(failed)}`);
  if (APPLY) reportWrites({ job: "retire-exploded-checklist-rows", intended: scanned, written: retired, skipped: notReached, failed });
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
