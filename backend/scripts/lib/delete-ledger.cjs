"use strict";
/**
 * delete-ledger.cjs -- the recoverability guarantee for every lane that
 * DELETES a sold_comps or card_catalog document: no ledger line, no delete.
 *
 * INCIDENT (2026-09-28, C:/tmp/incident_1430/REPORT.md). repoint-sales-
 * isauto-flip's self-collapse defect (fixed separately in PR #2488) deleted
 * 583 sales whose only surviving trace was that run's own PLAN_OUT ndjson --
 * and that record never carried price/soldAt/grade, only the plan's own
 * decision fields (fromId/toId/reason). A plan line describes what the lane
 * DECIDED; it is not a backup of what the lane DESTROYED. When #2488's fix
 * (or the next one nobody has found yet) turns out to be wrong in some case
 * it did not anticipate, there is nothing to restore the sale FROM.
 *
 * THE RULE: before ANY delete of a sold_comps or card_catalog document, the
 * FULL pre-delete document (every field Cosmos returned, verbatim) is
 * appended to a durable ndjson ledger. A ledger-write failure REFUSES the
 * delete -- it is never a soft warning the lane logs and proceeds past. This
 * is the opposite of every other failure mode in these lanes (a delete that
 * 404s is "already gone", a delete that throws is a reported duplicate/left-
 * behind row) precisely because THIS failure means the lane does not yet
 * have a recoverable copy of the thing it is about to destroy.
 *
 * USAGE -- one call, immediately before the delete it protects:
 *
 *   const { recordDeleteOrThrow } = require("./lib/delete-ledger.cjs");
 *   await recordDeleteOrThrow(fullDocBeforeDelete, {
 *     lane: "repoint-sales-isauto-flip",
 *     action: "collapse",                 // whatever this call site calls it
 *     reason: "same-sale-resident",
 *     toId: toId ?? null,                  // where the surviving copy lives, if any
 *     container: "sold_comps",             // or "card_catalog"
 *     controlContainer: control ?? null,   // optional: a live rematch_control
 *                                           // Container, for the best-effort mirror
 *   });
 *   await pool.item(doc.id, doc.cardId).delete();
 *
 * A failed `recordDeleteOrThrow` throws; the caller's own try/catch decides
 * how that surfaces (every existing bare-delete call site already wraps its
 * delete in try/catch, so this fits the same shape -- see this file's own
 * `ledgerWriteFailed` marker below for how a caller tells that failure apart
 * from an ordinary delete failure).
 *
 * WHERE THE LEDGER LIVES. `${LEDGER_OUT ?? PLAN_OUT}/deleted-docs-<lane>-
 * <runId>.ndjson` -- next to the lane's own PLAN_OUT (or LEDGER_OUT, for a
 * lane with no PLAN_OUT of its own, e.g. relocate-catalog-rows-by-list),
 * because the workflow's existing per-lane upload steps already sweep that
 * whole directory: no new upload step for any lane that already uploads
 * PLAN_OUT. `runId` is GITHUB_RUN_ID, or "local" for a bare run off CI, so a
 * local dry-run/test never collides with a real dispatch's ledger name.
 * Neither env var set falls back to a per-process os.tmpdir() directory,
 * same fallback shape PLAN_OUT itself already uses across these lanes, so a
 * ledger always has SOMEWHERE durable to land rather than silently having no
 * directory to open.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/** One open fd per (lane, runId, dir) triple per process -- appends across
 *  many calls in one run share the fd rather than reopening the file every
 *  time, mirroring the PLAN_OUT ndjson writers already in these lanes. */
const _fds = new Map();

function resolveLedgerDir() {
  const explicit = String(process.env.LEDGER_OUT ?? "").trim();
  if (explicit) return explicit;
  const planOut = String(process.env.PLAN_OUT ?? "").trim();
  if (planOut) return planOut;
  return path.join(os.tmpdir(), "hobbyiq-delete-ledger");
}

function runId() {
  const v = String(process.env.GITHUB_RUN_ID ?? "").trim();
  return v || "local";
}

function ledgerPathFor(lane) {
  const dir = resolveLedgerDir();
  const safeLane = String(lane ?? "unknown-lane").trim() || "unknown-lane";
  return path.join(dir, `deleted-docs-${safeLane}-${runId()}.ndjson`);
}

function openLedgerFd(lane) {
  const p = ledgerPathFor(lane);
  const key = p;
  if (_fds.has(key)) return _fds.get(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, "a");
  _fds.set(key, fd);
  return fd;
}

/**
 * Append one ledger line: the FULL document as Cosmos returned it (verbatim,
 * no stripping -- a partial record is exactly the gap this exists to close),
 * plus the caller's own context. fsync'd before returning, so a line this
 * function reports as written has actually reached disk, not just a
 * buffered fd a crash immediately after could still lose.
 *
 * Throws on any failure -- a caller that wants "refuse the delete, never
 * throw past it" wraps this itself (recordDeleteOrThrow below does exactly
 * that and is the function every delete call site should actually use).
 */
