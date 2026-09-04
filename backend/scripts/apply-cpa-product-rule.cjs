#!/usr/bin/env node
/**
 * apply-cpa-product-rule.cjs -- a card lives under the product whose DEDICATED
 * checklist names it.
 *
 * CF-THE-CHECKLIST-THAT-NAMES-THE-PRODUCT-WINS (Drew, 2026-08-30, D29/R2):
 * "the checklist that names the product wins; bcp's Bowman page is not that."
 *
 * 1,075 CPA autographs (2020-2026) are filed under BOTH `bowman` and
 * `bowman-chrome`. They are not two cards. The Chrome Prospect Autographs
 * insert ships in one release; baseballcardpedia's product page lists it
 * beside the other. The dedicated transcription names the product, the wiki
 * row folds onto it, and its sales travel with it -- one card, one pool.
 *
 * The decision is NOT in this file. It is src/services/catalog/cpaProductRule.ts
 * (pure, tested, mutation-checked): this script finds the identity groups,
 * asks the rule, and performs the moves the rule authorises. Read that file
 * for why the player gate comes first.
 *
 * THE GATE THAT MATTERS. (year, cardNumber, parallelSlug, auto) is NOT a card.
 * CPA numbers are INITIALS and initials collide -- CPA-ED is Eddy Diaz in one
 * product and Elijah Dunham in another. Measured 2026-08-30, of 3,459
 * identities carrying two dedicated setKeys, 1,879 are two DIFFERENT PLAYERS,
 * not one card filed twice. The rule abstains on every one of them, and this
 * script reports them on their own line rather than folding them.
 *
 * WHAT THIS SCRIPT WILL NOT DO. It never mints a row (a sale never mints).
 * It never folds ONTO a non-dedicated row. It never picks between two dedicated
 * checklists -- those are reported as keep-both for Drew, because R2 says the
 * sales split by the title's product words and that split is a separate pass.
 *
 * MODES (`mode` on the runner; NO default -- a whole-scope write is asked for
 * by name; CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME):
 *   fold    perform the folds the rule authorises (the 2,385-group population)
 *   report  decide everything, write nothing, print the full bucket census
 *
 * SCOPE. Deliberately narrow and REQUIRED: SPORTS, YEARS, PREFIXES and FAMILY
 * all have defaults matching the measured R2 population, and widening any of
 * them past that population demands SCOPE=all. R2 was ruled on bowman CPA
 * autos; the same defects exist elsewhere and are NOT this script's business
 * until they are measured.
 *
 * OPS. card_catalog was observed at offerThroughput=100 on 2026-08-30. At that
 * rate a query issued with the SDK default maxDegreeOfParallelism fans out to
 * every physical partition and NEVER RETURNS -- three queries hung past 300s,
 * including a COUNT filtered to one non-existent id. Every query here is
 * serial (maxDegreeOfParallelism 1, bufferItems false); the same 138k-row pull
 * then completes in 30s. Do not "optimise" this back.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write (the runner
 *      exports BACKFILL_APPLY, not APPLY -- read the banner before trusting an
 *      APPLY dispatch); MODE (required); SCOPE; SPORTS=baseball;
 *      YEARS=2020-2026; PREFIXES=CPA,BCPA; FAMILY=bowman;
 *      SLOT/SLOTS (hash of the identity key); CONCURRENCY=8; RUN_MINUTES=140;
 *      LIMIT.
 */
"use strict";
const path = require("path");
const crypto = require("crypto");

/**
 * An env var that is SET BUT EMPTY is a deliberate widening, not an absence.
 * `process.env.X || default` cannot tell those apart, and silently substituting
 * the default for an explicit `PREFIXES=` would scan every card number in the
 * family while the banner claimed the narrow scope -- exactly the shape of
 * CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME. Unset takes the default; emptied
 * reaches the scope guard and is refused there.
 */
