"use strict";

/**
 * CF-NAME-THE-ROWS-BEFORE-CALLING-DAMAGE (2026-09-13).
 *
 * The write-ledger + verify-by-read pattern (CF-VERIFY-THE-WRITE-BY-READING-
 * IT-BACK, 2026-09-07) is shared by retire-self-derived-identities.cjs and, in
 * spirit, its siblings — but the decision "does this point-read confirm the
 * write" was buried inline in the lane's main(), which connects to Cosmos and
 * cannot be required by a test. Pulled out here so the classification itself
 * is unit-testable against a MOCKED read result, with no Cosmos client and no
 * retry/cap machinery in the way.
 *
 * Nothing here talks to Cosmos. The caller does the point-read (or catches its
 * 404) and hands the outcome to `classifyLedgerRead`.
 */

/**
 * `entry`     — one write-ledger row: `{ id, pk, field, expect? }`.
 * `resource`  — the document `container.item(id, pk).read()` returned, or
 *               `undefined`/`null` if the read found nothing (a 404, whether
 *               the SDK resolved it as an empty resource or threw and the
 *               caller converted that into `resource: undefined`).
 * `retiredDefault` — the marker value to expect when `entry.expect` is not
 *               set (this lane's plain retire path never carries `expect`
 *               because it always writes the same `RETIRED` constant — see
 *               the lane's own comment on `const want = e.expect || RETIRED`).
 *
 * Returns `{ ok: true }` when the row carries the marker this entry's write
 * meant to leave, or `{ ok: false, reason, found }` naming exactly what the
 * read-back found instead:
 *
 *   "404"                      — the row is not readable at (id, pk) at all.
 *                                 Most likely a hard delete (this lane's own
 *                                 graded-child path, or a concurrent
 *                                 retire-*.cjs lane) raced the verify, or the
 *                                 ledger's mirrored pk does not match where
 *                                 the write actually went.
 *   "present-without-marker"   — the row exists but the field is unset/empty.
 *                                 The write did not land.
 *   "different-value"          — the field is set, but not to what THIS run's
 *                                 write meant to leave. Another writer touched
 *                                 it after.
 */
function classifyLedgerRead(entry, resource, retiredDefault) {
  if (!resource) {
    return { ok: false, reason: "404", found: "ABSENT" };
  }
  const got = resource[entry.field];
  const UNVERIFIED = "identityUnverified";
  if (entry.field === UNVERIFIED) {
    if (got === true) return { ok: true };
    const found = got === undefined || got === null || got === "" ? "ABSENT" : got;
    return { ok: false, reason: found === "ABSENT" ? "present-without-marker" : "different-value", found };
  }
  const want = entry.expect || retiredDefault;
  if (String(got || "") === want) return { ok: true };
  const found = got === undefined || got === null || got === "" ? "ABSENT" : got;
  return { ok: false, reason: found === "ABSENT" ? "present-without-marker" : "different-value", found };
}

/**
 * A write ledger keyed by id. A graded child is reachable twice in one
 * product pass — once as its own entry in the self-derived scan (it mirrors
 * its parent's identity fields and can classify and retire on its own),
 * and again as a member of its parent's `kids` list when the PARENT retires
 * and takes its children with it. Both paths used to push their own ledger
 * entry: a silent duplicate when they agreed, and a silently-shadowed first
 * write if they ever disagreed (the array's last entry for an id is the only
 * one the old verify read back, via whatever order a `Map`/loop produced).
 *
 * `push` keeps the FIRST entry for a given id and counts (never silently
 * drops) every later attempt to ledger the same id again.
 */
function createLedger() {
  const ids = new Set();
  const entries = [];
  let duplicates = 0;
  return {
    push(entry) {
      if (ids.has(entry.id)) { duplicates++; return false; }
      ids.add(entry.id);
      entries.push(entry);
      return true;
    },
    get entries() { return entries; },
    get duplicates() { return duplicates; },
    get length() { return entries.length; },
  };
}

module.exports = { classifyLedgerRead, createLedger };
