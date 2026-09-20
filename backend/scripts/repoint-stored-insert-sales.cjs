#!/usr/bin/env node
/**
 * repoint-stored-insert-sales.cjs -- move STORED sold_comps rows that a
 * REGISTERED insert set's own checklist confirms, off the BASE product's
 * pools they were mis-filed under, forever, until this lane runs.
 *
 * THE MEASURED PROBLEM (PR #2331 context). R66/R67/R70 taught the two
 * WRITERS (soldCompsStore.service.ts, persistVendorSalesToPool.service.ts)
 * to recognise a title naming a REGISTERED insert set of its own product, and
 * to re-key a FRESH sale onto the insert's own setKey -- but only when
 * CONFIRMED by the insert's checklist rows (insertSetTitleReader.ts +
 * insertSetChecklistConfirm.ts). That is an INGEST-PATH hook: it runs once,
 * at write time, for a sale being written today. CF-INGEST-KEEPS-STORED-
 * IDENTITY (soldCompsStore.service.ts, 2026-09-14) is the general form of why
 * this can never reach a STORED row -- ingest never re-derives the identity
 * of a document that already exists at an address, on any re-upsert, by
 * design (232 Bush/Mantle rows moving silently on a re-scrape is exactly the
 * incident that rule exists to prevent). So every insert sale that landed in
 * a BASE card's pool BEFORE #2331 shipped -- named a Panini Photogenic
 * Rookie Pix DT-5 sale, filed for decades under the base card at #5, priced
 * the wrong player forever -- stays there. Drew's own framing: this is the
 * single biggest source of wrong-player / wrong-card prices in the stored
 * pool, because a title-vocabulary defect that ran for the LIFETIME of a
 * product (until #2331 merged) affects every sale scraped in that window,
 * not a handful.
 *
 * THIS LANE closes exactly that gap, driving from the CHECKLIST rather than
 * scanning sold_comps pool-wide:
 *
 *   1. `titles` (SET_KEYS, reused -- see BCP_TITLES below) names one or more
 *      REGISTERED INSERT setKeys (`panini-photogenic-rookie-pix`, ...), never
 *      a base product -- `productParentOf` resolves each insert's own base
 *      product from productSetKeys.ts, and a key with no registered parent is
 *      refused by name (an insert with no parent is not this lane's shape).
 *   2. For each (sport:year cell, insert setKey), page card_catalog for the
 *      insert's own CHECKLIST-AUTHORITY rows (catalogAuthorityOf(source) ===
 *      "checklist") -- these are the CONFIRMATION SET, read once per target,
 *      never re-read per sale.
 *   3. Candidate sales are every stored row at the BASE PRODUCT'S OWN CELL:
 *      `STARTSWITH(c.hobbyiqCardId, "hiq:sport:year:baseSetKey:")` -- THE
 *      SAME query shape rekey-product-setkey.cjs's own MODE=pool lane already
 *      runs against sold_comps, header-justified there with a measured row
 *      count ("the pool is the substance of these rulings and it is swept
 *      directly, by slug prefix"). A per-number query is NOT used for
 *      candidate discovery (only for confirmation, in step 5) because a
 *      mis-pooled sale's STORED cardNumber may be the BASE product's own
 *      number for that roster slot, not the insert's -- the whole point of
 *      the CARD-NUMBER RULE below -- so filtering candidates by the insert's
 *      numbers before the checklist comparison runs would make that LEAVE
 *      reason structurally unreachable. Every candidate is double-checked in
 *      JS (productSetKeyOf, the same reader splitIdentityWriteGuard.ts's own
 *      carryProductRekeyOntoCardId uses) against BOTH cardId and
 *      hobbyiqCardId, since a vendor-partitioned row's cardId names no
 *      product at all and only hobbyiqCardId carries the base slug.
 *   4. Each candidate sale's TITLE is read through the REAL compiled
 *      `insertSetNamedInTitle` (dist/services/portfolioiq/
 *      insertSetTitleReader.js) against the sale's OWN base identity
 *      (sport/year/baseSetKey) -- exactly the question the ingest-time
 *      writers ask, asked here after the fact. A title that does not name
 *      THIS insert (or names it beside another) is left untouched.
 *   5. A title match is confirmed against the checklist rows ALREADY LOADED
 *      in step 2 -- no per-sale Cosmos read -- via `planInsertRekey`'s pure
 *      predicate below, which mirrors insertSetChecklistConfirm.ts's own
 *      "both known -> one row must confirm both" rule (FIX 1) without
 *      importing that module (its predicate is private; only its I/O-facing
 *      exports are public, and this lane's whole point is to do that
 *      confirmation WITHOUT a second Cosmos round-trip per sale).
 *
 * CARD-NUMBER RULE. An insert checklist usually numbers with its own prefix
 * (DT-5) while a mis-pooled sale may carry the BASE card's number instead (a
 * title-parser reading the base checklist's own #5 before #2331 existed to
 * redirect it). Confirmation requires the sale's STORED cardNumber to equal
 * the INSERT ROW's number, normalised exactly as insertSetChecklistConfirm.ts
 * normalises it (case/hyphen/leading-zero fold, via the shared, read-only
 * `cardNumberVariants` plus this file's own local leading-zero fold -- see
 * that module's header on why the fold is local and not added to the shared
 * helper, reused verbatim here for the same reason: hobbyIqCardId.service.ts
 * is a declared derivation-stamp input and this lane may only ever WIDEN a
 * comparison over its existing, unchanged output, never edit it). A sale
 * whose stored number is the BASE product's own number for that slot --
 * never appearing on the insert's checklist under any variant -- is LEFT,
 * named `number-is-base-number`, and listed: guessing that the title's own
 * number differs from the stored field is a job for a title-vocabulary pass,
 * not this identity mover.
 *
 * VERDICTS, ONE AXIS ONLY (relocation lists change one axis only):
 *   MOVE       title names ONLY this insert, AND confirms (number+player,
 *              or number alone when the checklist row carries no player) on
 *              exactly one checklist row. hobbyiqCardId's setKey segment
 *              moves to the insert key (withProductSetKey, the same helper
 *              carryProductRekeyOntoCardId already trusts); cardId's setKey
 *              segment moves TOO, but only when cardId is itself the hiq:
 *              slug equal to the pre-move hobbyiqCardId (a relocate) -- a raw
 *              vendor cardId is patched (hobbyiqCardId only), exactly the
 *              cardId/hobbyiqCardId split repoint-sales-to-checklist-
 *              numbered.cjs already draws between its two candidate shapes.
 *   LEAVE      named reasons below; nothing written.
 *   REFUSE     destination collision (a DIFFERENT sale already resident) --
 *              neither moved.
 *   COLLAPSE   the SAME sale (by content hash) already resident at the
 *              destination -- the short-address copy is deleted, the
 *              resident is untouched.
 *
 * LEAVE REASONS:
 *   two-inserts-named        the title names two distinct insert families --
 *                            R70's own "never choose" rule, reused: guessing
 *                            between two named games risks the wrong one.
 *   pinned-or-verified       the sale itself is a trust-anchored row this
 *                            lane must never re-address on a title-vocabulary
 *                            basis alone: `verifiedByUser === true` (a real
 *                            user attested THIS sale to THIS card -- the
 *                            highest-trust field the row itself carries), or
 *                            `source` is one of USER_SEED_SOURCES
 *                            (ebay-user-purchase / ebay-user-sale /
 *                            manual-user-entry / user-verified --
 *                            soldCompsStore.service.ts's own set: these
 *                            transactions are ALREADY reconciled through the
 *                            catalog by the user's own action per CF-A-USER-
 *                            SALE-IS-ALWAYS-RECONCILED, and a title-vocabulary
 *                            mover second-guessing a user's own purchase
 *                            record is exactly the class of harm the pin
 *                            check in soldCompsStore's own recordSoldComp
 *                            exists to prevent on the ingest side).
 *   already-parked            `identityUnverified === true` -- a row already
 *                            parked by the split-identity guard or by R70
 *                            itself has no reliable base identity to move
 *                            FROM; unparking is a different lane's job.
 *   number-is-base-number    the sale's stored cardNumber never appears on
 *                            the insert's own checklist (any normalised
 *                            variant) -- see CARD-NUMBER RULE above.
 *   no-checklist-match       the title names this insert and the number is
 *                            not the base number, but no checklist row
 *                            confirms BOTH the number and the (when known)
 *                            player together -- refuted, not unknown (the
 *                            checklist rows were already loaded in step 2;
 *                            there is no "the read failed" case here the way
 *                            insertSetChecklistConfirm.ts's live, per-sale
 *                            query has to allow for).
 *   insert-checklist-empty   the insert setKey has ZERO checklist-authority
 *                            rows in this cell -- nothing to confirm against;
 *                            counted separately from no-checklist-match so an
 *                            operator can tell "wrong number" from "the
 *                            checklist was never ingested for this cell".
 *
 * CF-A-SALE-IS-NEVER-LOST throughout: every relocation goes through
 * scripts/lib/relocate-sold-comp.cjs (upsert -> verify read-back -> delete);
 * the banner's own reconciliation is candidates found == moved + refused +
 * collapsed + failed + left (named).
 *
 * CONCURRENCY FROM THE START (per the brief: the model lane's serial
 * per-target loop over its one cross-partition query is a known defect, PR in
 * flight). This lane's per-(cell, insertKey) TARGET loop runs with bounded
 * concurrency (`CONCURRENCY`, default 6) via a small in-file pool -- each
 * target's own candidate-number sub-queries execute inside that same budget,
 * never unbounded. Every per-target write path (relocate / patch / holdings)
 * is independent of every other target's, so interleaving them changes
 * nothing about correctness, only wall clock -- verified by the
 * "concurrency>1 produces identical counters to CONCURRENCY=1" pin below.
 *
 * REPORT-FIRST. BACKFILL_APPLY=true (not APPLY) gates every write, matching
 * the runner's own env name and every sibling lane. `planInsertRekey` is
 * pure and runs identically in both modes; REPORT prints the same "would
 * move" counts a real APPLY would produce (pinned by the REPORT==APPLY
 * parity test below).
 *
 * SCOPE IS REQUIRED (sport:year cells, the runner's own `scope` input,
 * rekey-catalog-id-to-setkey's convention). TITLES/SET_KEYS IS REQUIRED and
 * names one or more REGISTERED INSERT setKeys -- empty or a wildcard ('all',
 * '*') is refused (exit 2): this lane rewrites the id segment itself, so
 * "every insert" is a whole-source write that needs its own name.
 *
 * NO NEW WORKFLOW INPUT. `titles` (BCP_TITLES) carries the insert setKey
 * list, exactly the convention repoint-sales-to-checklist-numbered.cjs and
 * rekey-catalog-id-to-setkey.cjs already use it for.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true / APPLY=true to write;
 *      SCOPE required (sport:year cells, comma list); SET_KEYS required
 *      (comma list of REGISTERED INSERT setKeys, no 'all'/'*');
 *      SLOT/SLOTS (sha1(id) shards, opt-in via SHARD=true for slot 0);
 *      CONCURRENCY=6; RUN_MINUTES=110; LIMIT=0.
 * Requires dist/ (insertSetTitleReader, productSetKeys, catalogAuthority,
 * splitIdentityWriteGuard, hobbyIqCardId, playerIdentityKey).
 */
