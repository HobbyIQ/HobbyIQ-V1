/**
 * duplicateWinnerRule -- D30. Given every catalog row that a group key says is
 * ONE card, which row survives, which rows fold onto it, and which groups must
 * a human rule on?
 *
 * Drew, 2026-08-30 09:50Z: "we need to find any duplicate cards in the card
 * catalog and consolidate all sales onto it. This will be a big big big issue
 * for us if sales are split across different cards in the card catalog of the
 * same card."
 *
 * Pure: no I/O, no Cosmos, no clock. The fleet reads it, the tests kill it.
 *
 * -- WHAT THIS MODULE IS *NOT* ----------------------------------------------
 *
 * It does not re-implement D29. `decideChecklistNumberedFold` (R1) and
 * `decideCpaProduct` (R2) are the shipped decisions for the numbered fold and
 * the CPA product question, and the fleet CALLS them. What lives here is the
 * decision D29 does not make: which of several rows on one identity survives
 * when the disagreement is a SPELLING, a COLOUR FORM, or an authority
 * difference -- plus the reach R1 explicitly declines (`twin-is-checklist`:
 * 65,856 of baseball's 78,560 numbered-vs-unnumbered groups have BOTH rows
 * checklist, and R1 skips every one of them by design).
 *
 * -- THE D31 COLOUR KEY, AND THE TWO READINGS THAT DESTROY REAL CARDS -------
 *
 * D31 (Drew, 2026-08-30 12:50Z) retracted the colour=refractor vocabulary rule:
 * a bare colour and `<colour> Refractor` are ONE card UNLESS one checklist
 * source names both forms. Everything turns on what "one source" means, and
 * both intuitive readings were measured against ground truth and REFUTED:
 *
 *   (a) collapse scrape runs to the PUBLISHER. Then 2025 Topps Chrome #79 reads
 *       `printing-plates-black` (checklistcenter) against
 *       `printing-plates-black-refractor` (checklistcenter-2026-08-29) as "one
 *       publisher names both" = two cards. A printing plate is a 1/1; there is
 *       no refractor plate. That MERGE-BLOCK leaves a real duplicate split
 *       forever.
 *
 *   (b) discriminate on PRINT RUN. Then Topps Finest #197 -- which carries
 *       `uncommon` and `uncommon-refractor` BOTH un-numbered from one
 *       `checklistcenter` string -- MERGES. Drew named those as TWO cards (600
 *       of them). This is the expensive direction: it destroys real cards.
 *
 * The discriminator that survives both is the SOURCE STRING -- ONE SCRAPE RUN.
 * One run listing both forms side by side is the site saying "two cards"; two
 * runs disagreeing is the site RE-SPELLING one card between scrapes. Publisher
 * collapse is used for exactly one thing: rule 3's majority, where two runs of
 * one site must not vote twice.
 *
 * All five nameable ground-truth cases are pinned in
 * tests/consolidateDuplicateRule.d31Colour.test.ts. Substituting `publisherOf`
 * for `sourceKeyOf` in the colour gate flips Finest #197 from two cards to one,
 * which is why consolidateDuplicateRule.sourceIdentity.test.ts asserts the two
 * functions are NOT interchangeable.
 */
import { catalogAuthorityOf } from "./catalogAuthority.service";
import { foldSpelling, chooseSpelling } from "./parallelSpellingFold";
import { isProductSetKey, productEntry, productSetKeyForName, spellForEra } from "./productSetKeys";
import {
  printRunOf,
  cleanParallelSlug,
  isAutoByCardNumber,
  DEFAULT_FORCE_AUTO_PREFIXES,
} from "./foldTwinRuleChecklistNumbered";

/** A catalog row as the D30 rules need to see it. */
export type DupRow = {
  id: string;
  cardId?: string | null;
  source?: string | null;
  sport?: string | null;
  year?: number | string | null;
  setKey?: string | null;
  cardNumber?: string | null;
  parallelSlug?: string | null;
  isAuto?: boolean | null;
  printRun?: number | null;
  playerName?: string | null;
  /** Sales observed on this row. Only ever a TIE-BREAK, never an authority. */
  salesCount?: number | null;
};

/** Why a group needs Drew. Reasons are DISJOINT: the first match names it. */
export type AmbiguousReason =
  | "no-checklist-row"
  | "two-checklist-print-runs-one-product"
  | "d31-one-source-names-both-colour-forms"
  | "two-dedicated-cpa-products"
  | "contradicts-holding-ruling";

/** Why a group is not a duplicate at all, and is never folded. */
export type NotAGroupReason = "single-row" | "printrun-conflict" | "player-differs";