const envOr = (name, dflt) => (process.env[name] === undefined ? dflt : String(process.env[name]));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const MODE = String(process.env.MODE || "").trim().toLowerCase();
const SCOPE = String(process.env.SCOPE || "").trim().toLowerCase();
const SPORTS = envOr("SPORTS", "baseball").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const YEARS = envOr("YEARS", "2020-2026").trim();
const PREFIXES = envOr("PREFIXES", "CPA,BCPA").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const FAMILY = envOr("FAMILY", "bowman").trim().toLowerCase();
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
const SHARD_SCOPE = runnerShardScope({ label: "apply-cpa-product-rule" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8));
const RUN_MS = Number(process.env.RUN_MINUTES || 140) * 60000;
const LIMIT = Number(process.env.LIMIT || 0);
const STARTED = Date.now();

/**
 * Pure: needs no compiled code, so it can run above the requires.
 * "2020-2026" or a comma list; a reversed range names no year.
 */
function parseYears(spec) {
  const m = /^(\d{4})-(\d{4})$/.exec(spec);
  if (m) {
    const lo = Number(m[1]), hi = Number(m[2]);
    if (hi < lo) return [];
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }
  return spec.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 1900);
}
const YEAR_LIST = parseYears(YEARS);

// ── THE SCOPE REFUSALS RUN FIRST, BEFORE ANY require() THAT CAN THROW ────────
// CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME: a whole-scope write is asked for by
// name (MODE=source with no SOURCES defaulted to baseballcardpedia and reported
// 13.14M rows). These gates sit ABOVE the @azure/cosmos and dist/ requires on
// purpose, the defect #1565 fixed for fold-checklist-numbered-twins: with a
// stale or absent `dist` the process died on MODULE_NOT_FOUND, which also exits
// 1, so a refusal that NEVER RAN looked exactly like a refusal that did. The
// exit code alone could not tell them apart and the message was never printed.
// None of these checks needs compiled code, so nothing about the build state
// can decide whether they fire.
if (!MODE) { console.error("FATAL: MODE is required and has no default. One of: fold | report"); process.exit(1); }
if (!["fold", "report"].includes(MODE)) { console.error(`FATAL: unknown MODE "${MODE}". One of: fold | report`); process.exit(1); }
if (!YEAR_LIST.length) { console.error(`FATAL: YEARS="${YEARS}" names no year. Use 2020-2026 or a comma list.`); process.exit(1); }
if (!SPORTS.length) { console.error("FATAL: SPORTS is empty; this rule was measured on baseball only."); process.exit(1); }
if (!PREFIXES.length) { console.error("FATAL: PREFIXES is empty; R2 was ruled on CPA/BCPA auto numbers."); process.exit(1); }
if (!FAMILY && SCOPE !== "all") { console.error("FATAL: FAMILY is empty -- that is every product in the catalog. Confirm it with SCOPE=all."); process.exit(1); }
if (!process.env.COSMOS_CONNECTION_STRING) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

const { CosmosClient } = require("@azure/cosmos");
const backend = path.resolve(__dirname, "..");
const { moveCatalogRow } = require(path.join(backend, "dist/services/catalog/catalogRowOps.service.js"));
const { decideCpaProduct, groupKey } = require(path.join(backend, "dist/services/catalog/cpaProductRule.js"));
const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const str = (v) => String(v ?? "").trim();
const shardOf = (k) => parseInt(crypto.createHash("sha1").update(String(k)).digest("hex").slice(0, 8), 16) % SLOTS;
const REASON = `the checklist that names the product wins; bcp's Bowman page is not that (D29/R2, Drew 2026-08-30)`;

/** Serial fan-out. card_catalog is at 100 RU/s; the default parallelism hangs. */
const SERIAL = { maxItemCount: 200, maxDegreeOfParallelism: 1, bufferItems: false };

const retry = async (fn, tries = 8) => {
  let wait = 500;
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e?.message ?? e);
      if (!/request rate|429|ETIMEDOUT|ECONNRESET|503|Request timed out/i.test(msg) || a >= tries) throw e;
      await new Promise((r) => setTimeout(r, wait)); wait = Math.min(wait * 2, 15000);
    }
  }
};


