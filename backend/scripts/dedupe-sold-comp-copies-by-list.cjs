#!/usr/bin/env node
/**
 * dedupe-sold-comp-copies-by-list.cjs -- CF-THE-LIST-IS-THE-SCOPE, for stray
 * DUPLICATE COPIES of one sale in sold_comps (Drew, 2026-09-27 ~23:56Z:
 * "Build lane + census; REPORT first").
 *
 * sold_comps ids (`${source}::${externalId}`) are unique only WITHIN a
 * partition (pk /cardId). Today's audits found the SAME sale stored as two
 * or more physical documents under different cardIds -- raw vendor ids,
 * malformed legacy slugs, numbered-variant slugs, wrong-sport or
 * wrong-setKey addresses. This lane DELETES the stray copy of a sale, never
 * moves or re-derives anything: the surviving copy already sits at the
 * checklist id the list names, so there is nothing to relocate. It is the
 * narrowest possible write -- one gated DELETE per stray, per entry -- and
 * it is intentionally NOT repoint-sales-by-list.cjs's job (that lane moves a
 * sale from one address to another; this one removes a copy that should
 * never have existed once the checklist-id copy is already resident).
 *
 * ────────────────────────────────────────────────────────────────────────
 * DOCTRINE: "COLLISION IS NOT A DUPLICATE"
 * ────────────────────────────────────────────────────────────────────────
 *
 * Two documents sharing a saleId are not automatically the same sale stored
 * twice -- a right guard in the wrong scope, or a census that never
 * resolved which copy is the keeper, looks identical at a glance to a
 * genuine duplicate. So this lane deletes ONLY when it is PROVABLY the same
 * sale: every content-identity field (source, externalId, title, price,
 * soldAt, grade fields, currency) must agree between the keeper and the
 * stray, gated AT THE DELETE CALL, per row, never from a batch snapshot
 * taken earlier. A 10/10 spot check on today's evidence found the stray and
 * the keeper byte-identical on title/price/soldAt -- this lane re-derives
 * that check itself rather than trusting the list's own say-so.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE GATES, PER ENTRY, AT THE DELETE CALL -- EACH NAMED AND COUNTED
 * ────────────────────────────────────────────────────────────────────────
 *
 *   (a) POINT-READ THE KEEPER at (saleId, keepCardId). Must exist --
 *       REFUSED (no-keeper) if not. The keeper's own cardId AND
 *       hobbyiqCardId must both equal keepCardId (a keeper that is itself
 *       mid-move, or that carries a stale hobbyiqCardId, is not yet the
 *       settled destination this lane is allowed to declare a survivor for)
 *       -- REFUSED (keeper-not-settled) otherwise. keepCardId's own
 *       card_catalog row must exist and be CHECKLIST-GRADE
 *       (catalogAuthorityOf(row.source) === "checklist") -- "present is not
 *       checklist-grade", exactly repoint-sales-by-list.cjs's own gate 1/2 --
 *       REFUSED (no-catalog-row) / REFUSED (not-checklist-grade) otherwise.
 *   (b) POINT-READ THE STRAY at (saleId, deleteCardId). Absent is not a
 *       failure: another lane (or this one's own earlier pass) may already
 *       have removed it -- SKIPPED (already-gone), counted, never retried
 *       as a delete.
 *   (c) CONTENT IDENTITY. source, externalId (when either side carries
 *       one), title, price/soldPrice, soldAt/date, gradeCompany, gradeValue
 *       and currency must agree between the keeper and the stray -- the
 *       same sale-content fields lib/relocate-sold-comp.cjs's own
 *       `contentHashOf` treats as identity, reused here via `varianceOf`
 *       rather than reimplemented, EXCLUDING cardId/hobbyiqCardId/parallel
 *       (a keeper and a stray legitimately differ on their own address, and
 *       `parallel` is address-shaped for the isauto-twins population this
 *       lane's own committed lists carry -- a no-auto/auto pair is the
 *       SAME sale event mis-filed onto the wrong parallel spelling, not two
 *       different sales). ANY other difference -- REFUSED (content-differs),
 *       and the stray is NEVER deleted.
 *   (d) deleteCardId must not equal keepCardId -- REFUSED (same-id), a list
 *       defect never silently skipped.
 *   (e) AFTER the delete, a CROSS-PARTITION verify (`SELECT c.id, c.cardId
 *       FROM c WHERE c.id = @id`) must return EXACTLY the keeper (count 1).
 *       Anything else -- zero, more than one, or the wrong one -- is
 *       FAILED (extra-copies-remain), with every extra listed by its own
 *       cardId. A THROWN read-back is FAILED too, never read as clean (the
 *       same rule relocateSoldComp's own header states for its verify).
 *
 * ────────────────────────────────────────────────────────────────────────
 * REPORT vs APPLY
 * ────────────────────────────────────────────────────────────────────────
 *
 * REPORT (apply=false, the default) computes EXACTLY what APPLY would --
 * every gate, every content-identity comparison -- and writes nothing: the
 * delete call itself is skipped in REPORT, never issued and rolled back.
 * This mirrors relocate-catalog-rows-by-list.cjs's own REPORT/APPLY split
 * (one derivation, one gated call, `dryRun`/apply decided at the single
 * write site) rather than inventing a parallel no-op branch that could skip
 * a check APPLY would hit.
 *
 * ────────────────────────────────────────────────────────────────────────
 * BUDGET + RELAUNCH
 * ────────────────────────────────────────────────────────────────────────
 *
 * A unit here is ONE STRAY COPY CONSIDERED (an entry can name only one
 * stray -- unlike repoint-sales-by-list.cjs's entries, which can each carry
 * many sales, this lane's list schema is one row per stray copy by
 * construction, see the header on the list files themselves). `budget()`/
 * `finishLane()` (lib/runner-budget.cjs) own the clock, the keepalive and
 * the exit discipline. The loop is idempotent: a re-run of a finished list
 * finds the stray already gone (SKIPPED already-gone) and writes nothing
 * further, so a relaunch after a budget stop costs one cheap point read per
 * settled entry.
 *
 * Env: COSMOS_CONNECTION_STRING; BACKFILL_APPLY/APPLY; SCOPE=<list file>
 *      (path relative to backend/; REQUIRED -- this lane deletes, so it has
 *      no default list, matching relocate-catalog-rows-by-list's own
 *      convention: a list-scoped DELETE lane with no default is safer than
 *      one that silently substitutes a population nobody named).
 * Requires dist/ (catalogAuthority.service.js and writeReconciliation.js).
 */
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const backend = path.resolve(__dirname, "..");
const { budget, finishLane } = require(path.join(__dirname, "lib", "runner-budget.cjs"));
const { withBackoff } = require(path.join(__dirname, "lib", "cosmos-backoff.cjs"));
const { pkOf } = require(path.join(__dirname, "lib", "catalog-none-pk.cjs"));