export type WinnerBy =
  | "checklist-authority" // r1
  | "numbered" // r2
  | "spelling-majority" // r3
  | "cpa-product" // r4
  | "colour-checklist-form" // r5
  | "no-auto-ghost" // r6
  | "canonical-spelling" // r7
  | "sales"; // r1 fallback: all-derived, most sales survives

export type DupDecision =
  | { kind: "consolidate"; winner: DupRow; losers: DupRow[]; winnerBy: WinnerBy; reason: string }
  | { kind: "ambiguous"; why: AmbiguousReason; detail: string; rows: DupRow[]; nearMiss?: boolean }
  | { kind: "not-a-group"; why: NotAGroupReason; detail: string };

// -- the pool width ----------------------------------------------------------

/**
 * DOES THIS POOL KEY BELONG TO THIS LOSER?
 *
 * `moveCatalogRow` re-points sales with `WHERE c.hobbyiqCardId = @s` -- an
 * EXACT match. Pool keys routinely EXTEND a row id with `:num-N` or a grade
 * segment, so a fold that only moved exact matches would strand them on a
 * deleted row.
 *
 * Widening to `STARTSWITH(id + ":")` creates the opposite hazard: within one
 * group a NUMBERED TWIN's id is itself an extension of the un-numbered loser's
 * id, so `<loser>:num-50` would be claimed by the loser and a real /50 card's
 * sales would move onto the un-numbered winner. LONGEST MATCH decides: a key
 * belongs to the most specific row in the group that prefixes it.
 *
 * This lives in the tested module rather than inside the script so the test
 * pins the CODE THAT RUNS. A test that re-implements the rule locally vouches
 * only for its own copy, and drifts silently from the script it names.
 */
export function ownsPoolKey(key: string, loserId: string, rivals: readonly string[]): boolean {
  if (key === loserId) return true;
  if (!key.startsWith(`${loserId}:`)) return false;
  for (const rid of rivals) {
    if ((key === rid || key.startsWith(`${rid}:`)) && rid.length > loserId.length) return false;
  }
  return true;
}

// -- the D30 grouping key ----------------------------------------------------

/**
 * THE PRODUCT HALF OF THE D30 GROUPING KEY, and why D29's `identityKeyOf`
 * cannot be it.
 *
 * `identityKeyOf` puts the RAW `setKey` FIELD in the key. That is exactly
 * right for D29 (R1 compares a target and a twin that already sit in one
 * product) and it is pinned by
 * `foldTwinRuleChecklistNumbered.test.ts:330` -- "identityKeyOf reads the
 * setKey FIELD, not the id segment" -- so it must not change. But it makes
 * TWO of D30's six modes unreachable, because D30's job is precisely the
 * groups whose rows disagree about the product's SPELLING:
 *
 *   - MODE=setkey (`id-setkey-drift`) needs the two spellings of ONE product
 *     to meet. Measured live 2026-08-30: `finest` [baseballcardpedia] vs
 *     `topps-finest` [checklistinsider] on 2024 #93-19 Andrew McCutchen --
 *     one card, two rows, two spellings, and the raw-field key never
 *     compares them.
 *   - MODE=cpa (`cross-product-cpa`) needs `bowman` and `bowman-chrome` to
 *     meet for an auto-prefixed CPA number, which is the whole population
 *     D29 R2 exists to decide.
 *
 * SO THE KEY NORMALIZES THE PRODUCT, AND ONLY THE PRODUCT'S SPELLING:
 *
 *   1. `productSetKeyForName` maps a KNOWN ALIAS of a product to that
 *      product's one spelling (`finest` -> `topps-finest`, `topps-update` ->
 *      `topps-update-series`). A setKey the table does not spell passes
 *      through UNCHANGED -- an unknown product is its own product, never
 *      guessed into a neighbour.
 *   2. `spellForEra` applies Drew's Donruss ruling (b): from 2009 the product
 *      is `panini-donruss`, before it `donruss`. So `donruss` and
 *      `panini-donruss` group together WITHIN one year and never across the
 *      1990/2024 boundary.
 *   3. The CPA exception, and nothing wider: `bowman` and `bowman-chrome`
 *      collapse to one product ONLY for an auto-prefixed CPA-style card
 *      number, exactly as the measurement did
 *      (`measure-baseball-2024-2026.cjs:256`).
 *
 * WHAT IT DELIBERATELY DOES NOT DO -- the catastrophic direction. Over-
 * grouping here MERGES DIFFERENT REAL CARDS, so every one of these stays a
 * separate group and is pinned by a test:
 *
 *   - `bowman` vs `bowman-chrome` for a NON-CPA number (#220): paper and
 *     chrome are different cards (memory: bowman-vs-chrome merging "would be
 *     catastrophic").
 *   - `bowman-chrome` vs `bowman-chrome-sapphire`: sapphire is another set,
 *     CPA number or not -- the CPA collapse names two products explicitly and
 *     sapphire is not one of them.
 *   - `bowman-draft` vs `bowman-chrome`, `bowman` vs `bowman-paper`: the
 *     family ladder relates them for PRICING, and `productFamilyOf` would
 *     collapse all four to `bowman`. Identity is not the family, so the
 *     family ladder is NOT used here.
 *
 * That last point is why `productFamilyOf` -- imported and never called by
 * the first build of the fleet -- is the WRONG function for this key: it maps
 * `bowman-chrome`, `bowman-paper`, `bowman-draft` and `bowman` all to
 * `bowman`, which is the merge Drew called catastrophic.
 */
