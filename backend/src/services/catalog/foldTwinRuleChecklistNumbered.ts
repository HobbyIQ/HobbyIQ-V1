/**
 * R1 -- CF-A-CHECKLIST-NUMBERED-ROW-IS-THE-IDENTITY (Drew, 2026-08-30 09:40Z)
 *
 * "When the checklist numbers a parallel, EVERY sale-minted twin (un-numbered,
 * or numbered differently) folds onto the checklist's numbered row and its
 * sales re-point there -- one card, one pool."
 *
 * WHY THE EXISTING decideTwinFold CANNOT ANSWER THIS. Its inputs are a
 * `baseId` plus the `numbered[]` rows sharing that literal id prefix, which
 * presumes the caller keyed its index on the un-numbered base STRING. Two
 * consequences, and Drew's own example hits both:
 *
 *   1. The checklist row is spelled `...:cpa-mh:base-refractor:auto:num-499`
 *      while the sale-minted twin is `...:cpa-mh:refractor:auto`. Those two
 *      strings never meet, so the twin is not merely skipped -- it is never a
 *      candidate. `base-refractor` and `refractor` are the same rung (D28),
 *      and 57,720 baseball rows still carried a `base-*` slug when this was
 *      measured, so it is not a wait-for-the-rename problem.
 *   2. `...:cpa-mh:refractor:auto:num-499` carries the SAME /499 as the
 *      checklist row under a different spelling. A caller that point-reads the
 *      un-numbered base id cannot reach a numbered twin at all -- and
 *      "different /N" is the larger half of the measured width.
 *
 * So R1 keys on a CLEANED IDENTITY rather than a literal id, and the authority
 * gate lives HERE rather than in the caller's query: a mutation-check showed
 * decideTwinFold will happily fold onto a DERIVED target when the caller's
 * filter is the only thing standing between it and a bad row.
 *
 * decideTwinFold itself is deliberately left untouched -- the cross-source
 * APPLY fleet is mid-flight against it and its contract must not change.
 */

/** A catalog row as this decision needs to see it. */
export type IdentityRow = {
  id: string;
  source?: string | null;
  sport?: string | null;
  year?: number | string | null;
  setKey?: string | null;
  cardNumber?: string | null;
  parallelSlug?: string | null;
  isAuto?: boolean | null;
  printRun?: number | null;
};

export type ChecklistNumberedSkip =
  | "no-checklist-numbered"
  | "ambiguous"
  | "twin-is-checklist"
  | "different-identity"
  | "twin-is-target"
  | "target-not-numbered"
  | "rival-print-run";

export type ChecklistNumberedKind = "unnumbered-twin" | "respelled-same-print-run" | "different-print-run" | "no-auto-ghost";

export type ChecklistNumberedDecision =
  | { fold: true; kind: ChecklistNumberedKind; reason: string }
  | { fold: false; skip: ChecklistNumberedSkip };

/**
 * D28's glue-strip, lifted so this rule and clean-base-cards-parallel-slug.cjs
 * share ONE spelling of "the same rung". `base-cards-refractor` and
 * `base-refractor` are both `refractor`; a slug that is only `base` stays
 * `base` -- stripping it to empty would make every Base row identical to every
 * row with no parallel at all, which is the 3.1x bloat mistake in reverse.
 *
 * Only the LEADING glue goes, once. `base-variation-refractor` is NOT reduced
 * to `variation-refractor`: `variation` is a real rung name and stripping real
 * rung names is exactly the mistake above.
 */
export function cleanParallelSlug(slug: string | null | undefined): string {
  const s = String(slug ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("base-cards-")) {
    const rest = s.slice("base-cards-".length);
    return rest || s;
  }
  if (s.startsWith("base-")) {
    const rest = s.slice("base-".length);
    if (rest) return rest;
  }
  return s;
}

/**
 * Card-number prefixes that are autographs BY DEFINITION (Drew: "CPA is what?"
 * -> Chrome Prospect Autograph). ONLY for these does a `no-auto` row count as
 * the same identity as its `auto` twin. Never a blanket auto/no-auto merge:
 * the isAuto boundary is the cardNumber, not the text.
 */
export const DEFAULT_FORCE_AUTO_PREFIXES = ["CPA", "BCPA", "CDA", "BDCA", "PA"];

/** The alphabetic prefix of a card number: "CPA-MH" -> "CPA", "BCP-109" -> "BCP". */
export function cardNumberPrefixOf(cardNumber: string | null | undefined): string {
  const m = String(cardNumber ?? "").trim().toUpperCase().match(/^([A-Z]+)/);
  return m ? m[1] : "";
}

