/**
 * CF-A-RULED-KEY-IS-A-FIXED-POINT (2026-09-03, follow-on to #1689).
 *
 * THE DEFECT THIS ENDS. #1689 measured it: of 6,386,510 pool rows with no
 * checklist-backed destination, 2,621,638 ALREADY HAVE THEIR CHECKLIST in
 * card_catalog — filed under a key `normalizeSetKey` no longer emits. 2,646
 * catalog setKeys are not fixed points of the deriver, stranding 2,488,691
 * checklist rows. The pool asks for `panini-donruss`; the 1987 checklist lives
 * under `donruss`. Nothing is missing; the two halves cannot say each other's
 * names.
 *
 * THE DOCTRINE, and it cuts BOTH ways:
 *
 *   A ruled key MUST be a normalizeSetKey fixed point.
 *
 * Read left to right that is the alias problem: a key the catalog uses must
 * survive the deriver unchanged, so where two spellings name ONE product the
 * deriver has to emit the CATALOG's spelling. Read right to left it is the
 * larger and more dangerous problem, and it is the one this file mostly
 * exists for: `normalizeSetKey` COLLAPSES 686 keys that name DISTINCT
 * products — `topps-triple-threads` -> `topps`, `bowman-university-chrome` ->
 * `bowman`, `panini-prizm-premier-league` -> `panini-prizm` — because 187 of
 * the 188 vocabulary patterns are unanchored and a brand rule swallows every
 * product whose name contains the brand. Those 686 keys hold 2,091,770 of the
 * 2,488,691 stranded checklist rows: 84% of the damage is the collapse, not
 * the aliases. Drew ruled 2026-09-03 that product-family collapse is
 * FORBIDDEN. One card, one row, one pool: a merge of two products splits
 * nothing but it FUSES two pools, and a fused pool prices both cards wrong.
 *
 * THE REMAINING 1,899 stale keys are a THIRD thing and not this file's to fix:
 * the catalog row's own key carries a year prefix or a trailing sport word
 * (`bowman-baseball`, `2024-25-panini-prizm`). There the deriver is right and
 * the stored key is the defect, so they are declared `catalog-key-malformed`,
 * left to collapse, and handed to the rename fleet — they hold 21,051
 * checklist rows between them.
 *
 * So an alias table alone would have made things worse. This module ships the
 * two halves together and refuses to let the first break the second: every
 * key here is EITHER an alias with a declared canonical OR a fixed point, the
 * fixed points are checked to be genuinely unreachable as alias targets, and
 * the whole thing is pinned by a test that walks the real catalog.
 *
 * WHICH SIDE IS CANONICAL IS DECIDED BY SOURCE, NOT BY SPELLING. The
 * maker-prefixed form is the house style, but only when a checklist stands
 * behind it. `nba-hoops` holds 26,355 checklistinsider rows and `panini-hoops`
 * holds ZERO, so `nba-hoops` is the key and the prefixed form is the alias —
 * the same doctrine as Drew's bare-Pokemon-code ruling (`sv8a`, not
 * `japanese-sv8a`) and the standing rule to count by source, not row count.
 *
 * WHERE THE VERDICTS COME FROM. data/setkey-reconciliation.json, generated
 * read-only by scripts/setkey-reconciliation/build-reconciliation.cjs from a
 * census of prod card_catalog + sold_comps. The verdicts are DERIVED by
 * mechanical rules over the key pair plus the evidence, not typed by hand;
 * where no rule fires the entry is `needs-ruling` and carries the question,
 * and this module treats those as fixed points (the safe direction: refuse to
 * merge until Drew rules).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type SetKeyVerdict = "alias" | "distinct" | "era-split" | "mis-sported" | "needs-ruling" | "malformed" | "catalog-key-malformed";

export interface ReconciliationEvidence {
  readonly catalogRows: number;
  readonly checklistRows: number;
  readonly years: string | null;
  readonly sports: readonly string[];
  readonly poolRowsAtDerived: number;
  readonly poolRowsAtKey: number;
}

export interface ReconciliationEntry {
  readonly setKey: string;
  readonly derivesToToday: string;
  readonly verdict: SetKeyVerdict;
  readonly canonical: string | null;
  readonly rule: string;
  readonly question?: string;
  readonly assumption?: boolean;
  readonly canonicalFlipped?: boolean;
  readonly evidence: ReconciliationEvidence;
}

interface ReconciliationDoc {
  readonly totals: { readonly verdicts: Record<string, number>; readonly staleSetKeys: number };
  readonly entries: ReadonlyArray<ReconciliationEntry>;
}

/** Load the verdict file. Same candidate-path shape as the parallel
 *  vocabulary: dist/data when compiled, backend/data in dev and in tests. */