const CPA_COLLAPSE_NUMBER = /^(?:cpa|bcpa)-/i;

/** The two products the CPA rule -- and only the CPA rule -- collapses. */
export const CPA_COLLAPSE_PRODUCTS = ["bowman", "bowman-chrome"] as const;

/** The one spelling of a row's product: a known alias resolved, the Donruss
 *  era applied, anything else left exactly as it was written. */
export function productKeyOf(row: Pick<DupRow, "setKey" | "year">): string {
  const raw = String(row.setKey ?? "").trim().toLowerCase();
  if (!raw) return "";
  const spelled = productSetKeyForName(raw) ?? raw;
  const year = Number(row.year);
  return spellForEra(spelled, Number.isFinite(year) && year > 0 ? year : null);
}

/** True iff this row is a `bowman`/`bowman-chrome` row at an auto-prefixed
 *  CPA-style number -- the ONE place two products share an identity. */
export function isCpaCollapseRow(row: Pick<DupRow, "setKey" | "year" | "cardNumber">): boolean {
  const p = productKeyOf(row);
  if (p !== "bowman" && p !== "bowman-chrome") return false;
  return CPA_COLLAPSE_NUMBER.test(String(row.cardNumber ?? "").trim());
}

/** The product half of the grouping key: the product's one spelling, or the
 *  collapsed `bowman|bowman-chrome` for a CPA number. */
export function groupProductKeyOf(row: Pick<DupRow, "setKey" | "year" | "cardNumber">): string {
  return isCpaCollapseRow(row) ? CPA_COLLAPSE_PRODUCTS.join("|") : productKeyOf(row);
}

/**
 * THE D30 GROUPING KEY: `sport | year | product | number | parallel | auto`.
 *
 * Every half except the product is D29's, byte for byte -- `cleanParallelSlug`
 * for the parallel and the same auto-by-card-number gate -- so a group the
 * two keys agree on is the same group, and R1 can still be called on its rows.
 * The product half is the one thing D30 widens, and only as far as one
 * product's own spellings.
 */
export function groupKeyOf(row: DupRow, forceAutoPrefixes: readonly string[] = DEFAULT_FORCE_AUTO_PREFIXES): string {
  const sport = String(row.sport ?? "").trim().toLowerCase();
  const year = String(row.year ?? "").trim();
  const cardNumber = String(row.cardNumber ?? "").trim().toLowerCase();
  const parallel = cleanParallelSlug(row.parallelSlug);
  const auto = row.isAuto === true || isAutoByCardNumber(row.cardNumber, forceAutoPrefixes) ? "auto" : "no-auto";
  return `${sport}|${year}|${groupProductKeyOf(row)}|${cardNumber}|${parallel}|${auto}`;
}

// -- source identity ---------------------------------------------------------

/**
 * ONE SCRAPE RUN. `checklistcenter` and `checklistcenter-2026-08-29` are two
 * DIFFERENT keys, deliberately: that is the whole D31 discriminator. Only the
 * `-graded` twin collapses, because a graded row has the same provenance as its
 * parent and is not a second transcription.
 */
export function sourceKeyOf(source: string | null | undefined): string {
  const s = String(source ?? "").toLowerCase().trim().replace(/-graded$/, "");
  return s || "(none)";
}

const SOURCE_PUBLISHER: ReadonlyArray<readonly [RegExp, string]> = [
  [/^beckett/, "beckett"],
  [/^(baseballcardpedia|bccp)/, "baseballcardpedia"],
  [/^checklistinsider/, "checklistinsider"],
  [/^checklistcenter/, "checklistcenter"],
  [/^cardboard/, "cardboardconnection"],
  [/^hobbymonitor/, "hobbymonitor"],
  [/^tcdb/, "tcdb"],
];

