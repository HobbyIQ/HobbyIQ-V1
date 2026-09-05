#!/usr/bin/env node
/**
 * CF-A-PRODUCT-EXCLUSIVE-PARALLEL-IS-PRODUCT-EVIDENCE (Drew, 2026-08-31).
 *
 * THE RULING. "A title naming a parallel that exists ONLY in another product
 * IS product evidence — the repair moves setKey + finish together."
 *
 * WHY THIS IS A SEPARATE LANE, not a mode on repair-base-to-title-finish.
 * That script's retarget() does head = p.slice(0, 5), which PRESERVES index 3
 * (the setKey) by design: it was reviewed as a parallel-only move. The rows
 * here are misfiled on setKey, so it structurally cannot repair them — it
 * computes hiq:baseball:2024:topps:1:x-fractor:no-auto, which is not a card
 * (flagship Topps has no X-Fractor) and correctly dies on the destination-
 * must-exist guard. Rewriting the setKey crosses the bowman-setkey-taxonomy
 * line (topps and topps-chrome are DIFFERENT cards), so it gets its own
 * script, its own scope refusal, and its own review — not a flag on a pass
 * whose blast radius was measured for something else.
 *
 * WHAT THE DIAGNOSIS ESTABLISHED (read-only, wf_089aca94-9dd, two agents,
 * the second re-reading every row from prod and correcting the first):
 *
 *   153  rows on hiq:baseball:2024:topps:*:base:* whose title names X-Fractor
 *        121 tca-ebay + 32 cardhedge  <- NOT one ingest path; the defect is in
 *                                        the shared parse, not in one source
 *
 *   Product the TITLE names:
 *      89  topps-chrome          25  topps-chrome-update    18  topps-pro-debut
 *      11  topps-allen-ginter     4  topps-finest            6  UNKNOWN
 *
 *   Destination existence, measured by point read:
 *       0  same-setKey destination exists   <- zero are repairable by the
 *                                              parallel-only pass, at any scope
 *     112  correct-setKey destination EXISTS <- repairable ONLY by a setKey move
 *      41  neither exists                    <- an acquisition list, never a guess
 *       2  wrong-card (the Skenes rows)      <- their own bucket, untouched
 *
 * HOW EXCLUSIVITY IS DERIVED — FROM THE CATALOG, NEVER A HARDCODED LIST.
 * The ruling's test is "the parallel exists under the sibling product and NOT
 * under the current one". Both halves are asked of card_catalog by COUNT, for
 * the row's own (sport, year) — so the answer is this product's actual
 * checklist in that year, not a belief about X-Fractor written into a regex
 * that would rot the first time Topps puts one in flagship. A hardcoded list
 * would also have to be re-derived per year and per sport; the catalog already
 * knows.
 *
 * WHAT IT REFUSES TO MOVE, every refusal counted by reason:
 *   lot           several cards in one title — a different defect entirely.
 *   noTitleProduct the title names no product the vocabulary reads (the 6
 *                 UNKNOWN). Nothing to move TOWARD.
 *   sameProduct   the title's product IS the row's setKey; this pass has no
 *                 opinion, the parallel-only lane owns it.
 *   notExclusive  the parallel exists under the CURRENT product too. Then the
 *                 title's finish is not product evidence and the row may well
 *                 be right where it is. AMBIGUOUS STAYS PUT.
 *   ambiguousDest several sibling products under the same family carry the
 *                 parallel. Picking one would be a guess (CF-RATIO-SIMILARITY-
 *                 IS-NOT-IDENTITY: several candidates = refuse, never nearest).
 *   noDest        the exact destination row is not checklist-backed in
 *                 card_catalog. THE DESTINATION MUST EXIST — the acquisition
 *                 bucket, reported by slug so it can be acquired, never minted.
 *   wrongCard     the row's card NUMBER is also wrong (the slug says #1, the
 *                 title states a product-coded number). A setKey move would
 *                 carry a wrong-numbered row to a new product and bury the
 *                 defect one level deeper. Counted, listed, UNTOUCHED — the
 *                 parser fix in this same commit stops the source, and these
 *                 rows want the cardNumber lane first.
 *
 * SCOPE IS REQUIRED, AND A WHOLE-SCOPE WRITE REFUSES WITHOUT ONE.
 * SPORTS + YEARS + SETKEYS name the WRONG setKey being swept. All three empty
 * with APPLY is refused before the connection string is even read
 * (CF-A-WHOLE-SOURCE-RETIRE-NEEDS-ITS-NAME): a cross-product mutation has to
 * say its own name out loud.
 *
 * Env: COSMOS_CONNECTION_STRING (required)
 *      BACKFILL_APPLY=true to write   (the runner exports BACKFILL_APPLY, not
 *                                      APPLY; APPLY=true also accepted)
 *      SPORTS   comma list, e.g. baseball    (the sport axis)
 *      YEARS    comma list, e.g. 2024        (the year axis)
 *      SETKEYS  comma list, e.g. topps       (the WRONG setKey being swept)
 *      SOURCES  comma list, e.g. tca-ebay    (optional; empty = every source)
 *      SLOT/SLOTS shard the work across parallel dispatches
 *      RUN_MINUTES=140  budget marker; prints RELAUNCH_NEEDED= for the runner
 *      LIMIT=0    bounded dry run (a LIMIT stop is NOT a budget stop)
 */