function loadReconciliation(): ReconciliationDoc {
  const candidates = [
    join(__dirname, "..", "..", "..", "data", "setkey-reconciliation.json"),
    join(__dirname, "..", "..", "data", "setkey-reconciliation.json"),
    join(process.cwd(), "backend", "data", "setkey-reconciliation.json"),
    join(process.cwd(), "data", "setkey-reconciliation.json"),
  ];
  let lastErr: Error | null = null;
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as ReconciliationDoc;
      if (!Array.isArray(parsed.entries) || !parsed.totals) {
        throw new Error(`setkey-reconciliation.json at ${p} missing entries/totals`);
      }
      return parsed;
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw new Error(`setkey-reconciliation.json not found in any candidate path. Last error: ${lastErr?.message}`);
}

const DOC = loadReconciliation();
const ENTRIES: ReadonlyArray<ReconciliationEntry> = DOC.entries;
const BY_KEY = new Map(ENTRIES.map((e) => [e.setKey, e]));

/**
 * ASSUMPTION — DREW HAS NOT RULED ON THESE DATES.
 *
 * One brand, two owners: the YEAR decides the spelling, because the maker
 * prefix is an anachronism before the acquisition. Panini did not own Donruss
 * until 2009, so `panini-donruss` on a 1987 card names a company that would
 * not exist in that market for another 22 years — a category error, not an
 * alias, and the reason `baseball|1987|donruss` holds 1,450 checklist rows
 * while `baseball|1987|panini-donruss` holds none.
 *
 * Panini's 2009 purchase of Donruss-Playoff carried Score and Leaf's US
 * trading-card line with it, so the three share a boundary. Fleer and Skybox
 * went to Upper Deck in 2005 and were NEVER Panini properties, so they take a
 * bare key in every year — encoded as `bareBeforeYear: null`, which reads as
 * "bare always".
 *
 * The dates are the assumption. The SHAPE is not: the era table exists because
 * `donruss` genuinely holds checklist rows from 1981 to 2026 across two
 * owners, and one spelling cannot be right for both ends of that range.
 * Flipping a date here is a one-line change; Drew ruling "no era split at all"
 * would instead be a `spellForEra` policy flip, which productSetKeys.ts
 * already supports (DONRUSS_SPELLING_POLICY).
 */
export interface EraRule {
  readonly brand: string;
  /** The bare brand key applies BELOW this year and the maker key from it.
   *  `null` means the bare key applies in every year (never acquired). */
  readonly bareBeforeYear: number | null;
  readonly makerKey: string | null;
  readonly why: string;
}