/**
 * THE SITE BEHIND A SCRAPE RUN -- used ONLY for rule 3's majority, so two runs
 * of one site cannot vote twice. NEVER for the D31 colour question: substitute
 * this for `sourceKeyOf` there and Topps Finest #197's 600 real cards merge.
 */
export function publisherOf(source: string | null | undefined): string {
  const s = String(source ?? "")
    .toLowerCase()
    .trim()
    .replace(/-graded$/, "")
    .replace(/[-_]?(scraped|scrape|import|run)?[-_]?\d{4}[-_]\d{2}[-_]\d{2}.*$/, "")
    .replace(/[-_]?v?\d+$/, "")
    .replace(/[-_]+$/, "");
  if (!s) return "(none)";
  for (const [re, pub] of SOURCE_PUBLISHER) if (re.test(s)) return pub;
  return s;
}

export const isChecklistRow = (r: DupRow): boolean => catalogAuthorityOf(r.source) === "checklist";

// -- the colour form ---------------------------------------------------------

/**
 * The finish words a bare colour can gain. Refractor is D31's named case; a
 * trailing `-prizm` rides the same shape. Deliberately SHORT: this list is a
 * suffix test inside a group already proven to be one card, never a vocabulary
 * rule about what a colour means (D31 retracted exactly that).
 */
const COLOUR_FINISHES = ["refractor", "prizm"] as const;

/**
 * `gold-refractor` -> { base: "gold", finish: "refractor" }. A slug with no
 * trailing finish word returns its own text as the base and a null finish.
 */
export function colourFormOf(slug: string | null | undefined): { base: string; finish: string | null } {
  const s = cleanParallelSlug(slug);
  for (const fin of COLOUR_FINISHES) {
    if (s.endsWith(`-${fin}`)) return { base: s.slice(0, -(fin.length + 1)), finish: fin };
  }
  return { base: s, finish: null };
}

/**
 * D31: does ONE SCRAPE RUN name both the bare colour and its `<colour>-finish`
 * form for this card? If so they are TWO CARDS and the group must not fold.
 *
 * Only CHECKLIST rows are asked. A derived row carrying both forms is our own
 * minting, not a site's statement about what exists -- and the retracted rule
 * is precisely what minted many of them.
 */
export function oneSourceNamesBothColourForms(
  rows: DupRow[],
): { both: true; source: string; forms: [string, string] } | { both: false } {
  const byRun = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!isChecklistRow(r)) continue;
    const slug = cleanParallelSlug(r.parallelSlug);
    if (!slug) continue;
    const key = sourceKeyOf(r.source);
    const set = byRun.get(key) ?? new Set<string>();
    set.add(slug);
    byRun.set(key, set);
  }
  for (const [src, forms] of byRun) {
    for (const slug of forms) {
      const { base, finish } = colourFormOf(slug);
      // The bare form is present alongside this finished form, from the SAME run.
      if (finish && base && forms.has(base)) return { both: true, source: src, forms: [base, slug] };
    }
  }
  return { both: false };
}

// -- print runs --------------------------------------------------------------

export const runOf = (r: DupRow): number | null => printRunOf(r as never);

/**
 * The distinct print runs among CHECKLIST rows. Two different /N from two
 * checklist rows of ONE product is D30's biggest ambiguous bucket and is never
 * folded -- but see `nearMissPrintRuns`, which splits the counter so Drew sees
 * a product-level question rather than a 51,182-row list.
 */
export function checklistRuns(rows: DupRow[]): number[] {
  return [...new Set(rows.filter(isChecklistRow).map(runOf).filter((n): n is number => n !== null))].sort(
    (a, b) => a - b,
  );
}

/**
 * A BASE CARD IS NOT A 1/1, AND A /1 ON ONE IS A TRANSCRIPTION ERROR.
 *
 * FOUND IN A LIVE DRY RUN, 2026-08-30. 2024 Panini Prizm #347 (Jayden Daniels
 * RC) carries two base rows:
 *
 *   ...:347:base:no-auto          beckett-scraped-2026-08-26   un-numbered, 190 sales
 *   ...:347:base:no-auto:num-1    checklistinsider-2026-08-28  /1, 0 sales
 *
 * Rule 2 ("numbered beats un-numbered") folded the genuine base card onto the
 * /1 and carried 190 ordinary base sales ($24-$136, titles reading "Jayden
 * Daniels #347 (RC)") with it. A real 1/1 Daniels rookie is worth thousands, so
 * that fold corrupts the identity's FMV in the EXPENSIVE direction -- the same
 * shape as the Finest #197 merge D31 exists to prevent.
 *
 * A base card is the most-printed card in the product; a print run of 1 on one
 * is a mis-transcription, never a rung. Panini Prizm's genuine 1/1s are named
 * parallels (black-finite, choice-nebula, gold-vinyl), and those are unaffected
 * because their parallel slug is not `base`.
 *
 * The group becomes AMBIGUOUS rather than folding the other way: the /1 row may
 * be a real card the checklist mis-filed, and guessing is worse than the split.
 */
