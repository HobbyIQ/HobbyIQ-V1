/**
 * CF-A-FRESHNESS-SKIP-MUST-NOT-HIDE-A-ROW-THE-RULES-NO-LONGER-COVER
 * (Drew, 2026-09-06).
 *
 * THE CONTRACT VERSION a stored price was produced under, and the two
 * questions the nightly cadence must ask before it is allowed to call a
 * holding "fresh".
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 *
 * `skipFreshOnlyWhenPoolUnchanged` (#C-2, 2026-09-03) made the nightly bill
 * proportional to CHANGE rather than to corpus: a fresh holding is skipped
 * only on positive evidence that its exact pool has not grown. That is the
 * right trade for a healthy row, and this module does not weaken it.
 *
 * But the skip asks exactly one question — "did this pool grow?" — and there
 * are two ways a holding needs revisiting that the question cannot see:
 *
 *   1. THE POOL CANNOT GROW, BECAUSE THERE IS NO POOL. A holding whose
 *      identity names no catalog row has nothing to price from. #1784 made
 *      that a REFUSAL: `mayPublishPrice` is false for every backing but
 *      `checklist-backed`, and the row is written with a `withheld` block
 *      naming `no-checklist-match` / `identity-not-in-catalog`.
 *
 *      The refusal write carries the PRIOR pass's `compsUsed` forward
 *      (holdingValuation ~776: `typeof priorMeta?.compsUsed === "number"`),
 *      because a refusal measured no pool of its own and inventing a 0 would
 *      read as "the pool was empty" — a different and false claim. So the row
 *      keeps a pre-#1784 comp count, the live count still matches it, and
 *      `live <= persistedCount` reads TRUE. The holding is skipped. Forever.
 *
 *      Measured 2026-09-06 on user-67878bb5: 9 of 16 holdings frozen at
 *      2026-08-30 / 09-04, two of them still publishing $14.79 on
 *      `hiq:baseball:2026:bowman-chrome:cpa-jwh:refractor:auto:num-499` — a
 *      slug with NO catalog row — while a sibling in the same document was
 *      repriced at 04:24:58Z. The cadence was not broken for that user; it
 *      was working exactly as written, on a row the rules had moved past.
 *
 *   2. THE RULES CHANGED SINCE THE STAMP WAS WRITTEN. #1784 is the case in
 *      point: it did not change any pool, so no amount of pool-growth
 *      checking re-admits a row it would now refuse. A holding priced under
 *      the old rules keeps its old number until something unrelated happens
 *      to its pool, which for an unbacked identity is never.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * A holding is "fresh" only when its last stamp was produced by the CURRENT
 * pricing contract AND its pool exists. Everything else is revisited. Stated
 * as the cadence asks it (`freshnessVerdictFor` below):
 *
 *   withheld stamp present   -> revisit. A refusal is not a published price,
 *                               and the whole point of a refusal is that it
 *                               must be re-asked when the world changes.
 *   stamp names no contract  -> revisit. Written before this field existed,
 *                               i.e. before #1784 — the exact population the
 *                               finding is about.
 *   contract != current      -> revisit. The rules moved.
 *   otherwise                -> defer to the pool check, unchanged.
 *
 * This is deliberately a STAMP question, not a catalog read. Asking the
 * catalog "does this slug have a row?" for every fresh holding would be a
 * second per-holding query on the exact path C-2 built to avoid per-holding
 * queries, and it would ask at cadence time a question the VALUATION path
 * already answered and persisted. The stamp is the answer, already on the row.
 * The cadence's job is to notice that the answer is a refusal or is stale —
 * not to re-derive it.
 *
 * ── WHY A CONTRACT VERSION AND NOT `engineVersion` ──────────────────────────
 *
 * `engineMeta.engineVersion` is the deploy's short git SHA. Gating freshness
 * on it would re-admit EVERY holding on EVERY deploy, which is precisely the
 * corpus-proportional nightly bill C-2 removed. This constant moves only when
 * a ruling changes which identities may carry a price or how a published
 * number is derived — a handful of times a year, each one a deliberate
 * decision by whoever makes the ruling.
 *
 * BUMPING IT. Bump when a change would make the engine reach a DIFFERENT
 * published verdict for an unchanged pool: a new identity gate, a retired
 * rung, a changed retention rule. Do NOT bump for a refactor, a log line, a
 * label, or a bug fix that cannot move a number. Every bump re-admits the
 * whole corpus for one night, so it costs one nightly run at the pre-C-2
 * price — cheap, and correct, and not free.
 */

/**
 * The current pricing contract. Stamped onto every published price by
 * `writeHoldingValuation`, and compared by the nightly freshness gate.
 *
 * History:
 *   "2026-09-06.a"  #1784 identity gate (`mayPublishPrice` — only a
 *                   checklist-backed identity may carry a number) + #1785's
 *                   one-stamp rule. The first version; every stamp written
 *                   before this constant existed names NO contract, which the
 *                   gate reads as "predates the contract" and revisits.
 */
export const PRICING_CONTRACT_VERSION = "2026-09-06.a" as const;

/** Why a fresh holding must be revisited despite its age, or `null` when its
 *  stamp is current and the pool check may decide as before. The vocabulary is
 *  CLOSED and it is what the telemetry emits — a reader never infers the
 *  reason from prose. */
export type StaleStampReason =
  /** The row carries a refusal, not a published price. Its pool may not even
   *  exist, so pool-growth can never re-admit it. */
  | "withheld-stamp"
  /** No `pricingSourceMeta` at all — nothing to judge, and #1674's own
   *  finding was that a row with no meta is invisible to every gate. */
  | "no-stamp"
  /** A stamp written before the contract version existed (pre-#1784). */
  | "pre-contract-stamp"
  /** A stamp from a superseded contract. */
  | "stale-contract-stamp";

/** The persisted stamp shape this module judges. Every field optional: the
 *  rows it exists to catch are exactly the ones missing them. */
export interface StampedHolding {
  pricingSourceMeta?: {
    contractVersion?: unknown;
    withheld?: unknown;
  } | null;
}

/**
 * May the cadence treat this holding's stamp as current?
 *
 * Returns `null` when the stamp is a published price at the current contract —
 * the ONLY case in which age plus an unchanged pool may skip the row. Anything
 * else returns the reason it must be revisited.
 *
 * Pure, and reads only what is already on the row: no Cosmos, no catalog, no
 * per-holding query. That is what lets the nightly ask it of every fresh
 * holding for free.
 */
export function staleStampReasonFor(h: StampedHolding | null | undefined): StaleStampReason | null {
  const meta = h?.pricingSourceMeta;
  if (!meta || typeof meta !== "object") return "no-stamp";
  // A refusal is never fresh. Asked FIRST: a withheld row may also carry a
  // current contract (it was refused by today's rules), and it must still be
  // re-asked — the refusal is a statement about a world that can change
  // (a checklist gets acquired, a matcher gets fixed) with no pool growth
  // whatsoever to signal it.
  if ("withheld" in meta && meta.withheld) return "withheld-stamp";
  const v = meta.contractVersion;
  if (typeof v !== "string" || v.length === 0) return "pre-contract-stamp";
  return v === PRICING_CONTRACT_VERSION ? null : "stale-contract-stamp";
}
