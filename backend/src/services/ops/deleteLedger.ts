// CF-NO-DELETE-WITHOUT-A-FULL-DOCUMENT-LEDGER-LINE-FIRST (2026-09-28).
//
// The TypeScript twin of backend/scripts/lib/delete-ledger.cjs, for the one
// delete path that lives in compiled src/ rather than a script:
// catalogRowOps.service.ts's `deleteTolerant`/`deleteAndVerifyGone` (which
// retireCatalogRow and moveCatalogRow's fold-replace branch both go through).
//
// WHY A SEPARATE FILE INSTEAD OF REQUIRING THE .cjs HELPER. catalogRowOps.
// service.ts is imported (transitively, via catalogMatcher.service.ts's
// `nonePartitionKey` import) by code that loads at App Service BOOT, in
// production. backend/scripts/ is NEVER packaged into the deploy zip --
// zip.js archives only package.json/package-lock.json/dist//node_modules --
// so a top-level `require("../../scripts/lib/delete-ledger.cjs")` from this
// module would resolve locally (scripts run against a built dist/) and throw
// "module not found" the instant the compiled App Service process touched
// this file in production. Same rule, same ndjson shape, two small files
// rather than one fragile cross-package require.
//
// Both retireCatalogRow and moveCatalogRow's own delete calls are in
// practice only ever invoked by backend/scripts/*.cjs lanes (grepped: no
// src/ caller other than a comment reference) -- catalogMatcher.service.ts
// imports only the pure `nonePartitionKey` helper from this file, never a
// delete function -- so in practice this only ever runs inside a script
// process, exactly like the .cjs helper, and reads the SAME env vars
// (LEDGER_OUT / PLAN_OUT / GITHUB_RUN_ID) so a lane that wires PLAN_OUT once
// gets both the sold_comps and card_catalog halves of its ledger in the
// same directory, swept by the same workflow upload step.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DeleteLedgerContext {
  /** Names the ndjson file and the mirror doc's `lane` field. Required. */
  lane: string;
  /** Free text describing WHY this delete is happening -- same vocabulary
   *  the caller's own reporting already uses. */
  action?: string | null;
  reason?: string | null;
  /** Where the surviving copy lives, if this delete is part of a move/fold/
   *  collapse. Omit (or null) for a bare retire. */
  toId?: string | null;
  /** "sold_comps" | "card_catalog" -- which container the doc came from. */
  container?: string | null;
}

const openFds = new Map<string, number>();

function resolveLedgerDir(): string {
  const explicit = String(process.env.LEDGER_OUT ?? "").trim();
  if (explicit) return explicit;
  const planOut = String(process.env.PLAN_OUT ?? "").trim();
  if (planOut) return planOut;
  return path.join(os.tmpdir(), "hobbyiq-delete-ledger");
}

function runId(): string {
  const v = String(process.env.GITHUB_RUN_ID ?? "").trim();
  return v || "local";
}

function ledgerPathFor(lane: string): string {
  const dir = resolveLedgerDir();
  const safeLane = (lane || "unknown-lane").trim() || "unknown-lane";
  return path.join(dir, `deleted-docs-${safeLane}-${runId()}.ndjson`);
}

function openLedgerFd(lane: string): number {
  const p = ledgerPathFor(lane);
  const existing = openFds.get(p);
  if (existing !== undefined) return existing;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, "a");
  openFds.set(p, fd);
  return fd;
}

/** Thrown by `recordDeleteOrThrow` iff the ledger line itself could not be
 *  written -- carries `ledgerWriteFailed: true` so a caller's catch block
 *  can count it apart from an ordinary delete failure without string-
 *  matching a message. */
export class LedgerWriteFailedError extends Error {
  readonly ledgerWriteFailed = true as const;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "LedgerWriteFailedError";
  }
}

export function isLedgerWriteFailure(err: unknown): err is LedgerWriteFailedError {
  return Boolean(err && typeof err === "object" && (err as { ledgerWriteFailed?: unknown }).ledgerWriteFailed === true);
}

function appendLedgerLineSync(doc: Record<string, unknown>, ctx: DeleteLedgerContext): void {
  const fd = openLedgerFd(ctx.lane);
  const line = {
    ledgerWrittenAt: new Date().toISOString(),
    runId: runId(),
    lane: ctx.lane,
    action: ctx.action ?? null,
    reason: ctx.reason ?? null,
    toId: ctx.toId ?? null,
    container: ctx.container ?? null,
    doc,
  };
  const bytes = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
  fs.writeSync(fd, bytes);
  fs.fsyncSync(fd);
}

/**
 * The one call site every card_catalog delete goes through. Writes the
 * FULL pre-delete document (verbatim, fsync'd) to a durable ndjson ledger
 * BEFORE the caller's own Cosmos delete call. Throws `LedgerWriteFailedError`
 * (refusing the delete) iff the ledger line itself could not be written.
 *
 * There is no `rematch_control` mirror here (unlike the sold_comps .cjs
 * twin): card_catalog's retire/fold lanes have no live Cosmos client handed
 * to this module (the caller keeps its own container reference, same as
 * every other function in catalogRowOps.service.ts), and the durable ndjson
 * line is the one guarantee this function makes -- a caller that also wants
 * the Cosmos mirror can add it at the call site with the container it
 * already holds, same shape as the .cjs helper's own best-effort mirror.
 */
export async function recordDeleteOrThrow(doc: Record<string, unknown>, ctx: DeleteLedgerContext): Promise<void> {
  try {
    appendLedgerLineSync(doc, ctx);
  } catch (e) {
    throw new LedgerWriteFailedError(
      `recordDeleteOrThrow: ledger write failed, delete refused — ${String((e as Error)?.message ?? e)}`,
      e,
    );
  }
}