export function baseCardCannotBeOneOfOne(rows: DupRow[]): boolean {
  const isBase = (r: DupRow) => {
    const s = cleanParallelSlug(r.parallelSlug);
    return s === "" || s === "base";
  };
  if (!rows.some(isBase)) return false;
  return rows.some((r) => isBase(r) && runOf(r) === 1) && rows.some((r) => isBase(r) && runOf(r) === null);
}

/**
 * Are these print runs a TRANSCRIPTION ERROR rather than two rungs?
 *
 * Sampling 40 of the 51,182 two-checklist-print-run groups: 30 are runs within
 * 10% of each other, overwhelmingly /149 vs /150 concentrated in 2024
 * bowman-chrome-mega-box, where checklistcenter-2026-08-29 says /149,
 * checklistinsider-2026-08-27 says /150 and beckett leaves it un-numbered. That
 * is ONE source's transcription error repeated across a product, and Drew can
 * rule it once per (product, parallel) instead of per card. The remaining ~25%
 * (e.g. /55 vs /75) are genuinely different rungs.
 *
 * This SPLITS THE COUNTER; it never decides. Both halves stay ambiguous.
 */
export function nearMissPrintRuns(runs: number[]): boolean {
  if (runs.length < 2) return false;
  const lo = runs[0];
  const hi = runs[runs.length - 1];
  return lo > 0 && hi > 0 && (hi - lo) / hi <= 0.1;
}

// -- rulings -----------------------------------------------------------------

/** A ruling from data/holding-identity-rulings.json, as this rule reads it. */
export type IdentityRuling = { from?: string | null; to?: string | null; note?: string | null };

/**
 * Does folding these losers onto this winner contradict a ruling Drew wrote?
 *
 * A ruling says a holding belongs at `to`. If the fleet is about to RETIRE
 * `to` -- moving the card out from under the ruling -- that is a contradiction,
 * reported and never silently resolved. Drew's 9 rulings include the CPA-BA and
 * CPA-FA bowman-chrome -> bowman decisions, which is exactly the population
 * MODE=cpa touches.
 */
export function contradictsRulings(
  winnerId: string,
  loserIds: string[],
  rulings: IdentityRuling[],
): IdentityRuling | null {
  const losers = new Set(loserIds.map((s) => String(s)));
  for (const r of rulings ?? []) {
    const to = String(r?.to ?? "");
    if (to && losers.has(to) && to !== winnerId) return r;
  }
  return null;
}

// -- spelling ----------------------------------------------------------------

/**
 * The canonical spelling for a group: D31's majority over DISTINCT PUBLISHERS,
 * tie -> the longer form.
 *
 * Each PUBLISHER votes once -- not each row, and not each scrape run. A site
 * that re-scraped four times is ONE transcription, and letting runs vote hands
 * the ruling to whichever site was scraped most often. `chooseSpelling` dedups
 * per `source`, so passing the publisher there IS the per-publisher vote.
 */
export function canonicalSpellingOf(rows: DupRow[]): string | null {
  return chooseSpelling(
    rows
      .filter((r) => String(r.parallelSlug ?? "").trim() !== "")
      .map((r) => ({
        parallelSlug: String(r.parallelSlug),
        source: publisherOf(r.source),
        isChecklist: isChecklistRow(r),
      })),
  );
}

const playerKeyOf = (n: string | null | undefined): string =>
  String(n ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** The distinct NAMED players among these rows. A null is not a name. */
export function namedPlayers(rows: DupRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    const k = playerKeyOf(r.playerName);
    if (k) out.add(k);
  }
  return out;
}

const salesOf = (r: DupRow): number => (Number.isFinite(Number(r.salesCount)) ? Number(r.salesCount) : 0);

/**
 * Rank rows so the SURVIVOR is deterministic across every slot and rerun:
 * checklist authority, then a print run present, then more sales, then the
 * longest id (the most specific spelling), then the id string.
 */
export function rankRows(rows: DupRow[]): DupRow[] {
  return [...rows].sort(
    (a, b) =>
      Number(isChecklistRow(b)) - Number(isChecklistRow(a)) ||
      Number(runOf(b) !== null) - Number(runOf(a) !== null) ||
      salesOf(b) - salesOf(a) ||
      String(b.id).length - String(a.id).length ||
      String(a.id).localeCompare(String(b.id)),
  );
}