export const ERA_SPLIT_TABLE: ReadonlyArray<EraRule> = Object.freeze([
  // The ONE brand with a real two-owner split in the catalog: `donruss` holds
  // 72,302 checklist rows across 1981-2026 and `panini-donruss` 194,915 across
  // 1990-2026. Two live spellings, one product line, so a year is the only
  // thing that can choose between them.
  { brand: "donruss", bareBeforeYear: 2009, makerKey: "panini-donruss",
    why: "ASSUMPTION (date unruled): Panini acquired Donruss-Playoff in 2009. Pinned by 1,450 checklist rows on baseball|1987|donruss against 0 on panini-donruss; measured 2026-09-03 the two spellings hold 72,302 and 194,915 checklist rows." },

  // NEVER-ACQUIRED brands. `makerKey: null` means the bare key is right in
  // EVERY year, so these entries exist to STOP a maker prefix, never to add
  // one. Measured 2026-09-03: `panini-fleer` and `panini-skybox` hold ZERO
  // catalog rows of any kind, which is what "never owned" looks like in the
  // data.
  { brand: "fleer", bareBeforeYear: null, makerKey: null,
    why: "ASSUMPTION (unruled): Upper Deck bought Fleer in 2005; Panini never owned it. `fleer` holds 34,652 checklist rows (1959-2007) and `panini-fleer` holds zero rows of any kind." },
  { brand: "skybox", bareBeforeYear: null, makerKey: null,
    why: "ASSUMPTION (unruled): Skybox went to Upper Deck with Fleer in 2005; Panini never owned it. `skybox` holds 841 checklist rows (1990-2000) and `panini-skybox` holds zero rows of any kind." },

  // Score and Leaf came to Panini with the 2009 Donruss-Playoff purchase, so
  // the OWNERSHIP story is the same as Donruss's — but the catalog does not
  // tell the same story, and NO SYNTHETIC PRODUCTS is the stronger rule.
  // Measured 2026-09-03: `panini-score` holds 402 rows and ZERO checklist
  // rows, `panini-leaf` holds zero rows of any kind, against 45,061 checklist
  // rows on `score` (1988-2025) and 12,521 on `leaf` (1949-2026). A maker key
  // no checklist has ever written is not a destination we may invent, so both
  // are bare in every year and the era boundary stays unencoded until a
  // checklist writes the prefixed spelling.
  { brand: "score", bareBeforeYear: null, makerKey: null,
    why: "ASSUMPTION (unruled): Panini acquired Score in 2009, but `panini-score` holds ZERO checklist rows against 45,061 on `score` — no synthetic products, so the bare key stands in every year." },
  { brand: "leaf", bareBeforeYear: null, makerKey: null,
    why: "ASSUMPTION (unruled): the Leaf US line came to Panini in 2009, but `panini-leaf` holds ZERO rows of any kind against 12,521 checklist rows on `leaf` — no synthetic products, so the bare key stands in every year. The modern independent Leaf is a different company again; its products are spelled by productSetKeys.ts." },
]);

const ERA_BY_BRAND = new Map(ERA_SPLIT_TABLE.map((r) => [r.brand, r]));
const ERA_BY_MAKER_KEY = new Map(
  ERA_SPLIT_TABLE.filter((r) => r.makerKey).map((r) => [r.makerKey as string, r]),
);

/**
 * The spelling a brand key takes in `year`. Both directions: a bare key in a
 * maker year takes the maker prefix, and a maker key in a pre-acquisition year
 * drops it. A key no era rule names, or a year we do not have, passes through
 * untouched — an era rule needs a year, and guessing one would mint identities.
 */
export function spellSetKeyForEra(setKey: string, year: number | null | undefined): string {
  const s = String(setKey ?? "").trim().toLowerCase();
  if (!s) return s;
  const y = typeof year === "number" && Number.isFinite(year) && year > 0 ? year : null;
  if (y === null) return s;

  const bare = ERA_BY_BRAND.get(s);
  if (bare) {
    if (bare.bareBeforeYear === null || bare.makerKey === null) return s; // never acquired
    return y >= bare.bareBeforeYear ? bare.makerKey : s;
  }
  const maker = ERA_BY_MAKER_KEY.get(s);
  if (maker && maker.bareBeforeYear !== null && y < maker.bareBeforeYear) return maker.brand;
  return s;
}

/**
 * ALREADY-RULED COLLAPSES — a decision beats a derivation.
 *
 * These keys hold checklist rows and the mechanical rules therefore call them
 * `distinct`, which would make them fixed points. But each one is a collapse
 * somebody DECIDED, wrote a rule for, and pinned with a test that states the
 * reasoning. The census can see that two spellings exist; it cannot see that a
 * human already ruled which of them is the product.
 *
 *   bowman-sapphire        -> bowman-chrome-sapphire   "vendors write Bowman
 *   bowman-mega-box        -> bowman-chrome-mega-box    Sapphire as shorthand;
 *   bowman-mega-box-chrome -> bowman-chrome-mega-box    there is no standalone
 *   topps-chrome-sapphire-edition -> topps-chrome-sapphire  product" (the
 *   bowman-draft-sapphire-chrome  -> bowman-draft-sapphire  vocabulary says so
 *                                                           outright)
 *   flair-showcase         -> flair                    marked DELIBERATE in
 *                                                      collapsedProductsBatch1
 *   panini-contenders-optic -> panini-contenders       ruled by opticIsOneProduct
 *   donruss-champions      -> panini-donruss           parent brand, pinned in
 *                                                      slugRegression
 *
 * This list is DERIVED, not guessed: it is every key for which a test in this
 * repo asserts `normalizeSetKey(x) === y` with a y our verdict would forbid
 * (extractable by grepping the suite for the assertion form). If Drew rules
 * differently later, the entry comes out here and the test changes with it —
 * one place, and the reason travels with it.
 *
 * The ones NOT here are the ones worth noticing: `select-certified` had a test
 * asserting a collapse too, and it is absent because the evidence overturned
 * it (1,376 checklist rows against zero, disjoint eras). A pin is evidence of
 * a decision, not proof it was the right one — so each of these was read, and
 * each states a reason the census cannot see. Several are also live
 * `needs-ruling` questions in the data file; Drew answering one moves it.
 */
