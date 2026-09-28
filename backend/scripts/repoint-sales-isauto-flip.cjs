#!/usr/bin/env node
/**
 * repoint-sales-isauto-flip.cjs -- the checklist's card-number section
 * decides isAuto, never the title. Repoint a sold_comps sale whose EXACT
 * hobbyiqCardId has NO checklist-grade card_catalog row, but whose
 * isAuto-FLIPPED id (same sport/year/setKey/cardNumber/parallel/printRun,
 * `auto` <-> `no-auto`) DOES have one.
 *
 * MOTIVATION (live trace, C:/tmp/bb25_trace_1530/RESULT.md, 2026-09-26).
 * 2025 Bowman's Best (baseball), base-parallel, unnumbered: of 23,383 sales,
 * 5,121 (21.9%) are backed ONLY at the OTHER isAuto value -- same
 * sport/year/setKey/cardNumber/parallel/printRun, wrong `auto`/`no-auto`
 * segment. `feedback_isauto_boundary_is_cardnumber_not_text.md`: isAuto is a
 * property of WHICH CARD-NUMBER SECTION the checklist filed the card under,
 * never a property of what the sale's title happened to say -- so when the
 * checklist attests exactly one of the two isAuto values for an otherwise
 * identical identity, that checklist row is the truth and the sale's id is
 * wrong. Owner Drew, 2026-09-26: "Let's get these done FAST."
 *
 * THE RULE, per in-scope sale:
 *   1. sport/year/setKey named by SCOPE (`sport:year`, REQUIRED, no default
 *      -- this lane has no whole-corpus mode, same convention as every
 *      sibling repoint lane); `titles` (SET_KEYS) OPTIONALLY narrows to one
 *      or more setKeys within that scope -- empty means every setKey found
 *      under the scope's own STARTSWITH prefix;
 *   2. the sale's OWN hobbyiqCardId/cardId (grade-aware -- a graded sale
 *      flips the same way, the grade tail is carried through verbatim) is
 *      the CURRENT id; the FLIPPED id is the same PARENT id with ONLY the
 *      `auto`/`no-auto` segment swapped -- sport, year, setKey, cardNumber,
 *      parallel, printRun and any subset segment are all byte-for-byte
 *      unchanged;
 *   3. the CURRENT id's own card_catalog row must be ABSENT, or present but
 *      NOT checklist-grade (catalogAuthorityOf(source) !== "checklist") --
 *      a sale already backed by its own checklist row has nothing to fix;
 *   4. the FLIPPED id's card_catalog row must be PRESENT and checklist-grade
 *      -- never a DERIVED or VENDOR row (those never adjudicate identity,
 *      CF-CATALOG-AUTHORITY);
 *   5. BOTH checklist-grade is a REFUSAL, never a move: if the current id
 *      ALSO carries a checklist row, moving would erase an attested card in
 *      favor of a guess about which one the sale actually was -- ambiguous,
 *      logged, left exactly where it is.
 *
 *      R-0927D SCOPED OVERRIDE (Drew, 2026-09-27 ~02:50Z; DRAFT PR #2453,
 *      C:/tmp/unsigned_1949/RESULT.md -- 22 (setKey, prefix, year) groups /
 *      3,265 pairs in baseball, e.g. bowman-chrome CPA- 2024 1,863 pairs).
 *      For AUTOGRAPH-ONLY inserts, a checklist-grade row at the `:no-auto`
 *      id is a MINTING ERROR -- the checklistinsider layout (and its listed
 *      siblings) mints autos unsigned. Consulted ONLY when the run is armed
 *      (`titles` carries the `auto-only-override` sentinel -- see below) and
 *      turns this refusal into a MOVE, no-auto -> auto, ONLY when the gate
 *      module (lib/auto-only-override.cjs, `autoOnlyOverride()`) finds ALL
 *      FOUR conditions true: (1) direction is no-auto->auto, never reversed;
 *      (2) the cardNumber prefix is registered auto-only for this (sport,
 *      year, setKey) -- the shared AUTO_ONLY_CARDNUMBER_PREFIX/
 *      isScopedAutoOnlyPrefix vocabulary, OR the :auto row's own category
 *      says autograph; (3) the :no-auto row's OWN source is one the census
 *      identified as the unsigned-minting layout (a data-driven allowlist,
 *      backend/data/auto-only-override-defective-sources.json -- NOT hard-
 *      coded); (4) namesAgree(sale.playerName, autoRow.playerName). Any miss
 *      falls through to the SAME unconditional refusal as before, recorded
 *      by the SAME `refusedChecklistAtBoth` counter. A successful override
 *      move is recorded by its OWN counter, `movedByAutoOnlyOverride`,
 *      NEVER folded into `repointed` -- so the everyday-refused population
 *      stays legible.
 *
 *      SENTINEL, NO NEW WORKFLOW INPUT. The literal token
 *      `auto-only-override`, anywhere in `titles` (SET_KEYS/BCP_TITLES),
 *      arms the gate for this run and is stripped from the setKey filter
 *      before use -- it is never itself a setKey. Dispatch e.g.
 *      `titles="auto-only-override"` (every setKey in SCOPE) or
 *      `titles="auto-only-override,bowman-chrome"` (armed + narrowed).
 *      Default (sentinel absent) is UNCHANGED from before this override
 *      existed: checklist-at-both refuses unconditionally.
 *   6. REPORT (apply=false) runs every guard APPLY runs and prints intended
 *      moves fromId->toId with up to 10 examples per setKey, writing
 *      nothing; APPLY calls relocateSoldComp (the ONE sanctioned mover --
 *      create-at-new + verify + delete-old), rewriting hobbyiqCardId and
 *      cardId ONLY -- no rekeyedFrom[] ledger field on the moved document
 *      itself, matching repoint-sales-tiffany-title-gated.cjs exactly (the
 *      audit trail is the PLAN_OUT ndjson, not a stamp on the row).
 *
 * PER-SETKEY COUNTS (report-lane incident: REPORT must run every guard APPLY
 * runs). Printed per setKey: candidates, repointed (or would-repoint),
 * refused-no-checklist-at-flip (the flip has no checklist row either -- not
 * this lane's defect to fix), refused-checklist-at-both (ambiguous -- NEVER
 * moved, logged by cardNumber), refused-graded-parse (the id does not parse,
 * grade-aware or otherwise).
 *
 * RECONCILE: candidates = repointed + movedByAutoOnlyOverride +
 * collapsedOntoResident + refusedNoChecklistAtFlip + refusedChecklistAtBoth +
 * refusedPossibleTwinAtDestination + refusedEtagChanged + failed.
 * Exits non-zero when the counters do not add up.
 * `movedByAutoOnlyOverride` is drawn from the SAME `candidates` population as
 * every other outcome (a checklist-at-both row was already a candidate
 * before the R-0927d gate ever runs), so -- unlike `refusedGradedParse` and
 * `notReached` below -- it belongs in this formula and must never be
 * excluded from it.
 *
 * `refusedGradedParse` and `notReached` are BOTH DELIBERATELY NOT part of
 * this formula, and DELIBERATELY NOT folded into the `refused`/`skipped`
 * counts reportWrites() sees as anything but their own named bucket: a row
 * whose id (grade-aware) does not parse at all never becomes a candidate
 * (`candidates` only increments after `flippedId()` succeeds), and a row the
 * budget stops before `processSale` classifies it never reaches that same
 * line either (the budget check is the FIRST thing `processSale` does, atop
 * of `s.candidates++`). Both are counted against `scanned`, reported on
 * their own line, and left out of the candidate reconciliation -- folding
 * either into it would count it against a population it was never drawn
 * from, producing a false RECONCILE MISMATCH / reportWrites over-account:
 * `refusedGradedParse` on any real run that meets even one malformed id
 * alongside a real outcome, and `notReached` (R-0927f, 2026-09-27: run
 * 36301171656) on ANY run the budget stops mid-scan -- not rare at all,
 * since every whole-sport-year scan over 100k+ rows routinely hits its own
 * budget, and that run exited 4 on a REPORT that had done nothing wrong.
 *
 * SCAN SHAPE. Point reads only for the destination check (item(id,
 * pk=/cardId)); the source scan is paginated {maxItemCount:500,
 * maxDegreeOfParallelism:-1} with `while(hasMoreResults())`, selecting by
 * `STARTSWITH(c.hobbyiqCardId, 'hiq:<sport>:<year>:<setKey>:')` -- sold_comps
 * CardHedge rows have no usable top-level sport/year fields, so this lane
 * never filters on them. Never cross-partition COUNT/GROUP BY. sold_comps
 * ids are unique only within a partition, so every read/delete is scoped by
 * (id, cardId).
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true (or APPLY=true) to
 *      write; SCOPE required (sport:year, one or more comma-separated
 *      cells); SET_KEYS / BCP_TITLES (the runner's `titles` input) optional,
 *      comma-separated setKey filter; SLOT/SLOTS; CONCURRENCY=8;
 *      RUN_MINUTES=110; LIMIT=0; PLAN_OUT.
 * Requires dist/ (hobbyIqCardId, catalogAuthority, writeReconciliation).
 *
 * R-0927e BACKOFF + HONEST EXIT (Drew, 2026-09-27, incident: run 36297136135,
 * SCOPE baseball:2026, APPLY -- gh run view 36297136135 --log,
 * C:/tmp/isauto-0926-runs.txt 05:26Z-06:2xZ entries).
 *
 * DEFECT 1: a Cosmos 429 inside a per-candidate `catalogRowAt()` point read
 * (`cat.item(id, id).read()`, no retry at all) outlived the @azure/cosmos
 * SDK's own internal retry budget and threw all the way out of `main()`
 * after 3,244 verified moves had already landed -- read-back afterwards
 * (11/11 sampled move rows) proved the writes DID land; only the SCAN died.
 * Fixed by wrapping every Cosmos call this lane makes (the two `catalogRowAt`
 * point reads, the `residentAt` point read, the source scan's `fetchNext`,
 * and -- via relocate-sold-comp.cjs's own new default -- the mover's
 * upsert/read-back/delete) in `withBackoff` (lib/cosmos-backoff.cjs):
 * bounded exponential backoff + jitter, honouring the server's own
 * `retryAfterInMs`, logging one `[backoff] ... 429 attempt k/N` line per
 * retry, rethrowing (labeled) after the budget exhausts. This does not
 * change what a move IS: create -> read-back -> delete, unchanged; a delete
 * whose OWN retries exhaust after a successful create+verify still leaves a
 * `duplicatesLeft` row -- a proven duplicate, never a lost sale.
 *
 * DEFECT 2: the workflow's own relaunch preamble
 * (`R=$(grep -aoE "(REPOINTED|WOULD REPOINT) +[0-9,]+" ...)`) reads the LAST
 * such banner line in the teed log -- and prints `repointed=0` when the
 * process died before ever reaching that banner, which reads as "zero writes
 * happened" when in fact 3,244 had. Fixed on both sides: this script now
 * writes its own counters to a small JSON ledger
 * (`<PLAN_OUT>/repoint-sales-isauto-flip-counters.json`,
 * or the OS temp dir when PLAN_OUT is unset) on EVERY exit path
 * (`process.on("exit")`, both the success path and an uncaught throw), and
 * the workflow's `preamble` for this lane (backfill-runner.yml, this lane's
 * own block only -- relaunch-on-marker/action.yml is untouched) now reads
 * that file instead of grepping a banner line, printing
 * `ABNORMAL EXIT after <n> confirmed writes -- see plan ledger` when the
 * ledger's own `abnormalExit` flag is set, rather than defaulting to 0.
 *
 * DEFECT 3 (bounded concurrency guard, no new input): if 429s exceed
 * THROTTLE_TRIP_AT (20) within THROTTLE_WINDOW_MS (60s), in-flight
 * concurrency is halved for the REST of the run (one-way per halving, can
 * halve more than once if pressure continues) and the drop is logged --
 * mirrors resolve-disagreeing-sale-twins.cjs's own one-way throttle-drop
 * shape, generalised to a sliding window instead of a lifetime count so a
 * long multi-hour scan does not trip on total throttles alone.
 */
