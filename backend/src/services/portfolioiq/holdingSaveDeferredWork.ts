// CF-CARD-SAVE-FAST (Drew, 2026-08-31: "saving edits on a card is SLOW").
//
// The save request path used to be: validate -> resolve identity -> persist ->
// REPRICE -> EMIT COMP -> write doc -> respond. The last three run before the
// user's Save button comes back, and two of them cannot change what the user
// just typed:
//
//   autoPriceHolding        a full computeEstimate. Measured on prod
//                           2026-08-12 (see tests/estimateInputChanged.test.ts):
//                           260 Cosmos deps / 1.76s on a well-comped card,
//                           911 Cosmos deps / 15.64s on a 0-comp 2026 Bowman
//                           Chrome prospect. The web client aborted the PATCH
//                           on the slow one.
//   emitUserEbayPurchaseComp  a sold_comps upsert. Only fires for
//                           purchaseSource ~ /^ebay/, but when it fires the
//                           user waits on a second container's write.
//
// Neither is part of "did my edit save?". Both must still HAPPEN — a comp we
// drop is market data we never get back, and a skipped reprice leaves a stale
// FMV on screen (CF-THE-SLUG-IS-A-PRICING-INPUT-TOO). So this is a MOVE, not a
// removal, and the move has to survive a process that dies mid-flight.
//
// The durability rule that makes deferral safe:
//
//   1. the marker is written INSIDE the same doc write that persists the edit,
//      so "the edit is saved" and "work is owed on it" become true atomically;
//   2. the work runs after the response;
//   3. the marker is cleared only after the work succeeded.
//
// A crash at any point leaves the marker set, and the sweep below re-runs it.
// The marker is therefore an at-least-once ledger, and every deferred operation
// is idempotent by construction (the comp upserts on a fixed dedup key
// `holding::<id>`; the reprice recomputes from current state), so replay
// converges on the same doc the synchronous path would have produced.
//
// What is NOT deferred, and why: validation, the identity gate, the catalog
// resolve, and the doc write all stay in the request. They decide what gets
// WRITTEN. This change only moves WHEN work runs, never what it writes.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";

/** The deferred operations a save can owe. Order is the order they run in. */
export type DeferredOp = "reprice" | "comp-emit";

/**
 * The marker persisted on a holding while work is owed on it.
 *
 * `at` lets the sweep prefer the oldest debt and lets an operator see how far
 * behind the deferred lane is. `attempts` bounds replay so a permanently
 * failing holding cannot be retried forever.
 */
export interface PendingSaveWork {
  ops: DeferredOp[];
  at: string;
  attempts: number;
}

/** Field name on the holding. Exported so tests and the sweep agree on it. */
export const PENDING_FIELD = "pendingSaveWork" as const;

/** Give up after this many failed sweeps; the holding is then logged, not retried. */
export const MAX_ATTEMPTS = 5;

type Rec = Record<string, unknown>;

/**
 * Decide what a save owes, from the same inputs the synchronous path used.
 *
 * `repriceNeeded` is `estimateInputChanged(previous, next)` — the existing
 * CF-PHOTO-PATCH-LATENCY gate, unchanged. A patch that could not move the
 * price still does no reprice; this only changes when a NEEDED reprice runs.
 *
 * `compEligible` mirrors emitUserEbayPurchaseComp's own early returns, so a
 * holding that would have been a no-op does not get a marker (and does not
 * make the sweep do useless work).
 */
export function deferredOpsFor(
  holding: PortfolioHolding,
  repriceNeeded: boolean,
): DeferredOp[] {
  const ops: DeferredOp[] = [];
  if (repriceNeeded) ops.push("reprice");
  if (compEligible(holding)) ops.push("comp-emit");
  return ops;
}

/**
 * The comp emit's own preconditions, read WITHOUT doing any I/O.
 *
 * Kept deliberately in sync with emitUserEbayPurchaseComp's guard clauses. If
 * that guard gains a condition and this does not, the cost is a marker for a
 * no-op emit — the sweep runs the real function, which returns early and the
 * marker clears. Divergence is therefore wasteful, never wrong.
 */
export function compEligible(holding: PortfolioHolding): boolean {
  const h = holding as unknown as Rec;
  const src = String(h.purchaseSource ?? "").trim();
  if (!src || !/^ebay/i.test(src)) return false;
  const price = Number(h.purchasePrice ?? NaN);
  if (!Number.isFinite(price) || price <= 0) return false;
  if (!String(h.purchaseDate ?? "").trim()) return false;
  if (!String(h.playerName ?? "").trim()) return false;
  return true;
}

/**
 * Stamp the marker on the holding. Called BEFORE the doc write so the debt is
 * persisted by the same write that persists the edit.
 *
 * Existing ops are unioned rather than replaced: a second save landing while
 * the first still owes work must not erase the first's debt.
 */
export function markPending(
  holding: PortfolioHolding,
  ops: DeferredOp[],
  now: string = new Date().toISOString(),
): void {
  if (ops.length === 0) return;
  const h = holding as unknown as Rec;
  const prev = readPending(holding);
  const merged = prev ? union(prev.ops, ops) : ops.slice();
  h[PENDING_FIELD] = {
    ops: merged,
    at: prev?.at ?? now,
    attempts: prev?.attempts ?? 0,
  } satisfies PendingSaveWork;
}

/** Read the marker, tolerating legacy/garbage shapes. */
export function readPending(holding: PortfolioHolding | undefined | null): PendingSaveWork | null {
  if (!holding) return null;
  const raw = (holding as unknown as Rec)[PENDING_FIELD];
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Rec;
  const ops = Array.isArray(rec.ops)
    ? rec.ops.filter((o): o is DeferredOp => o === "reprice" || o === "comp-emit")
    : [];
  if (ops.length === 0) return null;
  return {
    ops,
    at: typeof rec.at === "string" ? rec.at : new Date(0).toISOString(),
    attempts: Number.isFinite(rec.attempts) ? Number(rec.attempts) : 0,
  };
}

/** Clear the marker once the work has actually completed. */
export function clearPending(holding: PortfolioHolding | undefined | null): void {
  if (!holding) return;
  delete (holding as unknown as Rec)[PENDING_FIELD];
}

/** Drop the ops that succeeded; keep the rest so a partial failure still replays. */
export function clearOps(holding: PortfolioHolding, done: DeferredOp[]): void {
  const prev = readPending(holding);
  if (!prev) return;
  const left = prev.ops.filter((o) => !done.includes(o));
  if (left.length === 0) {
    clearPending(holding);
    return;
  }
  (holding as unknown as Rec)[PENDING_FIELD] = {
    ops: left,
    at: prev.at,
    attempts: prev.attempts,
  } satisfies PendingSaveWork;
}

/** Record a failed attempt so the sweep can bound its own retries. */
export function bumpAttempts(holding: PortfolioHolding): number {
  const prev = readPending(holding);
  if (!prev) return 0;
  const attempts = prev.attempts + 1;
  (holding as unknown as Rec)[PENDING_FIELD] = {
    ops: prev.ops,
    at: prev.at,
    attempts,
  } satisfies PendingSaveWork;
  return attempts;
}

function union(a: DeferredOp[], b: DeferredOp[]): DeferredOp[] {
  const out = a.slice();
  for (const op of b) if (!out.includes(op)) out.push(op);
  return out;
}