"use strict";
const path = require("node:path");
const crypto = require("node:crypto");
const { CosmosClient } = require("@azure/cosmos");
const ROOT = path.resolve(__dirname, "..");
const {
  parseListingIdentity, isMultiCardLot, inferSetKeyFromTitle,
} = require(path.join(ROOT, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
const { normalizeSetKey } = require(path.join(ROOT, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
const { productFamilyOf, productSetKeys } = require(path.join(ROOT, "dist/services/catalog/productSetKeys.js"));
const { reportWrites } = require(path.join(ROOT, "dist/services/ops/writeReconciliation.js"));

const APPLY = process.env.BACKFILL_APPLY === "true" || process.env.APPLY === "true";
const list = (v) => String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const SPORTS = list(process.env.SPORTS);
const YEARS = list(process.env.YEARS).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const SETKEYS = list(process.env.SETKEYS);
const SOURCES = list(process.env.SOURCES).filter((s) => s !== "all");
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
const SHARD_SCOPE = runnerShardScope({ label: "repair-setkey-from-title-parallel" });
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
// this runs before the connection string is read, so a mis-dispatched apply
// dies on its own arguments and never touches the account.
if (APPLY && !SPORTS.length && !YEARS.length && !SETKEYS.length) {
  console.error("REFUSED: BACKFILL_APPLY=true with SPORTS, YEARS and SETKEYS all empty is a");
  console.error("         whole-pool CROSS-PRODUCT mutation. Name the wrong setKey being swept");
  console.error("         (e.g. SPORTS=baseball YEARS=2024 SETKEYS=topps), or drop APPLY to report.");
  process.exit(2);
}

/** The doubled-year producer is fixed (0000f60) but stored titles still carry
 *  it; strip so the parser sees what the seller actually wrote. */
function dedupeYear(title, year) {
  const t = String(title ?? ""), y = String(year ?? "");
  return y && t.startsWith(y + " " + y + " ") ? t.slice(y.length + 1) : t;
}

/**
 * The products that could rival a chosen destination: everything sharing its
 * pricing FAMILY, read from the product table (productSetKeys), never from a
 * string prefix — `split("-").slice(0,2)` once made topps-series-1 and
 * topps-sapphire siblings, which is the mistake the table exists to end.
 *
 * Used only to REFUSE: if a rival also holds the exact destination card, the
 * title did not separate them and the row stays put.
 */
function siblingCandidates(setKey) {
  const fam = productFamilyOf(setKey);
  if (!fam) return [];
  return productSetKeys().filter((k) => productFamilyOf(k) === fam);
}

/**
 * Rebuild a slug with a new setKey AND a new parallel, preserving the rest.
 * Layout: hiq:sport:year:setKey:cardNumber:parallel:autoFlag[:num-N][:grade]
 *
 * This is the one structural difference from repair-base-to-title-finish:
 * index 3 (the setKey) MOVES. Everything else — sport, year, cardNumber, the
 * auto flag and any grade tail — is carried verbatim, and the print run
 * travels WITH the parallel.
 */
function retarget(slug, setKeySlug, parallelSlug, printRun) {
  const p = String(slug).split(":");
  if (p[0] !== "hiq" || p.length < 7) return null;
  const auto = p[6];
  const tail = p.slice(7).filter((x) => !/^num-\d+$/.test(x));
  const run = Number(printRun) > 0 ? ["num-" + Number(printRun)] : [];
  return [p[0], p[1], p[2], setKeySlug, p[4], parallelSlug, auto, ...run, ...tail].join(":");
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

  console.log(`repair-setkey-from-title-parallel  ${APPLY ? "APPLY" : "REPORT ONLY"}` +
              `  sports=${SPORTS.join(",") || "ALL"}  years=${YEARS.join(",") || "ALL"}` +
              `  setKeys(WRONG)=${SETKEYS.join(",") || "ALL"}  sources=${SOURCES.join(",") || "ALL"}` +
              `  slot ${SLOT}/${SLOTS}  budget ${RUN_MINUTES}m${LIMIT ? `  limit ${f(LIMIT)}` : ""}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);

  const where = ["IS_STRING(c.hobbyiqCardId)", "IS_STRING(c.title)"];
  const params = [];
  if (YEARS.length) { where.push(`c.cardYear IN (${YEARS.map((_, i) => `@y${i}`).join(",")})`); YEARS.forEach((y, i) => params.push({ name: `@y${i}`, value: y })); }
  if (SPORTS.length) { where.push(`(${SPORTS.map((_, i) => `STARTSWITH(c.hobbyiqCardId, @sp${i})`).join(" OR ")})`); SPORTS.forEach((s, i) => params.push({ name: `@sp${i}`, value: `hiq:${s}:` })); }
  if (SETKEYS.length) { where.push(`(${SETKEYS.map((_, i) => `CONTAINS(c.hobbyiqCardId, @sk${i})`).join(" OR ")})`); SETKEYS.forEach((k, i) => params.push({ name: `@sk${i}`, value: `:${k}:` })); }
  if (SOURCES.length) { where.push(`(${SOURCES.map((_, i) => `c.source = @src${i}`).join(" OR ")})`); SOURCES.forEach((s, i) => params.push({ name: `@src${i}`, value: s })); }

  const stats = {
    seen: 0, mine: 0, outOfScopeKey: 0, noFinish: 0, lot: 0, noTitleProduct: 0,
    sameProduct: 0, notExclusive: 0, ambiguousDest: 0, noDest: 0, wrongCard: 0,
    moves: 0, wrote: 0, vanished: 0, failed: 0,
  };
  const byMove = new Map(), missing = new Map(), wrongCards = [];
  const examples = [], refusedExamples = [];
  const destCache = new Map(), existCache = new Map();
  let stopReason = "";

  const destExists = async (slug) => {
    if (destCache.has(slug)) return destCache.get(slug);
    let ok = false;
    try { ok = !!(await cat.item(slug, slug).read()).resource; } catch { ok = false; }
    destCache.set(slug, ok);
    return ok;
  };

  /**
   * DOES THIS PARALLEL EXIST UNDER THIS PRODUCT, in this sport and year?
   * A COUNT against card_catalog — the checklist itself answers, so nothing
   * about which parallels belong to which product is written into this file.
   */
  const parallelExistsUnder = async (sport, year, setKey, parallelSlug) => {
    const key = `${sport}|${year}|${setKey}|${parallelSlug}`;
    if (existCache.has(key)) return existCache.get(key);
    let n = 0;
    try {
      const r = await cat.items.query({
        query: `SELECT VALUE COUNT(1) FROM c WHERE STARTSWITH(c.id, @pre) AND CONTAINS(c.id, @par)`,
        parameters: [
          { name: "@pre", value: `hiq:${sport}:${year}:${setKey}:` },
          { name: "@par", value: `:${parallelSlug}:` },
        ],
      }, { maxItemCount: 1 }).fetchNext();
      n = Number(r.resources?.[0] ?? 0);
    } catch { n = 0; }
    existCache.set(key, n);
    return n;
  };

  // CF-THE-SCAN-CAN-BE-THROTTLED-TOO. A throttled QUERY is the same claim as a
  // throttled write: not now, ask again.
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
      if (parts.length < 7) { stats.outOfScopeKey++; continue; }
      const [, sport, year, setKey, slugNum] = parts;
      // CONTAINS is a substring filter, so ':topps:' also admits nothing else
      // here -- but an exact check keeps a widened SETKEYS honest.
      if (SETKEYS.length && !SETKEYS.includes(String(setKey).toLowerCase())) { stats.outOfScopeKey++; continue; }

      // Refusals first, so a lot is never parsed into a move.
      if (isMultiCardLot(r.title)) {
        stats.lot++;
        if (refusedExamples.length < 10) refusedExamples.push(`  LOT            "${String(r.title).slice(0, 74)}"`);
        continue;
      }

      let parsed = {};
      try { parsed = parseListingIdentity(dedupeYear(r.title, r.cardYear)) || {}; } catch { stats.noFinish++; continue; }
      const wantParallel = slugify(parsed.parallel || "base") || "base";
      // No finish named, or the title says Base. This pass moves setKey ON THE
      // EVIDENCE OF A PARALLEL; with no parallel there is no evidence.
      if (wantParallel === "base") { stats.noFinish++; continue; }

      // What product does the TITLE name?
      const titleProduct = normalizeSetKey(inferSetKeyFromTitle(r.title, parsed.cardNumber) || "");
      if (!titleProduct) { stats.noTitleProduct++; continue; }
      if (titleProduct === String(setKey).toLowerCase()) {
        // The title agrees with the slug's product. Whatever else is wrong
        // here, it is not a setKey misfile — the parallel-only lane owns it.
        stats.sameProduct++;
        continue;
      }

      // THE RULING'S TEST, asked of the CATALOG both ways.
      // (1) The parallel must NOT exist under the product the row claims.
      const hereN = await parallelExistsUnder(sport, year, setKey, wantParallel);
      if (hereN > 0) {
        // Exists in both -> the title's finish is not product evidence.
        // AMBIGUOUS STAYS PUT.
        stats.notExclusive++;
        if (refusedExamples.length < 10) refusedExamples.push(`  NOTEXCLUSIVE   ${setKey} has ${hereN}x :${wantParallel}:  "${String(r.title).slice(0, 50)}"`);
        continue;
      }
      // (2) It must exist under the sibling the title names.
      const thereN = await parallelExistsUnder(sport, year, titleProduct, wantParallel);
      if (thereN === 0) {
        // The title's product does not carry this parallel either. Nothing is
        // established; this is not a destination.
        stats.noDest++;
        missing.set(`hiq:${sport}:${year}:${titleProduct}:*:${wantParallel}:*`,
          (missing.get(`hiq:${sport}:${year}:${titleProduct}:*:${wantParallel}:*`) || 0) + 1);
        continue;
      }
      // (3) The sibling the title names must be the ONLY candidate that FITS.
      // inferSetKeyFromTitle returns one product, but a family holds several
      // that carry the same parallel (topps-chrome and topps-chrome-update
      // both have X-Fractor). The title's words picked one; the CATALOG has to
      // agree that the others do not also hold this exact card. Several
      // holders that the title cannot separate = refuse, never nearest
      // (CF-RATIO-SIMILARITY-IS-NOT-IDENTITY).
      const rivals = [];
      for (const sib of siblingCandidates(titleProduct)) {
        if (sib === titleProduct) continue;
        const slug = retarget(r.hobbyiqCardId, sib, wantParallel, parsed.printRun);
        if (slug && await destExists(slug)) rivals.push(sib);
      }
      if (rivals.length) {
        stats.ambiguousDest++;
        if (refusedExamples.length < 10) {
          refusedExamples.push(`  AMBIGUOUSDEST  ${titleProduct} vs ${rivals.join("/")}  "${String(r.title).slice(0, 46)}"`);
        }
        continue;
      }

      const dest = retarget(r.hobbyiqCardId, titleProduct, wantParallel, parsed.printRun);
      if (!dest || dest === r.hobbyiqCardId) { stats.sameProduct++; continue; }

      // WRONG-CARD BUCKET. The slug's number and the title's number disagree.
      // The parser fix in this same commit is what makes this detectable: the
      // two Skenes rows have slug #1 and title #USC88, and before the fix the
      // parse ALSO said 1, so slug and parse agreed and nothing could see it.
      // A setKey move would carry a wrong-numbered row into a new product.
      const titleNum = String(parsed.cardNumber ?? "").toUpperCase();
      const slugNumU = String(slugNum ?? "").toUpperCase();
      if (titleNum && slugNumU && titleNum.replace(/-/g, "") !== slugNumU.replace(/-/g, "")) {
        stats.wrongCard++;
        if (wrongCards.length < 12) {
          wrongCards.push(`  slug#=${slugNumU}  title#=${titleNum}  ${r.source || "?"}  "${String(r.title).slice(0, 62)}"`);
        }
        continue;
      }

      if (!(await destExists(dest))) {
        stats.noDest++;
        missing.set(dest, (missing.get(dest) || 0) + 1);
        continue;
      }

      stats.moves++;
      const mk = `${setKey} -> ${titleProduct} (${parsed.parallel})`;
      byMove.set(mk, (byMove.get(mk) || 0) + 1);
      if (examples.length < 10) examples.push(`  ${r.source || "?"}  "${String(r.title).slice(0, 72)}"\n     ${r.hobbyiqCardId}\n  -> ${dest}`);

      if (!APPLY) continue;
      try {
        const d = (await sold.item(r.id, r.cardId ?? r.id).read()).resource;
        // A row that vanished between the query and the re-read is neither a
        // write nor a failure. stats.moves has ALREADY fired, so it is
        // DECLARED as skipped or it opens a silent shortfall in the very
        // identity the reconciliation block exists to check.
        if (!d) { stats.vanished++; continue; }
        d.hobbyiqCardId = dest;
        d.setKey = titleProduct;
        d.parallel = parsed.parallel;
        d.setKeyRepairedBy = {
          by: "repair-setkey-from-title-parallel",
          was: r.hobbyiqCardId,
          reason: "CF-A-PRODUCT-EXCLUSIVE-PARALLEL-IS-PRODUCT-EVIDENCE 2026-08-31",
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
              d2.setKey = titleProduct;
              d2.parallel = parsed.parallel;
              d2.setKeyRepairedBy = { by: "repair-setkey-from-title-parallel", was: r.hobbyiqCardId,
                reason: "CF-A-PRODUCT-EXCLUSIVE-PARALLEL-IS-PRODUCT-EVIDENCE 2026-08-31", at: new Date().toISOString() };
              await sold.item(r.id, r.cardId ?? r.id).replace(d2);
              stats.wrote++;
              continue;
            }
            stats.vanished++;
            continue;
          } catch { /* falls through to failed */ }
        }
        stats.failed++;
      }
    }
  } while (token);

  console.log("");
  console.log(`  scanned (scope)         ${f(stats.seen)}`);
  console.log(`  this shard              ${f(stats.mine)}`);
  console.log(`  out-of-scope setKey     ${f(stats.outOfScopeKey)}`);
  console.log(`  no finish in title      ${f(stats.noFinish)}   <- title names no parallel; no product evidence to act on`);
  console.log(`  REFUSED lot             ${f(stats.lot)}   <- several cards in one title; a different defect`);
  console.log(`  REFUSED no product      ${f(stats.noTitleProduct)}   <- title names no product the vocabulary reads`);
  console.log(`  REFUSED same product    ${f(stats.sameProduct)}   <- title's product IS the slug's; the parallel-only lane owns it`);
  console.log(`  AMBIGUOUS not exclusive ${f(stats.notExclusive)}   <- parallel exists under the CURRENT product too; STAYS PUT`);
  console.log(`  AMBIGUOUS multi-dest    ${f(stats.ambiguousDest)}   <- several sibling products carry it; picking one would be a guess`);
  console.log(`  ACQUISITION noDest      ${f(stats.noDest)}   <- destination not checklist-backed; an acquisition list, not a move`);
  console.log(`  WRONG-CARD (untouched)  ${f(stats.wrongCard)}   <- slug # and title # disagree; wants the cardNumber lane first`);
  console.log(`  MOVES setKey + finish   ${f(stats.moves)}`);
  console.log(`  wrote                   ${f(stats.wrote)}`);
  console.log(`  vanished before write   ${f(stats.vanished)}   <- row gone between query and re-read; declared, not a silent shortfall`);
  console.log(`  failed                  ${f(stats.failed)}`);
  if (byMove.size) {
    console.log(`  moves by product:`);
    for (const [k, n] of [...byMove.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`    ${String(n).padStart(7)}  ${k}`);
  }
  if (examples.length) { console.log(`  examples:`); for (const e of examples) console.log(e); }
  if (refusedExamples.length) { console.log(`  refused examples:`); for (const e of refusedExamples) console.log(e); }
  if (wrongCards.length) {
    console.log(`  WRONG-CARD rows (their own bucket, deliberately untouched):`);
    for (const w of wrongCards) console.log(w);
  }
  if (missing.size) {
    console.log(`  ACQUISITION LIST (destination absent from card_catalog):`);
    for (const [d, n] of [...missing].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    x${String(n).padStart(5)}  ${d}`);
  }
  if (stopReason) console.log(`\n${stopReason}`);
  if (!APPLY) console.log("\nREPORT ONLY - nothing written.");

  // CF-A-GREEN-RUN-IS-NOT-A-DATA-FLOW. What this run decided against what it
  // wrote. Every refusal is DECLARED as skipped — accounted for, not vanished —
  // so refusals stay out of the shortfall while a committed move that never
  // reached the database still fails the run.
  const refused = stats.lot + stats.noTitleProduct + stats.sameProduct
    + stats.notExclusive + stats.ambiguousDest + stats.noDest + stats.wrongCard;
  const intended = stats.moves + refused;
  const skipped = refused + (APPLY ? stats.vanished : stats.moves);
  reportWrites({
    job: "repair-setkey-from-title-parallel",
    intended,
    written: APPLY ? stats.wrote : 0,
    skipped,
    failed: stats.failed,
  });

  // The budget marker the runner relaunches on, verbatim. A LIMIT stop is a
  // dry-run bound and does NOT ask for a relaunch.
  const budgetStopped = budgetLeft() < 90000;
  console.log(`RELAUNCH_NEEDED=${budgetStopped ? "true" : "false"}`);
})().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || String(e));
  console.log("RELAUNCH_NEEDED=true");
  process.exit(3);
});