/** Is this card an autograph by its NUMBER, whatever a source stamped on isAuto? */
export function isAutoByCardNumber(
  cardNumber: string | null | undefined,
  forceAutoPrefixes: Iterable<string> = DEFAULT_FORCE_AUTO_PREFIXES,
): boolean {
  const prefix = cardNumberPrefixOf(cardNumber);
  if (!prefix) return false;
  for (const p of forceAutoPrefixes) if (String(p).trim().toUpperCase() === prefix) return true;
  return false;
}

/**
 * The identity a row belongs to: sport | year | setKey | cardNumber | cleaned
 * parallel | auto.
 *
 * setKey comes from the row FIELD, never the id segment. The D23 rename fleet
 * renames the field first, so mid-flight a row can read
 * `hiq:baseball:2020:topps:sjr-am:sapphire:no-auto:num-25` while carrying
 * setKey=topps-triple-threads -- and the field is the newer truth. Grouping on
 * the segment instead loses several thousand groups.
 *
 * The auto half is the row's isAuto, EXCEPT where the card number is an
 * auto-by-definition prefix: there both `auto` and `no-auto` rows key as auto,
 * which is what folds bccp's `...:refractor:no-auto:num-499` ghost onto the
 * real auto row instead of leaving it behind.
 */
export function identityKeyOf(
  row: IdentityRow,
  forceAutoPrefixes: Iterable<string> = DEFAULT_FORCE_AUTO_PREFIXES,
): string {
  const sport = String(row.sport ?? "").trim().toLowerCase();
  const year = String(row.year ?? "").trim();
  const setKey = String(row.setKey ?? "").trim().toLowerCase();
  const cardNumber = String(row.cardNumber ?? "").trim().toLowerCase();
  const parallel = cleanParallelSlug(row.parallelSlug);
  const auto = row.isAuto === true || isAutoByCardNumber(row.cardNumber, forceAutoPrefixes) ? "auto" : "no-auto";
  return `${sport}|${year}|${setKey}|${cardNumber}|${parallel}|${auto}`;
}