"use strict";
const path = require("path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));
const { recordDeleteOrThrow, isLedgerWriteFailure } = require(path.join(__dirname, "lib", "delete-ledger.cjs"));
const { parseSlugWithGrade } = require(path.join(__dirname, "lib", "graded-id.cjs"));
const { autoOnlyOverride, autoOnlyOverrideDisabledReason } = require(path.join(__dirname, "lib", "auto-only-override.cjs"));
const { namesAgree } = require(path.join(__dirname, "lib", "name-agreement.cjs"));
const { withBackoff } = require(path.join(__dirname, "lib", "cosmos-backoff.cjs"));

const REQUESTED_CONCURRENCY = Math.min(32, Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8)));
// Mutable: the throttle-window guard below halves `.effective` in place;
// every reader of concurrency (runPool) re-reads it per dispatch so a
// mid-run halving takes hold on the very next batch, not just the next page.
const CONCURRENCY_STATE = { effective: REQUESTED_CONCURRENCY };

// ── R-0927e THROTTLE WINDOW (defect 3, header above). A sliding window of
// 429 timestamps, not a lifetime count -- resolve-disagreeing-sale-twins.cjs
// trips once on a lifetime total; this lane instead asks "how many 429s in
// the last THROTTLE_WINDOW_MS", so a long multi-hour scan across many pages
// does not trip on accumulated-but-long-resolved pressure from an hour ago.
// `throttleStats` is a white-box export (mirrors the sibling lane's own
// convention) so a test can drive the drop without paying real backoff
// waits. Each halving is one-way for the rest of the run; pressure that
// continues past a first halving can trip again and halve again.
const THROTTLE_TRIP_AT = 20;
const THROTTLE_WINDOW_MS = 60 * 1000;
const throttleStats = { count: 0, timestamps: [], halvings: 0 };
function recordThrottle() {
  const now = Date.now();
  throttleStats.count++;
  throttleStats.timestamps.push(now);
  const cutoff = now - THROTTLE_WINDOW_MS;
  while (throttleStats.timestamps.length && throttleStats.timestamps[0] < cutoff) throttleStats.timestamps.shift();
  if (throttleStats.timestamps.length > THROTTLE_TRIP_AT) {
    throttleStats.halvings++;
    throttleStats.timestamps.length = 0; // this halving's own trip window is spent; start counting fresh
    const before = CONCURRENCY_STATE.effective;
    CONCURRENCY_STATE.effective = Math.max(1, Math.floor(before / 2));
    console.log(`\n  THROTTLED: more than ${THROTTLE_TRIP_AT} Cosmos 429s in the last ${Math.round(THROTTLE_WINDOW_MS / 1000)}s -- halving in-flight concurrency ${before} -> ${CONCURRENCY_STATE.effective} for the rest of this run (halving #${throttleStats.halvings}). sold_comps is shared with production pricing; this lane backs off rather than compete for it.`);
  }
}
// Test-only tuning for withBackoff's own bounds, so a test proving
// exhaustion (a 429 that outlives every retry) does not have to pay real
// multi-second backoff waits 8 times over. Absent in every real dispatch --
// no workflow input sets these, and the defaults (8 attempts, 500ms base)
// are what ships. `_TEST_BACKOFF_MAX_ATTEMPTS`/`_TEST_BACKOFF_BASE_MS`,
// leading underscore, deliberately outside the documented env list above.
const BACKOFF_OPTS = {
  label: "repoint-sales-isauto-flip",
  onThrottle: recordThrottle,
  ...(process.env._TEST_BACKOFF_MAX_ATTEMPTS ? { maxAttempts: Number(process.env._TEST_BACKOFF_MAX_ATTEMPTS) } : {}),
  ...(process.env._TEST_BACKOFF_BASE_MS ? { baseMs: Number(process.env._TEST_BACKOFF_BASE_MS) } : {}),
};
/** The one retrier every Cosmos call in this lane goes through -- passed
 *  explicitly to relocateSoldComp too, so the mover's own upsert/read-back/
 *  delete count toward the SAME throttle window as this lane's reads. */
