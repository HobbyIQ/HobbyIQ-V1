"use strict";

/**
 * CF-THE-SCAN-AND-THE-WRITE-MUST-AGREE-ON-WHERE-A-ROW-LIVES (2026-09-14).
 *
 * card_catalog partitions on `/cardId`. A document written without a `cardId`
 * property at all is stored by Cosmos at its own "None" partition key -- NOT
 * at a partition keyed by the document's `id`. `patchCatalogRowFields`
 * (backend/src/services/catalog/catalogRowOps.service.ts) computes its
 * partition key as `cardId ? String(cardId) : id`, which is correct for a row
 * that carries a cardId and WRONG for one that does not: its own internal
 * point-read 404s on a None-pk row and it returns `{action:"noop"}` without
 * throwing, and no parameter lets a caller override the pk it computes.
 *
 * retire-self-derived-identities.cjs measured this directly on sampled
 * `user-verified:*` catalog rows: every one carries no `cardId` (only
 * `holdingCardId`, a field patchCatalogRowFields never reads), a
 * cross-partition `WHERE c.id=@id` finds them immediately, and a point-read
 * at `(id, id)` 404s on them every single run -- the "scanned every run,
 * never point-readable" shape the lane's VERIFY BY READ kept failing on.
 *
 * This module is the pk decision and the None-pk patch, pulled out so both
 * are unit-testable against a MOCKED container with no real Cosmos client in
 * the path -- the same reason lib/write-ledger-verify.cjs and
 * lib/sport-contamination.cjs exist. Nothing here talks to a real Cosmos
 * account; the caller supplies a `container` with `.item(id, pk).read()` /
 * `.patch()` methods (the real SDK, or a mock with the same shape).
 *
 * ── THE SENTINEL IS RESOLVED LAZILY, AND NEVER VIA PartitionKeyBuilder
 * (2026-09-14, second pass) ──────────────────────────────────────────────
 *
 * The first version of this file did `const NONE_PK = new
 * PartitionKeyBuilder().addNoneValue().build()` AT MODULE LOAD -- the exact
 * shape `fastPatchIdIsSlug.cjs` and `nukeSalesDerivedCatalog.cjs` already use.
 * That construction worked locally (Node 25) and CRASHED in CI, the runner,
 * and on the App Service, all Node 20: `new PartitionKeyBuilder()` throws
 * "is not a constructor" there, at `require()` time -- so merely requiring
 * this file, before any row is ever scanned, would have taken down every
 * lane that imports it. Two changes fix both the crash and the moment it
 * could happen:
 *
 *   1. THE SENTINEL IS NEVER BUILT AT MODULE LOAD. `resolveNonePk()`
 *      computes it lazily, memoized on first call -- a require of this file
 *      can never throw, only a CALL that actually needs the sentinel can,
 *      and only once, if at all.
 *   2. PartitionKeyBuilder IS NOT USED AT ALL. `@azure/cosmos` also exports
 *      `NonePartitionKeyLiteral` from its internal PartitionKeyInternal
 *      module (used by the SDK's own batch/typeChecks code), but it is NOT
 *      re-exported from the package root in the version this repo pins
 *      (verified: `require("@azure/cosmos").NonePartitionKeyLiteral` is
 *      `undefined` here) -- so this resolves it defensively: use the named
 *      export if a future SDK version starts re-exporting it, and otherwise
 *      fall back to the plain object literal `{}`, which IS the documented
 *      shape (`NonePartitionKeyType = { [K in any]: never }`, i.e. any object
 *      with no partition-key-shaped keys) and was verified directly against
 *      prod: `container.item(id, {}).read()` finds a None-pk row exactly
 *      like the (now-removed) `PartitionKeyBuilder` result did.
 *
 * `fastPatchIdIsSlug.cjs` and `nukeSalesDerivedCatalog.cjs` still construct
 * their sentinel the old way, at module load, via `PartitionKeyBuilder` --
 * they carry the SAME latent Node-20 crash this file had. Out of scope to
 * fix here (this PR is `retire-self-derived-identities.cjs` and this lib
 * only), but worth flagging: neither script has run since this was found.
 */