const ALREADY_RULED_COLLAPSES: Readonly<Record<string, string>> = Object.freeze({
  "bowman-sapphire": "bowman-chrome-sapphire",
  "bowman-mega-box": "bowman-chrome-mega-box",
  "bowman-mega-box-chrome": "bowman-chrome-mega-box",
  "bowman-draft-sapphire-chrome": "bowman-draft-sapphire",
  "topps-chrome-sapphire-edition": "topps-chrome-sapphire",
  "flair-showcase": "flair",
  // CF-ULTRA-IS-NOT-FLEER, explicit and pinned. The catalog's split is real
  // (`ultra` 14,586 checklist rows 1991-2007, `fleer-ultra` 3,639 in 2025
  // alone) but which spelling wins is exactly what that ruling decided.
  "fleer-ultra": "ultra",
  // The sapphire ruling in the vocabulary, applied to its "Edition" spelling.
  "bowman-chrome-sapphire-edition": "bowman-chrome-sapphire",
  "bowman-draft-sapphire-edition": "bowman-draft-sapphire",
  "panini-contenders-optic": "panini-contenders",
  "donruss-champions": "panini-donruss",
});

/** The keys a prior ruling already decided, with the destination it ruled. */
export function alreadyRuledCollapses(): Array<[string, string]> {
  return Object.entries(ALREADY_RULED_COLLAPSES).sort((a, b) => a[0].localeCompare(b[0]));
}

// -- the alias table and the fixed points ------------------------------------

const ALIASES = new Map<string, string>();
const FIXED_POINTS = new Set<string>();