const retry = (fn) => withBackoff(fn, BACKOFF_OPTS);

// ── R-0927e HONEST EXIT (defect 2, header above). The workflow's relaunch
// preamble greps the LAST "REPOINTED"/"WOULD REPOINT" banner line out of the
// teed log -- a line this script only ever prints AFTER every setKey has
// finished, at the very end of main(). A crash mid-scan (run 36297136135's
// 429) means that line never gets printed at all, and the preamble's own
// shell default (`${R:-0}`) then reads as "zero writes happened" when in
// fact `s.repointed` (a live counter, updated the instant each move commits)
// was already 3,244. So the counters this script is SURE of, at the moment
// it is exiting -- however it is exiting -- are written to a small JSON file
// next to PLAN_OUT, on every exit path, and the workflow's own preamble for
// this lane (backfill-runner.yml) reads THAT file instead of the banner text.
//
// LEDGER_STATE is populated by main() the instant `s` and PLAN_OUT are both
// known (before any row is scanned, so even a crash on the very first
// candidate still has somewhere to write real, if all-zero, counters).
// `finalWritten` distinguishes the clean end-of-run write (main()'s own last
// line, everything reconciled) from the safety-net write below, which fires
// ONLY when nothing else already wrote a final ledger for this process.
const LEDGER_STATE = { s: null, dir: "", finalWritten: false };

function countersLedgerPath(dir) {
  // A directory next to PLAN_OUT when one was given (every real dispatch sets
  // PLAN_OUT -- see backfill-runner.yml's per-lane wiring); os.tmpdir() as a
  // fallback so a bare local run (no PLAN_OUT) still gets a ledger rather
  // than throwing trying to mkdir an empty path.
  const base = dir || require("node:os").tmpdir();
  return path.join(base, "repoint-sales-isauto-flip-counters.json");
}

/** Writes the counters ledger SYNCHRONOUSLY (never console.log/async -- see
 *  finishLane's own header on why a wedged pipe or an unresolved promise
 *  must never be trusted to run before process.exit()). Never throws: a
 *  ledger write failing must not be what turns a real outcome into a second,
 *  different crash. `abnormalExit` is the ONLY thing the workflow preamble
 *  keys off of -- true means the run did NOT reach its own clean ending. */
function writeCountersLedger(abnormalExit, extra = {}) {
  if (!LEDGER_STATE.s) return; // main() never got far enough to have counters
  const s = LEDGER_STATE.s;
  const record = {
    at: new Date().toISOString(),
    apply: APPLY,
    abnormalExit: !!abnormalExit,
    repointed: s.repointed ?? 0,
    movedByAutoOnlyOverride: s.movedByAutoOnlyOverride ?? 0,
    collapsedOntoResident: s.collapsedOntoResident ?? 0,
    refused: (s.refusedNoChecklistAtFlip ?? 0) + (s.refusedChecklistAtBoth ?? 0)
      + (s.refusedPossibleTwinAtDestination ?? 0) + (s.refusedEtagChanged ?? 0),
    failed: s.failed ?? 0,
    notReached: s.notReached ?? 0,
    candidates: s.candidates ?? 0,
    scanned: s.scanned ?? 0,
    confirmedWrites: (s.repointed ?? 0) + (s.movedByAutoOnlyOverride ?? 0) + (s.collapsedOntoResident ?? 0),
    ...extra,
  };
  try {
    fs.writeFileSync(countersLedgerPath(LEDGER_STATE.dir), JSON.stringify(record));
  } catch (e) {
    // Never let a ledger-write failure become the reason the process exits
    // abnormally -- the console banner (when reached) is still the fallback
    // record, this is a BEST-EFFORT second copy for the crash case.
    console.log(`\n::warning::could not write counters ledger: ${e?.message}`);
  }
}

