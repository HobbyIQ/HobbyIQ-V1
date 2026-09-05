#!/usr/bin/env node
/**
 * CF-REPAIR-THE-BASE-POOLS (Drew, 2026-08-31). The other direction.
 *
 * repair-refractor-mislabel.cjs scans rows carrying ':refractor:' and moves the
 * ones whose title says something else. This scans rows carrying ':base:' and
 * moves the ones whose title NAMES A FINISH — the leak the 2024 mix measurement
 * found, and the leak the parser fix in this same commit stops at the source.
 *
 * WHAT THE MEASUREMENT ESTABLISHED (read-only, 395,474 rows scanned across
 * cardYear=2024 x {bowman, bowman-draft, bowman-chrome, topps-chrome}):
 *
 *   1,853  base-slug rows whose title names a refractor finish
 *      44  refractor-slug rows whose title says Base   <- the other direction,
 *          already handled by repair-refractor-mislabel; 42:1 says the leak is
 *          overwhelmingly INTO base pools
 *
 *   Triaged, because a raw 1,853 overstates what is repairable:
 *     211  lots / multi-card    a DIFFERENT defect; moving them trades one
 *                               wrong pool for another
 *     134  wrong product        title names Panini Prizm / Bowman's Best /
 *                               University against a chrome-family slug; also a
 *                               different defect
 *   1,508  genuinely repairable single cards
 *
 *   Of those 1,508: 1,105 the live parser ALSO read as Base (the two defects
 *   this commit fixes — 867 bare X-Fractor, 235 plural "Refractors", 3 other),
 *   and 403 the live parser already reads correctly (stale rows, written before
 *   an earlier fix). Both groups are repairable by THIS pass, because both are
 *   re-derived from the parser as it stands after the fix. That is why the
 *   parser lands first: a repair run before it would be re-dirtied by the next
 *   ingest, and would itself re-derive the same wrong answer.
 *
 * ONLY-IMPROVE DOES NOT APPLY, same reasoning as the refractor-mislabel pass.
 * base -> refractor is not a loss of specificity; ':base:' on a title that says
 * "X-Fractor" is an INVENTED answer, and the title is the evidence. (Doctrine:
 * blank means unknown, never "Base" — chRowToSoldComp defaults an empty vendor
 * variant to "Base", which is how many of these were minted.)
 *
 * WHAT IT REFUSES TO MOVE, counted and never written:
 *   lot          isMultiCardLot from the shared parser — the SAME detector the
 *                parser now refuses a bare-refractor reading by. One rule, two
 *                lanes: two copies would drift, and the drift would show up as
 *                this pass moving rows the live parser would never write.
 *   wrongProduct the title names a product family the slug's setKey
 *                contradicts. A refractor repair would move it to a
 *                still-wrong pool.
 *   held         unparsedVariantReason — the title names a variant the parse
 *                does not carry, so the move would trade one mislabel for
 *                another (the PackFractor lesson from the last repair).
 *   noDest       the destination slug is not in card_catalog. THE DESTINATION
 *                MUST EXIST: the prior repair's stated failure mode was sales
 *                leaving one pool and arriving nowhere. Reported as an
 *                acquisition list, never guessed at.
 *
 * SCOPE IS AN INPUT, AND A WHOLE-SCOPE WRITE REFUSES WITHOUT ONE.
 * The parser defects are year-agnostic and sport-agnostic — 2024 chrome-family
 * is where they were MEASURED, not where they are. So SPORTS/YEARS/SETKEYS are
 * explicit inputs and the pass shards on them, to run wide. But APPLY with all
 * three left wide open is refused: a whole-scope mutation of the pool needs its
 * name said out loud (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME). Report-only
 * runs wide freely — that is how the full width gets measured.
 *
 * Env: COSMOS_CONNECTION_STRING (required)
 *      BACKFILL_APPLY=true to write   (the runner exports BACKFILL_APPLY, not
 *                                      APPLY; APPLY=true also accepted)
 *      SPORTS     comma list, e.g. baseball          (empty = every sport)
 *      YEARS      comma list, e.g. 2024              (empty = every year)
 *      SETKEYS    comma list, e.g. bowman-chrome     (empty = every setKey)
 *      SLOT/SLOTS shard the work across parallel dispatches
 *      RUN_MINUTES=140  budget marker; prints RELAUNCH_NEEDED= for the runner
 *      LIMIT=0    bounded dry run (a LIMIT stop is NOT a budget stop)
 */