const APPLY = String(process.env.BACKFILL_APPLY || process.env.APPLY || "") === "true";
const f = (n) => Number(n ?? 0).toLocaleString("en-US");

// CF-A-WHOLE-SCOPE-WRITE-REFUSES-WITHOUT-ITS-SCOPE (D-06, R3), matching
// repoint-sales-by-list.cjs and relocate-catalog-rows-by-list.cjs exactly:
// `scope` is shared with every other lane on this runner and carries THEIR
// vocabulary. There is no default list -- an absent or non-.json scope is
// FATAL, never read as "everything" or as some other lane's population.
const RAW_SCOPE = String(process.env.SCOPE || "").trim();
const SCOPE_ERROR = (() => {
  if (!RAW_SCOPE) {
    return "FATAL: SCOPE is empty. This lane deletes sold_comps rows and has no default list — "
      + "name the committed .json list to run (e.g. SCOPE=data/sold-comp-dedupes/<file>.json).";
  }
  if (!RAW_SCOPE.endsWith(".json")) {
    return `FATAL: SCOPE="${RAW_SCOPE}" does not name a list file. This lane's scope is a `
      + "committed .json list of (saleId, keepCardId, deleteCardId) triples — never a predicate, "
      + "a product key, or another lane's vocabulary.";
  }
  return null;
})();
const SCOPE = RAW_SCOPE;

/**
 * An entry names a saleId, its keeper and its stray, and nothing about it is
 * inferred. Returns { ok, ...fields } where a falsy `ok` carries the
 * refusal text.
 */
