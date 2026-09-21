#!/usr/bin/env node
/**
 * repoint-sales-cardnumber-suffix.cjs -- STAMP-MOVING NOTICE: this lane does
 * NOT change any derivation source file. Nothing in parseTitleIdentity.
 * service.ts or hobbyIqCardId.service.ts is touched by this PR. It exists to
 * REALIZE an already-shipped derivation fix (2026-09-12/13,
 * CF-DASH-SUFFIX-IS-PART-OF-THE-NUMBER, commit 80482103) on STORED rows that
 * were minted before that fix landed and have never been re-derived since.
 *
 * THE INVESTIGATION (2026-09-21). The reported symptom: 1,096 sold_comps
 * rows sit at `hiq:baseball:2024:bowmans-best:b24:*` while their titles
 * carry #B24-CE, #B24-SB, #B24-CMO... -- 90 different players collapsed
 * onto ONE address. Traced to the ROOT CAUSE, with evidence:
 *
 *   1. `extractCardNumber` / `DEFAULT_CARD_NUMBER_RE`
 *      (parseTitleIdentity.service.ts:446-447) had a REAL bug -- a
 *      letters-then-digits card number ("B24") had no dash-suffix tail
 *      alternative, so "#B24-CMO" truncated to "B24" at parse time. This
 *      was FOUND AND FIXED on 2026-09-12/13 (commit 80482103,
 *      "fix(parser): a dash-suffixed card number is one token, not
 *      truncated at the digits", CF-DASH-SUFFIX-IS-PART-OF-THE-NUMBER),
 *      pinned by 7 tests in tests/parseTitleIdentity.test.ts
 *      ("a dash-suffixed card number is one token...", all green today).
 *
 *   2. TODAY'S LIVE CODE IS CORRECT. Verified 2026-09-21 by running the
 *      COMPILED dist/ parser against the real failing titles:
 *
 *        parseListingIdentity("...#B24-CMO...").cardNumber === "B24-CMO"
 *        parseListingIdentity("...#B25-AS...").cardNumber  === "B25-AS"
 *        computeHobbyIqCardId({ cardNumber: "B24-CMO", ... })
 *          === "hiq:baseball:2024:bowmans-best:b24-cmo:base:auto"
 *
 *      -- full suffix preserved, both at the parse step and at the slug
 *      step. persistVendorSalesToPool.service.ts:1165-1802 (the LIVE
 *      ingest path) feeds the SAME `parsed.cardNumber` into BOTH `cardId`
 *      and the `computeHobbyIqCardId` call that produces `hobbyiqCardId`
 *      -- there is no second, stale code path deriving `hobbyiqCardId`
 *      differently from `cardId` today.
 *
 *   3. THE 1,095 (not 1,096 -- see below) STORED ROWS ARE STALE, NOT LIVE.
 *      Every one of them carries `_ts` = 2026-08-17, nine days before the
 *      parser fix, AND every one already carries
 *      `__migratedByBackfill: "CF-BACKFILL-CARDSIGHT-TITLE-IDENTITY-20260731"`
 *      -- meaning backfill-cardsight-title-identity.cjs already ran
 *      against them, but it ran BEFORE the parser fix existed, re-derived
 *      with the SAME bug, and wrote back the SAME wrong (truncated)
 *      answer. The fix and the backfill's run order crossed in a way that
 *      left these rows permanently stale until re-run. `cardId` (minted at
 *      original ingest, also pre-fix) and `hobbyiqCardId` (rewritten by
 *      that backfill run) therefore show the SAME truncation on
 *      `hobbyiqCardId` specifically, while `cardId` in the sampled rows
 *      happened to be minted under setKey `bowman` (a DIFFERENT, unrelated
 *      pre-existing setKey misfile) with its OWN cardNumber segment intact
 *      per-row (b24-cmo, b24-bt, ...) -- confirming the truncation is a
 *      derivation-time defect, not a title-content problem.
 *
 * BLAST RADIUS (read-only, 2026-09-21, sold_comps, source=cardsight,
 * title contains '#', 20,000 rows sampled across baseball/basketball/
 * football/hockey): 385 rows carry a BARE year-coded cardNumber segment
 * matching /^(b2[3-9]|bdc|bcp|f\d{1,3})$/ (no hyphen tail); of those, 381
 * are a SUFFIX-RESTORING correction on re-parse (the stored segment is a
 * strict, hyphen-bounded prefix of the freshly-parsed one) --
 *
 *     b25   286   (2025 Bowman's Best "Best of 2025 Autographs")
 *     b24    68   (2024 Bowman's Best -- the reported case)
 *     f15    16   (2025 Topps Chrome Update "Fortune 15" insert)
 *     b23    11   (2023 Bowman's Best)
 *
 * OTHER YEAR-CODED PREFIXES, MEASURED, UNAFFECTED. B25-/B23-/BDC-/BCP-
 * (when the vendor title states the suffix at all) and the digit-led
 * T-suffix shapes (87T-6, 91T-15A, 86T-11B) all parse WHOLE on today's
 * live code -- tested directly, zero truncation. The 4 remaining
 * "other-change" rows sampled during the sweep (cpa-eha->bcp-102 sibling
 * overrides, bdc-31 vs bd31 hyphen folds) are a DIFFERENT, unrelated
 * defect shape (CF-SIBLING-CHECKLIST-DECIDES-THE-PRODUCT / hyphen-fold
 * variance) and are explicitly OUT OF SCOPE for this lane -- it moves a
 * row ONLY when the correction is a strict hyphen-bounded suffix restore,
 * never any other kind of identity change.
 *
 * WHY THIS IS A REPOINT LANE, NOT A DERIVATION PATCH. There is no bug left
 * to patch in the two named service files -- patching something that
 * already works would be exactly the kind of unverified, invented change
 * CLAUDE.md's "verify before commit" / "verify output not existence"
 * rules exist to prevent. What remains is REALIZING the already-shipped
 * fix on stored rows, the same documented pattern as
 * repoint-sales-to-checklist-numbered.cjs and repoint-sales-parallel-
 * suffix.cjs: an ingest-time fix has zero effect on a row already sitting
 * in sold_comps before it landed.
 *
 * THE RULE. For a sale in scope (SCOPE cells, `titles` setKeys):
 *   1. re-parse the sale's own TITLE with the LIVE (fixed) parser
 *      (parseListingIdentity, from dist/, never a second parser);
 *   2. let OLD = the sale's own cardId/hobbyiqCardId cardNumber segment,
 *      NEW = slugify(parsed.cardNumber);
 *   3. MOVE only when NEW is a STRICT, hyphen-bounded suffix extension of
 *      OLD (`OLD + "-" + something === NEW`) -- never any other kind of
 *      change (a different card number entirely, a parallel change, a
 *      setKey change) is in scope for this lane;
 *   4. the full identity (setKey, parallel, isAuto, printRun) is
 *      RE-DERIVED from the same title via the SAME live
 *      computeHobbyIqCardId path production ingest uses, so the new
 *      address is exactly what a fresh ingest of this title would produce
 *      today -- never a hand-patched cardNumber segment glued onto the
 *      old address;
 *   5. title-contradiction / player-mismatch guards reuse the sibling
 *      lanes' own doctrine (absent beats wrong).
 *
 * SCOPE IS REQUIRED (sport:year cells) and `titles` (SET_KEYS) is REQUIRED
 * -- no 'all'/'*', same convention as every sibling repoint lane: a
 * whole-source write needs its own name.
 *
 * REPORT-FIRST. BACKFILL_APPLY=true (not APPLY) gates every write.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true to write; SCOPE
 *      required; SET_KEYS required; SLOT/SLOTS; CONCURRENCY=8;
 *      RUN_MINUTES=110; LIMIT=0.
 * Requires dist/ (parseTitleIdentity, hobbyIqCardId, catalogAuthority,
 * writeReconciliation).
 */