/**
 * RULE 3's SURVIVOR: the row carrying the canonical spelling.
 *
 * Returns null when the group is not a spelling group at all (every row
 * already spells the parallel the same way), or when no row actually carries
 * the canonical spelling -- in both cases `rankRows` decides as before, so
 * this narrows to exactly the rows rule 3 is about.
 *
 * The candidate set is restricted to rows that fold to ONE rung
 * (`foldSpelling`), which is what makes this a re-SPELLING rather than a
 * different parallel; the D31 colour gate and the print-run gate have already
 * refused above, so anything reaching here is one card.
 *
 * Among the rows carrying the canonical spelling, `rankRows` still orders --
 * a checklist row outranks a derived row spelling it the same way, so rule 1
 * is not lost to rule 3.
 */
export function pickSpellingWinner(rows: DupRow[]): DupRow | null {
  const spellings = new Set(rows.map((r) => cleanParallelSlug(r.parallelSlug)));
  if (spellings.size < 2) return null;

  // RULE 3 IS THE LAST WORD ON SPELLING, NOT THE FIRST WORD ON EVERYTHING.
  // The rules above it in the spec decide on facts stronger than a spelling
  // vote, so where either applies the majority does not get to overrule it:
  //
  //   r1 -- a checklist row beats a derived row. If some rows are checklist
  //         and some are not, only the checklist rows may survive, and the
  //         vote is taken among them (which is also `chooseSpelling`'s own
  //         voter rule, so this only stops a derived row winning on a tie).
  //   r2 -- numbered beats un-numbered. A print run is a fact off the
  //         checklist; a spelling is a transcription. If the rows disagree
  //         about the print run, r2 decides and rule 3 stands down.
  //   r6 -- the no-auto ghost folds onto the auto row, by card number.
  //
  // Narrowing here rather than in the caller keeps every rule's scope visible
  // in one place -- the "right guard, wrong scope" shape (#1177-#1180) is what
  // happens when a rule's reach is wider than the fact it is built on.
  const runs = new Set(rows.map((r) => runOf(r)));
  if (runs.size > 1) return null;
  const autos = new Set(rows.map((r) => r.isAuto === true));
  if (autos.size > 1) return null;

  const checklist = rows.filter(isChecklistRow);
  const eligible = checklist.length > 0 ? checklist : rows;
  if (new Set(eligible.map((r) => cleanParallelSlug(r.parallelSlug))).size < 2) return null;

  const canonical = canonicalSpellingOf(rows);
  if (!canonical) return null;

  const canonicalClean = cleanParallelSlug(canonical);
  const matches = eligible.filter(
    (r) => cleanParallelSlug(r.parallelSlug) === canonicalClean || String(r.parallelSlug ?? "").toLowerCase().trim() === canonical,
  );
  if (matches.length === 0) return null;
  return rankRows(matches)[0];
}

/**
 * THE D30 DECISION for one identity group.
 *
 * The ORDER of the gates IS the rule, and every gate that REFUSES sits above
 * every gate that MERGES. "Right guard, wrong scope" (#1177-#1180) is what
 * happens when a merge runs before its guard.
 *
 *   0. one row                        -> not a group
 *   1. rows name different players     -> not a group (CPA initials collision)
 *   2. D31: one scrape run names both colour forms -> AMBIGUOUS, two cards
 *   3. two checklist print runs        -> AMBIGUOUS (near-miss splits the counter)
 *   4. no checklist row                -> AMBIGUOUS, unless a printRun FIELD
 *                                         resolves it against an id suffix
 *   5. a fold would retire a ruled id  -> AMBIGUOUS
 *   6. otherwise the ranked winner, with winnerBy naming WHICH rule decided
 */
