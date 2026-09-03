/**
 * cpaProductRule -- which PRODUCT does an autograph card belong to, when the
 * catalog files the same card number under two of them?
 *
 * CF-THE-CHECKLIST-THAT-NAMES-THE-PRODUCT-WINS (Drew, 2026-08-30, D29/R2):
 * "the checklist that names the product wins; bcp's Bowman page is not that."
 *
 * The shape. 2021 CPA-AM is listed at `bowman` by baseballcardpedia and at
 * `bowman-chrome` by checklistcenter-2026-08-29. Those are not two cards: the
 * Chrome Prospect Autographs insert ships in one release, and the wiki page
 * filed it beside the other. The dedicated transcription names the product;
 * the wiki row folds onto it, carrying its sales.
 *
 * -- ROUND 1 WAS CORRECT AND COULD NOT REACH ITS POPULATION -----------------
 *
 * R1 ran on an identity key that required an EXACT `parallelSlug` string
 * match, and the two products spell the same rung differently. 2021 CPA-AM at
 * /499 is filed three ways -- `base-refractor` (checklistcenter),
 * `refractors-refractor` (beckett), `refractor` (bccp) -- so the one card
 * arrived as three groups and every one of them abstained "single-setkey".
 * Measured over the declared scope: the exact key found 1,506 fold groups and
 * left 100,418 single-setkey abstains; 2,894 of 3,033 (year, number, auto,
 * player) groups carry more than one spelling.
 *
 * So the key folds SPELLING (parallelSpellingFold, per D31 12:50Z: two
 * checklist SOURCES spelling one card two ways at the SAME print run is a
 * spelling, not two cards) and keeps the PRINT RUN as an attribute that must
 * agree. `groupKey` below builds it; `printRunsAgree` enforces the second half.
 *
 * -- THE COLLISION THE RULING DID NOT ANTICIPATE ----------------------------
 *
 * (year, cardNumber, parallelSlug, auto) is NOT a card. CPA numbers are
 * INITIALS, and initials collide: CPA-AN is both Angel Nunez and Alejandro
 * Nunez (memory: project_beckett_initials_card_numbers_collide). Measured over
 * the bowman CPA scope, of 3,459 identities carrying two dedicated setKeys,
 * 1,879 -- the MAJORITY -- are two different players who happen to share an
 * initials number, not one card filed under two products:
 *
 *     2021 CPA-ED   bowman/Eddy Diaz [beckett]  vs  bowman-chrome/Elijah Dunham [checklistcenter]
 *     2021 CPA-AM   bowman/Austin Martin        vs  bowman-chrome/Alexander Mojica
 *     2021 CPA-ARA  bowman/Alexander Ramirez    vs  bowman-chrome/Aldo Ramirez
 *
 * Reading those as a product conflict would report 1,879 phantom conflicts;
 * FOLDING them would merge two players' cards and their pools. So the player
 * gate comes FIRST and it is absolute: this rule decides a product only among
 * rows that agree on WHO is on the card. It never decides across a
 * disagreement and never guesses through a missing name -- 16,831 bccp rows in
 * scope carry `playerName: null`, and a null is not agreement.
 *
 * -- WHAT THIS RULE DELIBERATELY DOES NOT DO --------------------------------
 *
 * It never mints, never invents a target, and never picks between two dedicated
 * checklists. Two real products listing the same number for the same player is
 * a genuine split (R2: "both rows stay and the sales split by the title's
 * product words") -- this returns `keep-both` and the caller reports it. Every
 * other uncertainty is `abstain`, which is a decision to leave the data alone,
 * not a failure.
 *
 * Pure: no I/O, no Cosmos, no clock. The fleet reads it, the tests kill it.
 */
import { isBcpFamily, isDedicatedChecklist, catalogAuthorityOf } from "./catalogAuthority.service";
import { isProductSetKey } from "./productSetKeys";
import { foldCardNumber, sameCardNumber } from "../portfolioiq/hobbyIqCardId.service";
import { foldSpelling, chooseSpelling } from "./parallelSpellingFold";