// Safety net: covers a synchronous throw or an exit path this file's own
// main()/.catch() below did not anticipate. Guarded by `finalWritten` so it
// never overwrites a clean, deliberate final write with a redundant (but
// identical, since LEDGER_STATE.s is the same live object) one -- the guard
// matters only in that it makes the intent legible in the ledger's own
// `abnormalExit` flag: a `finalWritten` run already stamped its OWN verdict.
process.on("exit", () => {
  if (!LEDGER_STATE.finalWritten) writeCountersLedger(true, { exitHandler: true });
});

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "repoint-sales-isauto-flip" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── THE SCOPE. `sport:year` cells, REQUIRED, no default and no whole-corpus
// mode -- same convention as every sibling repoint lane on this runner. The
// runner's inherited defaults ("", "refractor", "all") are REFUSED (exit 2)
// rather than read as "everything".
const INHERITED_SCOPES = new Set(["", "refractor", "all"]);
const RAW_SCOPE = csv(process.env.SCOPE);
const CELL_RE = /^([a-z-]+):(\d{4})$/;
const SCOPE_CELLS = [];
const SCOPE_REJECTED = [];
for (const raw of RAW_SCOPE) {
  const cell = lower(raw);
  const m = CELL_RE.exec(cell);
  if (!m) { SCOPE_REJECTED.push(raw); continue; }
  SCOPE_CELLS.push({ cell, sport: m[1], year: Number(m[2]) });
}

// ── THE PRODUCT FILTER. `titles` (SET_KEYS / BCP_TITLES, the runner's shared
// `titles` input) OPTIONALLY narrows to one or more setKeys within the
// dispatched scope cells. Empty means every setKey the scan finds under the
// cell's own prefix -- this lane has no allowlist of "known" setKeys the way
// the Tiffany lane does, because its shape (flip one segment, check both
// addresses) is the same for every product.
const WILDCARDS = new Set(["", "all", "*"]);
const RAW_SET_KEYS = csv(process.env.SET_KEYS || process.env.BCP_TITLES).map(lower);

// ── R-0927D SENTINEL. No new workflow input for this override -- the lane
// rides the existing `titles` (SET_KEYS/BCP_TITLES) channel. The literal
// token `auto-only-override`, anywhere in that comma-list, ARMS the gate
// (autoOnlyOverride, lib/auto-only-override.cjs) for this run and is then
// stripped OUT of the list before it is read as a setKey filter -- it is
// never itself a setKey, and its presence/absence never changes what
// setKeys are in scope. Dispatch e.g. `titles="auto-only-override"` alone
// (every setKey under SCOPE) or `titles="auto-only-override,bowman-chrome"`
// (armed AND narrowed to bowman-chrome).
const AUTO_ONLY_OVERRIDE_SENTINEL = "auto-only-override";
const AUTO_ONLY_OVERRIDE_ARMED = RAW_SET_KEYS.includes(AUTO_ONLY_OVERRIDE_SENTINEL);
const REQUESTED_SET_KEYS = RAW_SET_KEYS.filter((k) => !WILDCARDS.has(k) && k !== AUTO_ONLY_OVERRIDE_SENTINEL);

async function forEachPage(container, spec, onPage, pageSize = 500) {
  const iter = container.items.query(spec, { maxItemCount: pageSize, maxDegreeOfParallelism: -1 });
  while (iter.hasMoreResults()) {
    const page = await retry(() => iter.fetchNext());
    if ((await onPage(page.resources ?? [])) === false) return;
  }
}

/** The flipped id: same parent id, ONLY the auto/no-auto segment swapped --
 *  every other segment (sport, year, setKey, subset, cardNumber, parallel,
 *  printRun) stays byte-for-byte what the row's own id already says.
 *  Grade-aware -- a graded child's tier is carried through untouched, never
 *  re-derived. Returns null when the id (grade-aware) does not parse at all.
 *
 *  BUILT FROM THE PARSED STRUCTURE, NEVER A TRAILING-SEGMENT STRING CUT: the
 *  auto/no-auto segment is NOT always last in the parent slug -- a printRun
 *  carries `:num-N` AFTER it (`hiq:...:1:base:no-auto:num-99`) -- so this
 *  locates the token by identity (`parsed.isAuto`), not by position. */