function classifyEntry(e) {
  const saleId = String(e?.saleId ?? "").trim();
  const keepCardId = String(e?.keepCardId ?? "").trim();
  const deleteCardId = String(e?.deleteCardId ?? "").trim();
  const reason = String(e?.reason ?? "").trim();
  if (!saleId) return { ok: false, why: "entry has no saleId" };
  if (!keepCardId) return { ok: false, why: `entry has no keepCardId: ${saleId.slice(0, 60)}` };
  if (!keepCardId.startsWith("hiq:")) return { ok: false, why: `keepCardId is not a hiq slug: ${keepCardId.slice(0, 60)}` };
  if (!deleteCardId) return { ok: false, why: `entry has no deleteCardId: ${saleId.slice(0, 60)}` };
  if (deleteCardId === keepCardId) return { ok: false, why: `deleteCardId equals keepCardId: ${saleId.slice(0, 60)}` };
  if (!reason) return { ok: false, why: `entry has no reason: ${saleId.slice(0, 60)}` };
  return { ok: true, saleId, keepCardId, deleteCardId, reason };
}

/**
 * The content-identity fields this lane compares between a keeper and a
 * stray, mirroring lib/relocate-sold-comp.cjs's own `contentHashOf` inputs
 * MINUS the address fields (cardId/hobbyiqCardId, which a keeper and a
 * stray are EXPECTED to differ on) and MINUS `parallel` (address-shaped for
 * this lane's own isauto-twins lists -- a no-auto/auto spelling difference
 * is the reason the sale was mis-filed twice, not evidence the two
 * documents describe different sales). `currency` and `externalId` are
 * added on top of contentHashOf's own set: the hash never included them,
 * but a genuine content-identity check for "is this literally the same
 * sale" should, when either document carries one.
 */
const IDENTITY_FIELDS = [
  "source", "externalId", "title", "price", "soldPrice", "soldAt", "date",
  "gradeCompany", "gradeValue", "currency",
];

/** Does an error carry a Cosmos 404? */
function is404(e) {
  return e?.code === 404 || e?.statusCode === 404;
}