"use strict";
const path = require("path");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 6));
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "repoint-stored-insert-sales" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── THE SCOPE. sport:year cells; an inherited default is REFUSED ────────────
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^[a-z][a-z0-9-]*:\d{4}$/;
const SCOPE_CELLS = RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));

// ── THE TARGET INSERT SETKEYS. Riding the runner's `titles` input (SET_KEYS/
// BCP_TITLES), the same convention repoint-sales-to-checklist-numbered.cjs
// and rekey-catalog-id-to-setkey.cjs already use it for. Empty or a wildcard
// is refused -- a whole-source write needs its own name.
const WILDCARDS = new Set(["", "all", "*"]);
const RAW_SET_KEYS = csv(process.env.SET_KEYS || process.env.BCP_TITLES).map(lower);
const SET_KEYS = RAW_SET_KEYS.filter((k) => !WILDCARDS.has(k));

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

async function forEachPage(container, spec, onPage, pageSize = 1000) {
  let token;
  do {
    const page = await retry(() => container.items
      .query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext());
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

/** A tiny bounded-concurrency pool -- CONCURRENCY workers pull from `items`
 *  and run `worker` on each; the model lane's own header names its serial
 *  per-target loop as the known defect this lane must not repeat. Each
 *  target's own writes are independent of every other's (a different sale
 *  set, a different destination id), so interleaving changes only wall
 *  clock, never which decision a given sale receives -- pinned by the
 *  identical-counters-under-concurrency test. */
async function runPool(items, concurrency, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) || 0 }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** Result cap for a per-number sold_comps candidate query -- generous
 *  headroom (a single card number's sale volume across one product-year,
 *  even a flagship, is a few hundred at most); a hit answers by STOPPING
 *  this number's scan and counting it, never by silently truncating what
 *  the banner reports as "found". */
const CANDIDATE_PAGE_SIZE = 500;

/**
 * LOCAL leading-zero fold, over `cardNumberVariants`'s own (unchanged)
 * output -- the SAME fold insertSetChecklistConfirm.ts applies, for the SAME
 * reason (hobbyIqCardId.service.ts, its home, is a declared derivation-stamp
 * input; this lane may only ever widen a comparison over its existing output,
 * never edit the shared helper). "BD005" gains "BD5"/"BD-5"; a bare "005"
 * gains "5". Never strips a run to nothing ("000" keeps "0").
 */
function withLeadingZeroFold(variants) {
  const out = new Set(variants);
  for (const v of variants) {
    const m = /^([A-Za-z]*)-?(0+\d+)$/.exec(v);
    if (!m) continue;
    const [, prefix, digits] = m;
    const stripped = digits.replace(/^0+(?=\d)/, "");
    if (!stripped || stripped === digits) continue;
    out.add(`${prefix}${stripped}`);
    out.add(`${prefix}${stripped}`.toLowerCase());
    if (prefix) {
      out.add(`${prefix}-${stripped}`);
      out.add(`${prefix}-${stripped}`.toLowerCase());
    }
  }
  return [...out];
}

const normNumber = (n) => String(n ?? "").trim().toLowerCase();

/** Multi-player catalog rows are one string with every name listed
 *  ("Eddie Murray / Cal Ripken Jr.") -- the SAME D33 shape
 *  insertSetChecklistConfirm.ts's catalogRowPlayerKeys reads. Split on the
 *  documented separators; a single-name row is a one-element list. */
function catalogRowPlayerKeys(playerIdentityKeyFn, playerName) {
  const raw = String(playerName ?? "");
  const keys = new Set();
  for (const part of raw.split(/\s*[/&]\s*/)) {
    const k = playerIdentityKeyFn(part);
    if (k) keys.add(k);
  }
  return keys;
}

function playerMatchesRow(playerIdentityKeyFn, salePlayer, rowPlayer) {
  const saleKey = playerIdentityKeyFn(salePlayer ?? "");
  if (!saleKey) return false;
  return catalogRowPlayerKeys(playerIdentityKeyFn, rowPlayer).has(saleKey);
}

/**
 * THE pure confirmation predicate -- insertSetChecklistConfirm.ts's own FIX-1
 * rule ("both known -> one row must confirm both, together"), evaluated here
 * against checklist rows ALREADY LOADED for the whole target (no per-sale
 * Cosmos read; this is the one difference from that module's shape, which
 * exists solely because that module answers per-sale, at ingest, and this
 * lane answers per-target, once, against a set it already paged).
 *
 * @param {{cardNumberVariants:(s:string)=>string[], playerIdentityKey:(s:string)=>string}} deps
 * @param {Array<{cardNumber?:string|null, playerName?:string|null}>} checklistRows
 * @param {string|null} saleCardNumber
 * @param {string|null} salePlayerName
 * @returns {"confirmed"|"refuted"} -- never "unknown": the rows are already
 *          in hand, so there is no read to fail.
 */
function confirmedAgainstLoadedChecklist(deps, checklistRows, saleCardNumber, salePlayerName) {
  const num = normNumber(saleCardNumber);
  const playerKey = deps.playerIdentityKey(salePlayerName ?? "");
  if (!num && !playerKey) return "refuted";
  const variants = num
    ? new Set(withLeadingZeroFold(deps.cardNumberVariants(saleCardNumber)).map((v) => v.toLowerCase()))
    : null;
  let matched;
  if (num && playerKey) {
    matched = checklistRows.some((r) => variants.has(normNumber(r.cardNumber)) && playerMatchesRow(deps.playerIdentityKey, salePlayerName, r.playerName));
  } else if (num) {
    matched = checklistRows.some((r) => variants.has(normNumber(r.cardNumber)));
  } else {
    matched = checklistRows.some((r) => playerMatchesRow(deps.playerIdentityKey, salePlayerName, r.playerName));
  }
  return matched ? "confirmed" : "refuted";
}

/** Every normalised card-number variant appearing on the insert's own
 *  checklist rows -- used ONLY for the "number-is-base-number" LEAVE
 *  distinction (a stored number that never appears on the insert's
 *  checklist under any variant is presumptively the BASE product's own
 *  number for that slot, not a mis-transcribed insert number). */
function checklistNumberVariantSet(deps, checklistRows) {
  const set = new Set();
  for (const r of checklistRows) {
    if (!r.cardNumber) continue;
    for (const v of withLeadingZeroFold(deps.cardNumberVariants(r.cardNumber))) set.add(v.toLowerCase());
  }
  return set;
}

const USER_SEED_SOURCES = new Set(["ebay-user-purchase", "ebay-user-sale", "manual-user-entry", "user-verified"]);

/**
 * Pure per-sale decision -- no I/O -- so REPORT and APPLY run the EXACT same
 * logic (the sibling bug this guards against: a structural zero because a
 * write-only code path decided something a report-only path never ran).
 *
 * @param {object} deps  { insertSetNamedInTitle, cardNumberVariants, playerIdentityKey, productSetKeyOf, withProductSetKey }
 * @param {object} sale  the sold_comps row as read
 * @param {object} ctx
 * @param {string} ctx.sport
 * @param {number} ctx.year
 * @param {string} ctx.baseSetKey     the base product's setKey (from productParentOf)
 * @param {string} ctx.insertSetKey   the registered insert key this target confirms against
 * @param {Array}  ctx.checklistRows  the insert's own checklist-authority rows for this cell
 * @param {Set<string>} ctx.checklistNumberVariants  every normalised number the checklist carries
 * @param {"cardId"|"hobbyiqCardId"} shape which address the candidate query found this sale by
 */
function planInsertRekey(deps, sale, shape, ctx) {
  // ── NEVER-MOVE MARKERS, checked first, before any title/checklist work ──
  if (sale.verifiedByUser === true) {
    return { action: "leave", reason: "pinned-or-verified", detail: "verifiedByUser=true -- a real user attested this exact sale to this exact card" };
  }
  if (USER_SEED_SOURCES.has(String(sale.source ?? ""))) {
    return { action: "leave", reason: "pinned-or-verified", detail: `source=${sale.source} -- a user-owned transaction already reconciled through the catalog at write time (CF-A-USER-SALE-IS-ALWAYS-RECONCILED)` };
  }
  if (sale.identityUnverified === true) {
    return { action: "leave", reason: "already-parked", detail: "identityUnverified=true -- already parked; unparking is a different lane's job" };
  }

  const insertMatches = deps.insertSetNamedInTitle({
    title: sale.title, sport: ctx.sport, year: ctx.year, setKey: ctx.baseSetKey, playerName: sale.playerName,
  });
  if (insertMatches.length === 0) {
    return { action: "leave", reason: "title-does-not-name-insert", detail: "title names no known insert of its own product" };
  }
  if (insertMatches.length > 1) {
    return {
      action: "leave", reason: "two-inserts-named",
      detail: `title names ${insertMatches.length} distinct insert sets (${insertMatches.map((m) => m.root).join(", ")}) -- never choosing between two named games`,
    };
  }
  const only = insertMatches[0];
  if (only.registeredKey !== ctx.insertSetKey) {
    // Names a DIFFERENT registered insert than the one this target confirms
    // against -- not this target's sale (it will be a candidate under its
    // own insert's target, if that key is also in scope this run).
    return { action: "leave", reason: "title-names-a-different-insert", detail: `title names "${only.root}" -> ${only.registeredKey ?? "(unregistered)"}, not ${ctx.insertSetKey}` };
  }

  const num = normNumber(sale.cardNumber);
  if (num && !ctx.checklistNumberVariants.has(num) && !withLeadingZeroFold(deps.cardNumberVariants(sale.cardNumber)).some((v) => ctx.checklistNumberVariants.has(v.toLowerCase()))) {
    return { action: "leave", reason: "number-is-base-number", detail: `stored cardNumber "${sale.cardNumber}" never appears on ${ctx.insertSetKey}'s checklist -- likely the base product's own number for this slot; a title re-read is a different pass` };
  }

  const verdict = confirmedAgainstLoadedChecklist(deps, ctx.checklistRows, sale.cardNumber, sale.playerName);
  if (verdict !== "confirmed") {
    return { action: "leave", reason: "no-checklist-match", detail: `title names ${ctx.insertSetKey} but no checklist row confirms cardNumber="${sale.cardNumber ?? ""}" playerName="${sale.playerName ?? ""}" together` };
  }

  // ── MOVE. One axis: the setKey segment, on whichever field(s) name the
  // base product. hobbyiqCardId always moves when it names the base product;
  // cardId moves TOO only when it is itself an hiq: slug naming the SAME base
  // product as hobbyiqCardId pre-move (a relocate) -- otherwise cardId is a
  // raw vendor partition key and only hobbyiqCardId is patched.
  const hiq = String(sale.hobbyiqCardId ?? "");
  const cardId = String(sale.cardId ?? "");
  const hiqIsBase = deps.productSetKeyOf(hiq) === ctx.baseSetKey;
  const cardIdIsBase = cardId.startsWith("hiq:") && deps.productSetKeyOf(cardId) === ctx.baseSetKey && cardId === hiq;
  if (!hiqIsBase && !cardIdIsBase) {
    return { action: "leave", reason: "neither-field-names-base-product", detail: `cardId=${cardId} hobbyiqCardId=${hiq} -- neither names ${ctx.baseSetKey}; not this target's row (pre-existing split, not this lane's to fix)` };
  }

  const newHiq = hiqIsBase ? deps.withProductSetKey(hiq, ctx.insertSetKey) : hiq;
  if (cardIdIsBase) {
    const newCardId = deps.withProductSetKey(cardId, ctx.insertSetKey);
    return { action: "relocate", newCardId, newHiq: newCardId };
  }
  return { action: "patch", newHiq };
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPOINT: stored insert sales sitting in a BASE product's pool follow the");
  console.log("  insert's OWN checklist-confirmed identity (CF-INGEST-KEEPS-STORED-IDENTITY repair)");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error("");
    console.error(`FATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not cells: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       A cell looks like football:2024 (sport:year).");
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("");
    console.error("FATAL: SCOPE is REQUIRED and names the cells to scan, as sport:year.");
    console.error("       There is no 'all' for this lane. Dispatch with -f scope=football:2024,football:2025");
    console.error("       (comma-separate for several cells).");
    process.exit(2);
  }
  if (!SET_KEYS.length) {
    console.error("");
    console.error("FATAL: SET_KEYS (the runner's `titles` input) is REQUIRED and names the");
    console.error("       REGISTERED INSERT setKey(s) to repair -- an empty value or a wildcard");
    console.error("       ('all', '*') is refused: a whole-source write needs its own name.");
    console.error("       Dispatch with -f titles=panini-photogenic-rookie-pix (comma-separate for several).");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { productParentOf } = require(path.join(backend, "dist/services/catalog/productSetKeys.js"));
  const { insertSetNamedInTitle } = require(path.join(backend, "dist/services/portfolioiq/insertSetTitleReader.js"));
  const { cardNumberVariants } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));
  const { productSetKeyOf, withProductSetKey } = require(path.join(backend, "dist/services/portfolioiq/splitIdentityWriteGuard.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(backend, "scripts", "lib", "relocate-sold-comp.cjs"));

  const deps = { insertSetNamedInTitle, cardNumberVariants, playerIdentityKey, productSetKeyOf, withProductSetKey };
  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");
  const portfolio = db.container("portfolio");

  // ── Resolve each target insert's base product, up front, and refuse by
  // name any insert with no registered parent -- an insert with no base
  // product is not this lane's shape (it is either a flagship's own insert
  // with no parent registered yet, or a mis-typed key).
  const targets = [];
  const rejectedNoParent = [];
  for (const insertSetKey of SET_KEYS) {
    const parent = productParentOf(insertSetKey);
    if (!parent) { rejectedNoParent.push(insertSetKey); continue; }
    targets.push({ insertSetKey, baseSetKey: parent });
  }
  if (rejectedNoParent.length) {
    console.error("");
    console.error(`FATAL: ${rejectedNoParent.length} setKey(s) have no registered PARENT in productSetKeys.ts: ${rejectedNoParent.join(", ")}`);
    console.error("       This lane repairs a registered INSERT's sales against its BASE product;");
    console.error("       a key with no parent names no base product to repair away from.");
    process.exit(2);
  }

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.join(", ")}`);
  console.log(`  target insert setKeys   ${targets.map((t) => `${t.insertSetKey} (base: ${t.baseSetKey})`).join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log(`  concurrency ${CONCURRENCY}`);
  console.log("");

  const s = {
    checklistRowsScanned: 0, insertChecklistEmpty: 0, targetsFailed: 0,
    candidateNumbers: 0, candidatesFound: 0, otherShard: 0,
    moved: 0, patched: 0, collapsedOntoResident: 0,
    leftPinnedOrVerified: 0, leftAlreadyParked: 0, leftNumberIsBaseNumber: 0,
    leftNoChecklistMatch: 0, leftTitleDoesNotNameInsert: 0, leftTwoInsertsNamed: 0,
    leftTitleNamesDifferentInsert: 0, leftNeitherFieldNamesBase: 0,
    refusedDestinationCollision: 0, failed: 0,
    holdingsRepointed: 0, holdingsWalked: 0, holdingDocsWalked: 0,
    targetsProcessed: 0,
  };
  const bySetKey = new Map();
  const moveExamples = [];
  const leaveBuckets = {
    "pinned-or-verified": [], "already-parked": [], "number-is-base-number": [],
    "no-checklist-match": [], "title-does-not-name-insert": [], "two-inserts-named": [],
    "title-names-a-different-insert": [], "neither-field-names-base-product": [],
  };
  const failures = [];
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  let stoppedAtBudget = false;

  // ── Holdings index, built ONCE -- fold-checklist-numbered-twins' own
  // shape, portfolio.holdings is a MAP: Object.entries, never JOIN.
  async function buildHoldingsIndex() {
    const index = new Map();
    let docs = 0;
    await forEachPage(portfolio, { query: "SELECT c.id, c.userId, c.holdings FROM c WHERE IS_DEFINED(c.holdings)", parameters: [] }, async (rows) => {
      for (const doc of rows) {
        docs++;
        const holdings = doc.holdings && typeof doc.holdings === "object" ? doc.holdings : null;
        if (!holdings) continue;
        for (const [hid, h] of Object.entries(holdings)) {
          s.holdingsWalked++;
          if (!h || typeof h !== "object") continue;
          for (const slug of new Set([String(h.hobbyiqCardId ?? ""), String(h.cardId ?? "")])) {
            if (!slug) continue;
            const list = index.get(slug) ?? [];
            list.push({ docId: doc.id, userId: doc.userId, holdingId: hid });
            index.set(slug, list);
          }
        }
      }
      return true;
    }, 100);
    s.holdingDocsWalked = docs;
    if (docs === 0) throw new Error("walked ZERO portfolio docs -- refusing to claim holdings are clean");
    console.log(`  holdings index: walked ${f(s.holdingsWalked)} holdings across ${f(docs)} portfolio docs; ${f(index.size)} distinct slugs held`);
    return index;
  }
  const holdingsIndex = await buildHoldingsIndex();

  async function repointHoldings(oldId, newId) {
    const hits = holdingsIndex.get(oldId);
    if (!hits || !hits.length) return;
    const byDoc = new Map();
    for (const h of hits) {
      const k = `${h.docId}|${h.userId}`;
      const e = byDoc.get(k) ?? { docId: h.docId, userId: h.userId, ids: new Set() };
      e.ids.add(h.holdingId);
      byDoc.set(k, e);
    }
    for (const { docId, userId, ids } of byDoc.values()) {
      const ops = [];
      for (const hid of ids) {
        ops.push({ op: "set", path: `/holdings/${hid}/hobbyiqCardId`, value: newId });
        ops.push({ op: "set", path: `/holdings/${hid}/cardId`, value: newId });
        ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedBy`, value: "repoint-stored-insert-sales" });
        ops.push({ op: "set", path: `/holdings/${hid}/identityResolvedAt`, value: new Date().toISOString() });
        ops.push({ op: "set", path: `/holdings/${hid}/identityRenamedFrom`, value: oldId });
      }
      if (APPLY) await retry(() => portfolio.item(docId, userId).patch(ops));
      s.holdingsRepointed += ids.size;
    }
    holdingsIndex.delete(oldId);
  }

  async function residentAt(saleId, cardId) {
    try { return (await retry(() => pool.item(saleId, cardId).read())).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }
  function isSameSale(resident, incomingAtNewAddress) {
    if (!resident) return false;
    return contentHashOf(resident) === contentHashOf(incomingAtNewAddress);
  }

  /** One (cell, target) unit: page the insert's checklist rows, find
   *  candidate sales at the base product for each distinct number, plan and
   *  (in APPLY) write each one. Independent of every other unit -- safe to
   *  run inside the concurrency pool. */
  async function processTarget(cell, target) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; return; }
    const [sport, yearStr] = cell.split(":");
    const year = Number(yearStr);
    const { insertSetKey, baseSetKey } = target;

    if (SHARD_SCOPE.SHARDED && shardOf(`${cell}|${insertSetKey}`) !== SHARD_SCOPE.SLOT) { s.otherShard++; return; }

    // ── STEP 2: the insert's own checklist-authority rows for this cell.
    const checklistRows = [];
    await forEachPage(cat, {
      query: `SELECT c.cardNumber, c.playerName, c.source FROM c
              WHERE c.sport = @sport AND (c.year = @year OR c.cardYear = @year)
                AND c.setKey = @setKey AND NOT IS_DEFINED(c.gradeTier)`,
      parameters: [
        { name: "@sport", value: sport },
        { name: "@year", value: year },
        { name: "@setKey", value: insertSetKey },
      ],
    }, async (page) => {
      for (const r of page) { s.checklistRowsScanned++; if (isChecklist(r.source)) checklistRows.push(r); }
      return true;
    });

    s.targetsProcessed++;
    if (checklistRows.length === 0) {
      s.insertChecklistEmpty++;
      return;
    }

    const numberVariants = checklistNumberVariantSet(deps, checklistRows);
    s.candidateNumbers += new Set(checklistRows.map((r) => r.cardNumber).filter(Boolean)).size;

    // ── STEP 3: candidate sales -- STARTSWITH(c.hobbyiqCardId, @prefix) over
    // the BASE PRODUCT'S OWN CELL (sport:year:baseSetKey:), the SAME query
    // shape rekey-product-setkey.cjs's own MODE=pool lane already runs
    // against sold_comps and justifies in its own header (measured
    // 2026-09-01: 43,724 rows at one product-year prefix, most of them still
    // sitting under a legacy VENDOR cardId rather than their own hiq: slug --
    // "the pool is the substance of these rulings and it is swept directly,
    // by slug prefix"). This is deliberately WIDER than repoint-sales-to-
    // checklist-numbered.cjs's own exact-equality queries (which address a
    // single already-known short id) because this lane's whole job is
    // finding sales whose STORED CARD NUMBER may be the insert's own OR the
    // base product's -- there is no number to filter by in SQL until the
    // candidates are already in hand and checked against the loaded
    // checklist, which is why the scope is a PRODUCT CELL and not a number.
    // Bounded to exactly the one (sport, year, baseSetKey) cell this target
    // names; never a whole-sport or whole-pool scan.
    const prefix = `hiq:${sport}:${year}:${baseSetKey}:`;
    const candidatesByKey = new Map();
    await forEachPage(pool, {
      query: "SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, @p)",
      parameters: [{ name: "@p", value: prefix }],
    }, async (page) => {
      for (const row of page) candidatesByKey.set(`${row.id}::${row.cardId}`, row);
      return true;
    }, CANDIDATE_PAGE_SIZE);

    {
      const ctx = { sport, year, baseSetKey, insertSetKey, checklistRows, checklistNumberVariants: numberVariants };
      for (const sale of candidatesByKey.values()) {
        if (CLOCK.outOfClock()) { stoppedAtBudget = true; return; }
        const hiqBase = productSetKeyOf(String(sale.hobbyiqCardId ?? "")) === baseSetKey;
        const cardIdBase = productSetKeyOf(String(sale.cardId ?? "")) === baseSetKey;
        if (!hiqBase && !cardIdBase) continue; // STARTSWITH false positive guard (never expected, but never trusted blind)
        s.candidatesFound++;
        if (LIMIT && (s.moved + s.patched) >= LIMIT) continue;

        let plan;
        try {
          plan = planInsertRekey(deps, sale, hiqBase ? "hobbyiqCardId" : "cardId", ctx);
        } catch (e) {
          s.failed++;
          failures.push(`  FAILED plan ${sale.id}@${sale.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
          continue;
        }

        if (plan.action === "leave") {
          const bumpMap = {
            "pinned-or-verified": "leftPinnedOrVerified", "already-parked": "leftAlreadyParked",
            "number-is-base-number": "leftNumberIsBaseNumber", "no-checklist-match": "leftNoChecklistMatch",
            "title-does-not-name-insert": "leftTitleDoesNotNameInsert", "two-inserts-named": "leftTwoInsertsNamed",
            "title-names-a-different-insert": "leftTitleNamesDifferentInsert",
            "neither-field-names-base-product": "leftNeitherFieldNamesBase",
          };
          const key = bumpMap[plan.reason];
          if (key) s[key]++;
          const bucket = leaveBuckets[plan.reason];
          if (bucket && bucket.length < 50) bucket.push(`  ${sale.id}@${sale.cardId}: ${plan.detail}`);
          continue;
        }

        try {
          if (plan.action === "relocate") {
            const oldCardId = String(sale.cardId ?? "");
            const keep = { ...stripSystem(sale), cardId: plan.newCardId, hobbyiqCardId: plan.newHiq, insertRekeyedAt: new Date().toISOString(), insertRekeyedFrom: oldCardId, insertRekeyedBy: "repoint-stored-insert-sales" };
            keep.contentHash = contentHashOf(keep);

            const resident = await residentAt(sale.id, plan.newCardId);
            if (resident) {
              if (isSameSale(resident, keep)) {
                if (APPLY) await retry(() => pool.item(sale.id, oldCardId).delete());
                s.collapsedOntoResident++;
                continue;
              }
              s.refusedDestinationCollision++;
              failures.push(`  REFUSED destination-collision ${sale.id}@${oldCardId} -> ${plan.newCardId}: a DIFFERENT sale already resides there`);
              continue;
            }

            const res = await relocateSoldComp(pool, { keep, drop: [{ id: sale.id, cardId: oldCardId }], retry, verifyFields: ["cardId", "hobbyiqCardId"], dryRun: !APPLY });
            if (!res.ok && res.stage !== "dry-run") {
              s.failed++;
              failures.push(`  FAILED relocate ${sale.id}@${oldCardId} -> ${plan.newCardId}: ${res.error ?? "unknown"}`);
              continue;
            }
            s.moved++;
            bump(bySetKey, insertSetKey);
            if (moveExamples.length < 50) moveExamples.push(`  MOVE ${JSON.stringify(sale.title ?? "")} | ${oldCardId} -> ${plan.newCardId}`);
            await repointHoldings(oldCardId, plan.newCardId);
          } else {
            // patch: hobbyiqCardId only, cardId (a vendor partition) unchanged.
            if (APPLY) {
              await retry(() => pool.item(sale.id, sale.cardId).patch([
                { op: "set", path: "/hobbyiqCardId", value: plan.newHiq },
                { op: "set", path: "/insertRekeyedFrom", value: String(sale.hobbyiqCardId ?? "") },
                { op: "set", path: "/insertRekeyedAt", value: new Date().toISOString() },
                { op: "set", path: "/insertRekeyedBy", value: "repoint-stored-insert-sales" },
              ]));
            }
            s.patched++;
            bump(bySetKey, insertSetKey);
            if (moveExamples.length < 50) moveExamples.push(`  PATCH ${JSON.stringify(sale.title ?? "")} | ${sale.cardId}: hobbyiqCardId ${sale.hobbyiqCardId} -> ${plan.newHiq}`);
            await repointHoldings(String(sale.hobbyiqCardId ?? ""), plan.newHiq);
          }
        } catch (e) {
          s.failed++;
          failures.push(`  FAILED write ${sale.id}@${sale.cardId}: ${String(e?.stack ?? e?.message ?? e)}`);
        }
      }
    }
  }

  const units = [];
  for (const cell of SCOPE_CELLS) for (const target of targets) units.push({ cell, target });
  // A persistent read failure (a query that throws every retry, a broken
  // checklist page) fails ONLY the one (cell, target) unit it happened on --
  // never the whole run. Each unit is independent (its own checklist rows,
  // its own candidate sales, its own writes), so one bad unit's exception is
  // caught, counted, and named here rather than rejecting the pool's
  // Promise.all and losing every OTHER target's already-planned work.
  await runPool(units, CONCURRENCY, async ({ cell, target }) => {
    try {
      await processTarget(cell, target);
    } catch (e) {
      s.targetsFailed++;
      failures.push(`  FAILED target ${cell}|${target.insertSetKey}: ${String(e?.stack ?? e?.message ?? e)}`);
    }
  });

  console.log("");
  console.log(`checklist rows scanned (insert targets)   ${f(s.checklistRowsScanned)}${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} targets in other shards)` : ""}`);
  console.log(`  targets processed                        ${f(s.targetsProcessed)}`);
  console.log(`  targets with an EMPTY checklist           ${f(s.insertChecklistEmpty)}   <- nothing to confirm against, not ingested for this cell`);
  console.log(`  targets FAILED (persistent read failure)  ${f(s.targetsFailed)}   <- this target's sales are untouched; every OTHER target still ran`);
  console.log(`  distinct checklist numbers scanned        ${f(s.candidateNumbers)}`);
  console.log("");
  console.log(`candidates found (title names this insert or not, all read)  ${f(s.candidatesFound)}`);
  console.log(`  ${APPLY ? "MOVED" : "WOULD MOVE"}          ${f(s.moved)}`);
  console.log(`  ${APPLY ? "PATCHED" : "WOULD PATCH"}        ${f(s.patched)}`);
  console.log(`  COLLAPSED onto a resident (same sale, by hash)  ${f(s.collapsedOntoResident)}`);
  console.log(`  REFUSED: destination collision            ${f(s.refusedDestinationCollision)}`);
  console.log(`  failed                                    ${f(s.failed)}`);
  console.log("");
  console.log(`  LEFT: title does not name this insert     ${f(s.leftTitleDoesNotNameInsert)}`);
  console.log(`  LEFT: title names a DIFFERENT insert       ${f(s.leftTitleNamesDifferentInsert)}`);
  console.log(`  LEFT: two-inserts-named                    ${f(s.leftTwoInsertsNamed)}`);
  console.log(`  LEFT: pinned-or-verified                   ${f(s.leftPinnedOrVerified)}`);
  console.log(`  LEFT: already-parked                       ${f(s.leftAlreadyParked)}`);
  console.log(`  LEFT: number-is-base-number                ${f(s.leftNumberIsBaseNumber)}`);
  console.log(`  LEFT: no-checklist-match                   ${f(s.leftNoChecklistMatch)}`);
  console.log(`  LEFT: neither field names the base product ${f(s.leftNeitherFieldNamesBase)}`);
  console.log("");
  console.log(`  holdings re-pointed        ${f(s.holdingsRepointed)}   (walked ${f(s.holdingsWalked)} holdings across ${f(s.holdingDocsWalked)} portfolio docs)`);

  if (bySetKey.size) { console.log(`\n  by insert setKey:`); for (const [k, n] of [...bySetKey.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(9)}  ${k}`); }
  if (moveExamples.length) { console.log(`\n  MOVE/PATCH examples (title | from -> to), sample of ${moveExamples.length}:`); for (const e of moveExamples) console.log(e); }
  for (const [reason, list] of Object.entries(leaveBuckets)) {
    if (list.length) { console.log(`\n  LEFT (${reason}), sample of ${f(list.length)}:`); for (const l of list) console.log(l); }
  }
  if (failures.length) { console.log(`\n  FAILURES/REFUSALS (${f(failures.length)}):`); for (const fl of failures) console.log(fl); }

  // ── CF-A-SALE-IS-NEVER-LOST reconciliation ---------------------------------
  const totalLeft = s.leftTitleDoesNotNameInsert + s.leftTitleNamesDifferentInsert + s.leftTwoInsertsNamed
    + s.leftPinnedOrVerified + s.leftAlreadyParked + s.leftNumberIsBaseNumber + s.leftNoChecklistMatch
    + s.leftNeitherFieldNamesBase;
  const written = s.moved + s.patched + s.collapsedOntoResident;
  const refused = s.refusedDestinationCollision;
  const accountedFor = written + refused + s.failed + totalLeft;
  console.log("");
  console.log(`CF-A-SALE-IS-NEVER-LOST`);
  console.log(`  candidates found            ${f(s.candidatesFound)}`);
  console.log(`  ${APPLY ? "=" : "would be ="} moved ${f(s.moved)} + patched ${f(s.patched)} + collapsed ${f(s.collapsedOntoResident)} + refused ${f(refused)} + failed ${f(s.failed)} + left ${f(totalLeft)}`);
  if (accountedFor !== s.candidatesFound) {
    console.error(`!! CF-A-SALE-IS-NEVER-LOST: accounted ${f(accountedFor)} != found ${f(s.candidatesFound)}. A sale is unaccounted for. Exit 4.`);
    process.exitCode = 4;
  } else {
    console.log(`  matched -- every candidate is moved, patched, collapsed, refused, failed, or left with a named reason.`);
  }

  if (APPLY) {
    reportWrites({
      job: "repoint-stored-insert-sales",
      intended: s.candidatesFound,
      written,
      skipped: totalLeft,
      refused,
      failed: s.failed,
    });
  }

  console.log("");
  console.log(`  ${APPLY ? "MOVED" : "WOULD MOVE"} ${f(s.moved)}   ${APPLY ? "PATCHED" : "WOULD PATCH"} ${f(s.patched)}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  if (s.failed) {
    console.error(`::error::${f(s.failed)} sale(s) failed -- see FAILURES above.`);
    process.exitCode = 4;
  }
}

module.exports = {
  planInsertRekey, confirmedAgainstLoadedChecklist, withLeadingZeroFold, checklistNumberVariantSet,
  CELL_RE, WILDCARDS, INHERITED_SCOPES, USER_SEED_SOURCES,
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); await finishLane(1, { budget: CLOCK }); });
}
