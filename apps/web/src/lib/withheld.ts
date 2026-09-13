// CF-WITHHELD-SAYS-WHY (Drew, 2026-09-05).
//
// The words a refused price is explained in, and the one place they live.
//
// THE BUG THIS FIXES. `dailyIqActions.ts` mapped every withheld holding to a
// single sentence — "value withheld: cost-basis check" — because the reason
// was not on the wire to branch on. It is now (CF-WITHHELD-REACHES-THE-GLASS),
// and one sentence for four causes is not vagueness, it is a false statement:
// a `no-checklist-match` holding was being told its cost basis blocked the
// price when nothing of the sort happened. Drew's audit, 2026-09-05.
//
// FOUR RULES, the same ones dailyIqActions keeps:
//
// 1. THE REASON IS SAID IN THE USER'S WORDS. "checklist being acquired",
//    never "no-checklist-match". The engine's vocabulary is the INPUT to this
//    mapping, never its output.
//
// 2. EVERY REASON SAYS WHAT WOULD UNLOCK IT. A refusal the reader can do
//    nothing about is a dead end; a refusal with a next step is a task. Two
//    of the four are ours to fix and say so ("we are acquiring it"), one is
//    the owner's ("confirm the card details"), one is time ("comps settling").
//    Saying nothing at all is what the audit found.
//
// 3. THE REFUSED NUMBER IS EVIDENCE, NOT A PRICE. `proposed` is what the
//    engine computed and declined to publish. It is quoted ONLY inside a
//    sentence that says it was refused and why — never as a value, never in
//    a value slot, never summed into a total. This is the line between
//    explaining a refusal and quietly undoing it.
//
// 4. ABSENT IS NOT A REASON. A row with no `withheld` block (an old worker,
//    a row unpriced for an ordinary reason) gets the honest generic, not an
//    invented cause.

import type { PortfolioHolding } from "./api";

/** The engine's closed vocabulary, mirrored from the wire.
 *
 *  `no-exact-pool` joined 2026-09-12 (#2059): the engine already named this
 *  refusal internally (holdingValuation.ts's `NoBasisRefusalReason`), but the
 *  wire type in pricingEnvelope.ts only recognised the original four, so a
 *  persisted `no-exact-pool` block was silently dropped to `null` at
 *  `withheldOf` (pricingEnvelope.builder.ts) — the holding reached the UI as
 *  an unreasoned "—" though the engine had, in fact, answered. See the D24
 *  Diamond Dominance / Magnetic Field case: the identity is known and
 *  checklist-backed, no sale of it exists yet in the window searched.
 *
 *  `ladder-timeout` joined the same day, same shape: the engine's own
 *  fallback-ladder wall-clock budget (ladderBudget.service.ts) can withdraw
 *  a rung walk before it finishes checking every rung — most likely because
 *  sold_comps was under fleet load. This is DIFFERENT from `no-exact-pool`,
 *  which means every rung looked and found nothing: a timed-out ladder made
 *  no claim about the pool at all, so the copy must not imply "no sale
 *  exists" — that would send an owner looking for a match under another
 *  slug when the truth is simply "try again once things are less busy".
 *
 *  `confidence-gate` joined 2026-09-13, the SAME shape again: the legacy
 *  confidence-gated reprice lane's own decline reason
 *  (`noBasisReasonFromEngine`'s fallback in holdingValuation.ts) was already
 *  persisted on every holding it declined, and this file's union — like the
 *  wire type it mirrors — never named it, so `withheldOf` dropped it to
 *  `null`. Unlike the other five, this is not a rare edge: measured
 *  read-only against prod on 2026-09-13, it is the SINGLE LARGEST refusal
 *  reason on the live portfolio (39 of 139 holdings, 67% of every withhold),
 *  every one of them reaching the glass as an unreasoned "—". */
export type WithheldReason =
  | "cost-basis-floor"
  | "no-checklist-match"
  | "identity-not-in-catalog"
  | "pool-migrating"
  | "no-exact-pool"
  | "ladder-timeout"
  | "confidence-gate";

export interface WithheldBlock {
  reason: WithheldReason;
  blockingId: string | null;
  blockingCount: number | null;
  proposed: number | null;
  retained: number | null;
  retentionRefused: string | null;
  retainedRung?: string | null;
}

/**
 * The refusal on this holding, or null.
 *
 * Reads the envelope only — the flat wire never carried this block, so there
 * is no legacy fallback to write and none is invented. Absent means the row
 * was published normally OR the worker predates the field; both are "no
 * refusal to explain", which is Rule 4.
 */
export function withheldOf(h: PortfolioHolding): WithheldBlock | null {
  const w = h.pricing?.provenance?.withheld;
  return w ?? null;
}

/** Rule 1: the short label, for a chip or a column. Two or three words. */
const SHORT: Record<WithheldReason, string> = {
  "cost-basis-floor": "held below your cost",
  "no-checklist-match": "checklist being acquired",
  "identity-not-in-catalog": "card not in catalog yet",
  "pool-migrating": "comps settling",
  "no-exact-pool": "no sales yet for this exact card",
  "ladder-timeout": "price still computing",
  "confidence-gate": "not enough evidence yet",
};

