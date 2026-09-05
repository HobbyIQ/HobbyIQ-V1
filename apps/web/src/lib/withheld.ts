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

/** The engine's closed vocabulary, mirrored from the wire. */
export type WithheldReason =
  | "cost-basis-floor"
  | "no-checklist-match"
  | "identity-not-in-catalog"
  | "pool-migrating";

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