function appendLedgerLineSync(doc, ctx) {
  const lane = ctx?.lane;
  const fd = openLedgerFd(lane);
  const line = {
    ledgerWrittenAt: new Date().toISOString(),
    runId: runId(),
    lane: lane ?? null,
    action: ctx?.action ?? null,
    reason: ctx?.reason ?? null,
    toId: ctx?.toId ?? null,
    container: ctx?.container ?? null,
    doc,
  };
  const bytes = Buffer.from(JSON.stringify(line) + "\n", "utf8");
  fs.writeSync(fd, bytes);
  fs.fsyncSync(fd);
}

/**
 * Best-effort mirror of a compact ledger record into `rematch_control`
 * (partition key `/id`, provisioned via `containers.createIfNotExists` --
 * see rematch-sold-comps.cjs's `getOrCreateControlContainer` for the same
 * pattern this borrows). NEVER throws: this is a convenience second copy for
 * an operator who wants to query Cosmos directly rather than pull the
 * ndjson artifact, not a second gate on the delete. The ndjson line written
 * by `appendLedgerLineSync` is the one durable copy this module guarantees;
 * a caller with no `controlContainer` (or one that 404s/throttles) still
 * gets the delete gated on the file write alone.
 *
 * id = `${runId}::${saleId}::${pk}` so two different deletes (even of the
 * same saleId moving through two different partitions across a run, or the
 * same saleId in two different runs) never collide on one document.
 */
async function mirrorToControlBestEffort(doc, ctx) {
  const container = ctx?.controlContainer;
  if (!container) return;
  try {
    const saleId = String(doc?.id ?? "unknown-id");
    const pk = String(doc?.cardId ?? doc?.hobbyiqCardId ?? "unknown-pk");
    const id = `${runId()}::${saleId}::${pk}`;
    await container.items.upsert({
      id,
      docType: "delete_ledger_mirror",
      lane: ctx?.lane ?? null,
      action: ctx?.action ?? null,
      reason: ctx?.reason ?? null,
      toId: ctx?.toId ?? null,
      container: ctx?.container ?? null,
      deletedDoc: doc,
      mirroredAt: new Date().toISOString(),
    });
  } catch {
    // Best-effort ONLY -- the ndjson line already landed (or this function
    // would not have been reached, see recordDeleteOrThrow), so a mirror
    // failure here changes nothing about whether the delete is safe.
  }
}

/**
 * The one call site every delete goes through. Writes the ledger line FIRST
 * (fsync'd), then best-effort mirrors to rematch_control, then returns.
 * Throws (refusing the delete) iff the ledger line itself could not be
 * written -- never for a mirror failure, which is swallowed above.
 *
 * `ctx`:
 *   lane               required -- names the ndjson file and the mirror doc
 *   action, reason     free text describing WHY this delete is happening,
 *                       same vocabulary the caller's own emitPlanRow uses
 *   toId               where the surviving copy lives, if this delete is
 *                       part of a move/collapse (null for a bare retire)
 *   container          "sold_comps" | "card_catalog"
 *   controlContainer   optional live rematch_control Container for the
 *                       best-effort mirror; omitted or null skips it
 */
async function recordDeleteOrThrow(doc, ctx) {
  if (!doc || typeof doc !== "object") {
    const err = new Error("recordDeleteOrThrow: refusing — no full document was supplied to ledger before the delete");
    err.ledgerWriteFailed = true;
    throw err;
  }
  try {
    appendLedgerLineSync(doc, ctx);
  } catch (e) {
    const err = new Error(`recordDeleteOrThrow: ledger write failed, delete refused — ${String(e?.message ?? e)}`);
    err.ledgerWriteFailed = true;
    err.cause = e;
    throw err;
  }
  await mirrorToControlBestEffort(doc, ctx);
}

/** True iff `err` is the refusal `recordDeleteOrThrow` throws on a ledger
 *  write failure -- lets a caller's counters tell "ledger-write-failed" apart
 *  from every other delete-time failure without string-matching a message. */
function isLedgerWriteFailure(err) {
  return Boolean(err && err.ledgerWriteFailed === true);
}

/** Test/process-exit hygiene: close every fd this module opened. Idempotent. */
function closeAllLedgerFds() {
  for (const fd of _fds.values()) {
    try { fs.closeSync(fd); } catch { /* already closed or never opened */ }
  }
  _fds.clear();
}

module.exports = {
  recordDeleteOrThrow,
  isLedgerWriteFailure,
  ledgerPathFor,
  closeAllLedgerFds,
  // Exported for unit tests only -- not part of the call-site contract.
  _internal: { appendLedgerLineSync, mirrorToControlBestEffort, resolveLedgerDir, runId },
};