"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
const { CosmosClient } = require("@azure/cosmos");
const ROOT = path.resolve(__dirname, "..");
const { parseListingIdentity, isMultiCardLot } = require(path.join(ROOT, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { unparsedVariantReason } = require(path.join(ROOT, "dist/services/catalog/attestationGuard.js"));
const { reportWrites } = require(path.join(ROOT, "dist/services/ops/writeReconciliation.js"));

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
const list = (v) => String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const SPORTS = list(process.env.SPORTS);
const YEARS = list(process.env.YEARS).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const SETKEYS = list(process.env.SETKEYS);
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
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809): the one exit path.
const { finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const SHARD_SCOPE = runnerShardScope({ label: "repair-base-to-title-finish" });
const { SHARDED, SLOT, SLOTS } = SHARD_SCOPE;

const RUN_MINUTES = Number(process.env.RUN_MINUTES || 120);
/** Wall clock a single unit may still be granted after the budget expires.
 *  CHECKED BEFORE EACH UNIT, never at the loop top. See lib/runner-budget.cjs. */
const RESERVE_MS = Number(process.env.RESERVE_MS || 90 * 1000);
/** Hard cap on the post-loop verify-by-read: it answers, or it says it could
 *  not. It never holds the step open until the runner kills it. */
const VERIFY_MS = Number(process.env.VERIFY_MS || 10 * 60 * 1000);
const LIMIT = Number(process.env.LIMIT || 0);

const f = (n) => Number(n).toLocaleString();
const started = Date.now();
const budgetLeft = () => RUN_MINUTES * 60000 - (Date.now() - started);
const shardOf = (id) => parseInt(crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 8), 16) % SLOTS;
const slugify = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE. Refusals before requires:
// this runs before the connection string is even read, so a mis-dispatched
// apply dies on its own arguments and never touches the account.
if (APPLY && !SPORTS.length && !YEARS.length && !SETKEYS.length) {
  console.error("REFUSED: BACKFILL_APPLY=true with SPORTS, YEARS and SETKEYS all empty is a whole-pool mutation.");
  console.error("         Name at least one axis (e.g. YEARS=2024 SETKEYS=bowman-chrome), or drop APPLY to report.");
  process.exit(2);
}

/** The doubled-year producer is fixed (0000f60) but stored titles still carry
 *  it; strip so the parser sees what the seller actually wrote. */
function dedupeYear(title, year) {
  const t = String(title ?? ""), y = String(year ?? "");
  return y && t.startsWith(y + " " + y + " ") ? t.slice(y.length + 1) : t;
}

/** Title names a product family the slug's setKey contradicts. Mirrors the
 *  measurement's own triage, which counted 134 of these and refused them. */
const OTHER_PRODUCT_RE = /\bprizm\b|\bpanini\b|\bselect\b|\bmosaic\b|\boptic\b|\bbowman'?s\s+best\b|\buniversity\b|\bsapphire\b/i;
function namesAnotherProduct(title, setKey) {
  if (!OTHER_PRODUCT_RE.test(String(title ?? ""))) return false;
  // A title may legitimately say "sapphire" when the slug IS the sapphire
  // product — bowman-vs-chrome-vs-sapphire are different cards, and the setKey
  // is what says which one this row claims to be.
  const m = String(title).match(OTHER_PRODUCT_RE);
  const named = slugify(m ? m[0] : "");
  return named ? !String(setKey || "").toLowerCase().includes(named) : false;
}

/**
 * Rebuild a slug with a new parallel and print run, preserving everything else.
 * Layout: hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N][:grade]
 * The print run travels WITH the parallel — that is the bug that made an
 * earlier rematch point at rows which did not exist.
 */
function retarget(slug, parallelSlug, printRun) {
  const p = String(slug).split(":");
  if (p[0] !== "hiq" || p.length < 7) return null;
  const head = p.slice(0, 5);
  const auto = p[6];
  const tail = p.slice(7).filter((x) => !/^num-\d+$/.test(x));
  const run = Number(printRun) > 0 ? ["num-" + Number(printRun)] : [];
  return [...head, parallelSlug, auto, ...run, ...tail].join(":");
}

(async () => {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }
  const db = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  }).database(process.env.COSMOS_DATABASE ?? "hobbyiq");
  const sold = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`repair-base-to-title-finish  ${APPLY ? "APPLY" : "REPORT ONLY"}` +
              `  sports=${SPORTS.join(",") || "ALL"}  years=${YEARS.join(",") || "ALL"}` +
              `  setKeys=${SETKEYS.join(",") || "ALL"}  slot ${SLOT}/${SLOTS}` +
              `  budget ${RUN_MINUTES}m${LIMIT ? `  limit ${f(LIMIT)}` : ""}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  // A ':base:' row, scoped. CONTAINS on the slug is the cheap filter; the
  // parser decides after.
  const where = ["IS_STRING(c.hobbyiqCardId)", "CONTAINS(c.hobbyiqCardId, ':base:')", "IS_STRING(c.title)"];
  const params = [];
  if (YEARS.length) { where.push(`c.cardYear IN (${YEARS.map((_, i) => `@y${i}`).join(",")})`); YEARS.forEach((y, i) => params.push({ name: `@y${i}`, value: y })); }
  if (SPORTS.length) { where.push(`(${SPORTS.map((_, i) => `STARTSWITH(c.hobbyiqCardId, @sp${i})`).join(" OR ")})`); SPORTS.forEach((s, i) => params.push({ name: `@sp${i}`, value: `hiq:${s}:` })); }
  if (SETKEYS.length) { where.push(`(${SETKEYS.map((_, i) => `CONTAINS(c.hobbyiqCardId, @sk${i})`).join(" OR ")})`); SETKEYS.forEach((k, i) => params.push({ name: `@sk${i}`, value: `:${k}:` })); }

  const stats = {
    seen: 0, mine: 0, correct: 0, lot: 0, wrongProduct: 0, held: 0, vanished: 0,
    noDest: 0, moves: 0, wrote: 0, failed: 0,
  };
  const byFinish = new Map(), heldWhy = new Map(), missing = new Map();
  const examples = [], refusedExamples = [];
  const destCache = new Map();
  let stopReason = "";

  const destExists = async (slug) => {
    if (destCache.has(slug)) return destCache.get(slug);
    let ok = false;
    try { ok = !!(await cat.item(slug, slug).read()).resource; } catch { ok = false; }
    destCache.set(slug, ok);
    return ok;
  };

  // CF-THE-SCAN-CAN-BE-THROTTLED-TOO. A throttled QUERY is the same claim as a
  // throttled write: not now, ask again. Letting it reach the top level kills
  // the worker and abandons everything it had not reached.
  const queryWithRetry = async (spec, opts) => {
    let wait = 1000;
    for (let attempt = 0; ; attempt++) {
      try { return await sold.items.query(spec, opts).fetchNext(); }
      catch (e) {
        const throttled = /request rate is too large|429|ETIMEDOUT|ECONNRESET|503/i.test(String(e?.message));
        if (!throttled || attempt >= 12) throw e;
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 30000);
      }
    }
  };

  let token;
  outer:
  do {
    if (budgetLeft() < 90000) { stopReason = `stopped at the ${RUN_MINUTES}-minute budget`; break; }
    const page = await queryWithRetry(
      { query: `SELECT c.id, c.cardId, c.title, c.hobbyiqCardId, c.cardYear, c.source FROM c WHERE ${where.join(" AND ")}`,
        parameters: params },
      { maxItemCount: 400, continuationToken: token },
    );
    token = page.continuationToken;

    for (const r of page.resources) {
      stats.seen++;
      if (SLOTS > 1 && shardOf(r.id) !== SLOT) continue;
      stats.mine++;
      if (LIMIT && stats.mine >= LIMIT) { stopReason = `stopped at LIMIT=${f(LIMIT)} (a dry-run bound, not a budget stop)`; break outer; }

      const parts = String(r.hobbyiqCardId).split(":");
      if (parts.length < 7 || parts[5] !== "base") { stats.correct++; continue; }
      const setKey = parts[3];

      // Refusals first, so a lot is never parsed into a move.
      if (isMultiCardLot(r.title)) {
        stats.lot++;
        if (refusedExamples.length < 8) refusedExamples.push(`  LOT           "${String(r.title).slice(0, 78)}"`);
        continue;
      }
      if (namesAnotherProduct(r.title, setKey)) {
        stats.wrongProduct++;
        if (refusedExamples.length < 8) refusedExamples.push(`  WRONGPRODUCT  ${setKey}  "${String(r.title).slice(0, 66)}"`);
        continue;
      }

      let parsed = {};
      try { parsed = parseListingIdentity(dedupeYear(r.title, r.cardYear)) || {}; } catch { stats.correct++; continue; }
      const want = slugify(parsed.parallel || "base") || "base";
      // The title says Base too, or says nothing. Nothing to do — and this is
      // the overwhelming majority of a ':base:' scan.
      if (want === "base") { stats.correct++; continue; }

      const holdReason = unparsedVariantReason({
        title: r.title, parsedParallel: parsed.parallel,
        parsedIsAuto: parsed.isAuto, parsedPrintRun: parsed.printRun,
      });
      if (holdReason) { stats.held++; heldWhy.set(holdReason, (heldWhy.get(holdReason) || 0) + 1); continue; }

      const dest = retarget(r.hobbyiqCardId, want, parsed.printRun);
      if (!dest || dest === r.hobbyiqCardId) { stats.correct++; continue; }

      if (!(await destExists(dest))) {
        stats.noDest++;
        missing.set(dest, (missing.get(dest) || 0) + 1);
        continue;
      }

      stats.moves++;
      byFinish.set(parsed.parallel, (byFinish.get(parsed.parallel) || 0) + 1);
      if (examples.length < 10) examples.push(`  ${r.source || "?"}  "${String(r.title).slice(0, 74)}"\n     ${r.hobbyiqCardId}\n  -> ${dest}`);

      if (!APPLY) continue;
      try {
        const d = (await sold.item(r.id, r.cardId ?? r.id).read()).resource;
        // A row that vanished between the query and the re-read is neither a
        // write nor a failure, and counting it as neither breaks the identity
        // this job's banner claims: stats.moves has ALREADY fired, so the row
        // would sit in `intended` with nothing on the other side. Counted
        // explicitly so every move still reconciles.
        if (!d) { stats.vanished++; continue; }
        d.hobbyiqCardId = dest;
        d.parallel = parsed.parallel;
        d.parallelRepairedBy = {
          by: "repair-base-to-title-finish",
          was: r.hobbyiqCardId,
          reason: "CF-REPAIR-THE-BASE-POOLS 2026-08-31 (plural Refractors + bare X-Fractor)",
          at: new Date().toISOString(),
        };
        await sold.item(r.id, r.cardId ?? r.id).replace(d);
        stats.wrote++;
      } catch (e) {
        if (/request rate is too large|429/i.test(String(e?.message))) {
          await new Promise((res) => setTimeout(res, 2000));
          try {
            const d2 = (await sold.item(r.id, r.cardId ?? r.id).read()).resource;
            if (d2) {
              d2.hobbyiqCardId = dest;
              d2.parallel = parsed.parallel;
              d2.parallelRepairedBy = { by: "repair-base-to-title-finish", was: r.hobbyiqCardId,
                reason: "CF-REPAIR-THE-BASE-POOLS 2026-08-31 (plural Refractors + bare X-Fractor)", at: new Date().toISOString() };
              await sold.item(r.id, r.cardId ?? r.id).replace(d2);
              stats.wrote++;
              continue;
            }
            // Vanished on the retry read too — same accounting as above.
            stats.vanished++;
            continue;
          } catch { /* falls through to failed */ }
        }
        stats.failed++;
      }
    }
  } while (token);

  console.log("");
  console.log(`  scanned (scope)        ${f(stats.seen)}`);
  console.log(`  this shard             ${f(stats.mine)}`);
  console.log(`  correct / title agrees ${f(stats.correct)}   <- title says Base too, or names nothing`);
  console.log(`  REFUSED lot            ${f(stats.lot)}   <- several cards in one title; a different defect, counted never moved`);
  console.log(`  REFUSED wrong product  ${f(stats.wrongProduct)}   <- title names another product family than the slug's setKey`);
  console.log(`  held (unparsed variant)${f(stats.held)}   <- title names a variant the parse does not carry — a second wrong move buries it`);
  console.log(`  noDest (catalog gap)   ${f(stats.noDest)}   <- destination slug absent from card_catalog; an acquisition list, not a move`);
  console.log(`  MOVES base -> finish   ${f(stats.moves)}`);
  console.log(`  wrote                  ${f(stats.wrote)}`);
  console.log(`  vanished before write  ${f(stats.vanished)}   <- row gone between query and re-read; declared, not a silent shortfall`);
  console.log(`  failed                 ${f(stats.failed)}`);
  if (byFinish.size) {
    console.log(`  moves by finish:`);
    for (const [k, n] of [...byFinish.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`    ${String(n).padStart(7)}  ${k}`);
  }
  if (heldWhy.size) console.log(`  held reasons: ${[...heldWhy].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }
  if (refusedExamples.length) { console.log(`  refused examples:`); for (const e of refusedExamples) console.log(e); }
  for (const [d, n] of [...missing].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  MISSING DEST x${n}  ${d}`);
  if (stopReason) console.log(`\n${stopReason}`);
  if (!APPLY) console.log("\nREPORT ONLY - nothing written.");

  // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. What this run decided, against what it
  // wrote. The refusals are DECLARED as skipped — they are accounted for, not
  // vanished — so they stay out of the shortfall while a committed move that
  // never reached the database still fails the run.
  // A row that vanished between the query and the re-read is DECLARED too. It
  // is not a write and not a failure, but stats.moves already counted it into
  // `intended`, so leaving it out of `skipped` would open a silent shortfall in
  // exactly the identity this block exists to check.
  const intended = stats.moves + stats.held + stats.noDest + stats.lot + stats.wrongProduct;
  const skipped = stats.held + stats.noDest + stats.lot + stats.wrongProduct
    + (APPLY ? stats.vanished : stats.moves);
  reportWrites({
    job: "repair-base-to-title-finish",
    intended,
    written: APPLY ? stats.wrote : 0,
    skipped,
    failed: stats.failed,
  });

  // The budget marker the runner relaunches on, verbatim. A LIMIT stop is a
  // dry-run bound and does NOT ask for a relaunch.
  const budgetStopped = budgetLeft() < 90000;
  console.log(`RELAUNCH_NEEDED=${budgetStopped ? "true" : "false"}`);
})()
// CF-A-LANE-EXITS-WHEN-ITS-WORK-IS-DONE (#1809). Success exits too: a lane
// that lets the loop drain is betting every library released every handle.
// Runs 33975816175/25863/34391/40824 lost that bet AFTER reconciling clean.
// process.exitCode set by the body above is HONOURED, never overwritten.
  .then(() => finishLane(process.exitCode || 0))
  .catch(async (e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  console.log("RELAUNCH_NEEDED=true");

    await finishLane(3);
  });