/** The /N a row carries, from its own field or its id's trailing `:num-N`. */
export function printRunOf(row: IdentityRow): number | null {
  const pr = Number(row.printRun);
  if (Number.isFinite(pr) && pr > 0) return pr;
  const m = String(row.id ?? "").match(/:num-(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * R1: does `twin` fold onto `target`?
 *
 * FOLD iff every one of these holds:
 *   - the target is a CHECKLIST-authority row (the gate is HERE, not in the
 *     caller's query) AND carries a print run;
 *   - the twin is NOT checklist authority -- a checklist twin is
 *     cross-source's job, and R1 is explicitly about sale-minted / vendor rows;
 *   - both sit on the same cleaned identity key;
 *   - the twin is un-numbered, or carries a DIFFERENT /N than the target.
 *
 * A twin already at the target's /N and spelling is not a twin, it is the
 * target. Everything else skips with a named reason -- guessing is worse than
 * the split.
 */
export function decideChecklistNumberedFold(input: {
  target: IdentityRow;
  twin: IdentityRow;
  targetIsChecklist: boolean;
  twinIsChecklist: boolean;
  forceAutoPrefixes?: Iterable<string>;
}): ChecklistNumberedDecision {
  const { target, twin, targetIsChecklist, twinIsChecklist } = input;
  const prefixes = input.forceAutoPrefixes ?? DEFAULT_FORCE_AUTO_PREFIXES;

  if (!targetIsChecklist) return { fold: false, skip: "no-checklist-numbered" };
  const targetRun = printRunOf(target);
  if (!targetRun) return { fold: false, skip: "target-not-numbered" };

  // THE TARGET IS ONLY EVER ITSELF BY ID. A twin that agrees on every field --
  // same /N, same cleaned rung, same auto -- is still a SEPARATE ROW holding
  // its own sales, and it is precisely the row today's script cannot reach
  // (Drew's `...:cpa-mh:refractor:auto:num-499`, 1 sale, beside the checklist
  // row's 0). Comparing fields here instead of ids would skip the whole
  // "different spelling, same /N" half of the width.
  if (String(twin.id) === String(target.id)) return { fold: false, skip: "twin-is-target" };
  if (identityKeyOf(target, prefixes) !== identityKeyOf(twin, prefixes)) return { fold: false, skip: "different-identity" };

  // THE no-auto GHOST IS THE ONE CHECKLIST-AUTHORITY TWIN R1 FOLDS.
  // `bccp` classifies as checklist authority, so the plain twin-is-checklist
  // gate below would refuse the ghost Drew explicitly ruled must fold. The
  // exemption is deliberately narrow: the twin must be no-auto against an auto
  // target on an auto-BY-DEFINITION card number. That is not a taxonomy
  // disagreement between two checklists -- a CPA card is an autograph, so a
  // no-auto row for one is a transcription error, not a second card. Any other
  // checklist twin stays cross-source's business.
  const ghost = twin.isAuto !== true && target.isAuto === true && isAutoByCardNumber(twin.cardNumber, prefixes);
  if (twinIsChecklist && !ghost) return { fold: false, skip: "twin-is-checklist" };

  const twinRun = printRunOf(twin);

  // A DIFFERENT /N IS A RIVAL CARD, NOT A MISSPELLING.
  //
  // Drew's R1 text says a twin "numbered differently" folds, but every example
  // he gave is a RESPELLING at the SAME print run: `...:refractor:auto:num-499`
  // against the checklist's `...:base-refractor:auto:num-499`. Read literally,
  // "different /N" folds a genuine /1 onto a /36,960 -- the first dry run
  // surfaced exactly that (`topps:259:foilfractor:num-1` -> `...:num-36960`,
  // and `mlm-cs:gold:num-2025` -> `...:num-50`). Two real print runs are two
  // rungs of the parallel ladder, and collapsing them is the 3.1x dedup-bloat
  // mistake in reverse: "duplicate" is a conclusion, not an observation.
  //
  // So a rival /N is REPORTED for a human to rule on, never folded. What folds
  // is the row that contradicts no print run the checklist names: an
  // un-numbered twin, or one at the SAME /N under a different spelling.
  if (twinRun !== null && twinRun !== targetRun) return { fold: false, skip: "rival-print-run" };

  const kind: ChecklistNumberedKind = ghost
    ? "no-auto-ghost"
    : twinRun === null
      ? "unnumbered-twin"
      : "respelled-same-print-run";
  const why =
    kind === "no-auto-ghost"
      ? `a ${cardNumberPrefixOf(twin.cardNumber)} card is an autograph by definition, so this no-auto row is the same card as the auto one`
      : kind === "unnumbered-twin"
        ? "the twin omitted the print run the checklist names"
        : `the twin spells the same /${targetRun} card differently than the checklist does`;
  return {
    fold: true,
    kind,
    reason: `${why} -- folded onto the checklist numbered row ${target.id} [${String(target.source ?? "")}] (CF-A-CHECKLIST-NUMBERED-ROW-IS-THE-IDENTITY)`,
  };
}

/**
 * Pick the ONE checklist numbered row that is a group's identity.
 *
 * Two distinct print runs among the checklist rows -> ambiguous. Which /N was
 * the sale? Guessing is worse than the split, exactly as decideTwinFold treats
 * an ambiguous group today.
 */
export function pickChecklistNumberedTarget(
  rows: IdentityRow[],
  isChecklist: (source: string | null | undefined) => boolean,
): { target: IdentityRow } | { skip: "no-checklist-numbered" | "ambiguous" } {
  const numbered = rows.filter((r) => isChecklist(r.source) && printRunOf(r) !== null);
  if (!numbered.length) return { skip: "no-checklist-numbered" };
  const runs = new Set(numbered.map((r) => printRunOf(r)));
  if (runs.size > 1) return { skip: "ambiguous" };
  // Several checklist rows at the SAME /N are different spellings of one rung.
  // The longest id is the most specific spelling; ties break on the id string
  // so every slot and every rerun picks the same target.
  const sorted = [...numbered].sort(
    (a, b) => String(b.id).length - String(a.id).length || String(a.id).localeCompare(String(b.id)),
  );
  return { target: sorted[0] };
}

/**
 * The shard axis. A fold is decided per GROUP, so every row of one identity
 * must land on ONE worker -- shard on the twin id and two workers race to move
 * the same target. (The setKey-range lesson: an axis that is not GROUP BY'd
 * before dispatch put 89% of a retire on one worker and could not reach 66,711
 * rows.)
 */
export function shardOfIdentity(identityKey: string, slots: number, sha1hex: (s: string) => string): number {
  if (!Number.isFinite(slots) || slots <= 1) return 0;
  return parseInt(sha1hex(identityKey).slice(0, 8), 16) % slots;
}