function flippedId(id, parseHobbyIqCardId) {
  const split = parseSlugWithGrade(id, parseHobbyIqCardId);
  if (!split) return null;
  const { parsed, gradeTier } = split;
  const parts = ["hiq", parsed.sport, String(parsed.year), parsed.setKey];
  if (parsed.subsetInId && parsed.subsetName) parts.push(`sub-${parsed.subsetName}`);
  parts.push(parsed.cardNumber, parsed.parallel, parsed.isAuto ? "no-auto" : "auto");
  if (parsed.printRun) parts.push(`num-${parsed.printRun}`);
  const flippedParent = parts.join(":");
  return gradeTier ? `${flippedParent}:${gradeTier}` : flippedParent;
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  REPOINT: the checklist's card-number section decides isAuto, never the title");
  console.log("  (live trace, C:/tmp/bb25_trace_1530/RESULT.md, 2026-09-26)");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error(`\nFATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not sport:year cells: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       Dispatch with -f scope=baseball:2025 (comma-separate for several cells).");
    process.exit(2);
  }
  if (!SCOPE_CELLS.length || RAW_SCOPE.some((x) => INHERITED_SCOPES.has(lower(x)))) {
    console.error("\nFATAL: SCOPE is REQUIRED and names the cell(s) to scan, as sport:year -- this lane has no whole-corpus mode.");
    process.exit(2);
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING required"); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { parseHobbyIqCardId } = require(path.join(backend, "dist/services/portfolioiq/hobbyIqCardId.service.js"));
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { isScopedAutoOnlyPrefix } = require(path.join(backend, "dist/services/portfolioiq/scopedAutoOnlyPrefixes.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.map((c) => c.cell).join(", ")}`);
  console.log(`  titles (setKey filter)   ${REQUESTED_SET_KEYS.length ? REQUESTED_SET_KEYS.join(", ") : "(none -- every setKey found)"}`);
  // The allowlist is loaded (and, on failure, its warning printed) HERE, at
  // startup, before any sale is scanned -- never lazily on the first
  // checklist-at-both hit. A missing/malformed allowlist file must never be
  // able to sit latent through an entire run and only surface mid-batch.
  const autoOnlyOverrideDisabled = AUTO_ONLY_OVERRIDE_ARMED ? autoOnlyOverrideDisabledReason() : null;
  if (AUTO_ONLY_OVERRIDE_ARMED && autoOnlyOverrideDisabled) {
    console.log(`  R-0927d auto-only override  DISABLED for this run -- autoOnlyOverrideDisabled: ${autoOnlyOverrideDisabled} (every checklist-at-both stays refused; nothing thrown, run continues)`);
  } else {
    console.log(`  R-0927d auto-only override  ${AUTO_ONLY_OVERRIDE_ARMED ? "ARMED (titles carried the auto-only-override sentinel)" : "off (default -- checklist-at-both refuses unconditionally)"}`);
  }
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  const s = {
    scanned: 0, otherShard: 0, candidates: 0,
    repointed: 0, collapsedOntoResident: 0, movedByAutoOnlyOverride: 0,
    refusedNoChecklistAtFlip: 0, refusedChecklistAtBoth: 0, refusedGradedParse: 0,
    refusedPossibleTwinAtDestination: 0, refusedEtagChanged: 0,
    failed: 0, notReached: 0, ledgerWriteFailed: 0,
  };
  // From this line on, the module-scope exit safety net (process.on("exit"),
  // registered above) can see LIVE counters -- a crash one line below this
  // still has an all-zero-but-real ledger to write, rather than nothing.
  LEDGER_STATE.s = s;
  let stoppedAtBudget = false;
  // Per-setKey counters, for the report-lane incident's own per-setKey table.
  const perSetKey = new Map();
  function bucket(setKey) {
    if (!perSetKey.has(setKey)) {
      perSetKey.set(setKey, {
        candidates: 0, repointed: 0, movedByAutoOnlyOverride: 0,
        refusedNoChecklistAtFlip: 0, refusedChecklistAtBoth: 0, refusedGradedParse: 0,
      });
    }
    return perSetKey.get(setKey);
  }
  const ambiguousByCardNumber = new Map(); // "setKey|cardNumber" -> count
  const examples = []; // up to 10 per setKey, fromId -> toId
  const examplesBySetKey = new Map();
  const refusals = { "possible-twin-at-destination": [] };
  const failures = [];

  const PLAN_OUT = str(process.env.PLAN_OUT);
  LEDGER_STATE.dir = PLAN_OUT;
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
      fromId: extra.fromId ?? null, toId: extra.toId ?? null, error: extra.error ?? null,
    };
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed for ${sale?.id}: ${e?.message}`); }
  }

  async function residentAt(saleId, cardId) {
    try { return (await retry(() => pool.item(saleId, cardId).read())).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }

  async function catalogRowAt(id) {
    try { return (await retry(() => cat.item(id, id).read())).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }

  // ── THE MOVE (shared body). Used both by the everyday move (current
  // absent/non-checklist, flip checklist-grade) and by the R-0927d override
  // move (both checklist-grade, but the gate's four conditions held). The
  // ONLY difference between the two callers is which counter records the
  // success -- `repointed` for the everyday case, `movedByAutoOnlyOverride`
  // for the override, per the ruling's explicit ask for a NEW, separate
  // counter so `refusedChecklistAtBoth` still prints the everyday-refused
  // population undiluted.
  async function performMove(sale, currentId, toId, setKey, st, { viaOverride }) {
    const exList = examplesBySetKey.get(setKey) ?? [];
    if (exList.length < 10) {
      exList.push(`  ${sale.id}: ${currentId} -> ${toId}  ("${String(sale.title ?? "").slice(0, 90)}")${viaOverride ? " [auto-only-override]" : ""}`);
      examplesBySetKey.set(setKey, exList);
    }
    if (examples.length < 10) examples.push(`  ${sale.id}: ${currentId} -> ${toId}  ("${String(sale.title ?? "").slice(0, 90)}")${viaOverride ? " [auto-only-override]" : ""}`);

    // Collision / twin detection runs in BOTH modes -- a REPORT must show
    // what would happen, mirrors every sibling repoint lane.
    const resident = await residentAt(sale.id, toId);
    if (resident) {
      if (contentHashOf(resident) === contentHashOf({ ...sale, cardId: toId, hobbyiqCardId: toId })) {
        s.collapsedOntoResident++;
        if (APPLY) {
          try {
            // CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-LEDGER-LINE-FIRST
            // (2026-09-28). `sale` is the FULL pre-delete document (this
            // lane's own scan query selects every field). A ledger-write
            // failure refuses the delete -- counted separately from the
            // "best effort" catch below, which is only for the DELETE
            // itself throwing after a successful ledger write.
            await recordDeleteOrThrow(sale, {
              lane: "repoint-sales-isauto-flip", action: "collapse", reason: "same-sale-resident",
              toId, container: "sold_comps",
            });
            await pool.item(sale.id, sale.cardId).delete();
          } catch (e) {
            if (isLedgerWriteFailure(e)) { s.ledgerWriteFailed++; s.failed++; }
            // else: best effort; proven duplicate either way
          }
        }
        emitPlanRow(sale, "collapse", "same-sale-resident", { fromId: currentId, toId });
        return;
      }
      s.refusedPossibleTwinAtDestination++;
      refusals["possible-twin-at-destination"].push(`  ${sale.id}@${currentId} -> ${toId}: a DIFFERENT document already resides at (${sale.id}, ${toId}) -- refused, neither moved`);
      emitPlanRow(sale, "refused", "possible-twin-at-destination", { fromId: currentId, toId });
      return;
    }

    try {
      // CF-CH-CARD-SET-ALREADY-HAS-THE-YEAR, the move-side half: relocateSoldComp
      // itself heals a pre-2026-08-24 (commit 0000f60) doubled-year title
      // before it upserts `keep` (lib/relocate-sold-comp.cjs, review follow-up
      // to PR #2474: centralized there instead of per-caller so every mover
      // inherits it, not just this one).
      const keep = stripSystem({ ...sale, cardId: toId, hobbyiqCardId: toId });
      const result = await relocateSoldComp(pool, {
        keep, drop: [{ id: sale.id, cardId: sale.cardId }],
        verifyFields: ["cardId", "hobbyiqCardId"],
        dryRun: !APPLY,
        // Same retrier this lane's own reads use, so a 429 anywhere inside
        // the mover's upsert/read-back/delete counts toward the SAME
        // throttle window (recordThrottle) that halves CONCURRENCY_STATE.
        retry,
      });
      if (result?.ok) {
        if (viaOverride) { s.movedByAutoOnlyOverride++; st.movedByAutoOnlyOverride++; }
        else { s.repointed++; st.repointed++; }
        emitPlanRow(sale, "move", viaOverride ? "auto-only-override" : "isauto-flip", { fromId: currentId, toId });
      } else if (result?.staleSincePlan?.length) {
        s.refusedEtagChanged++;
        emitPlanRow(sale, "refused", "stale-since-plan", { fromId: currentId, toId });
      } else {
        s.failed++;
        const duplicateLeft = Array.isArray(result?.duplicatesLeft) && result.duplicatesLeft.length > 0;
        const stage = result?.stage ?? "unknown";
        const errMsg = result?.error ?? "unknown";
        const state = duplicateLeft
          ? `DUPLICATE LEFT -- keeper upserted+verified at ${toId}, old row at ${sale.cardId} was NOT deleted; sale now resident at BOTH addresses`
          : `nothing written -- sale untouched at its old address ${sale.cardId}`;
        const msg = `FAILED relocate ${sale.id}@${currentId} -> ${toId}: [stage=${stage}] ${errMsg} -- ${state}`;
        failures.push(`  ${msg}`);
        emitPlanRow(sale, "failed", "relocate", { fromId: currentId, toId, error: `[stage=${stage}] ${errMsg}` });
        console.log(`\n::warning::${msg}`);
      }
    } catch (e) {
      s.failed++;
      const code = e?.code ?? e?.statusCode ?? "unknown";
      const msg = `FAILED relocate ${sale.id}@${currentId} -> ${toId}: [${code}] ${e?.message || e} -- UNKNOWN whether the write landed before the throw; verify both addresses`;
      failures.push(`  ${msg}`);
      emitPlanRow(sale, "failed", "relocate-threw", { fromId: currentId, toId, error: `[${code}] ${e?.message || String(e)}` });
      console.log(`\n::warning::${msg}`);
    }
  }

  async function processSale(sale, setKey) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; s.notReached++; return; }
    s.scanned++;

    const currentId = String(sale.hobbyiqCardId || sale.cardId || "");
    const st = bucket(setKey);

    const toId = flippedId(currentId, parseHobbyIqCardId);
    if (!toId) {
      // Not this lane's shape (e.g. does not carry an auto/no-auto segment
      // at all, grade-aware or otherwise) -- not counted as a candidate.
      return;
    }
    s.candidates++;
    st.candidates++;

    // ── THE CURRENT ADDRESS'S OWN CATALOG ROW. Absent or non-checklist is
    // the precondition for this lane to have anything to fix at all -- a
    // sale already backed by its OWN checklist row is untouched, full stop
    // (checked implicitly by the flip-side / both-sides logic below).
    let currentRow, flipRow;
    try {
      [currentRow, flipRow] = await Promise.all([catalogRowAt(currentId), catalogRowAt(toId)]);
    } catch (e) {
      s.failed++;
      const code = e?.code ?? e?.statusCode ?? "unknown";
      const msg = `FAILED catalog-read ${sale.id}@${currentId} (flip ${toId}): [${code}] ${e?.message || e} -- nothing written, sale untouched at its old address`;
      failures.push(`  ${msg}`);
      emitPlanRow(sale, "failed", "catalog-read", { fromId: currentId, toId, error: `[${code}] ${e?.message || String(e)}` });
      console.log(`\n::warning::${msg}`);
      return;
    }

    const currentIsChecklist = currentRow ? isChecklist(currentRow.source) : false;
    if (currentIsChecklist) {
      // The sale's OWN id is already checklist-backed -- nothing to move.
      // Not a candidate outcome to tally beyond `candidates` itself, since
      // this shape (checklist at current, whatever at flip) is the everyday
      // PRESENT case the trace measured at 74.5% -- but it still must be
      // accounted for in the reconcile, so it is folded into
      // refusedNoChecklistAtFlip's sibling bucket: no, it is its own case.
      // Filed as "checklist-at-both" only when the FLIP also carries one
      // (the true ambiguous case); otherwise it is simply not this lane's
      // defect, tallied as refusedNoChecklistAtFlip's complement below.
      const flipIsChecklist = flipRow ? isChecklist(flipRow.source) : false;
      if (flipIsChecklist) {
        // ── R-0927D. `currentId` is the SALE's own (:no-auto) address and
        // `toId` is the flip (:auto) address -- this branch is entered only
        // when BOTH sides are checklist-grade, i.e. exactly the ambiguous
        // shape the override exists for. The override NEVER runs the
        // reverse direction: it is only ever consulted when the CURRENT
        // (unflipped) row is the `:no-auto` one and the flip is `:auto`
        // (parsed.isAuto === false on the current row -- checked via the
        // parsed segments, never a string suffix test).
        const segs = parseSlugWithGrade(currentId, parseHobbyIqCardId);
        const cardNumber = segs?.parsed?.cardNumber ?? "unknown";
        const currentIsNoAuto = segs?.parsed?.isAuto === false;

        if (AUTO_ONLY_OVERRIDE_ARMED && currentIsNoAuto) {
          const gate = autoOnlyOverride({
            direction: "no-auto-to-auto",
            cardNumber,
            scope: { sport: segs?.parsed?.sport, year: segs?.parsed?.year, setKey },
            noAutoSource: currentRow?.source,
            saleName: sale.playerName,
            autoRowName: flipRow?.playerName,
            autoRowCategory: flipRow?.category,
            isScopedAutoOnlyPrefix,
            namesAgree,
          });
          if (gate.move) {
            await performMove(sale, currentId, toId, setKey, st, { viaOverride: true });
            return;
          }
        }

        s.refusedChecklistAtBoth++;
        st.refusedChecklistAtBoth++;
        const key = `${setKey}|${cardNumber}`;
        ambiguousByCardNumber.set(key, (ambiguousByCardNumber.get(key) ?? 0) + 1);
        emitPlanRow(sale, "refused", "checklist-at-both", { fromId: currentId, toId });
      } else {
        s.refusedNoChecklistAtFlip++;
        st.refusedNoChecklistAtFlip++;
        emitPlanRow(sale, "left", "already-checklist-backed", { fromId: currentId, toId });
      }
      return;
    }

    const flipIsChecklist = flipRow ? isChecklist(flipRow.source) : false;
    if (!flipIsChecklist) {
      // Neither address is checklist-backed -- an acquisition gap, not this
      // lane's defect to fix.
      s.refusedNoChecklistAtFlip++;
      st.refusedNoChecklistAtFlip++;
      emitPlanRow(sale, "left", "no-checklist-at-flip", { fromId: currentId, toId });
      return;
    }

    // ── THE MOVE. current = absent/non-checklist, flip = checklist-grade.
    // The checklist attests the flipped isAuto value; the sale's id is wrong.
    await performMove(sale, currentId, toId, setKey, st, { viaOverride: false });
  }

  async function runPool(items, worker) {
    let idx = 0;
    const runner = async () => { while (idx < items.length) { const my = idx++; await worker(items[my]); } };
    // Read CONCURRENCY_STATE.effective HERE, not once at module scope -- a
    // halving mid-scan (recordThrottle) takes hold on the very next page's
    // runPool call, since each page's worker count is decided fresh.
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY_STATE.effective, Math.max(items.length, 1)) }, runner));
  }

  for (const { cell, sport, year } of SCOPE_CELLS) {
    if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
    // Discover setKeys to scan: when `titles` is empty, this lane cannot
    // discover setKeys via GROUP BY (forbidden -- never cross-partition
    // aggregate), so it requires REQUESTED_SET_KEYS OR falls back to scanning
    // the bare cell prefix `hiq:<sport>:<year>:` and letting parseSlugWithGrade
    // + the id's own setKey segment sort candidates into buckets as they are
    // found -- one query per cell, not per setKey, when no filter is given.
    const setKeysToScan = REQUESTED_SET_KEYS.length ? REQUESTED_SET_KEYS : [null];
    for (const setKeyFilter of setKeysToScan) {
      if (CLOCK.outOfClock()) { stoppedAtBudget = true; break; }
      const prefix = setKeyFilter ? `hiq:${sport}:${year}:${setKeyFilter}:` : `hiq:${sport}:${year}:`;
      const rows = [];
      await forEachPage(pool, {
        query: "SELECT * FROM c WHERE STARTSWITH(c.hobbyiqCardId, @prefix)",
        parameters: [{ name: "@prefix", value: prefix }],
      }, async (page) => {
        for (const r of page) {
          if (SHARD_SCOPE.SHARDED && shardOf(String(r.id)) !== SHARD_SCOPE.SLOT) { s.otherShard++; continue; }
          rows.push(r);
        }
        if (LIMIT > 0 && rows.length >= LIMIT) return false;
        return true;
      });
      // Bucket each row by the setKey ITS OWN id names (parseSlugWithGrade),
      // never by the filter string -- a bare-cell scan sees every setKey at
      // once and each row must be tallied under its own product.
      await runPool(rows, async (row) => {
        const currentId = String(row.hobbyiqCardId || row.cardId || "");
        const split = parseSlugWithGrade(currentId, parseHobbyIqCardId);
        if (!split) {
          s.refusedGradedParse++;
          const st = bucket(setKeyFilter || "(unparsed)");
          st.refusedGradedParse++;
          s.scanned++;
          emitPlanRow(row, "refused", "graded-parse", { fromId: currentId });
          return;
        }
        const rowSetKey = split.parsed.setKey;
        if (setKeyFilter && rowSetKey !== setKeyFilter) return; // defensive; STARTSWITH already scoped this
        await processSale(row, rowSetKey);
      });
    }
  }

  console.log("");
  console.log("  PER-SETKEY COUNTS:");
  const sortedSetKeys = [...perSetKey.entries()].sort((a, b) => b[1].candidates - a[1].candidates);
  for (const [setKey, st] of sortedSetKeys) {
    console.log(`\n  setKey: ${setKey}`);
    console.log(`    candidates                    ${f(st.candidates)}`);
    console.log(`    ${APPLY ? "repointed" : "would-repoint"}                  ${f(st.repointed)}`);
    console.log(`    ${APPLY ? "movedByAutoOnlyOverride" : "wouldMoveByAutoOnlyOverride"}  ${f(st.movedByAutoOnlyOverride)}`);
    console.log(`    refused-no-checklist-at-flip   ${f(st.refusedNoChecklistAtFlip)}`);
    console.log(`    refused-checklist-at-both      ${f(st.refusedChecklistAtBoth)}`);
    console.log(`    refused-graded-parse           ${f(st.refusedGradedParse)}`);
    const ex = examplesBySetKey.get(setKey);
    if (ex && ex.length) {
      console.log(`    examples (up to 10):`);
      for (const line of ex) console.log(line);
    }
  }

  console.log("");
  for (const [reason, lines] of Object.entries(refusals)) {
    if (!lines.length) continue;
    console.log(`\n  REFUSED (${reason}), up to 20 shown:`);
    for (const line of lines.slice(0, 20)) console.log(line);
  }
  if (ambiguousByCardNumber.size) {
    console.log(`\n  REFUSED (checklist-at-both) by setKey|cardNumber, ambiguous census (${ambiguousByCardNumber.size} distinct):`);
    const sorted = [...ambiguousByCardNumber.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [key, count] of sorted) console.log(`  ${key}: ${f(count)}`);
  }
  if (failures.length) {
    console.log(`\n  FAILURES (${f(failures.length)}), every one listed:`);
    for (const line of failures) console.log(line);
  }

  console.log("");
  console.log(`sales scanned                          ${f(s.scanned)}${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} in other shards)` : ""}`);
  console.log(`  candidates (isAuto-flip shape)        ${f(s.candidates)}`);
  console.log(`  ${APPLY ? "REPOINTED" : "WOULD REPOINT"}                       ${f(s.repointed)}`);
  console.log(`  ${APPLY ? "movedByAutoOnlyOverride" : "wouldMoveByAutoOnlyOverride"} (R-0927d)  ${f(s.movedByAutoOnlyOverride)}`);
  console.log(`  COLLAPSED onto a resident (same sale)  ${f(s.collapsedOntoResident)}`);
  console.log(`  REFUSED: no-checklist-at-flip           ${f(s.refusedNoChecklistAtFlip)}`);
  console.log(`  REFUSED: checklist-at-both (ambiguous)  ${f(s.refusedChecklistAtBoth)}`);
  console.log(`  REFUSED: graded-parse                   ${f(s.refusedGradedParse)}`);
  console.log(`  REFUSED: possible-twin-at-destination   ${f(s.refusedPossibleTwinAtDestination)}`);
  console.log(`  REFUSED: stale since the read            ${f(s.refusedEtagChanged)}`);
  console.log(`  failed                                  ${f(s.failed)}`);
  console.log(`  of which ledger-write-failed             ${f(s.ledgerWriteFailed)}`);
  console.log(`  not reached (budget)                     ${f(s.notReached)}`);
  console.log(`  Cosmos 429 retries (this run)           ${f(throttleStats.count)}${throttleStats.halvings ? `   <- concurrency halved ${throttleStats.halvings}x, now ${f(CONCURRENCY_STATE.effective)} (started at ${f(REQUESTED_CONCURRENCY)})` : ""}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  // RECONCILE (R-0927f fix, 2026-09-27, incident: run 36301171656, SCOPE
  // baseball:2026 REPORT concurrency=4, budget hit mid-scan). That run
  // printed `candidates 880,871` but `accounted-for 988,758` -- accounted-for
  // exceeded candidates by EXACTLY `notReached` (107,887), and exited 4
  // ("RECONCILE MISMATCH") on a run that had done nothing wrong; every
  // whole-sport-year scan over 100k+ rows routinely hits its own budget, so
  // this was not a rare edge case.
  //
  // THE BUG. `s.notReached++` fires at the TOP of `processSale`, BEFORE
  // `flippedId()` ever runs and BEFORE `s.candidates++` -- see the guard at
  // that function's own top. So a not-reached row was NEVER a candidate,
  // exactly the same shape `refusedGradedParse` (documented and excluded
  // below) already is. The formula used to ADD `notReached` on top of
  // `candidateOutcomes` while comparing that sum against `s.candidates` --
  // two different populations on the two sides of one `!==`, guaranteed to
  // mismatch by exactly `notReached` on any run the budget actually stops.
  // The fix is the one `refusedGradedParse` already models: `notReached` is
  // EXCLUDED from this formula, denominators on both sides of the `!==`
  // stay `candidates`-only, and a clean budget stop reconciles instead of
  // exiting 4. `notReached` is still reported on its own line (the banner
  // above) -- never silently dropped, just never folded into a population
  // it was never drawn from (see the `reportWrites` call below, where it is
  // excluded from `skipped` for the identical reason).
  const candidateOutcomes = s.repointed + s.movedByAutoOnlyOverride + s.collapsedOntoResident
    + s.refusedNoChecklistAtFlip + s.refusedChecklistAtBoth
    + s.refusedPossibleTwinAtDestination + s.refusedEtagChanged
    + s.failed;
  console.log(`\n  reconciled: candidates ${f(s.candidates)} = accounted-for ${f(candidateOutcomes)}`);
  if (candidateOutcomes !== s.candidates) {
    console.error("  !! RECONCILE MISMATCH -- a candidate was neither repointed, collapsed, refused nor failed");
    process.exitCode = 4;
  }

  // `refusedGradedParse` is DELIBERATELY EXCLUDED here. reportWrites
  // reconciles `refused` (and every other bucket) against `intended:
  // s.candidates`, and a row that failed to parse never became a candidate
  // in the first place (`s.candidates++` only runs after `flippedId()`
  // succeeds -- see the header above and the guard at the top of
  // `processSale`). Folding it into `refusedTotal` would count it against a
  // population it was never drawn from: reportWrites computes `overAccounted
  // = accounted - intended`, and a single unparseable row on top of one real
  // outcome pushes `accounted` one past `intended` every time -- a FALSE RED
  // ("COUNTERS DO NOT ADD UP", exit 4) on an otherwise-clean APPLY, and
  // near-certain at scale because the scan is a bare prefix STARTSWITH that
  // will meet malformed ids. It is reported on its own line (below and in the
  // per-setKey table) instead, exactly as `scanned`'s own non-candidate rows
  // already are.
  //
  // `notReached` is EXCLUDED from `skipped` for the SAME reason (R-0927f,
  // 2026-09-27, run 36301171656). `reportWrites` (backend/src/services/ops/
  // writeReconciliation.ts, off-limits to this fix -- src/ is untouched)
  // computes `accounted = written + skipped + refused + failed` and compares
  // it against `intended: s.candidates`. A not-reached row never became a
  // candidate (the budget check at the top of `processSale` returns before
  // `flippedId()` ever runs), so passing it as `skipped` against an
  // `intended` that never counted it produces the exact "COUNTERS DO NOT ADD
  // UP" / overAccounted false red this run hit on ANY budget stop under
  // APPLY -- not a rare malformed-id edge case, but the ordinary outcome of
  // a whole-sport-year scan over 100k+ rows. Omitted here entirely (the
  // field is optional and defaults to 0), matching `refusedGradedParse`'s
  // own omission from `refusedTotal` immediately above.
  const refusedTotal = s.refusedNoChecklistAtFlip + s.refusedChecklistAtBoth
    + s.refusedPossibleTwinAtDestination + s.refusedEtagChanged;
  if (APPLY) {
    reportWrites({
      job: "repoint-sales-isauto-flip",
      intended: s.candidates,
      written: s.repointed + s.movedByAutoOnlyOverride + s.collapsedOntoResident,
      refused: refusedTotal,
      failed: s.failed,
    });
  }

  if (s.failed) { console.error(`::error::${f(s.failed)} sale(s) failed.`); process.exitCode = 4; }

  // THE CLEAN LEDGER WRITE. main() reached its own end -- every setKey was
  // scanned (or the budget stopped it on purpose, `s.notReached` says so),
  // the reconcile ran, and whatever exitCode was set above (0, 4, or the
  // scope-refusal 2 never reaches here at all) is final. `abnormalExit:
  // false` is the ONLY signal the workflow preamble needs to print the
  // ordinary repointed=N line instead of ABNORMAL EXIT.
  writeCountersLedger(false);
  LEDGER_STATE.finalWritten = true;
}

