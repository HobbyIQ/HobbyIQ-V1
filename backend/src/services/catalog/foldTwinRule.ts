/**
 * foldTwinRule -- when does an UN-NUMBERED catalog row fold into its NUMBERED
 * twin? One pure decision shared by fold-unnumbered-twins.cjs and its tests.
 *
 * CF-A-KEY-NEEDS-BOTH-HALVES (Drew, 2026-08-29, holding ca7a150b): a twin
 * minted by a sale, a vendor or a user folds into the ONE numbered checklist
 * row that is the same card.
 *
 * CF-A-SUPERFRACTOR-IS-ONE-OF-ONE (Drew, 2026-08-29: "superfractors are 1/1",
 * two Max Williams SuperFractors in the picker -- bcp's un-numbered
 * `superfractor:auto` beside beckett's `superfractor:auto:num-1`): a
 * SuperFractor or a printing plate is 1/1 by definition (glossary), so an
 * un-numbered one is the same card with the "/1" omitted -- it folds whatever
 * its source.
 *
 * CF-ONE-SOURCE-OMITTED-THE-PRINT-RUN (mode "cross-source"): when the
 * un-numbered row and the numbered row come from DIFFERENT checklist sources
 * and the un-numbered row's source lists NO numbered variant of this card, one
 * source simply omitted the print run -- the numbered row is strictly more
 * specific (only-improve) and the twin folds. A source that itself lists both
 * an un-numbered X and an X /N is describing two cards (numbered Base is
 * checklist-defined) -- left alone.
 */
export type NumberedTwin = { id: string; printRun: number; source: string };
export type FoldMode = "vendor" | "cross-source";
export type FoldSkip = "ambiguous" | "twin-is-checklist" | "same-source-lists-both";
export type FoldDecision =
  | { fold: true; target: NumberedTwin; reason: string; kind: "vendor" | "one-of-one" | "cross-source" }
  | { fold: false; skip: FoldSkip };

/** Parallel slugs that are 1/1 by definition (glossary: SuperFractor, Printing Plate). */
export const ALWAYS_ONE_OF_ONE = /(^|-)superfractor(-|$)|printing-plate/;

/** The parallel segment of an un-numbered hiq id: hiq:sport:year:setKey:cardNumber:PARALLEL:auto */
export function parallelSlugOf(baseId: string): string {
  const seg = String(baseId ?? "").split(":");
  return seg.length >= 6 ? seg[5] : "";
}

export function decideTwinFold(input: {
  baseId: string;
  twinSource: string;
  twinIsChecklist: boolean;
  numbered: NumberedTwin[];
  mode: FoldMode;
}): FoldDecision {
  const { baseId, twinSource, twinIsChecklist, numbered, mode } = input;
  const oneOfOne = ALWAYS_ONE_OF_ONE.test(parallelSlugOf(baseId));
  const runs = new Set(numbered.map((n) => n.printRun));
  let target: NumberedTwin | undefined;
  if (runs.size === 1) target = numbered[0];
  else if (oneOfOne) target = numbered.find((n) => n.printRun === 1); // the /1 IS the card; the other print runs are mis-parses
  if (!target) return { fold: false, skip: "ambiguous" };

  if (!twinIsChecklist) {
    return { fold: true, target, kind: "vendor", reason: "un-numbered twin folded into its one numbered checklist row (CF-A-KEY-NEEDS-BOTH-HALVES)" };
  }
  if (oneOfOne && target.printRun === 1) {
    return { fold: true, target, kind: "one-of-one", reason: "a SuperFractor / printing plate is 1/1 by definition; the un-numbered row omitted it (CF-A-SUPERFRACTOR-IS-ONE-OF-ONE)" };
  }
  if (mode === "cross-source") {
    if (numbered.some((n) => n.source === twinSource)) return { fold: false, skip: "same-source-lists-both" };
    return { fold: true, target, kind: "cross-source", reason: `one checklist source (${twinSource}) omitted the print run another (${target.source}) lists -- the numbered row is strictly more specific (CF-ONE-SOURCE-OMITTED-THE-PRINT-RUN)` };
  }
  return { fold: false, skip: "twin-is-checklist" };
}