/** Rule 2: what would unlock a price, per reason. */
const UNLOCK: Record<WithheldReason, string> = {
  // The owner cannot act on this one — the number is the market's, and the
  // guard is deliberate. Saying "confirm the card" here would send them on an
  // errand that changes nothing.
  "cost-basis-floor": "Sales below your cost basis are not published as a value.",
  "no-checklist-match": "Confirm the card details to price it now.",
  "identity-not-in-catalog": "We are adding this card to the catalog.",
  "pool-migrating": "Recent sales are still settling into this card's pool.",
  // The owner cannot act on this one either — the card is known and
  // checklist-backed, and nothing they confirm produces a sale that has not
  // happened. Time and new data are the only unlock, same shape as the
  // cost-basis floor.
  "no-exact-pool": "Pricing resumes once a sale of this exact card is recorded.",
  // Also not the owner's to fix, and unlike no-exact-pool it is not even a
  // statement about the market — the engine simply did not finish checking
  // in time. The next repricing pass is the unlock, not a new sale.
  "ladder-timeout": "This usually resolves on its own — try refreshing in a moment.",
  // Not the owner's to fix either. The legacy pricing pass looked and could
  // not clear its own confidence bar — thin comps, a stale read, or a low
  // sample count — and declined rather than guess. The next scheduled
  // reprice, or more sales landing in the pool, is the unlock.
  "confidence-gate": "The next pricing pass may find enough evidence to publish a value.",
};

/** The words for the attention column and the row chip. */
export function withheldShort(reason: WithheldReason): string {
  return SHORT[reason];
}

/** The "what would unlock this" line for the detail panel. */
export function withheldUnlock(reason: WithheldReason): string {
  return UNLOCK[reason];
}

/**
 * The full sentence for the detail panel, with the evidence quoted.
 *
 * Rule 3 in code: `proposed` appears ONLY here, inside a sentence that says
 * it was refused. For the cost-basis floor that sentence is the whole point —
 * "the market shows $2, we did not publish it because it is far below the
 * $29.45 you paid" is a defensible refusal, while a bare "—" reads as a
 * broken price. When there is no computed number (nothing to refuse), the
 * sentence says the cause without pretending a number existed.
 */
export function withheldSentence(
  w: WithheldBlock,
  opts: { costBasis?: number | null } = {},
): string {
  const money = (n: number) =>
    `$${n.toLocaleString("en-US", {
      minimumFractionDigits: n < 100 ? 2 : 0,
      maximumFractionDigits: n < 100 ? 2 : 0,
    })}`;

  if (w.reason === "cost-basis-floor" && w.proposed != null) {
    const basis = opts.costBasis;
    return basis != null && basis > 0
      ? `The market shows ${money(w.proposed)} — far below the ${money(basis)} you paid, so we do not publish it as this card's value.`
      : `The market shows ${money(w.proposed)}, far below your cost, so we do not publish it as this card's value.`;
  }
  if (w.reason === "no-checklist-match") {
    return "We have not matched this card to a product checklist yet, so there is no pool to price it from.";
  }
  if (w.reason === "identity-not-in-catalog") {
    return "This card is not in the catalog yet, so it has no sales pool of its own.";
  }
  if (w.reason === "pool-migrating") {
    return "This card's sales are moving between pools right now. A price would be measured against a pool that is still changing.";
  }
  if (w.reason === "no-exact-pool") {
    return "This card is in the catalog, but no sale of it has been recorded yet, so there is no pool to price it from.";
  }
  if (w.reason === "ladder-timeout") {
    return "We could not finish checking this card's sales in time, likely due to high demand on our pricing data. This is not a statement that no sale exists — just try again in a moment.";
  }
  if (w.reason === "confidence-gate") {
    return "We found some evidence for this card, but not enough to publish a confident value yet. We will keep checking on the next pricing pass.";
  }
  // cost-basis-floor with nothing computed: no number to quote, and Rule 3
  // forbids borrowing one.
  return "We did not publish a market value for this card.";
}

/**
 * How many sales stood behind the refused read, when that is worth saying.
 *
 * A refusal drawn from four sales and one drawn from zero are different
 * claims, and the reader is entitled to tell them apart. Null when the count
 * is absent or zero — "0 sales" adds nothing a reason has not already said.
 */
export function withheldPoolNote(w: WithheldBlock): string | null {
  const n = w.blockingCount;
  if (n == null || n <= 0) return null;
  return n === 1 ? "1 sale in this pool" : `${n} sales in this pool`;
}

/**
 * CF-WITHHELD-OUTLIVES-THE-SPINNER (2026-09-08): may this row say
 * "CHECKING PRICE…"?
 *
 * The incident: six eBay-imported holdings showed the spinner and a bare
 * "—" indefinitely. The engine had in fact priced them and WITHHELD with
 * `no-checklist-match`, persisting a reason to each row — but the row hid
 * that reason behind the spinner for as long as a reprice looked in flight,
 * and a cross-instance poll could keep it looking in flight until the
 * client's own 5-minute deadline.
 *
 * The rule: a run being in flight is not a reason to un-say something
 * already decided. A row carrying a terminal refusal shows its REASON even
 * while a run works; a row with no verdict at all still shows the spinner,
 * because there "we are looking" is the honest claim.
 *
 * `withheld` and `value` are the same two facts the row already computes.
 */
export function showsCheckingPrice(args: {
  repricing: boolean;
  value: number | null;
  withheld: WithheldBlock | null;
}): boolean {
  if (!args.repricing) return false;
  // A published number never gets a spinner — the run may confirm it.
  if (args.value != null) return false;
  // Decided already: the reason outranks the promise of one.
  if (args.withheld != null) return false;
  return true;
}