/** Resolves and memoizes the SDK's "no partition key" sentinel WITHOUT ever
 *  constructing a `PartitionKeyBuilder` and without doing any of this at
 *  module load -- see the header above for why both matter. Safe to call
 *  from a require()'d module on any Node version: at worst it falls back to
 *  the plain-object literal, and the fallback path is itself exercised by a
 *  mocked `@azure/cosmos` export so a future engine change here cannot go
 *  unnoticed silently. */
let _nonePk;
function resolveNonePk() {
  if (_nonePk !== undefined) return _nonePk;
  let literal;
  try {
    // Not re-exported from the package root in the pinned SDK version
    // (checked: it is `undefined` here), but resolved defensively in case a
    // future version starts exporting it -- this is exactly the sentinel the
    // SDK's own internals compare against (utils/typeChecks.js).
    ({ NonePartitionKeyLiteral: literal } = require("@azure/cosmos"));
  } catch {
    literal = undefined;
  }
  // The documented shape either way: an object with no partition-key-typed
  // keys. Verified directly against prod (see PR body): `container.item(id,
  // {}).read()` finds a row Cosmos stored at its own None partition key.
  _nonePk = literal && typeof literal === "object" ? literal : {};
  return _nonePk;
}

/** Fields that address the row. Mirrors catalogRowOps.service.ts's own
 *  UNPATCHABLE set -- patching these is a MOVE, not a field repair, and this
 *  module must refuse them the same way the shared helper does. */
const UNPATCHABLE = new Set(["id", "cardId", "hobbyiqCardId"]);

/**
 * The partition key a WRITE to this row must use, mirroring what
 * `patchCatalogRowFields` computes for a row that DOES carry a `cardId`
 * (`cardId ? String(cardId) : id`) and correcting the one case that function
 * gets wrong: a row with no `cardId` at all lives at Cosmos's own "None"
 * partition key, not at a partition keyed by its `id`.
 */
function pkOf(row) {
  if (row && row.cardId) return String(row.cardId);
  return resolveNonePk();
}

/** True when `pkOf` would resolve to the None partition key for this row --
 *  i.e. the shared `patchCatalogRowFields` helper cannot address it, because
 *  that function's own fallback guesses `id` instead. */
function isNonePkRow(row) {
  return !(row && row.cardId);
}

/**
 * Patch a None-pk row directly, mirroring `patchCatalogRowFields`'s contract
 * exactly (point-read first, no-op if every value already matches, a JSON
 * patch with a `<field>Before` shadow otherwise) so a row written through
 * here is indistinguishable from one `patchCatalogRowFields` wrote, other
 * than the partition key used to reach it.
 *
 * `container` needs only `.item(id, pk).read()` and `.item(id, pk).patch(ops)`
 * -- the same two calls `patchCatalogRowFields` makes -- so a test can hand
 * this a plain object mock instead of a real `@azure/cosmos` Container.
 * `retry` defaults to a passthrough so a caller that already wraps its own
 * throttling retry (as the lane does) can supply it; tests can omit it.
 */
async function patchNonePkRow(container, id, fields, opts = {}) {
  const names = Object.keys(fields || {});
  if (!names.length) throw new Error("patchNonePkRow: no fields given");
  const illegal = names.filter((n) => UNPATCHABLE.has(n));
  if (illegal.length) {
    throw new Error(`patchNonePkRow: ${illegal.join(", ")} address the row -- use moveCatalogRow, not a field patch`);
  }
  const retry = opts.retry || ((fn) => fn());
  const nonePk = resolveNonePk();

  const { resource: row } = await retry(() => container.item(id, nonePk).read());
  if (!row) return { action: "noop", id, fieldsChanged: [] };

  const current = row;
  const changed = names.filter((n) => current[n] !== fields[n]);
  if (!changed.length) return { action: "noop", id, fieldsChanged: [] };

  const ops = [];
  for (const n of changed) {
    ops.push({ op: current[n] === undefined ? "add" : "set", path: `/${n}`, value: fields[n] });
    const shadow = `${n}Before`;
    ops.push({ op: current[shadow] === undefined ? "add" : "set", path: `/${shadow}`, value: current[n] ?? null });
  }
  await retry(() => container.item(id, nonePk).patch(ops));
  return { action: "patch", id, fieldsChanged: changed };
}

module.exports = { resolveNonePk, pkOf, isNonePkRow, patchNonePkRow, UNPATCHABLE };