async function main() {
  if (SCOPE_ERROR) { console.error(SCOPE_ERROR); process.exit(1); }

  const { CosmosClient } = require("@azure/cosmos");
  const { catalogAuthorityOf } = require(path.join(backend, "dist/services/catalog/catalogAuthority.service.js"));
  const { reportWrites } = require(path.join(backend, "dist/services/ops/writeReconciliation.js"));
  const { varianceOf } = require(path.join(__dirname, "lib", "relocate-sold-comp.cjs"));
  const { recordDeleteOrThrow, isLedgerWriteFailure } = require(path.join(__dirname, "lib", "delete-ledger.cjs"));

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) { console.error("FATAL: COSMOS_CONNECTION_STRING not set"); process.exit(1); }

  // The list IS the scope. A missing or empty file is a refusal, never a
  // silent no-op that looks like success.
  const listPath = path.isAbsolute(SCOPE) ? SCOPE : path.join(backend, SCOPE);
  if (!fs.existsSync(listPath)) {
    console.error(`FATAL: scope list not found: ${listPath}`);
    console.error("This lane refuses to run without an explicit committed list.");
    process.exit(1);
  }
  const doc = JSON.parse(fs.readFileSync(listPath, "utf8"));
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  if (entries.length === 0) {
    console.error(`FATAL: ${SCOPE} names no entries — nothing is in scope.`);
    process.exit(1);
  }

  console.log(`scope file              ${SCOPE}`);
  console.log(`for lane                ${doc.forLane ?? "(unlabelled)"}`);
  console.log(`entries in scope        ${f(entries.length)}`);
  if (doc.finding) console.log(`  finding: ${String(doc.finding).slice(0, 200)}`);

  // The client is NAMED rather than chained away, so finishLane() can
  // dispose it -- an undisposed SDK keeps keep-alive sockets open (#1809).
  const client = new CosmosClient({
    connectionString: conn,
    connectionPolicy: { retryOptions: { maxRetryAttemptsOnThrottledRequests: 60, maxWaitTimeInSeconds: 300 } },
  });
  const db = client.database(process.env.COSMOS_DATABASE || "hobbyiq");
  const cat = db.container("card_catalog");
  const pool = db.container("sold_comps");

  const retry = (fn) => withBackoff(fn, { label: "dedupe-sold-comp-copies-by-list" });

  const catalogRowAt = async (id) => {
    // A row without cardId lives at Cosmos's own None partition key, so the
    // point read must use pkOf's decision, never a bare (id, id) guess.
    try { return (await retry(() => cat.item(id, id).read())).resource ?? null; }
    catch (err) {
      if (err?.code !== 404 && err?.statusCode !== 404) throw err;
    }
    try {
      const nonePk = pkOf({});
      return (await retry(() => cat.item(id, nonePk).read())).resource ?? null;
    } catch (err) {
      if (err?.code === 404 || err?.statusCode === 404) return null;
      throw err;
    }
  };

  // ── THE CLOCK. A unit is ONE STRAY COPY CONSIDERED: a point-read of the
  // keeper, a point-read of the stray, an optional delete, and a
  // cross-partition verify. Sized like repoint-sales-by-list.cjs's own
  // per-sale reserve (create+verify+delete there vs read+delete+verify
  // here — the same three-round-trip shape).
  const CLOCK = budget({ minutes: 110, reserveMs: 30 * 1000, verifyMs: 60 * 1000 });
  console.log(`  ${CLOCK.describe()}`);
  console.log("");

  let deleted = 0;
  let skippedAlreadyGone = 0;
  let refusedNoKeeper = 0, refusedKeeperNotSettled = 0, refusedNoCatalogRow = 0, refusedNotChecklistGrade = 0;
  let refusedContentDiffers = 0, refusedSameId = 0;
  let failed = 0;
  let ledgerWriteFailed = 0;
  let entriesFailedToClassify = 0;
  let stoppedAt = null;
  let considered = 0;

  const PLAN_OUT = String(process.env.PLAN_OUT || "").trim();
  let planFd = null;
  if (PLAN_OUT) {
    try {
      fs.mkdirSync(PLAN_OUT, { recursive: true });
      const planPath = path.join(PLAN_OUT, "dedupe-sold-comp-copies-by-list-plan.ndjson");
      planFd = fs.openSync(planPath, "w");
      console.log(`  plan file         ${planPath}`);
    } catch (e) {
      console.log(`\n::warning::could not open PLAN_OUT (${PLAN_OUT}): ${e?.message}`);
      planFd = null;
    }
  }
  function emitPlanRow(record) {
    if (!planFd) return;
    try { fs.appendFileSync(planFd, JSON.stringify(record) + "\n"); }
    catch (e) { console.log(`\n::warning::PLAN_OUT write failed: ${e?.message}`); }
  }

  for (const e of entries) {
    if (CLOCK.outOfClock()) { stoppedAt = considered; break; }
    considered++;
    const c = classifyEntry(e);
    if (!c.ok) {
      entriesFailedToClassify++;
      console.error(`  MALFORMED — ${c.why}`);
      continue;
    }
    const { saleId, keepCardId, deleteCardId, reason } = c;

    console.log(`\n  ENTRY  ${saleId.slice(0, 66)}`);
    console.log(`      keep   ${keepCardId.slice(0, 66)}`);
    console.log(`      delete ${deleteCardId.slice(0, 66)}`);
    console.log(`      reason: ${reason.slice(0, 120)}`);

    // ── GATE (d): deleteCardId must not equal keepCardId ────────────────
    // classifyEntry already refuses this at parse time; kept here as a
    // belt-and-suspenders count in case a future caller drives the gates
    // directly with a hand-built entry object.
    if (deleteCardId === keepCardId) {
      refusedSameId++;
      console.error("      REFUSED (same-id): deleteCardId equals keepCardId");
      emitPlanRow({ action: "refused", reason: "same-id", saleId, keepCardId, deleteCardId });
      continue;
    }

    // ── GATE (a): point-read the KEEPER; must exist, be settled, and its
    // catalog row must be checklist-grade ───────────────────────────────
    let keeper;
    try {
      keeper = (await retry(() => pool.item(saleId, keepCardId).read())).resource ?? null;
    } catch (err) {
      if (is404(err)) keeper = null;
      else {
        failed++;
        console.error(`      FAILED: keeper read threw — ${String(err?.message ?? err).slice(0, 100)}`);
        emitPlanRow({ action: "failed", reason: "keeper-read-threw", saleId, keepCardId, deleteCardId, error: String(err?.message ?? err) });
        continue;
      }
    }
    if (!keeper) {
      refusedNoKeeper++;
      console.error("      REFUSED (no-keeper): saleId has no document at keepCardId");
      emitPlanRow({ action: "refused", reason: "no-keeper", saleId, keepCardId, deleteCardId });
      continue;
    }
    if (keeper.cardId !== keepCardId || keeper.hobbyiqCardId !== keepCardId) {
      refusedKeeperNotSettled++;
      console.error(`      REFUSED (keeper-not-settled): keeper's own cardId/hobbyiqCardId (${keeper.cardId}/${keeper.hobbyiqCardId}) does not both equal keepCardId`);
      emitPlanRow({ action: "refused", reason: "keeper-not-settled", saleId, keepCardId, deleteCardId, keeperCardId: keeper.cardId, keeperHobbyiqCardId: keeper.hobbyiqCardId });
      continue;
    }

    let keeperCatalogRow;
    try {
      keeperCatalogRow = await catalogRowAt(keepCardId);
    } catch (err) {
      failed++;
      console.error(`      FAILED: keeper catalog read threw — ${String(err?.message ?? err).slice(0, 100)}`);
      emitPlanRow({ action: "failed", reason: "catalog-read-threw", saleId, keepCardId, deleteCardId, error: String(err?.message ?? err) });
      continue;
    }
    if (!keeperCatalogRow) {
      refusedNoCatalogRow++;
      console.error("      REFUSED (no-catalog-row): keepCardId has no card_catalog row");
      emitPlanRow({ action: "refused", reason: "no-catalog-row", saleId, keepCardId, deleteCardId });
      continue;
    }
    const keeperAuthority = catalogAuthorityOf(keeperCatalogRow.source);
    if (keeperAuthority !== "checklist") {
      refusedNotChecklistGrade++;
      console.error(`      REFUSED (not-checklist-grade): keepCardId's row authority is "${keeperAuthority}", not checklist — present is not checklist-grade`);
      emitPlanRow({ action: "refused", reason: "not-checklist-grade", saleId, keepCardId, deleteCardId, authority: keeperAuthority });
      continue;
    }

    // ── GATE (b): point-read the STRAY; absent is a benign SKIP ─────────
    let stray;
    try {
      stray = (await retry(() => pool.item(saleId, deleteCardId).read())).resource ?? null;
    } catch (err) {
      if (is404(err)) stray = null;
      else {
        failed++;
        console.error(`      FAILED: stray read threw — ${String(err?.message ?? err).slice(0, 100)}`);
        emitPlanRow({ action: "failed", reason: "stray-read-threw", saleId, keepCardId, deleteCardId, error: String(err?.message ?? err) });
        continue;
      }
    }
    if (!stray) {
      skippedAlreadyGone++;
      console.log("      SKIPPED (already-gone): no document at deleteCardId — nothing to delete");
      emitPlanRow({ action: "skipped", reason: "already-gone", saleId, keepCardId, deleteCardId });
      continue;
    }

    // ── GATE (c): CONTENT IDENTITY, gated fresh at the delete call, never
    // from a batch snapshot ─────────────────────────────────────────────
    const variance = varianceOf([keeper, stray], IDENTITY_FIELDS);
    if (variance.differing.length > 0) {
      refusedContentDiffers++;
      console.error(`      REFUSED (content-differs): ${variance.differing.join(", ")} disagree between the keeper and the stray — never deleted`);
      emitPlanRow({ action: "refused", reason: "content-differs", saleId, keepCardId, deleteCardId, differing: variance.differing, values: variance.values });
      continue;
    }

    // CF-A-DOUBLED-YEAR-IS-NOT-A-DIFFERENT-SALE / CF-SOLDAT-FORMAT-IS-NOT-
    // CONTENT (2026-09-28 dedupe census): varianceOf normalizes `title`
    // (doubled leading year, whitespace) and `soldAt`/`date` (parsed
    // instant, so a +00:00 offset and a .000Z suffix for the SAME moment
    // agree) before comparing. `normalizedFields` names which of the
    // CHECKED fields had a normalizer applied at all -- not only the ones
    // that actually differed byte-for-byte -- so this line can say plainly
    // whether normalization was even in play for this pair, independent of
    // whether it was the reason the gate passed.
    if (variance.normalizedFields?.length) {
      console.log(`      (content identity used normalized comparison on: ${variance.normalizedFields.join(", ")})`);
    }

    // ── THE DELETE. REPORT computes every gate above identically and
    // stops HERE — the delete call itself is the ONLY branch point between
    // REPORT and APPLY, mirroring repoint-sales-by-list.cjs's own single
    // relocateSoldComp call gated on dryRun. ────────────────────────────
    if (!APPLY) {
      deleted++;
      console.log("      WOULD DELETE the stray — content identity confirmed, keeper settled and checklist-grade");
      emitPlanRow({ action: "would-delete", saleId, keepCardId, deleteCardId, normalizedFields: variance.normalizedFields });
      continue;
    }

    // CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-LEDGER-LINE-FIRST (2026-09-28):
    // `stray` is the full pre-delete document from GATE (b)'s own read. A
    // ledger-write failure refuses the delete outright -- counted apart
    // from an ordinary delete-threw failure, and the Cosmos delete call is
    // never reached without a durable copy of the row it is about to
    // remove.
    try {
      await recordDeleteOrThrow(stray, {
        lane: "dedupe-sold-comp-copies-by-list", action: "delete", reason,
        toId: keepCardId, container: "sold_comps",
      });
    } catch (err) {
      if (isLedgerWriteFailure(err)) ledgerWriteFailed++;
      failed++;
      console.error(`      FAILED: ledger write refused the delete — ${String(err?.message ?? err).slice(0, 100)}`);
      emitPlanRow({ action: "failed", reason: "ledger-write-failed", saleId, keepCardId, deleteCardId, error: String(err?.message ?? err) });
      continue;
    }

    try {
      await retry(() => pool.item(saleId, deleteCardId).delete());
    } catch (err) {
      if (is404(err)) {
        // Gone since GATE (b)'s own read -- a benign concurrent mutation
        // (another lane, or an idempotent re-run of this one), never a
        // failure. Counted as already-gone rather than a delete this run
        // performed, so the reconcile's `deleted` count reflects only what
        // THIS run actually removed.
        skippedAlreadyGone++;
        console.log("      SKIPPED (already-gone): stray vanished between the read and the delete");
        emitPlanRow({ action: "skipped", reason: "already-gone", saleId, keepCardId, deleteCardId });
        continue;
      }
      failed++;
      console.error(`      FAILED: delete threw — ${String(err?.message ?? err).slice(0, 100)}`);
      emitPlanRow({ action: "failed", reason: "delete-threw", saleId, keepCardId, deleteCardId, error: String(err?.message ?? err) });
      continue;
    }

    // ── GATE (e): cross-partition verify — exactly one document, the
    // keeper, answers to this id afterward ──────────────────────────────
    let verifyRows;
    try {
      const res = await retry(() => pool.items.query({
        query: "SELECT c.id, c.cardId FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: saleId }],
      }).fetchAll());
      verifyRows = res?.resources ?? [];
    } catch (err) {
      // A THROWN read-back is FAILED, never clean -- the same rule
      // relocateSoldComp's own verify applies (lib/relocate-sold-comp.cjs).
      // The delete already happened; this run does not know the true state
      // of the pool, so it must not report success on a guess.
      failed++;
      console.error(`      FAILED: post-delete verify threw — ${String(err?.message ?? err).slice(0, 100)}`);
      emitPlanRow({ action: "failed", reason: "verify-threw", saleId, keepCardId, deleteCardId, error: String(err?.message ?? err) });
      continue;
    }
    const extras = verifyRows.filter((r) => r.cardId !== keepCardId);
    if (verifyRows.length !== 1 || extras.length > 0) {
      failed++;
      console.error(`      FAILED (extra-copies-remain): post-delete verify found ${verifyRows.length} document(s) for this id, expected exactly 1 (the keeper)`);
      for (const extra of extras) console.error(`        EXTRA COPY: cardId=${extra.cardId}`);
      emitPlanRow({ action: "failed", reason: "extra-copies-remain", saleId, keepCardId, deleteCardId, extras: verifyRows });
      continue;
    }

    deleted++;
    console.log("      DELETED — verified exactly one copy remains, at keepCardId");
    emitPlanRow({ action: "deleted", saleId, keepCardId, deleteCardId, normalizedFields: variance.normalizedFields });
  }

  console.log(`\n${APPLY ? "APPLY" : "REPORT ONLY — nothing written"}`);
  console.log(`  entries in scope             ${f(entries.length)}`);
  console.log(`  entries considered           ${f(considered)}${stoppedAt === null ? "   <- the whole list" : ""}`);
  console.log(`  entries malformed            ${f(entriesFailedToClassify)}`);
  console.log(`  ${APPLY ? "DELETED" : "WOULD DELETE"}                  ${f(deleted)}`);
  console.log(`  SKIPPED: already-gone         ${f(skippedAlreadyGone)}`);
  console.log(`  REFUSED: no-keeper            ${f(refusedNoKeeper)}`);
  console.log(`  REFUSED: keeper-not-settled   ${f(refusedKeeperNotSettled)}`);
  console.log(`  REFUSED: no-catalog-row       ${f(refusedNoCatalogRow)}`);
  console.log(`  REFUSED: not-checklist-grade  ${f(refusedNotChecklistGrade)}`);
  console.log(`  REFUSED: content-differs      ${f(refusedContentDiffers)}`);
  console.log(`  REFUSED: same-id              ${f(refusedSameId)}`);
  console.log(`  FAILED                        ${f(failed)}`);
  console.log(`  of which ledger-write-failed  ${f(ledgerWriteFailed)}`);

  // `notReached` is whole ENTRIES the outer loop never STARTED at all --
  // this lane's unit IS the entry (one stray per entry, by list-schema
  // construction), so there is no separate per-sale straddle to track the
  // way repoint-sales-by-list.cjs must.
  const notReached = stoppedAt === null ? 0 : entries.length - stoppedAt - entriesFailedToClassify;
  console.log(`  not reached (budget)          ${f(notReached)}   <- the relaunch settles these`);

  // RECONCILE. Every entry is exactly one of { deleted/would-delete,
  // skipped(already-gone), refused(by reason), failed, malformed,
  // not-reached }.
  const refused = refusedNoKeeper + refusedKeeperNotSettled + refusedNoCatalogRow
    + refusedNotChecklistGrade + refusedContentDiffers + refusedSameId;
  const accounted = deleted + skippedAlreadyGone + refused + failed + entriesFailedToClassify + notReached;
  const intended = entries.length;

  console.log(`\n  reconciled: intended ${f(intended)} = ${APPLY ? "deleted" : "would-delete"} ${f(deleted)} `
    + `+ skipped ${f(skippedAlreadyGone)} + refused ${f(refused)} + failed ${f(failed)} `
    + `+ malformed ${f(entriesFailedToClassify)} + not-reached ${f(notReached)}`);
  if (accounted !== intended) {
    console.error("  !! RECONCILE MISMATCH -- an entry was neither deleted, skipped, refused, failed, malformed nor deferred");
    process.exitCode = 4;
  }

  if (APPLY) {
    reportWrites({
      job: "dedupe-sold-comp-copies-by-list",
      intended,
      written: deleted,
      skipped: skippedAlreadyGone + entriesFailedToClassify + notReached,
      refused,
      failed,
    });
  }

  if (!APPLY) console.log("\nREPORT ONLY — nothing was written. Re-run with BACKFILL_APPLY=true to apply.");

  // -- THE MARKER THE RELAUNCH GREPS -----------------------------------
  //
  // CF-RELAUNCH-ONLY-ON-BUDGET (#1361). Written as a source literal, not
  // assembled from variables, exactly matching every sibling list lane.
  if (stoppedAt !== null) {
    console.log(`\n  stopped at the ${CLOCK.RUN_MINUTES}-minute budget -- `
      + `stopped at ${f(stoppedAt)} of ${f(intended)}; the relaunch continues from here`);
    console.log("  the list is IDEMPOTENT: a finished delete re-reads as no stray left at deleteCardId,"
      + " so the continuation re-derives cheaply and writes only what is left.");
  } else {
    console.log(`\n  finished within budget (considered=${f(considered)}) — done, no re-dispatch.`);
  }

  return { client, budget: CLOCK };
}

module.exports = { classifyEntry, APPLY, SCOPE_ERROR, IDENTITY_FIELDS };

if (require.main === module) {
  main()
    .then((ctx) => finishLane(process.exitCode || 0, ctx))
    .catch(async (e) => {
      console.error("FATAL:", e?.stack || e?.message);
      await finishLane(3, {});
    });
}