/** One catalog row as this rule needs to see it. */
export type CpaRow = {
  id: string;
  setKey: string;
  source: string;
  playerName?: string | null;
  printRun?: number | null;
  /** The stored spelling. The group is keyed on its FOLD, not on this string. */
  parallelSlug?: string | null;
};

export type CpaAbstain =
  | "single-setkey"
  | "no-dedicated-source"
  | "player-disagreement"
  | "print-run-disagree"
  | "target-not-a-product"
  | "nothing-to-fold";

export type CpaDecision =
  | {
      kind: "fold";
      target: string;
      from: string[];
      rows: CpaRow[];
      reason: string;
      /** The spelling that survives (D31 majority-of-sources), or null. */
      spelling: string | null;
    }
  | { kind: "keep-both"; setKeys: string[]; reason: string }
  | { kind: "abstain"; why: CpaAbstain; detail: string };

/**
 * CF-THE-ID-CARRIES-THE-PRODUCT (D23): hyphen- and case-insensitive. Re-exported
 * from hobbyIqCardId.service so this rule and D23's rename fleet share ONE
 * comparison rather than two that can drift apart.
 */
export { sameCardNumber };

/**
 * The identity key rows are grouped on, stated ONCE so the fleet, the tests and
 * any later reader cannot drift apart.
 *
 *   (year, folded cardNumber, auto, player, folded parallel spelling)
 *
 * The print run is deliberately NOT in the key: D31 makes it an attribute that
 * must AGREE, which `printRunsAgree` checks inside the group. Putting it in the
 * key would re-split the very rows the spelling fold just brought together --
 * a checklist that numbers a rung /499 and a wiki row that leaves it blank are
 * the same card, and they must land in one group for the rule to see both.
 *
 * A row with no player name still gets a key (the empty player), because the
 * player GATE -- not the grouping -- is what refuses to decide across a
 * disagreement. Grouping nulls together keeps them visible to that gate.
 */
export function groupKey(row: {
  year?: number | string | null;
  cardYear?: number | string | null;
  cardNumber?: string | null;
  isAuto?: boolean | null;
  playerName?: string | null;
  parallelSlug?: string | null;
}): string {
  return [
    String(row.year ?? row.cardYear ?? ""),
    foldCardNumber(row.cardNumber),
    row.isAuto === true ? "auto" : "no-auto",
    playerKey(row.playerName),
    foldSpelling(row.parallelSlug),
  ].join("|");
}

/**
 * The player-name key. Case, punctuation and spacing are noise; a missing name
 * is NOT a name, and is never treated as agreement with anything.
 */
export function playerKey(name: string | null | undefined): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * A derived or vendor row's product filing folds too -- it was generated from
 * our own comps or a vendor's classification, and neither names a product
 * (catalogAuthority: "consume CardHedge SALES, not CardHedge PRODUCT fields").
 * A dedicated checklist row never folds, and an UNKNOWN source is left alone
 * rather than assumed foldable.
 */
export function isFoldableProductFiling(source: string | null | undefined): boolean {
  const s = String(source ?? "").toLowerCase().trim().replace(/-graded$/, "");
  if (isDedicatedChecklist(s)) return false;
  if (isBcpFamily(s)) return true;
  return /^(ingest-auto-seed|sold-comps-stub|catalog-explode|tree-builder|sales-derived|sales-attested|pool|subset-unfold|cardhedge|cardsight|ebay)/.test(s);
}

/** The set of distinct NAMED players among these rows (nulls excluded). */
function namedPlayers(rows: CpaRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const k = playerKey(r.playerName);
    if (k) out.add(k);
  }
  return out;
}

const setKeyOf = (r: CpaRow): string => String(r.setKey ?? "").toLowerCase().trim();