for (const e of ENTRIES) {
  const key = e.setKey;
  if (e.verdict === "alias" && e.canonical && e.canonical !== key) {
    ALIASES.set(key, e.canonical);
    continue;
  }
  // Two verdicts KEEP today's collapse, because in both the deriver is right
  // and the CATALOG ROW is the defect:
  //   `malformed`             no checklist row stands behind the key and the
  //                           key is not a product name (a raw spaced title);
  //   `catalog-key-malformed` the key carries a year prefix or a trailing
  //                           sport word that stripYearAndSport removes
  //                           (`bowman-baseball` -> `bowman`).
  // Making these fixed points would bless a malformed key and let a year
  // prefix into the identity. They belong to the catalog rename fleet.
  if (e.verdict === "malformed" || e.verdict === "catalog-key-malformed") continue;
  // A FIXED POINT NEEDS CHECKLIST EVIDENCE TO EARN ITS PROMOTION.
  //
  // distinct | era-split | mis-sported | needs-ruling all mean the same thing
  // to the deriver — do not rewrite this key — but only where a checklist
  // actually stands behind the key. Without that, the verdict rests on nothing
  // but the key's SHAPE, and shape is exactly what the existing vocabulary has
  // already ruled on deliberately: "Bowman Chrome Prospects" folds to
  // `bowman-chrome` (the file header rules it), "Bowman Draft Chrome" to
  // `bowman-draft`, "Upper Deck SPx Finite" to `spx-finite`. Every one of
  // those keys holds ZERO checklist rows, so promoting them here would
  // overturn a ruling on no evidence at all — which is the same error as
  // trusting a derived catalog row to adjudicate.
  //
  // Count by source, not by row count: the checklist is what confers the
  // authority to be a fixed point, and 514 of the 686 distinct keys have it.
  // `needs-ruling` IS REPORT-ONLY AND CHANGES NOTHING.
  //
  // The instinct is that refusing to merge is the safe direction, so an
  // unruled key should become a fixed point until Drew decides. That is wrong
  // here, and `bowman-sapphire` is why: the vocabulary already carries an
  // explicit ruling on it -- "vendors write Bowman Sapphire as shorthand for
  // Bowman Chrome Sapphire, so the collapse is intended, not a bug. There is
  // no standalone Bowman Sapphire product." A verdict that says "I could not
  // decide this mechanically" has no authority to overturn a decision someone
  // already made deliberately.
  //
  // So an unruled key keeps TODAY'S behaviour and travels to Drew as a
  // question. Changing it would be acting on the absence of a rule, which is
  // the opposite of what an open question means.
  if (e.verdict === "needs-ruling") continue;
  // AN ERA KEY IS NOT A FIXED POINT — IT IS A KEY THAT NEEDS A YEAR.
  //
  // `donruss` is stale precisely BECAUSE normalizeSetKey rewrites it, and the
  // instinct is to stop that. But normalizeSetKey has no year, and with no
  // year the modern spelling is the right default -- the vocabulary has said
  // so since CF-PANINI-IS-ANACHRONISTIC-BEFORE-2009, and
  // `resolveSetKeyForSlug("baseball", "Donruss", 1987)` already answers
  // `donruss` correctly because IT has the year.
  //
  // So the era split is not resolved here at all. It is resolved by
  // spellSetKeyForEra / spellForEra at the call sites that know the year, and
  // pinning the bare key here would break the year-less default without
  // fixing anything the year-aware path gets wrong.
  if (e.verdict === "era-split") continue;
  // A DECISION BEATS A DERIVATION. Where somebody already ruled this collapse
  // and pinned it, the ruling stands and the verdict is report-only.
  if (ALREADY_RULED_COLLAPSES[key]) continue;
  if (e.evidence.checklistRows > 0) FIXED_POINTS.add(key);
}

/** Every alias, as [from, to]. Sorted, for the tests and for reporting. */
export function setKeyAliases(): Array<[string, string]> {
  return [...ALIASES.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Every key the reconciliation declares a fixed point — a product the
 *  deriver must stop collapsing into its family. */
export function reconciledFixedPoints(): string[] {
  return [...FIXED_POINTS].sort();
}

/** The reconciliation entry for a key, or null. */
export function reconciliationEntry(setKey: string | null | undefined): ReconciliationEntry | null {
  const s = String(setKey ?? "").trim().toLowerCase();
  if (!s) return null;
  return BY_KEY.get(s) ?? null;
}

/**
 * The reconciled spelling of a key, applied by normalizeSetKey AFTER slugify
 * and BEFORE the vocabulary.
 *
 * Two answers, and the second is the load-bearing one:
 *   - an ALIAS returns its declared canonical (`finest` -> `topps-finest`);
 *   - a FIXED POINT returns itself and tells the caller to STOP, so no
 *     unanchored brand pattern downstream can collapse it into its family.
 *
 * Exact-token by construction: the maps are consulted with `===`, never a
 * prefix or a substring test, for the same reason the Japanese-code ruling is
 * — a `startsWith` rule here would swallow every product whose name begins
 * with a brand, which is the very defect being fixed.
 */
export function reconcileSetKey(slug: string): { key: string; final: boolean } {
  const s = String(slug ?? "").trim().toLowerCase();
  if (!s) return { key: s, final: false };
  const alias = ALIASES.get(s);
  if (alias) return { key: alias, final: true };
  if (FIXED_POINTS.has(s)) return { key: s, final: true };
  return { key: s, final: false };
}

/** The open questions, largest first — for the PR body and for Drew. */
export function needsRulingQuestions(): Array<{ setKey: string; question: string; checklistRows: number }> {
  return ENTRIES
    .filter((e) => e.verdict === "needs-ruling")
    .map((e) => ({
      setKey: e.setKey,
      question: e.question ?? "",
      checklistRows: e.evidence.checklistRows,
    }))
    .sort((a, b) => b.checklistRows - a.checklistRows);
}

/** The counts, for reporting. */
export function reconciliationTotals(): Record<string, number> {
  return DOC.totals.verdicts;
}
