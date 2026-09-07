// CF-A-MUTATOR-PATCHES-FIELDS-NEVER-THE-WHOLE-DOC (Drew, 2026-09-07, #1941
// follow-up).
//
// #1941 drew the line at who MINTS a sold_comps row and deliberately left the
// ~150 mutator lanes unpoliced: a lane that stamps `flaggedWrong` on a row the
// guard already judged at ingest is not re-adjudicating an address. That was
// the right line for an IDENTITY guard. It is the wrong line for a
// CONCURRENCY one, and this is the concurrency one.
//
// THE DEFECT. A mutator that reads a document, sets one field on the copy and
// upserts the whole thing back writes every OTHER field too -- at the value it
// read, which by then may be stale:
//
//     const row = await pool.item(id, pk).read();     // t0
//     row.hobbyiqCardId = repoint;                    // one field intended
//     await pool.items.upsert(row);                   // t1: ALL fields written
//
// Between t0 and t1 another lane's `flaggedWrong` stamp lands and is then
// overwritten by this upsert carrying the pre-stamp value. Nothing errors.
// Nothing is logged. The stamp is simply gone, and the only evidence is a row
// that a later census finds unflagged for a reason nobody can reconstruct.
// Last writer wins, and "last" is a race.
//
// This is not hypothetical here. Ten-plus writers run against sold_comps
// concurrently today -- the rematch fleet, the relocate and park lists, the
// rekey lanes, the retire sweeps -- and they touch DIFFERENT fields of the
// SAME rows by design: that is what makes the pool converge. Full-document
// upsert makes those writes mutually destructive rather than composable.
//
// THE FIX is the operation Cosmos already offers and these lanes were not
// using: a partial-document PATCH names the fields it changes and leaves every
// other field on the server untouched. Two concurrent patches to different
// fields of one row BOTH survive. No etag, no retry loop, no lost stamp.
//
// WHY A HELPER AND NOT A RULE IN EACH LANE. catalogAuthority.service's header
// records what a second copy of one predicate costs, and patchCatalogRowFields
// exists for exactly this reason on card_catalog. This is its sold_comps twin,
// with one difference the containers force:
//
//   card_catalog   id === cardId === the slug; a row is its own partition, so
//                  `pk` is derivable from the row.
//   sold_comps     partitioned on /cardId, which is NOT the id (an id is
//                  `{source}::{sourceExternalId}`). The partition key must be
//                  passed, and it cannot be guessed.
//
// ADDRESSING FIELDS ARE REFUSED, for the same reason patchCatalogRowFields
// refuses them: `cardId` is the partition key and Cosmos cannot patch it at
// all, so a "re-key by patch" is not a slow path, it is a silently wrong one.
// A re-key is a new document plus a verified delete, which is
// relocateSoldComp's job (CF-A-SALE-IS-NEVER-LOST, D19) -- doing it by field
// patch is how half-moved rows happen. `id` likewise addresses the document.
//
// WHAT IT RETURNS is the applied field list, because the ledger is the
// verification. CF-EVERY-WRITE-RECONCILES: a lane reports intended = written +
// skipped + failed, and it cannot report what it wrote unless the write path
// tells it. `noop` when every value already matches, so a re-run is free and a
// re-run's ledger is honest about having changed nothing.

import type { Container, PatchOperation, RequestOptions } from "@azure/cosmos";

/** Fields that ADDRESS the document. Patching these is a re-key, not a field
 *  repair -- and `cardId` is the partition key, which Cosmos cannot patch at
 *  all. Use relocateSoldComp (backend/scripts/lib/relocate-sold-comp.cjs). */
const UNPATCHABLE = new Set(["id", "cardId"]);

/** Cosmos system properties. A caller that read a row and handed the whole
 *  thing back would otherwise try to patch `_etag`, which fails at the
 *  server with a message that does not name the cause. */
const SYSTEM_FIELDS = new Set(["_rid", "_self", "_etag", "_attachments", "_ts"]);