export function decideDuplicateGroup(input: {
  rows: DupRow[];
  rulings?: IdentityRuling[];
  forceAutoPrefixes?: readonly string[];
}): DupDecision {
  const rows = (input.rows ?? []).filter((r) => r && r.id);
  const rulings = input.rulings ?? [];
  const prefixes = input.forceAutoPrefixes ?? DEFAULT_FORCE_AUTO_PREFIXES;

  if (rows.length < 2) return { kind: "not-a-group", why: "single-row", detail: `${rows.length} row(s)` };

  // GATE 1: WHO IS ON THE CARD comes first and is absolute. CPA numbers are
  // INITIALS and initials collide -- CPA-AN is both Angel Nunez and Alejandro
  // Nunez. Folding across a player disagreement merges two players' pools.
  const players = namedPlayers(rows);
  if (players.size > 1) {
    return {
      kind: "not-a-group",
      why: "player-differs",
      detail: `rows name ${players.size} players: ${[...players].join(", ")}`,
    };
  }

  // GATE 2: D31. One scrape run naming both forms is the site saying TWO CARDS.
  const both = oneSourceNamesBothColourForms(rows);
  if (both.both) {
    return {
      kind: "ambiguous",
      why: "d31-one-source-names-both-colour-forms",
      detail: `${both.source} names both "${both.forms[0]}" and "${both.forms[1]}" -- one scrape run listing both forms is two cards (D31)`,
      rows,
    };
  }

  // GATE 2b: a BASE card carrying /1 beside an un-numbered base row. Found in a
  // live dry run: 190 ordinary base sales were about to fold onto a /1. A base
  // card is the most-printed card in the product, so the /1 is a transcription
  // error -- and folding toward it is the expensive direction.
  if (baseCardCannotBeOneOfOne(rows)) {
    return {
      kind: "ambiguous",
      why: "two-checklist-print-runs-one-product",
      nearMiss: false,
      detail:
        "a BASE row is numbered /1 beside an un-numbered base row -- a base card is not a 1/1, so the /1 is a mis-transcription; folding either way risks a real card's pool (found live on 2024 panini-prizm #347, 190 sales)",
      rows,
    };
  }

  // GATE 3: two checklist print runs. Which /N was the sale? Guessing is worse
  // than the split. The near-miss flag only SPLITS THE COUNTER for Drew.
  const runs = checklistRuns(rows);
  if (runs.length > 1) {
    const near = nearMissPrintRuns(runs);
    return {
      kind: "ambiguous",
      why: "two-checklist-print-runs-one-product",
      nearMiss: near,
      detail: `${runs.length} checklist print runs (/${runs.join(", /")})${
        near
          ? " -- NEAR MISS (<=10% apart): likely one source's transcription error, rulable once per (product, parallel)"
          : " -- distinct rungs"
      }`,
      rows,
    };
  }

  const checklist = rows.filter(isChecklistRow);

  // GATE 4: no checklist row at all. Spec rule 1 says most-sales survives and
  // the card joins the acquisition list -- but FIRST check the printRun FIELD.
  // `...:gold-wave-refractor:no-auto` carrying printRun=50 beside `...:num-50`
  // is the SAME /50 written two ways, which is r2 and not ambiguity at all.
  if (checklist.length === 0) {
    // THE REFINEMENT IS ABOUT WHERE THE PRINT RUN IS WRITTEN, NOT WHAT IT SAYS.
    //
    // `runOf` merges two different facts -- the printRun FIELD and the id's
    // trailing `:num-N` -- so it cannot see the shape this rescues:
    // `...:gold-wave-refractor:no-auto` carrying printRun=50 in its FIELD beside
    // `...:gold-wave-refractor:no-auto:num-50` carrying it in the ID. That is
    // one /50 rung written two ways, and both rows agree on the number.
    //
    // Asking `runOf` instead would fold a DERIVED row that merely asserts /10
    // onto an un-numbered twin with nothing corroborating it -- a derived row
    // inventing a print run for a card no checklist numbers. That group stays
    // ambiguous, which is why the two facts are read separately here.
    const idRuns = new Set(
      rows.map((r) => String(r.id ?? "").match(/:num-(\d+)$/)).filter((m): m is RegExpMatchArray => m !== null).map((m) => Number(m[1])),
    );
    const fieldOnly = new Set(
      rows.filter((r) => !/:num-\d+$/.test(String(r.id ?? ""))).map((r) => Number(r.printRun)).filter((n) => Number.isFinite(n) && n > 0),
    );
    const agreed = [...idRuns].filter((n) => fieldOnly.has(n));
    if (idRuns.size === 1 && fieldOnly.size === 1 && agreed.length === 1) {
      const fieldRuns = agreed;
      const winner = rankRows(rows)[0];
      const losers = rows.filter((r) => r.id !== winner.id);
      const clash = contradictsRulings(winner.id, losers.map((r) => r.id), rulings);
      if (clash) {
        return {
          kind: "ambiguous",
          why: "contradicts-holding-ruling",
          detail: `the fold would retire ${clash.to}, which one of Drew's rulings names as an identity`,
          rows,
        };
      }
      return {
        kind: "consolidate",
        winner,
        losers,
        winnerBy: "numbered",
        reason: `no checklist row, but the print run /${fieldRuns[0]} sits in the FIELD on one row and the id suffix on the other -- the same rung written two ways`,
      };
    }
    return {
      kind: "ambiguous",
      why: "no-checklist-row",
      detail: `all ${rows.length} rows are derived/vendor (${[
        ...new Set(rows.map((r) => String(r.source ?? "?"))),
      ].join(", ")}) -- most-sales would survive; the card joins the acquisition list`,
      rows,
    };
  }

  // GATE 5/6: the winner, ranked deterministically; winnerBy names the rule
  // that actually decided, which is what the dry run reports per kind.
  //
  // RULE 3 IS APPLIED HERE, NOT DESCRIBED HERE. Drew, 12:50Z: "the majority
  // spelling among the checklist sources for that product wins, tie -> the
  // longer form." `rankRows` alone cannot express that: its last tie-break is
  // `String(b.id).length - String(a.id).length`, which is Drew's TIE-BREAK
  // promoted to the whole rule. Measured live: four publishers spelling
  // `refractor` against beckett's lone `refractors-refractor` folded onto
  // beckett, because that id is longer. So when the group is a SPELLING group
  // the majority picks the survivor and `rankRows` only orders the rest.
  const winner = pickSpellingWinner(rows) ?? rankRows(rows)[0];
  const losers = rows.filter((r) => r.id !== winner.id);
  if (losers.length === 0) return { kind: "not-a-group", why: "single-row", detail: "one distinct row id" };

  const clash = contradictsRulings(winner.id, losers.map((r) => r.id), rulings);
  if (clash) {
    return {
      kind: "ambiguous",
      why: "contradicts-holding-ruling",
      detail: `the fold would retire ${clash.to}, which one of Drew's rulings names as an identity${
        clash.note ? ` ("${String(clash.note).slice(0, 90)}")` : ""
      }`,
      rows,
    };
  }

  const winnerBy = winnerByOf(winner, losers, prefixes);
  return { kind: "consolidate", winner, losers, winnerBy, reason: reasonFor(winnerBy, winner) };
}