/** A finite, positive print run, or null. `/0` and NaN are not print runs. */
function printRunOf(r: CpaRow): number | null {
  const n = r.printRun;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Do the rows agree on the print run?
 *
 * D31: the print run is "an attribute that must AGREE (same /N, or one side
 * un-numbered where the checklist numbers it) -- never merge two different
 * print runs". So: at most ONE distinct /N among the rows. A row carrying no
 * print run agrees with any single /N -- that is the "un-numbered where the
 * checklist numbers it" case, and it is exactly how a bare `gold` row meets
 * the checklist's `gold-refractor /50`. Two DIFFERENT numbers are two cards
 * and the caller must abstain rather than pick one.
 */
export function printRunsAgree(rows: CpaRow[]): { agree: boolean; runs: number[] } {
  const runs = [...new Set((rows ?? []).map(printRunOf).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  return { agree: runs.length <= 1, runs };
}

/** Does this source's spelling get a vote? Only a checklist transcription. */
const spellingVotes = (r: CpaRow): boolean => catalogAuthorityOf(r.source) === "checklist";

/**
 * Decide the product for ONE identity group -- rows sharing
 * (year, folded cardNumber, parallelSlug, auto), already grouped by the caller.
 *
 * The order of the gates IS the rule:
 *   1. one setKey                       -> nothing to decide
 *   2. no dedicated row at all          -> abstain; R2 names no winner
 *   3. dedicated rows name 2+ players   -> abstain: an initials collision, and
 *                                          NOT a product conflict
 *   4. dedicated rows name 2+ setKeys
 *      for the SAME player              -> keep-both; the caller splits sales
 *   5. exactly one dedicated setKey     -> fold every OTHER setKey's rows onto
 *                                          it -- but only rows that AGREE on
 *                                          the player, and only rows whose
 *                                          product filing is foldable.
 */
export function decideCpaProduct(rows: CpaRow[]): CpaDecision {
  const all = (rows ?? []).filter((r) => r && setKeyOf(r));
  const setKeys = new Set(all.map(setKeyOf));
  if (setKeys.size <= 1) {
    return {
      kind: "abstain",
      why: "single-setkey",
      detail: `all ${all.length} rows sit at ${[...setKeys][0] ?? "(none)"}`,
    };
  }

  const dedicated = all.filter((r) => isDedicatedChecklist(r.source));
  if (dedicated.length === 0) {
    const sources = [...new Set(all.map((r) => String(r.source ?? "?")))].join(", ");
    return {
      kind: "abstain",
      why: "no-dedicated-source",
      detail: `${setKeys.size} setKeys and no dedicated checklist among [${sources}] -- R2 names no winner`,
    };
  }

  // GATE: the initials collision. Two dedicated rows naming two different
  // players are two CARDS that share a number, not one card filed twice.
  const dedicatedPlayers = namedPlayers(dedicated);
  if (dedicatedPlayers.size > 1) {
    const shown = dedicated.map((r) => `${setKeyOf(r)}/${r.playerName ?? "?"}`).join(" vs ");
    return {
      kind: "abstain",
      why: "player-disagreement",
      detail: `the dedicated rows name ${dedicatedPlayers.size} different players (${shown}) -- an initials collision, not a product conflict`,
    };
  }

  const dedicatedSetKeys = [...new Set(dedicated.map(setKeyOf))].sort();
  if (dedicatedSetKeys.length > 1) {
    // A "conflict" between `bowman` and `bowman-baseball` is one product spelled
    // two ways mid-rename, not two products. Report it as the spelling question
    // it is rather than asking Drew to rule on a phantom.
    if (!dedicatedSetKeys.every((k) => isProductSetKey(k))) {
      const unspelled = dedicatedSetKeys.filter((k) => !isProductSetKey(k));
      return {
        kind: "abstain",
        why: "target-not-a-product",
        detail: `dedicated setKeys [${dedicatedSetKeys.join(", ")}] include a spelling productSetKeys does not carry (${unspelled.join(", ")}) -- D23's rename population, not a product conflict`,
      };
    }
    return {
      kind: "keep-both",
      setKeys: dedicatedSetKeys,
      reason: `two dedicated checklists name the same card for the same player (${dedicatedSetKeys.join(" and ")}) -- both products are real; sales split by the title's product words (R2)`,
    };
  }

  const target = dedicatedSetKeys[0];

  // THE TARGET MUST BE A PRODUCT THE TABLE SPELLS.
  //
  // A dedicated source is trusted to name WHICH product, not to spell it. The
  // catalog currently holds 475 CPA rows at `bowman-baseball` and 58 at
  // `bowman-mega`, all from dedicated sources -- un-normalized spellings that
  // D23's rename fleet is moving to `bowman` and `bowman-mega-box` right now.
  // Folding onto one of those would move rows to an address that is about to
  // stop existing, and would do it with a checklist source's authority. So the
  // winner must be a key productSetKeys actually spells; anything else is a
  // spelling question, not a product question, and is left for the rename.
  if (!isProductSetKey(target)) {
    return {
      kind: "abstain",
      why: "target-not-a-product",
      detail: `the only dedicated setKey is "${target}", which productSetKeys does not spell -- an un-normalized spelling (D23's rename population), not a product ruling`,
    };
  }

  // GATE: the print run must AGREE (D31) -- and it is checked HERE, not
  // earlier, because it guards a MERGE and nothing above this line merges.
  // `keep-both` leaves two rows standing and `target-not-a-product` defers to
  // D23's rename; neither cares what the print runs say, and refusing them on a
  // print run would report a phantom (a /499 bowman row beside a /250
  // mega-box row is two real products, not a print-run conflict).
  //
  // The group key folds SPELLINGS, not print runs: `gold` and `gold-refractor`
  // arrive together only because the caller collapsed the finish suffix. D31 is
  // explicit that from ONE source at different print runs they are two cards,
  // so two distinct /N here means the fold key was too loose for this group and
  // the rows are left exactly as they are.
  const runs = printRunsAgree(all);
  if (!runs.agree) {
    return {
      kind: "abstain",
      why: "print-run-disagree",
      detail: `${target} is the only dedicated product, but the rows carry ${runs.runs.length} different print runs (/${runs.runs.join(", /")}) -- different print runs are different cards (D31), never merged`,
    };
  }

  const player = [...dedicatedPlayers][0] ?? "";

  // Only rows that AGREE on the player fold. A bcp row naming someone else is
  // a different card that happens to share the number (measured: 267 of the
  // 2,385 fold groups), and a null name is not agreement.
  const foldable: CpaRow[] = [];
  for (const r of all) {
    if (setKeyOf(r) === target) continue;
    if (!isFoldableProductFiling(r.source)) continue;
    if (player) {
      const k = playerKey(r.playerName);
      if (!k || k !== player) continue;
    }
    foldable.push(r);
  }

  if (foldable.length === 0) {
    return {
      kind: "abstain",
      why: "nothing-to-fold",
      detail: `${target} is the only dedicated product, but no other row both agrees on the player and carries a foldable product filing`,
    };
  }

  // THE SURVIVING SPELLING (D31, 12:50Z). The group holds one card spelled
  // several ways; the majority spelling among the CHECKLIST sources at the
  // winning product wins, ties to the longer form. Only rows already AT the
  // target vote -- the losing product's spelling does not get to rename the
  // winner's row, and a derived row never votes at all. When no row at the
  // target carries a spelling this is null and the caller leaves the
  // destination's parallel exactly as it is.
  const atTarget = all.filter((r) => setKeyOf(r) === target && String(r.parallelSlug ?? "").trim() !== "");
  const spelling = chooseSpelling(
    atTarget.map((r) => ({
      parallelSlug: String(r.parallelSlug),
      source: String(r.source ?? ""),
      isChecklist: spellingVotes(r),
    })),
  );

  return {
    kind: "fold",
    target,
    from: [...new Set(foldable.map(setKeyOf))].sort(),
    rows: foldable,
    reason: `the checklist that names the product wins: ${target} is named by a dedicated checklist; the other rows file the same card under another product (D29/R2)`,
    spelling,
  };
}