export interface PatchSoldCompFieldsOptions {
  /** Optimistic concurrency: fail with 412 if the row changed since it was
   *  read. NOT needed to make concurrent field writes safe -- that is what
   *  the patch itself does -- and it is the wrong tool for the common case,
   *  because a 412 from an UNRELATED field's write makes a lane retry a
   *  write that was never in conflict. Reach for it only when the new value
   *  is computed FROM the old one (a counter, an append), where a lost
   *  update is a wrong number rather than a stale one. */
  ifMatchEtag?: string;
  /** Report what a real run would change, without writing. Costs the one
   *  point read the change-detection already pays for. */
  dryRun?: boolean;
  /** Max attempts on a retryable Cosmos status (429 throttle, 449 concurrent
   *  write on the same partition). Default 5. */
  maxAttempts?: number;
  /** Sleep. Injected so tests do not spend real time in backoff. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PatchSoldCompFieldsResult {
  action: "patch" | "noop";
  id: string;
  cardId: string;
  /** The fields whose value actually CHANGED -- what the ledger should count.
   *  A field requested at the value it already held is not in this list. */
  fieldsChanged: string[];
  /** Attempts spent, including the successful one. >1 means Cosmos throttled
   *  or 449'd; a lane logging throughput wants to see this. */
  attempts: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 429 = throttled (RU budget exhausted); 449 = "retry with", Cosmos' signal
 * that two writes hit the same partition concurrently and this one should be
 * re-issued. Both are transient and both are EXPECTED under a fleet -- 449 in
 * particular is the very condition this helper exists to make survivable, so
 * treating it as a failure would defeat the point.
 */
function retryableAfterMs(err: unknown, attempt: number): number | null {
  const e = err as { code?: number | string; statusCode?: number; retryAfterInMs?: number; headers?: Record<string, unknown> } | null;
  const code = Number(e?.code ?? e?.statusCode);
  if (code !== 429 && code !== 449) return null;
  const hinted = Number(e?.retryAfterInMs ?? e?.headers?.["x-ms-retry-after-ms"]);
  if (Number.isFinite(hinted) && hinted > 0) return hinted;
  return 50 * Math.pow(2, attempt); // 50, 100, 200, 400 ms
}

/**
 * Patch NAMED fields on one sold_comps row, leaving every other field on the
 * server untouched.
 *
 * @param container a `sold_comps` handle
 * @param id        the document id (`{source}::{sourceExternalId}`)
 * @param pk        the partition key -- the row's `cardId`. Required: it is
 *                  not derivable from the id, and a wrong one addresses a
 *                  document that does not exist rather than erroring.
 * @param fields    field -> new value. Addressing and system fields refused.
 */
export async function patchSoldCompFields(
  container: Container,
  id: string,
  pk: string,
  fields: Record<string, unknown>,
  opts: PatchSoldCompFieldsOptions = {},
): Promise<PatchSoldCompFieldsResult> {
  if (!id) throw new Error("patchSoldCompFields: id is required");
  if (!pk) throw new Error("patchSoldCompFields: pk (the row's cardId) is required — it is not derivable from the id");

  const names = Object.keys(fields ?? {});
  if (!names.length) throw new Error("patchSoldCompFields: no fields given");

  const illegal = names.filter((n) => UNPATCHABLE.has(n));
  if (illegal.length) {
    throw new Error(
      `patchSoldCompFields: ${illegal.join(", ")} address the row — a re-key is relocateSoldComp's job, not a field patch`,
    );
  }
  const system = names.filter((n) => SYSTEM_FIELDS.has(n));
  if (system.length) {
    throw new Error(`patchSoldCompFields: ${system.join(", ")} are Cosmos system properties and cannot be patched`);
  }

  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const sleep = opts.sleep ?? defaultSleep;

  // ONE READ, to decide what actually changes. This is not the read half of a
  // read-modify-write: nothing from `row` is written back. It exists so the
  // ledger can distinguish "changed it" from "it already said that", which is
  // what makes a re-run's report honest.
  let attempts = 0;
  let row: Record<string, unknown> | null = null;
  for (let attempt = 0; ; attempt++) {
    attempts++;
    try {
      const { resource } = await container.item(id, pk).read<Record<string, unknown>>();
      row = (resource as Record<string, unknown> | undefined) ?? null;
      break;
    } catch (err) {
      if ((err as { code?: number })?.code === 404) { row = null; break; }
      const waitMs = attempt + 1 < maxAttempts ? retryableAfterMs(err, attempt) : null;
      if (waitMs === null) throw err;
      await sleep(waitMs);
    }
  }
  if (!row) return { action: "noop", id, cardId: pk, fieldsChanged: [], attempts };

  const changed = names.filter((n) => row![n] !== fields[n]);
  if (!changed.length) return { action: "noop", id, cardId: pk, fieldsChanged: [], attempts };
  if (opts.dryRun === true) return { action: "patch", id, cardId: pk, fieldsChanged: changed, attempts };

  // `add` creates a field that is absent; `set` replaces one that is present.
  // Cosmos rejects `set` on a path that does not exist, so the distinction is
  // load-bearing on legacy rows -- and most of these lanes exist precisely to
  // fill in a field legacy rows never had.
  const ops: PatchOperation[] = changed.map((n) => ({
    op: row![n] === undefined ? "add" : "replace",
    path: `/${n}`,
    value: fields[n],
  }));

  // The etag rides in RequestOptions.accessCondition, not in the patch body:
  // the body's own `condition` field is a predicate over the DOCUMENT, a
  // different feature entirely.
  const reqOpts: RequestOptions | undefined = opts.ifMatchEtag
    ? { accessCondition: { type: "IfMatch", condition: opts.ifMatchEtag } }
    : undefined;

  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) attempts++;
    try {
      await container.item(id, pk).patch(ops, reqOpts);
      return { action: "patch", id, cardId: pk, fieldsChanged: changed, attempts };
    } catch (err) {
      const waitMs = attempt + 1 < maxAttempts ? retryableAfterMs(err, attempt) : null;
      if (waitMs === null) throw err;
      await sleep(waitMs);
    }
  }
}