module.exports = {
  flippedId, INHERITED_SCOPES, WILDCARDS, CELL_RE, AUTO_ONLY_OVERRIDE_SENTINEL,
  // White-box exports for the backoff/honest-exit tests only -- mirrors
  // resolve-disagreeing-sale-twins.cjs's own `throttleStats` export
  // convention, so a test can drive the halving and the ledger write
  // without paying real backoff waits or a real Cosmos 429.
  throttleStats, recordThrottle, CONCURRENCY_STATE, REQUESTED_CONCURRENCY,
  LEDGER_STATE, writeCountersLedger, countersLedgerPath,
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => {
      console.error("::error::" + (e?.stack ?? e));
      // ABNORMAL EXIT (defect 2, header above). main() threw before reaching
      // its own clean ending -- the counters LEDGER_STATE.s already carries
      // (updated live as each move committed, never only at the end) are
      // written here, `abnormalExit: true`, so the workflow's preamble can
      // print an honest "ABNORMAL EXIT after <n> confirmed writes" instead of
      // defaulting to repointed=0 on a run that in fact wrote 3,244 rows.
      writeCountersLedger(true, { error: String(e?.message ?? e) });
      LEDGER_STATE.finalWritten = true;
      finishLane(1, { budget: CLOCK });
    });
}