/**
 * The identity key is `groupKey` in cpaProductRule -- (year, folded number,
 * auto, player, FOLDED parallel spelling). It is imported, never re-derived
 * here: R1 shipped a local copy that keyed on the EXACT parallelSlug string,
 * and the two products spell the same rung differently, so the one card
 * arrived as three groups that each abstained "single-setkey".
 */

/**
 * The row's id with its setKey segment rewritten to the product that won and
 * its parallel segment rewritten to the spelling that survived.
 *
 * hiq:<sport>:<year>:<setKey>:<cardNumber>:<parallelSlug>:<auto>[:num-N]
 *                    seg[3]                 seg[5]
 *
 * Both segments move together: the whole point of R2 is that the product and
 * the spelling are two halves of one address, and rewriting only seg[3] leaves
 * the row beside its twin under the losing spelling.
 */
function withSetKeyAndParallel(id, setKey, parallelSlug) {
  const seg = String(id).split(":");
  if (seg.length < 7 || seg[0] !== "hiq") return null;
  seg[3] = setKey;
  if (parallelSlug) seg[5] = parallelSlug;
  return seg.join(":");
}

async function rowAt(cat, id) {
  try { const { resource } = await retry(() => cat.item(id, id).read()); return resource ?? null; }
  catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
}

