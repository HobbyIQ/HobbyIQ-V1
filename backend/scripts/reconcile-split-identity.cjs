#!/usr/bin/env node
/**
 * reconcile-split-identity.cjs -- one card, one row, one pool: a sold_comps
 * row whose two identity fields NAME DIFFERENT hiq: cards is being read into
 * BOTH cards' price pools, because the exact pool reader ORs cardId and
 * hobbyiqCardId together. This lane closes the split when the CHECKLIST can
 * say which of the two addresses is the card.
 *
 * MOTIVATION (tonight's census, 2026-09-27 ~00:00Z, "SPLIT-IDENTITY"
 * diagnostic; scripts/lib/split-identity.cjs's own HIQ_SPLIT class -- "no
 * ingest writes two different slugs for one sale"). 2026 baseball slot 5
 * alone measured 73,567 such rows. Owner Drew: "Let's get a lot of agents
 * going in clean up."
 *
 * THE RULE, per split row (both cardId and hobbyiqCardId are hiq: slugs and
 * they differ -- classifyIdentity's HIQ_SPLIT, lib/split-identity.cjs):
 *
 *   1. point-read card_catalog (pk /cardId) at BOTH ids;
 *   2. exactly ONE of the two rows is checklist-grade
 *      (catalogAuthorityOf(source) === "checklist" --
 *      dist/services/catalog/catalogAuthority.service.js; DERIVED and VENDOR
 *      never count, same doctrine as every sibling repoint lane) -> set BOTH
 *      cardId and hobbyiqCardId to that checklist id. sold_comps partitions
 *      on /cardId: when the winning id differs from the row's OWN cardId
 *      this is a MOVE (relocateSoldComp create-then-delete with read-back);
 *      when the winner IS ALREADY the row's own cardId (only hobbyiqCardId
 *      was the stale field), it is a PATCH IN PLACE -- relocateSoldComp's
 *      same upsert+verify, `drop: []`, nothing deleted;
 *   3. BOTH ids are checklist-grade -> REFUSE "ambiguous-both-checklist" --
 *      the catalog names two winners and a guess between them would be ours,
 *      never Drew's;
 *   4. NEITHER id is checklist-grade -> REFUSE "neither-checklist" -- an
 *      acquisition gap, the rematch's job, not this lane's;
 *   5. graded ids preserve the grade segment verbatim
 *      (scripts/lib/graded-id.cjs's parseSlugWithGrade -- a graded child's
 *      tier is carried through untouched on whichever side wins);
 *   6. REPORT (apply=false) runs every guard APPLY runs and writes nothing.
 *
 * TWIN / RESIDENT HANDLING is identical to #2441
 * (repoint-sales-isauto-flip.cjs): a document already resident at (id,
 * winningId) that is byte-identical to what this row would become COLLAPSES
 * (the old row is deleted, nothing new is written); a resident that differs
 * is a possible twin and is REFUSED, neither side moved.
 *
 * SCAN SHAPE. `STARTSWITH(c.hobbyiqCardId, 'hiq:<sport>:<year>:')` (+ setKey
 * prefix when `titles` narrows it), paginated {maxItemCount:500,
 * maxDegreeOfParallelism:-1}, `while (iter.hasMoreResults())`. The
 * client-side filter `cardId !== hobbyiqCardId` (and both sides isHiq) is
 * exactly classifyIdentity's HIQ_SPLIT predicate -- reused from
 * lib/split-identity.cjs rather than re-implemented, so the census and this
 * repair decide identically. Never a cross-partition COUNT or GROUP BY.
 * CardHedge rows carry no top-level sport/year fields at all -- this lane
 * never filters on them, and a CardHedge row's cardId is a vendor id, not an
 * hiq: slug, so it is COHERENT or VENDOR-DESIGN under classifyIdentity and
 * never reaches this lane's candidate population in the first place.
 *
 * PRE-CANDIDATE REFUSALS ARE NOT RECONCILED AGAINST CANDIDATES (the #2441
 * lesson). A row this lane never turns into a candidate (one-sided identity,
 * a non-hiq cardId, a malformed slug that will not parse) is counted against
 * `scanned`, reported on its own line, and left OUT of the candidate
 * reconcile -- folding it in would count an outcome against a population it
 * was never drawn from.
 *
 * RECONCILE: candidates = reconciled + collapsedOntoResident +
 * refusedAmbiguousBothChecklist + refusedNeitherChecklist +
 * refusedPossibleTwinAtDestination + refusedEtagChanged + failed +
 * notReached. Exits non-zero when the counters do not add up.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY=true (or APPLY=true) to
 *      write; SCOPE required (sport:year, one or more comma-separated
 *      cells); SET_KEYS / BCP_TITLES (the runner's `titles` input) optional,
 *      comma-separated setKey filter; SLOT/SLOTS; CONCURRENCY=8;
 *      RUN_MINUTES=110; LIMIT=0; PLAN_OUT.
 * Requires dist/ (catalogAuthority, writeReconciliation).
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
const splitIdentity = require(path.join(__dirname, "lib", "split-identity.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();
const f = (n) => Number(n ?? 0).toLocaleString("en-US");
const csv = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const STARTED = Date.now();
const CLOCK = budget({ minutes: 110, reserveMs: 90 * 1000, verifyMs: 5 * 60 * 1000, startedAt: STARTED });
const CONCURRENCY = Math.min(32, Math.max(1, Number(process.env.CONCURRENCY || process.env.BACKFILL_CONCURRENCY || 8)));
const LIMIT = Number(process.env.LIMIT || 0);

const SHARD_SCOPE = runnerShardScope({ label: "reconcile-split-identity" });
const shardOf = (key) => parseInt(crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8), 16) % SHARD_SCOPE.SLOTS;

// ── THE SCOPE. `sport:year` cells, REQUIRED, no default and no whole-corpus
// mode -- same convention as every sibling repoint lane on this runner.
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

// ── THE PRODUCT FILTER. `titles` (SET_KEYS / BCP_TITLES) OPTIONALLY narrows
// to one or more setKeys within the dispatched scope cells. Empty means
// every setKey found under the cell's own STARTSWITH prefix.
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

/** The setKey a hiq: slug (grade-aware) names, or null when it does not
 *  parse at all. */