"use strict";
const path = require("path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const CONCURRENCY = Math.min(32, Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8)));
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "repoint-sales-cardnumber-suffix" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^[a-z][a-z0-9-]*:\d{4}$/;
const SCOPE_CELLS = RAW_SCOPE.map(lower).filter((p) => CELL_RE.test(p));
const SCOPE_REJECTED = RAW_SCOPE.filter((p) => !CELL_RE.test(lower(p)));

const WILDCARDS = new Set(["", "all", "*"]);
const RAW_SET_KEYS = csv(process.env.SET_KEYS || process.env.BCP_TITLES).map(lower);
const SET_KEYS = RAW_SET_KEYS.filter((k) => !WILDCARDS.has(k));

/** A sale's cardNumber slug segment is a STRICT, hyphen-bounded prefix of
 *  the freshly-parsed one -- "b24" -> "b24-cmo", never "b24" -> "b24x" or
 *  any other kind of change. Both sides already slugified. */
function isSuffixRestore(oldSeg, newSeg) {
  if (!oldSeg || !newSeg || oldSeg === newSeg) return false;
  return newSeg.startsWith(`${oldSeg}-`);
}

function cardNumberSegmentOf(id) {
  const parts = String(id ?? "").split(":");
  if (parts.length < 7 || parts[0] !== "hiq") return null;
  return parts[4];
}

async function forEachPage(container, spec, onPage, pageSize = 500) {
  let token;
  do {
    const page = await container.items.query(spec, { maxItemCount: pageSize, continuationToken: token }).fetchNext();
    token = page.continuationToken;
    if ((await onPage(page.resources ?? [])) === false) return;
  } while (token);
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPOINT: a stored sale's cardNumber suffix, restored from its own title");
  console.log("  (realizes the 2026-09-12/13 parser fix on rows minted before it landed)");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error(`\nFATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not cells: ${SCOPE_REJECTED.join(", ")}`);
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("\nFATAL: SCOPE is REQUIRED and names the cells to scan, as sport:year.");
    process.exit(2);
  }
  if (!SET_KEYS.length) {
    console.error("\nFATAL: SET_KEYS (the runner's `titles` input) is REQUIRED -- an empty value");
    console.error("       or a wildcard ('all', '*') is refused: a whole-source write needs its own name.");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { parseListingIdentity } = require(path.join(backend, "dist/services/portfolioiq/parseTitleIdentity.service.js"));
  const { computeHobbyIqCardId, slugify } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { playerIdentityKey } = require(path.join(backend, "dist/services/catalog/playerIdentityKey.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";

  /** Does the sale's own player match the destination catalog row's player?
   *  Absence on either side is NOT a match -- absent beats wrong, mirrors
   *  repoint-sales-parallel-suffix.cjs's own playerMatches verbatim. */
  function playerMatches(salePlayerName, targetPlayerName) {
    const saleKey = playerIdentityKey(salePlayerName);
    if (!saleKey || !targetPlayerName) return false;
    const targetNames = String(targetPlayerName).split(/\s*[/&]\s*/).map((n) => playerIdentityKey(n)).filter(Boolean);
    return targetNames.includes(saleKey);
  }

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.join(", ")}`);
  console.log(`  target setKeys   ${SET_KEYS.join(", ")}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  const s = {
    scanned: 0, otherShard: 0, candidates: 0,
    relocated: 0, collapsedOntoResident: 0,
    refusedNotSuffixRestore: 0, refusedUnparsed: 0, refusedEtagChanged: 0,
    refusedDestinationNotOnChecklist: 0, refusedDifferentPlayer: 0,
    refusedPinnedOrFlagged: 0, refusedPossibleTwinAtDestination: 0,
    failed: 0, notReached: 0,
  };
  let stoppedAtBudget = false;
  let planned = 0;
  const refusals = {
    "destination-not-on-checklist": [], "different-player": [],
    "pinned-or-flagged": [], "possible-twin-at-destination": [],
  };

  // PLAN_OUT -- one NDJSON record per in-scope sale, same auditability
  // doctrine as repoint-sales-parallel-suffix.cjs's own PLAN_OUT (fixed path
  // the runner sets, guarded on script name, never a new workflow input).
  const PLAN_OUT = str(process.env.PLAN_OUT);
  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, `plan-slot-${SHARD_SCOPE.SLOT}.ndjson`);
      planFd = fs.openSync(planPath, "w");
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
      planFd = null;
    }
  }
  function emitPlanRow(sale, action, reason, extra = {}) {
    if (!planFd) return;
    const record = {
      action, reason,
      id: sale?.id ?? null, source: sale?.source ?? null, title: sale?.title ?? null,
      cardId: sale?.cardId ?? null, hobbyiqCardId: sale?.hobbyiqCardId ?? null,
      fromCardNumber: extra.fromCardNumber ?? null, toCardNumber: extra.toCardNumber ?? null,
      target: extra.target ?? null,
    };
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed for ${sale?.id}: ${e?.message}`); }
  }

  async function residentAt(saleId, cardId) {
    try { return (await pool.item(saleId, cardId).read()).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }

  async function catalogRowAt(id) {
    try { return (await cat.item(id, id).read()).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }

  async function processSale(sale) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; s.notReached++; return; }
    s.scanned++;
    const currentId = String(sale.hobbyiqCardId || sale.cardId || "");
    const oldSeg = cardNumberSegmentOf(currentId);
    if (!oldSeg) { s.refusedUnparsed++; return; }
    // Only ever act on the BARE year-coded shape this defect actually
    // produces -- never a general re-derivation of every sale's identity.
    if (!/^(b2[3-9]|bdc|bcp|f\d{1,3})$/.test(oldSeg)) return;

    // Never touch a parked/flagged/excluded/verified/user-seeded row --
    // the shared relocate lib does NOT enforce this ("a parked row still
    // MOVES"), so this lane must, same doctrine as repoint-sales-parallel-
    // suffix.cjs's own guard.
    if (sale.verifiedByUser === true || sale.flaggedWrong === true || sale.excludedFromFmv === true || sale.identityUnverified === true) {
      s.refusedPinnedOrFlagged++;
      refusals["pinned-or-flagged"].push(`  ${sale.id}@${currentId}: parked/flagged/verified/excluded row -- never touched by this lane`);
      emitPlanRow(sale, "refused", "pinned-or-flagged", { fromCardNumber: oldSeg });
      return;
    }

    const parsed = parseListingIdentity(String(sale.title || ""));
    if (!parsed.cardNumber) { s.refusedUnparsed++; return; }
    const newSeg = slugify(String(parsed.cardNumber));
    if (!isSuffixRestore(oldSeg, newSeg)) { s.refusedNotSuffixRestore++; return; }
    s.candidates++;

    const parts = currentId.split(":");
    const setKey = parts[3];
    let newId;
    try {
      newId = computeHobbyIqCardId({
        sport: sale.sport, year: sale.cardYear ?? sale.year,
        setKey,
        cardNumber: parsed.cardNumber,
        parallel: parsed.parallel ?? sale.parallel ?? "Base",
        isAuto: Boolean(parsed.isAuto ?? sale.isAuto),
        printRun: parsed.printRun ?? null,
      });
    } catch {
      s.refusedUnparsed++;
      return;
    }
    // The strict-suffix-restore predicate above already proves this is the
    // SAME correction shape as the reported defect -- but the re-derivation
    // is the FULL live identity, so a rerun must still land on a NEW id
    // whose own cardNumber segment is the suffix-restored one (belt and
    // suspenders against a parallel/isAuto re-derivation quietly changing
    // the target to something this lane never claimed to fix).
    const newSegOfResult = cardNumberSegmentOf(newId);
    if (!isSuffixRestore(oldSeg, newSegOfResult || "")) { s.refusedNotSuffixRestore++; return; }

    // ── THE DESTINATION MUST BE A STRICT CHECKLIST ROW, PLAYER-MATCHED.
    // Mirrors repoint-sales-parallel-suffix.cjs (~L939-972): this lane never
    // moves a sale onto an address unless the catalog itself attests that
    // card at that address, and the row's own player agrees with the
    // sale's -- absent beats wrong, never a guess from the title alone.
    let destRow;
    try {
      destRow = await catalogRowAt(newId);
    } catch (e) {
      s.failed++;
      console.log(`\n::warning::catalog read failed for ${sale.id} -> ${newId}: ${e?.message || e}`);
      return;
    }
    if (!destRow || !isChecklist(destRow.source)) {
      s.refusedDestinationNotOnChecklist++;
      refusals["destination-not-on-checklist"].push(`  ${sale.id}@${currentId} -> ${newId}: no STRICT checklist row at the destination -- refused, never minted from a sale`);
      emitPlanRow(sale, "refused", "destination-not-on-checklist", { fromCardNumber: oldSeg, toCardNumber: newSeg, target: newId });
      return;
    }
    if (!playerMatches(sale.playerName, destRow.playerName)) {
      s.refusedDifferentPlayer++;
      refusals["different-player"].push(`  ${sale.id}@${currentId} -> ${newId}: sale player "${sale.playerName ?? ""}" does not match checklist player "${destRow.playerName ?? ""}" -- refused`);
      emitPlanRow(sale, "refused", "different-player", { fromCardNumber: oldSeg, toCardNumber: newSeg, target: newId });
      return;
    }

    planned++;

    // Collision / twin detection runs in BOTH modes -- a REPORT must show
    // what would happen, not stop short and claim a bare "would relocate"
    // for a move that would actually collide. Mirrors repoint-sales-
    // parallel-suffix.cjs, which checks `residentAt` unconditionally and
    // only gates the WRITE itself on `dryRun: !APPLY` inside relocateSoldComp.
    const resident = await residentAt(sale.id, newId);
    if (resident) {
      // POSSIBLE-TWIN-AT-DESTINATION: a doc already sits at (this sale's id,
      // newId). Only a byte-identical twin (the SAME sale, already moved) is
      // safe to collapse onto; any other resident is a DIFFERENT document
      // that happens to share this sale's id, and moving over it would
      // silently erase it -- refused, never overwritten.
      if (contentHashOf(resident) === contentHashOf({ ...sale, cardId: newId, hobbyiqCardId: newId })) {
        s.collapsedOntoResident++;
        if (APPLY) { try { await pool.item(sale.id, sale.cardId).delete(); } catch { /* best effort; the sale is a proven duplicate either way */ } }
        emitPlanRow(sale, "collapse", "same-sale-resident", { fromCardNumber: oldSeg, toCardNumber: newSeg, target: newId });
        return;
      }
      s.refusedPossibleTwinAtDestination++;
      refusals["possible-twin-at-destination"].push(`  ${sale.id}@${currentId} -> ${newId}: a DIFFERENT document already resides at (${sale.id}, ${newId}) -- refused, neither moved`);
      emitPlanRow(sale, "refused", "possible-twin-at-destination", { fromCardNumber: oldSeg, toCardNumber: newSeg, target: newId });
      return;
    }

    try {
      const keep = stripSystem({ ...sale, cardId: newId, hobbyiqCardId: newId, cardNumber: parsed.cardNumber });
      const result = await relocateSoldComp(pool, {
        keep, drop: [{ id: sale.id, cardId: sale.cardId }],
        verifyFields: ["cardId", "hobbyiqCardId", "cardNumber"],
        dryRun: !APPLY,
      });
      if (result?.ok) {
        s.relocated++;
        emitPlanRow(sale, "relocate", "cardnumber-suffix-restore", { fromCardNumber: oldSeg, toCardNumber: newSeg, target: newId });
      } else if (result?.staleSincePlan?.length) {
        s.refusedEtagChanged++;
        emitPlanRow(sale, "refused", "stale-since-plan", { fromCardNumber: oldSeg, toCardNumber: newSeg, target: newId });
      } else {
        s.failed++;
      }
    } catch (e) {
      s.failed++;
      console.log(`\n::warning::relocate failed for ${sale.id}: ${e?.message || e}`);
    }
  }

  async function runPool(items, worker) {
    let idx = 0;
    const runner = async () => { while (idx < items.length) { const my = idx++; await worker(items[my]); } };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(items.length, 1)) }, runner));
  }

  for (const cell of SCOPE_CELLS) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    const [sport, yearStr] = cell.split(":");
    for (const setKey of SET_KEYS) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const prefix = `hiq:${sport}:${yearStr}:${setKey}:`;
      const rows = [];
      await forEachPage(pool, {
        query: "SELECT * FROM c WHERE STARTSWITH(c.cardId, @prefix) OR STARTSWITH(c.hobbyiqCardId, @prefix)",
        parameters: [{ name: "@prefix", value: prefix }],
      }, async (page) => {
        for (const r of page) {
          if (SHARD_SCOPE.SHARDED && shardOf(String(r.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; continue; }
          rows.push(r);
        }
        if (LIMIT > 0 && rows.length >= LIMIT) return false;
        return true;
      });
      await runPool(rows, processSale);
    }
  }

  console.log("");
  for (const [reason, lines] of Object.entries(refusals)) {
    if (!lines.length) continue;
    console.log(`\n  REFUSED (${reason}), up to 20 shown:`);
    for (const line of lines.slice(0, 20)) console.log(line);
  }

  console.log("");
  console.log(`sales scanned                          ${f(s.scanned)}${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} in other shards)` : ""}`);
  console.log(`  candidates (bare year-coded shape)    ${f(s.candidates)}`);
  console.log(`  ${APPLY ? "RELOCATED" : "WOULD RELOCATE"}                     ${f(s.relocated)}`);
  console.log(`  COLLAPSED onto a resident (same sale)  ${f(s.collapsedOntoResident)}`);
  console.log(`  REFUSED: not a suffix restore           ${f(s.refusedNotSuffixRestore)}`);
  console.log(`  REFUSED: unparsed / no cardNumber       ${f(s.refusedUnparsed)}`);
  console.log(`  REFUSED: pinned/flagged/verified/excl.  ${f(s.refusedPinnedOrFlagged)}`);
  console.log(`  REFUSED: destination-not-on-checklist   ${f(s.refusedDestinationNotOnChecklist)}`);
  console.log(`  REFUSED: different-player               ${f(s.refusedDifferentPlayer)}`);
  console.log(`  REFUSED: possible-twin-at-destination   ${f(s.refusedPossibleTwinAtDestination)}`);
  console.log(`  REFUSED: stale since the read            ${f(s.refusedEtagChanged)}`);
  console.log(`  failed                                  ${f(s.failed)}`);
  console.log(`  not reached (budget)                     ${f(s.notReached)}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  // RECONCILE. Every candidate this lane's suffix-restore predicate found is
  // moved, collapsed onto a proven duplicate, refused (named), failed, or
  // not reached before the budget -- never silently dropped.
  const candidateOutcomes = s.relocated + s.collapsedOntoResident
    + s.refusedDestinationNotOnChecklist + s.refusedDifferentPlayer
    + s.refusedPossibleTwinAtDestination + s.refusedEtagChanged
    + s.failed + s.notReached;
  console.log(`\n  reconciled: candidates ${f(s.candidates)} = accounted-for ${f(candidateOutcomes)}`);
  if (candidateOutcomes !== s.candidates) {
    console.error("  !! RECONCILE MISMATCH -- a candidate was neither moved, collapsed, refused, failed nor left unreached");
    process.exitCode = 4;
  }

  reportWrites({
    job: "repoint-sales-cardnumber-suffix",
    intended: planned, written: s.relocated,
    skipped: s.candidates - s.relocated - s.failed, failed: s.failed,
  });

  if (s.failed) { console.error(`::error::${f(s.failed)} sale(s) failed.`); process.exitCode = 4; }
}

module.exports = { isSuffixRestore, cardNumberSegmentOf, INHERITED_SCOPES, WILDCARDS, CELL_RE };

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); finishLane(1, { budget: CLOCK }); });
}