async function main() {
  const conn = process.env.COSMOS_CONNECTION_STRING;

  // MODE / YEARS / SPORTS / PREFIXES / FAMILY were parsed and ENFORCED at the
  // top of this file, above the requires. Do not move those gates back down
  // here: a stale dist would make them unreachable and the MODULE_NOT_FOUND
  // would masquerade as the refusal (#1565).
  const years = YEAR_LIST;

  const db = new CosmosClient({ connectionString: conn, connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 30, maxWaitTimeInSeconds: 120 } } }).database("hobbyiq");
  const cat = db.container("card_catalog"), pool = db.container("sold_comps");

  console.log(`apply-cpa-product-rule  MODE=${MODE}  slot ${SLOT}/${SLOTS}  ${APPLY && MODE === "fold" ? "APPLY (moves card_catalog rows, re-points sales)" : "REPORT ONLY -- nothing written"}  concurrency ${CONCURRENCY}  budget ${RUN_MS / 60000}m`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`SCOPE: sport=${SPORTS.join(",")}  years=${years[0]}-${years[years.length - 1]}  cardNumber prefixes=${PREFIXES.join(",")}  setKey family=${FAMILY || "(ALL — SCOPE=all)"}  un-graded identity rows only${LIMIT ? `  LIMIT=${f(LIMIT)}` : ""}`);
  console.log(`only a DEDICATED checklist names a product; bcp-family and derived rows fold onto it. Two dedicated products for the same player are KEPT and reported, never merged.`);
  console.log(`the player gate is absolute: an initials collision (CPA-ED = Eddy Diaz and Elijah Dunham) abstains and is NOT a product conflict.\n`);

  const s = {
    rowsRead: 0, identities: 0, otherSlot: 0,
    singleSetKey: 0, noDedicated: 0, playerDisagreement: 0, nothingToFold: 0,
    printRunDisagree: 0, targetNotAProduct: 0, spellingChanged: 0,
    keptBoth: 0, foldGroups: 0,
    moved: 0, folded: 0, replaced: 0, noop: 0,
    salesRepointed: 0, gradedRetired: 0,
    refusedSetKeySplit: 0, failed: 0, notReached: 0,
  };
  const keepBothPairs = new Map(), foldPairs = new Map(), examples = [], keepBothExamples = [], collisionExamples = [], printRunExamples = [], spellingExamples = [];
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  let stopReason = null;

  // ── PASS 1: pull the scope and group it into identities ───────────────────
  const groups = new Map();
  {
    const sportSql = `c.sport IN (${SPORTS.map((_, i) => `@sp${i}`).join(",")})`;
    const yearSql = `(c.year IN (${years.map((_, i) => `@y${i}`).join(",")}) OR c.cardYear IN (${years.map((_, i) => `@y${i}`).join(",")}))`;
    const prefSql = `(${PREFIXES.map((_, i) => `STARTSWITH(UPPER(c.cardNumber), @p${i})`).join(" OR ")})`;
    const famSql = FAMILY ? ` AND STARTSWITH(c.setKey, @fam)` : "";
    const query = {
      query: `SELECT c.id, c.setKey, c.source, c.playerName, c.printRun, c.year, c.cardYear, c.cardNumber, c.parallelSlug, c.isAuto, c.cardId FROM c WHERE NOT IS_DEFINED(c.gradeTier) AND IS_DEFINED(c.cardNumber) AND ${sportSql} AND ${yearSql} AND ${prefSql}${famSql}`,
      parameters: [
        ...SPORTS.map((v, i) => ({ name: `@sp${i}`, value: v })),
        ...years.map((v, i) => ({ name: `@y${i}`, value: v })),
        ...PREFIXES.map((v, i) => ({ name: `@p${i}`, value: v })),
        ...(FAMILY ? [{ name: "@fam", value: FAMILY }] : []),
      ],
    };
    let token;
    do {
      const page = await retry(() => cat.items.query(query, { ...SERIAL, continuationToken: token }).fetchNext());
      token = page.continuationToken;
      for (const r of page.resources ?? []) {
        s.rowsRead++;
        const k = groupKey(r);
        const list = groups.get(k) ?? [];
        list.push(r);
        groups.set(k, list);
      }
      if (s.rowsRead % 20000 < 200) process.stderr.write(`\r  pass 1: ${f(s.rowsRead)} rows -> ${f(groups.size)} identities   `);
      if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; break; }
    } while (token && !stopReason);
    process.stderr.write("\n");
    console.log(`  pass 1: ${f(s.rowsRead)} rows read -> ${f(groups.size)} distinct (year, cardNumber, parallelSlug, auto) identities`);
  }

  // ── PASS 2: decide, and perform what the rule authorises ──────────────────
  async function handle(key, rows) {
    const d = decideCpaProduct(rows.map((r) => ({ id: str(r.id), setKey: str(r.setKey), source: str(r.source), playerName: r.playerName ?? null, printRun: r.printRun ?? null, parallelSlug: str(r.parallelSlug) })));

    if (d.kind === "abstain") {
      if (d.why === "single-setkey") s.singleSetKey++;
      else if (d.why === "no-dedicated-source") s.noDedicated++;
      else if (d.why === "player-disagreement") {
        s.playerDisagreement++;
        if (collisionExamples.length < 10) collisionExamples.push(`  ${key}   ${d.detail}`);
      } else if (d.why === "print-run-disagree") {
        s.printRunDisagree++;
        if (printRunExamples.length < 10) printRunExamples.push(`  ${key}   ${d.detail}`);
      } else if (d.why === "target-not-a-product") s.targetNotAProduct++;
      else s.nothingToFold++;
      return;
    }

    if (d.kind === "keep-both") {
      s.keptBoth++;
      bump(keepBothPairs, d.setKeys.join(" <> "));
      if (keepBothExamples.length < 10) keepBothExamples.push(`  ${key}   ${d.setKeys.join(" <> ")}   ${rows.find((r) => r.playerName)?.playerName ?? "?"}`);
      return;
    }

    // d.kind === "fold"
    s.foldGroups++;
    for (const from of d.from) bump(foldPairs, `${from} -> ${d.target}`);
    if (examples.length < 12) {
      const who = rows.find((r) => r.playerName)?.playerName ?? "?";
      examples.push(`  ${key}  ${who}\n        ${d.from.join(", ")} -> ${d.target}   (${d.rows.map((r) => r.source).join(", ")})`);
    }

    for (const r of d.rows) {
      const src = rows.find((x) => str(x.id) === r.id);
      if (!src) continue;
      // The destination carries BOTH halves of the ruling: the product the
      // dedicated checklist named, and the spelling the majority of checklist
      // sources at that product used (D31, tie -> the longer form). A fold that
      // moved only the setKey would land the row beside its twin under the
      // losing spelling and leave the pair split exactly as R1 found them.
      const spell = d.spelling && str(d.spelling) ? str(d.spelling) : str(src.parallelSlug);
      const newSlug = withSetKeyAndParallel(src.id, d.target, spell);
      if (!newSlug || newSlug === src.id) { s.noop++; continue; }
      if (spell && str(src.parallelSlug) && spell !== str(src.parallelSlug)) {
        s.spellingChanged++;
        if (spellingExamples.length < 10) spellingExamples.push(`  ${str(src.parallelSlug)} -> ${spell}   (${src.source} -> ${d.target})`);
      }
      // One read at the destination, reused as moveCatalogRow's `known`
      // (CF-DO-NOT-LOOK-TWICE). Authority decides the survivor there: a
      // dedicated checklist row already at the address KEEPS it and the
      // incoming derived row folds under it.
      const incumbent = await rowAt(cat, newSlug);
      const res = await moveCatalogRow(cat, src, newSlug, { setKey: d.target, parallelSlug: spell }, {
        reason: `${REASON}: ${r.source} filed this under ${r.setKey}`,
        dryRun: !APPLY || MODE !== "fold",
        salesContainer: pool,
        known: incumbent,
        retry,
      });
      s.salesRepointed += res.salesRepointed;
      s.gradedRetired += res.gradedChildrenRetired;
      if (res.action === "move") s.moved++;
      else if (res.action === "fold") s.folded++;
      else if (res.action === "replace") s.replaced++;
      else s.noop++;
    }
  }

  const keys = [...groups.keys()];
  const mine = keys.filter((k) => { if (SLOTS === 1 || shardOf(k) === SLOT) return true; s.otherSlot++; return false; });
  console.log(`  pass 2: ${f(mine.length)} identities in this slot (+${f(s.otherSlot)} belonging to other slots)\n`);

  for (let i = 0; i < mine.length && !stopReason; i += CONCURRENCY) {
    const batch = mine.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (k) => {
      s.identities++;
      try { await handle(k, groups.get(k) ?? []); }
      catch (e) {
        // CF-A-KEY-NEEDS-BOTH-HALVES: moveCatalogRow refuses a row whose id and
        // whose setKey FIELD disagree. D23's rename fleet is mid-flight and some
        // rows carry the old spelling in one half. That is a REFUSAL of another
        // repair's population, not a failure of this one.
        const msg = String(e?.message ?? e);
        if (/newSlug says setKey/.test(msg)) {
          s.refusedSetKeySplit++;
          if (s.refusedSetKeySplit <= 3) console.log(`  refused (setKey id/field split, D23's population) ${k}`);
          return;
        }
        s.failed++; if (s.failed <= 8) console.error(`  failed ${k}: ${msg.slice(0, 120)}`);
      }
    }));
    if (LIMIT && s.foldGroups >= LIMIT) { stopReason = "limit"; s.notReached = mine.length - Math.min(i + CONCURRENCY, mine.length); break; }
    if (Date.now() - STARTED > RUN_MS) { stopReason = "budget"; s.notReached = mine.length - Math.min(i + CONCURRENCY, mine.length); break; }
    if (s.identities % 2000 < CONCURRENCY) process.stderr.write(`\r  decided=${f(s.identities)} foldGroups=${f(s.foldGroups)} moved=${f(s.moved + s.folded + s.replaced)}   `);
  }
  process.stderr.write("\n");

  // ── the census ────────────────────────────────────────────────────────────
  const written = s.moved + s.folded + s.replaced;
  console.log(`\n${APPLY && MODE === "fold" ? "APPLIED" : "REPORT ONLY -- nothing written"}`);
  console.log(`  identities decided (this slot)  ${f(s.identities)}   (+${f(s.otherSlot)} belonging to other slots)`);
  console.log(`  ROWS MOVED                      ${f(written)}   <- the sub-totals below, which sum to it`);
  console.log(`    moved to the winning product     ${f(s.moved)}`);
  console.log(`    folded (a row was already there) ${f(s.folded)}`);
  console.log(`    replaced a lower-authority twin  ${f(s.replaced)}`);
  console.log(`  fold groups authorised          ${f(s.foldGroups)}   <- identities the rule decided; the rows above are their members`);
  console.log(`  rows whose SPELLING also moved  ${f(s.spellingChanged)}   <- the majority spelling among the checklist sources won (D31); a subset of ROWS MOVED, not an addition`);
  console.log(`  sales re-pointed                ${f(s.salesRepointed)}`);
  console.log(`  graded children retired         ${f(s.gradedRetired)}   <- regenerable by materialize-graded-identities`);
  console.log(`\n  ABSTAINED (left exactly as they are):`);
  console.log(`    single setKey                    ${f(s.singleSetKey)}   <- nothing to decide`);
  console.log(`    no dedicated checklist           ${f(s.noDedicated)}   <- bcp/derived only; R2 names no winner`);
  console.log(`    player disagreement              ${f(s.playerDisagreement)}   <- an initials collision, NOT a product conflict`);
  console.log(`    print-run disagreement           ${f(s.printRunDisagree)}   <- two different /N in one group; different print runs are different cards (D31)`);
  console.log(`    target not a product spelling    ${f(s.targetNotAProduct)}   <- D23's rename population, not a product ruling`);
  console.log(`    nothing foldable                 ${f(s.nothingToFold)}   <- one dedicated product, but no row both agrees on the player and is foldable`);
  console.log(`  KEPT BOTH                       ${f(s.keptBoth)}   <- two dedicated products, same player; sales split by title words is a SEPARATE pass`);
  console.log(`  refused (setKey id/field split)  ${f(s.refusedSetKeySplit)}   <- D23's rename population`);
  console.log(`  failed                          ${f(s.failed)}`);
  console.log(`  not reached                     ${f(s.notReached)}`);

  if (foldPairs.size) {
    console.log(`\n  folds by product pair:`);
    for (const [k, n] of [...foldPairs.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(48)} ${f(n).padStart(8)}`);
  }
  if (keepBothPairs.size) {
    console.log(`\n  KEPT BOTH by product pair (Drew's ruling needed on each -- R2 named bowman<>bowman-chrome, which measured ZERO):`);
    for (const [k, n] of [...keepBothPairs.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(k).padEnd(48)} ${f(n).padStart(8)}`);
  }
  if (examples.length) { console.log(`\n  fold examples:`); for (const e of examples) console.log(e); }
  if (keepBothExamples.length) { console.log(`\n  keep-both examples:`); for (const e of keepBothExamples) console.log(e); }
  if (collisionExamples.length) { console.log(`\n  initials-collision examples (abstained):`); for (const e of collisionExamples) console.log(e); }
  if (printRunExamples.length) { console.log(`\n  print-run-disagreement examples (abstained):`); for (const e of printRunExamples) console.log(e); }
  if (spellingExamples.length) { console.log(`\n  surviving-spelling examples:`); for (const e of spellingExamples) console.log(e); }

  if (stopReason === "budget") console.log(`\nstopped at the ${RUN_MS / 60000}-minute budget — the relaunch continues from here`);
  else if (stopReason === "limit") console.log(`\nstopped at LIMIT=${f(LIMIT)} — a bounded run`);

  if (APPLY && MODE === "fold") {
    // CF-A-SLICE-IS-NOT-A-SIBLING-COUNTER: the counters below are DISJOINT.
    // `written` is the row-level total and its three sub-totals are printed on
    // their own lines above, never summed into skipped. Every identity this run
    // took on is either a fold group, an abstain, a keep-both, a refusal, a
    // failure, or was never reached.
    reportWrites({
      job: "apply-cpa-product-rule",
      intended: s.identities + s.notReached,
      written: s.foldGroups,
      skipped: s.singleSetKey + s.noDedicated + s.playerDisagreement + s.printRunDisagree + s.targetNotAProduct + s.nothingToFold + s.keptBoth + s.refusedSetKeySplit + s.notReached,
      failed: s.failed,
    });
  }
}

main().catch((e) => { console.error("FATAL:", e?.stack || e?.message); process.exit(3); });