function slugSetKey(id, parseHobbyIqCardId) {
  const split = parseSlugWithGrade(id, parseHobbyIqCardId);
  return split ? split.parsed.setKey : null;
}

async function main() {
  console.log("");
  console.log("=".repeat(78));
  console.log("  RECONCILE: one card, one row, one pool -- a split identity's two");
  console.log("  addresses are settled onto whichever one the CHECKLIST attests");
  console.log("  (tonight's census, 2026-09-27 ~00:00Z, SPLIT-IDENTITY diagnostic)");
  console.log(`  MODE: ${APPLY ? "APPLY -- this run WRITES" : "REPORT ONLY -- nothing is written"}`);
  console.log("=".repeat(78));

  if (SCOPE_REJECTED.length) {
    console.error(`\nFATAL: SCOPE carries ${SCOPE_REJECTED.length} value(s) that are not sport:year cells: ${SCOPE_REJECTED.join(", ")}`);
    console.error("       Dispatch with -f scope=baseball:2026 (comma-separate for several cells).");
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
    scanned: 0, otherShard: 0, notHiqSplit: 0, candidates: 0,
    reconciledToHobbyiqCardId: 0, reconciledToCardId: 0, collapsedOntoResident: 0,
    refusedAmbiguousBothChecklist: 0, refusedNeitherChecklist: 0,
    refusedPossibleTwinAtDestination: 0, refusedEtagChanged: 0,
    failed: 0, notReached: 0,
  };
  let stoppedAtBudget = false;
  // Per-setKey counters -- the setKey named by the row's OWN hobbyiqCardId,
  // since that is the field the source scan itself is prefixed on.
  const perSetKey = new Map();
  function bucket(setKey) {
    if (!perSetKey.has(setKey)) {
      perSetKey.set(setKey, {
        candidates: 0, reconciledToHobbyiqCardId: 0, reconciledToCardId: 0,
        refusedAmbiguousBothChecklist: 0, refusedNeitherChecklist: 0,
        refusedPossibleTwinAtDestination: 0, gradedParse: 0,
      });
    }
    return perSetKey.get(setKey);
  }
  const examplesBySetKey = new Map();
  const examples = [];
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

    const cardId = String(sale.cardId || "");
    const hobbyiqCardId = String(sale.hobbyiqCardId || "");

    // THE CANDIDATE SHAPE, reused verbatim from lib/split-identity.cjs: both
    // sides must be hiq: slugs and they must differ. Anything else (a
    // one-sided identity, a foreign/vendor cardId, an already-coherent row)
    // is not this lane's shape and is NOT a candidate -- counted against
    // `scanned` only, per the #2441 lesson on pre-candidate refusals.
    const classified = splitIdentity.classifyIdentity(sale);
    if (classified.klass !== splitIdentity.HIQ_SPLIT) {
      s.notHiqSplit++;
      return;
    }
    s.candidates++;
    const st = bucket(setKey);
    st.candidates++;

    let cardIdRow, hobbyiqCardIdRow;
    try {
      [cardIdRow, hobbyiqCardIdRow] = await Promise.all([catalogRowAt(cardId), catalogRowAt(hobbyiqCardId)]);
    } catch (e) {
      s.failed++;
      const code = e?.code ?? e?.statusCode ?? "unknown";
      const msg = `FAILED catalog-read ${sale.id}@${cardId} (hobbyiqCardId ${hobbyiqCardId}): [${code}] ${e?.message || e} -- nothing written, sale untouched`;
      failures.push(`  ${msg}`);
      emitPlanRow(sale, "failed", "catalog-read", { fromId: cardId, toId: hobbyiqCardId, error: `[${code}] ${e?.message || String(e)}` });
      console.log(`\n::warning::${msg}`);
      return;
    }

    const cardIdIsChecklist = cardIdRow ? isChecklist(cardIdRow.source) : false;
    const hobbyiqCardIdIsChecklist = hobbyiqCardIdRow ? isChecklist(hobbyiqCardIdRow.source) : false;

    if (cardIdIsChecklist && hobbyiqCardIdIsChecklist) {
      // BOTH sides attested -- the catalog names two winners. A guess
      // between them would be ours, never Drew's. REFUSE, log by setKey.
      s.refusedAmbiguousBothChecklist++;
      st.refusedAmbiguousBothChecklist++;
      emitPlanRow(sale, "refused", "ambiguous-both-checklist", { fromId: cardId, toId: hobbyiqCardId });
      return;
    }
    if (!cardIdIsChecklist && !hobbyiqCardIdIsChecklist) {
      // NEITHER side attested -- an acquisition gap, the rematch's job.
      s.refusedNeitherChecklist++;
      st.refusedNeitherChecklist++;
      emitPlanRow(sale, "refused", "neither-checklist", { fromId: cardId, toId: hobbyiqCardId });
      return;
    }

    // Exactly one side is checklist-grade -- that id wins. sold_comps is
    // partitioned on /cardId, so any row whose winner differs from its OWN
    // cardId MOVES (relocateSoldComp); a winner that is ALREADY the row's
    // own cardId needs no partition change at all -- only the wrong
    // hobbyiqCardId field is stale, so this is a PATCH IN PLACE, never a
    // relocate. Written through the SAME upsert relocateSoldComp itself
    // uses, so the field write goes through the identical guard
    // (splitIdentityWriteGuard) every other write on this container does;
    // `drop: []` makes it a pure upsert with nothing to delete.
    const winningId = hobbyiqCardIdIsChecklist ? hobbyiqCardId : cardId;
    const toHobbyiqCardId = hobbyiqCardIdIsChecklist;
    const isPatchInPlace = winningId === cardId;

    const exList = examplesBySetKey.get(setKey) ?? [];
    if (exList.length < 10) {
      exList.push(`  ${sale.id}: ${cardId} || ${hobbyiqCardId} -> ${winningId}  ("${String(sale.title ?? "").slice(0, 90)}")`);
      examplesBySetKey.set(setKey, exList);
    }
    if (examples.length < 10) examples.push(`  ${sale.id}: ${cardId} || ${hobbyiqCardId} -> ${winningId}  ("${String(sale.title ?? "").slice(0, 90)}")`);

    if (isPatchInPlace) {
      try {
        const keep = stripSystem({ ...sale, cardId: winningId, hobbyiqCardId: winningId });
        const result = await relocateSoldComp(pool, {
          keep, drop: [],
          verifyFields: ["cardId", "hobbyiqCardId"],
          dryRun: !APPLY,
        });
        if (result?.ok) {
          if (toHobbyiqCardId) { s.reconciledToHobbyiqCardId++; st.reconciledToHobbyiqCardId++; }
          else { s.reconciledToCardId++; st.reconciledToCardId++; }
          emitPlanRow(sale, "patch", "checklist-attested-in-place", { fromId: cardId, toId: winningId });
        } else {
          s.failed++;
          const stage = result?.stage ?? "unknown";
          const errMsg = result?.error ?? "unknown";
          const msg = `FAILED patch-in-place ${sale.id}@${cardId}: [stage=${stage}] ${errMsg}`;
          failures.push(`  ${msg}`);
          emitPlanRow(sale, "failed", "patch-in-place", { fromId: cardId, toId: winningId, error: `[stage=${stage}] ${errMsg}` });
          console.log(`\n::warning::${msg}`);
        }
      } catch (e) {
        s.failed++;
        const code = e?.code ?? e?.statusCode ?? "unknown";
        const msg = `FAILED patch-in-place ${sale.id}@${cardId}: [${code}] ${e?.message || e}`;
        failures.push(`  ${msg}`);
        emitPlanRow(sale, "failed", "patch-in-place-threw", { fromId: cardId, toId: winningId, error: `[${code}] ${e?.message || String(e)}` });
        console.log(`\n::warning::${msg}`);
      }
      return;
    }

    // Collision / twin detection runs in BOTH modes -- a REPORT must show
    // what would happen, mirrors every sibling repoint lane.
    const resident = await residentAt(sale.id, winningId);
    if (resident) {
      if (contentHashOf(resident) === contentHashOf({ ...sale, cardId: winningId, hobbyiqCardId: winningId })) {
        s.collapsedOntoResident++;
        if (APPLY) { try { await pool.item(sale.id, sale.cardId).delete(); } catch { /* best effort; proven duplicate either way */ } }
        emitPlanRow(sale, "collapse", "same-sale-resident", { fromId: cardId, toId: winningId });
        return;
      }
      s.refusedPossibleTwinAtDestination++;
      st.refusedPossibleTwinAtDestination++;
      refusals["possible-twin-at-destination"].push(`  ${sale.id}@${cardId} -> ${winningId}: a DIFFERENT document already resides at (${sale.id}, ${winningId}) -- refused, neither moved`);
      emitPlanRow(sale, "refused", "possible-twin-at-destination", { fromId: cardId, toId: winningId });
      return;
    }

    try {
      const keep = stripSystem({ ...sale, cardId: winningId, hobbyiqCardId: winningId });
      const result = await relocateSoldComp(pool, {
        keep, drop: [{ id: sale.id, cardId: sale.cardId }],
        verifyFields: ["cardId", "hobbyiqCardId"],
        dryRun: !APPLY,
      });
      if (result?.ok) {
        if (toHobbyiqCardId) { s.reconciledToHobbyiqCardId++; st.reconciledToHobbyiqCardId++; }
        else { s.reconciledToCardId++; st.reconciledToCardId++; }
        emitPlanRow(sale, "move", "checklist-attested", { fromId: cardId, toId: winningId });
      } else if (result?.staleSincePlan?.length) {
        s.refusedEtagChanged++;
        emitPlanRow(sale, "refused", "stale-since-plan", { fromId: cardId, toId: winningId });
      } else {
        s.failed++;
        const duplicateLeft = Array.isArray(result?.duplicatesLeft) && result.duplicatesLeft.length > 0;
        const stage = result?.stage ?? "unknown";
        const errMsg = result?.error ?? "unknown";
        const state = duplicateLeft
          ? `DUPLICATE LEFT -- keeper upserted+verified at ${winningId}, old row at ${sale.cardId} was NOT deleted; sale now resident at BOTH addresses`
          : `nothing written -- sale untouched at its old address ${sale.cardId}`;
        const msg = `FAILED relocate ${sale.id}@${cardId} -> ${winningId}: [stage=${stage}] ${errMsg} -- ${state}`;
        failures.push(`  ${msg}`);
        emitPlanRow(sale, "failed", "relocate", { fromId: cardId, toId: winningId, error: `[stage=${stage}] ${errMsg}` });
        console.log(`\n::warning::${msg}`);
      }
    } catch (e) {
      s.failed++;
      const code = e?.code ?? e?.statusCode ?? "unknown";
      const msg = `FAILED relocate ${sale.id}@${cardId} -> ${winningId}: [${code}] ${e?.message || e} -- UNKNOWN whether the write landed before the throw; verify both addresses`;
      failures.push(`  ${msg}`);
      emitPlanRow(sale, "failed", "relocate-threw", { fromId: cardId, toId: winningId, error: `[${code}] ${e?.message || String(e)}` });
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
    // One query per cell when `titles` is empty -- GROUP BY / cross-
    // partition discovery is forbidden, so a bare cell scan buckets each row
    // by the setKey ITS OWN id names, never by a filter string.
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
      await runPool(rows, async (row) => {
        const setKey = slugSetKey(String(row.hobbyiqCardId || row.cardId || ""), parseHobbyIqCardId);
        if (!setKey) {
          const st = bucket(setKeyFilter || "(unparsed)");
          st.gradedParse++;
          s.scanned++;
          emitPlanRow(row, "refused", "graded-parse", { fromId: String(row.cardId || ""), toId: String(row.hobbyiqCardId || "") });
          return;
        }
        if (setKeyFilter && setKey !== setKeyFilter) return; // defensive; STARTSWITH already scoped this
        await processSale(row, setKey);
      });
    }
  }

  console.log("");
  console.log("  PER-SETKEY COUNTS:");
  const sortedSetKeys = [...perSetKey.entries()].sort((a, b) => b[1].candidates - a[1].candidates);
  for (const [setKey, st] of sortedSetKeys) {
    console.log(`\n  setKey: ${setKey}`);
    console.log(`    candidates                       ${f(st.candidates)}`);
    console.log(`    ${APPLY ? "reconciled-to-hobbyiqCardId" : "would-reconcile-to-hobbyiqCardId"}  ${f(st.reconciledToHobbyiqCardId)}`);
    console.log(`    ${APPLY ? "reconciled-to-cardId       " : "would-reconcile-to-cardId       "}  ${f(st.reconciledToCardId)}`);
    console.log(`    refused-ambiguous-both-checklist  ${f(st.refusedAmbiguousBothChecklist)}`);
    console.log(`    refused-neither-checklist         ${f(st.refusedNeitherChecklist)}`);
    console.log(`    refused-possible-twin             ${f(st.refusedPossibleTwinAtDestination)}`);
    console.log(`    graded-parse                      ${f(st.gradedParse)}`);
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
  if (failures.length) {
    console.log(`\n  FAILURES (${f(failures.length)}), every one listed:`);
    for (const line of failures) console.log(line);
  }

  const reconciledTotal = s.reconciledToHobbyiqCardId + s.reconciledToCardId;
  console.log("");
  console.log(`sales scanned                             ${f(s.scanned)}${SHARD_SCOPE.SHARDED ? `  (${f(s.otherShard)} in other shards)` : ""}`);
  console.log(`  not-hiq-split (not this lane's shape)   ${f(s.notHiqSplit)}`);
  console.log(`  candidates (HIQ-SPLIT rows)             ${f(s.candidates)}`);
  console.log(`  ${APPLY ? "RECONCILED" : "WOULD RECONCILE"}                        ${f(reconciledTotal)}`);
  console.log(`    -> to hobbyiqCardId                   ${f(s.reconciledToHobbyiqCardId)}`);
  console.log(`    -> to cardId                          ${f(s.reconciledToCardId)}`);
  console.log(`  COLLAPSED onto a resident (same sale)   ${f(s.collapsedOntoResident)}`);
  console.log(`  REFUSED: ambiguous-both-checklist       ${f(s.refusedAmbiguousBothChecklist)}`);
  console.log(`  REFUSED: neither-checklist              ${f(s.refusedNeitherChecklist)}`);
  console.log(`  REFUSED: possible-twin-at-destination   ${f(s.refusedPossibleTwinAtDestination)}`);
  console.log(`  REFUSED: stale since the read            ${f(s.refusedEtagChanged)}`);
  console.log(`  failed                                  ${f(s.failed)}`);
  console.log(`  not reached (budget)                     ${f(s.notReached)}`);
  if (stoppedAtBudget || CLOCK.outOfClock()) {
    console.log(`  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- the slot has more to do`);
  }
  if (!APPLY) console.log(`\nREPORT ONLY -- nothing was written. Re-run with BACKFILL_APPLY=true to apply.`);

  // RECONCILE. Every candidate is reconciled, collapsed onto a proven
  // duplicate, refused (named), failed, or not reached before the budget --
  // never silently dropped. `notHiqSplit` and `gradedParse` are counted
  // against `scanned`, not `candidates` -- a row that never became a
  // candidate never entered this population (the #2441 lesson: folding a
  // pre-candidate refusal into the candidate reconcile produces a FALSE
  // MISMATCH the instant scanning meets even one non-candidate row).
  const candidateOutcomes = reconciledTotal + s.collapsedOntoResident
    + s.refusedAmbiguousBothChecklist + s.refusedNeitherChecklist
    + s.refusedPossibleTwinAtDestination + s.refusedEtagChanged
    + s.failed + s.notReached;
  console.log(`\n  reconciled: candidates ${f(s.candidates)} = accounted-for ${f(candidateOutcomes)}`);
  if (candidateOutcomes !== s.candidates) {
    console.error("  !! RECONCILE MISMATCH -- a candidate was neither reconciled, collapsed, refused, failed nor left unreached");
    process.exitCode = 4;
  }

  const refusedTotal = s.refusedAmbiguousBothChecklist + s.refusedNeitherChecklist
    + s.refusedPossibleTwinAtDestination + s.refusedEtagChanged;
  if (APPLY) {
    reportWrites({
      job: "reconcile-split-identity",
      intended: s.candidates,
      written: reconciledTotal + s.collapsedOntoResident,
      refused: refusedTotal,
      skipped: s.notReached,
      failed: s.failed,
    });
  }

  if (s.failed) { console.error(`::error::${f(s.failed)} sale(s) failed.`); process.exitCode = 4; }
}

module.exports = {
  INHERITED_SCOPES, WILDCARDS, CELL_RE, slugSetKey,
};

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx || { budget: CLOCK }))
    .catch(async (e) => { console.error("::error::" + (e?.stack ?? e)); finishLane(1, { budget: CLOCK }); });
}
