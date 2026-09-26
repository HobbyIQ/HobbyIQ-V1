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
 *      logged, left exactly where it is;
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
 * RECONCILE: candidates = repointed + collapsedOntoResident +
 * refusedNoChecklistAtFlip + refusedChecklistAtBoth +
 * refusedPossibleTwinAtDestination + refusedEtagChanged + failed +
 * notReached. Exits non-zero when the counters do not add up.
 *
 * `refusedGradedParse` is DELIBERATELY NOT part of this formula, and is
 * DELIBERATELY NOT folded into the `refused` count reportWrites() sees
 * either: a row whose id (grade-aware) does not parse at all never becomes a
 * candidate in the first place (`candidates` only increments after
 * `flippedId()` succeeds), so it is counted against `scanned`, reported on
 * its own line, and left out of both reconciliations -- folding it into
 * either would count it against a population it was never drawn from,
 * producing a false RECONCILE MISMATCH / reportWrites over-account on any
 * real run that meets even one malformed id alongside a real outcome.
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
 */
"use strict";
const path = require("path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const backend = path.resolve(__dirname, "..");

const { runnerShardScope } = require(path.join(__dirname, "lib", "runner-shard-scope.cjs"));
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { relocateSoldComp, stripSystem, contentHashOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));
const { parseSlugWithGrade } = require(path.join(__dirname, "lib", "graded-id.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const CONCURRENCY = Math.min(32, Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8)));
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
const REQUESTED_SET_KEYS = RAW_SET_KEYS.filter((k) => !WILDCARDS.has(k));

async function forEachPage(container, spec, onPage, pageSize = 500) {
  const iter = container.items.query(spec, { maxItemCount: pageSize, maxDegreeOfParallelism: -1 });
  while (iter.hasMoreResults()) {
    const page = await iter.fetchNext();
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
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));

  const isChecklist = (source) => catalogAuthorityOf(source) === "checklist";

  const client = new CosmosClient(conn);
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const pool = db.container("sold_comps");
  const cat = db.container("card_catalog");

  console.log(`  scope (${SCOPE_CELLS.length} cell${SCOPE_CELLS.length === 1 ? "" : "s"})    ${SCOPE_CELLS.map((c) => c.cell).join(", ")}`);
  console.log(`  titles (setKey filter)   ${REQUESTED_SET_KEYS.length ? REQUESTED_SET_KEYS.join(", ") : "(none -- every setKey found)"}`);
  console.log(`  ${SHARD_SCOPE.banner()}`);
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  const s = {
    scanned: 0, otherShard: 0, candidates: 0,
    repointed: 0, collapsedOntoResident: 0,
    refusedNoChecklistAtFlip: 0, refusedChecklistAtBoth: 0, refusedGradedParse: 0,
    refusedPossibleTwinAtDestination: 0, refusedEtagChanged: 0,
    failed: 0, notReached: 0,
  };
  let stoppedAtBudget = false;
  // Per-setKey counters, for the report-lane incident's own per-setKey table.
  const perSetKey = new Map();
  function bucket(setKey) {
    if (!perSetKey.has(setKey)) {
      perSetKey.set(setKey, {
        candidates: 0, repointed: 0,
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
    try { return (await pool.item(saleId, cardId).read()).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
  }

  async function catalogRowAt(id) {
    try { return (await cat.item(id, id).read()).resource ?? null; }
    catch (e) { if (e?.code === 404 || e?.statusCode === 404) return null; throw e; }
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
        s.refusedChecklistAtBoth++;
        st.refusedChecklistAtBoth++;
        const segs = parseSlugWithGrade(currentId, parseHobbyIqCardId);
        const cardNumber = segs?.parsed?.cardNumber ?? "unknown";
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
    const exList = examplesBySetKey.get(setKey) ?? [];
    if (exList.length < 10) {
      exList.push(`  ${sale.id}: ${currentId} -> ${toId}  ("${String(sale.title ?? "").slice(0, 90)}")`);
      examplesBySetKey.set(setKey, exList);
    }
    if (examples.length < 10) examples.push(`  ${sale.id}: ${currentId} -> ${toId}  ("${String(sale.title ?? "").slice(0, 90)}")`);

    // Collision / twin detection runs in BOTH modes -- a REPORT must show
    // what would happen, mirrors every sibling repoint lane.
    const resident = await residentAt(sale.id, toId);
    if (resident) {
      if (contentHashOf(resident) === contentHashOf({ ...sale, cardId: toId, hobbyiqCardId: toId })) {
        s.collapsedOntoResident++;
        if (APPLY) { try { await pool.item(sale.id, sale.cardId).delete(); } catch { /* best effort; proven duplicate either way */ } }
        emitPlanRow(sale, "collapse", "same-sale-resident", { fromId: currentId, toId });
        return;
      }
      s.refusedPossibleTwinAtDestination++;
      refusals["possible-twin-at-destination"].push(`  ${sale.id}@${currentId} -> ${toId}: a DIFFERENT document already resides at (${sale.id}, ${toId}) -- refused, neither moved`);
      emitPlanRow(sale, "refused", "possible-twin-at-destination", { fromId: currentId, toId });
      return;
    }

    try {
      const keep = stripSystem({ ...sale, cardId: toId, hobbyiqCardId: toId });
      const result = await relocateSoldComp(pool, {
        keep, drop: [{ id: sale.id, cardId: sale.cardId }],
        verifyFields: ["cardId", "hobbyiqCardId"],
        dryRun: !APPLY,
      });
      if (result?.ok) {
        s.repointed++;
        st.repointed++;
        emitPlanRow(sale, "move", "isauto-flip", { fromId: currentId, toId });
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

  async function runPool(items, worker) {
    let idx = 0;
    const runner = async () => { while (idx < items.length) { const my = idx++; await worker(items[my]); } };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(items.length, 1)) }, runner));
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
  console.log(`  COLLAPSED onto a resident (same sale)  ${f(s.collapsedOntoResident)}`);
  console.log(`  REFUSED: no-checklist-at-flip           ${f(s.refusedNoChecklistAtFlip)}`);
  console.log(`  REFUSED: checklist-at-both (ambiguous)  ${f(s.refusedChecklistAtBoth)}`);
  console.log(`  REFUSED: graded-parse                   ${f(s.refusedGradedParse)}`);
  console.log(`  REFUSED: possible-twin-at-destination   ${f(s.refusedPossibleTwinAtDestination)}`);
  console.log(`  REFUSED: stale since the read            ${f(s.refusedEtagChanged)}`);
  console.log(`  failed                                  ${f(s.failed)}`);
  console.log(`  not reached (budget)                     ${f(s.notReached)}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  // RECONCILE. Every candidate is repointed, collapsed onto a proven
  // duplicate, refused (named), failed, or not reached before the budget --
  // never silently dropped. Denominators must match: `candidates` is the
  // SAME population every outcome below is drawn from. `refusedGradedParse`
  // is counted against `scanned`, not `candidates` (a row that does not
  // parse never became a candidate), so it is added to both sides of the
  // ledger identically and cancels out of the candidate reconcile below.
  const candidateOutcomes = s.repointed + s.collapsedOntoResident
    + s.refusedNoChecklistAtFlip + s.refusedChecklistAtBoth
    + s.refusedPossibleTwinAtDestination + s.refusedEtagChanged
    + s.failed + s.notReached;
  console.log(`\n  reconciled: candidates ${f(s.candidates)} = accounted-for ${f(candidateOutcomes)}`);
  if (candidateOutcomes !== s.candidates) {
    console.error("  !! RECONCILE MISMATCH -- a candidate was neither repointed, collapsed, refused, failed nor left unreached");
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
  const refusedTotal = s.refusedNoChecklistAtFlip + s.refusedChecklistAtBoth
    + s.refusedPossibleTwinAtDestination + s.refusedEtagChanged;
  if (APPLY) {
    reportWrites({
      job: "repoint-sales-isauto-flip",
      intended: s.candidates,
      written: s.repointed + s.collapsedOntoResident,
      refused: refusedTotal,
      skipped: s.notReached,
      failed: s.failed,
    });
  }

  if (s.failed) { console.error(`::error::${f(s.failed)} sale(s) failed.`); process.exitCode = 4; }
}

module.exports = {
  flippedId, INHERITED_SCOPES, WILDCARDS, CELL_RE,
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); finishLane(1, { budget: CLOCK }); });
}