/**
 * WHICH RULE decided, for the per-kind counters. First match names it, so the
 * counters are disjoint and sum to the consolidated total.
 */
function winnerByOf(winner: DupRow, losers: DupRow[], prefixes: readonly string[]): WinnerBy {
  const wRun = runOf(winner);

  const ghost = losers.some(
    (l) => l.isAuto !== true && winner.isAuto === true && isAutoByCardNumber(l.cardNumber, prefixes),
  );
  if (ghost) return "no-auto-ghost";

  if (wRun !== null && losers.some((l) => runOf(l) === null)) return "numbered";

  const wClean = cleanParallelSlug(winner.parallelSlug);
  const wFold = foldSpelling(winner.parallelSlug);
  const wBase = colourFormOf(winner.parallelSlug).base;

  if (losers.some((l) => foldSpelling(l.parallelSlug) === wFold && cleanParallelSlug(l.parallelSlug) !== wClean)) {
    return "canonical-spelling";
  }
  if (losers.some((l) => colourFormOf(l.parallelSlug).base === wBase && cleanParallelSlug(l.parallelSlug) !== wClean)) {
    return "colour-checklist-form";
  }
  if (new Set([winner, ...losers].map((r) => String(r.setKey ?? "").toLowerCase())).size > 1) {
    return "spelling-majority";
  }
  if (losers.every((l) => !isChecklistRow(l)) && isChecklistRow(winner)) return "checklist-authority";
  return "checklist-authority";
}

function reasonFor(by: WinnerBy, winner: DupRow): string {
  switch (by) {
    case "no-auto-ghost":
      return `a ${String(winner.cardNumber ?? "").toUpperCase()} card is an autograph by definition, so the no-auto row is the same card (D30 r6)`;
    case "numbered":
      return `the checklist numbers this parallel /${runOf(winner)}; the twin omitted it (D30 r2)`;
    case "canonical-spelling":
      return "one rung spelled several ways; the canonical spelling survives (D30 r7)";
    case "colour-checklist-form":
      return "no checklist scrape run names both colour forms, so this is one card in the form the checklist names (D31 / D30 r5)";
    case "spelling-majority":
      return "the majority spelling among the checklist publishers for this product wins, tie -> the longer form (D30 r3)";
    case "cpa-product":
      return "the dedicated checklist names the product (D29/R2)";
    case "sales":
      return "no checklist row: the row holding the most sales survives and the card joins the acquisition list (D30 r1)";
    default:
      return "a checklist-authority row beats every sale-/vendor-minted row (D30 r1)";
  }
}

/**
 * The D23 rename still OWNS these products' spelling. A `spelled` product is
 * one productSetKeys decides, and the rename fleet is moving its rows right
 * now; folding a setKey-drift group inside one would move rows to an address
 * that is about to change under us. MODE=setkey skips them behind a counter.
 */
export function isRenameOwnedProduct(setKey: string | null | undefined): boolean {
  const e = productEntry(setKey);
  return e?.spelled === true;
}

export { isProductSetKey };
