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

/**
 * CF-RECONCILIATION-DEFENSIVE-LOAD (2026-09-04). The first cut read the
 * verdict file EAGERLY at module top level and THREW when it could not be
 * found. That is the same defect CF-BOWMAN-DATASET-DEFENSIVE-LOAD fixed in
 * bowmanParallelsDataset.ts, and it bit immediately: `manualIdentityPricing`
 * stubs `fs.readFileSync` for its own fixture, and because this module is
 * pulled in transitively by hobbyIqCardId.service, that stub reached THIS
 * loader and the throw took down three unrelated pricing tests. A module every
 * minted id imports must not be able to throw at IMPORT time — a process-wide
 * crash is strictly worse than a degraded lookup.
 *
 * So the loader follows the house pattern exactly: lazy, cached, EMPTY-doc
 * fallback. On the empty doc there are no aliases and no fixed points, so
 * `reconcileSetKey` returns `{ final: false }` for every key and
 * normalizeSetKey behaves precisely as it did before this module existed.
 * Degraded, never fatal.
 */
const EMPTY_DOC: ReconciliationDoc = Object.freeze({
  totals: { verdicts: {}, staleSetKeys: 0 },
  entries: [],
});

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
  console.warn(
    `[setKeyReconciliation] setkey-reconciliation.json not found in any candidate path — every key passes through unreconciled (last error: ${lastErr?.message})`,
  );
  return EMPTY_DOC;
}

// Lazy singletons: built on first use, then cached. Nothing runs at import.
let _doc: ReconciliationDoc | null = null;
let _byKey: Map<string, ReconciliationEntry> | null = null;

function doc(): ReconciliationDoc {
  if (!_doc) _doc = loadReconciliation();
  return _doc;
}

function entries(): ReadonlyArray<ReconciliationEntry> {
  return doc().entries;
}

function byKey(): Map<string, ReconciliationEntry> {
  if (!_byKey) _byKey = new Map(entries().map((e) => [e.setKey, e]));
  return _byKey;
}

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

/**
 * THE ERA REWRITE ITSELF LIVES IN productSetKeys.ts, NOT HERE.
 *
 * The first cut of this file exported its own `spellSetKeyForEra`, and it was
 * a duplicate: `spellForEra` in productSetKeys.ts already encodes the same
 * Donruss 2009 boundary (PANINI_DONRUSS_FROM_YEAR, under
 * DONRUSS_SPELLING_POLICY), and it is already wired into the three seams that
 * know a year — hobbyIqCardId.service, duplicateWinnerRule and
 * gapTriage.service. Shipping a second era function next to it bought nothing
 * and risked two boundaries drifting apart; the four brands the table adds
 * beyond Donruss all carry `makerKey: null`, so an era function would return
 * them unchanged anyway. A key rewrite with no production call site is not a
 * behaviour, so the function is gone and the table stays as what it actually
 * is: the EVIDENCE for the boundary, measured 2026-09-03, that
 * `build-reconciliation.cjs` reads to mark `donruss` as `era-split` and that
 * documents why fleer/skybox/score/leaf are deliberately NOT split.
 */

/**
 * THE OPEN QUESTIONS, ANSWERED FROM EVIDENCE (2026-09-04).
 *
 * The first cut shipped 20 keys as `needs-ruling` and asked Drew all of them.
 * Most did not need asking: the evidence in this repo already settles them,
 * and a question whose answer is written down is not an open question. Each
 * verdict below cites what settled it — a `productSetKeys.ts` entry, a
 * standing CF ruling in the vocabulary, a sibling service that already
 * disagrees, or the checklist row counts and sample titles in the census.
 *
 * TWO KINDS OF ANSWER, and Drew's standing rule decides which applies:
 *
 *   ALIAS — one product, two spellings. The key folds onto the canonical.
 *           Only where the SAME cards are being named twice.
 *   DISTINCT — a real separate product. It becomes a fixed point and the
 *           deriver must stop collapsing it. "Distinct products are NEVER
 *           collapsed" (Drew), because a fused pool prices both cards wrong.
 *
 * The tie-break, when the census is ambiguous, is the one Drew has used
 * every time: does the collapse put DIFFERENT CARDS in one pool? Mega Box
 * #52 is Ohtani and Bowman Chrome #52 is Wetherholt — that is a merge that
 * corrupts cards, so they are distinct. Where the card numbers and the cards
 * genuinely coincide and only the words differ, it is an alias.
 */
const RULED_ALIASES: Readonly<Record<string, { to: string; why: string }>> = Object.freeze({
  // SAPPHIRE SPELLINGS. The vocabulary's CF-SAPPHIRE ruling is explicit and
  // pinned by sapphireOneName.test.ts: "vendors write Bowman Sapphire as
  // shorthand for Bowman Chrome Sapphire ... There is no standalone Bowman
  // Sapphire product." These are word-order and marketing-suffix variants of
  // that ONE product — "Sapphire Edition", "Sapphire Chrome" — naming the
  // same cards, so they are aliases, not new products.
  "bowman-sapphire-edition": { to: "bowman-chrome-sapphire",
    why: "CF-SAPPHIRE-ONE-NAME: 'Edition' is a marketing suffix on the same product; sapphireOneName.test.ts already pins 'Bowman Sapphire Chrome' -> bowman-chrome-sapphire. 11,079 checklist rows 2020-2023, and the census's own sample titles show '2025 Bowman Chrome Sapphire Baseball' and '2025 Bowman Sapphire Baseball' side by side for the same release." },
  "bowman-sapphire-chrome": { to: "bowman-chrome-sapphire",
    why: "CF-SAPPHIRE-ONE-NAME, word order only. sapphireOneName.test.ts:34 already pins the title form 'Bowman Sapphire Chrome' to this destination; the setKey spelling must agree." },
  "topps-sapphire-chrome": { to: "topps-chrome-sapphire",
    why: "Word order only — the vocabulary already carries [/topps-(?:chrome-sapphire|sapphire-chrome)/] as ONE rule with two spellings of the same product." },
  "topps-sapphire-chrome-factory-set": { to: "topps-chrome-sapphire",
    why: "2016 Topps Chrome Sapphire was SOLD as a factory set — the delivery format, not a different product. 1,044 checklist rows, all 2016, the year of that release. A box configuration does not mint an identity." },

  // BOWMAN NSCC. #1612 ruled NSCC its OWN PRODUCT, and it is — that ruling is
  // about `bowman-chrome-nscc`, which is already a distinct product and stays
  // one. The question here was only which SPELLING names it, and that was
  // already decided: bowmanNsccIsItsOwnProduct.test.ts pins "Bowman NSCC" ->
  // bowman-chrome-nscc with the reasoning stated (Drew 2026-08-31, of BNR-VGJ:
  // "isn't it under bowman chrome set?" then "ok, do it"; the promo says Bowman
  // Chrome ON THE CARD, and the catalog had already settled it with 780 rows
  // keyed bowman-chrome-nscc). A decision beats a derivation: the census can
  // see two spellings exist, it cannot see that a human already chose.
  "bowman-nscc": { to: "bowman-chrome-nscc",
    why: "#1612 rules NSCC its own product and `bowman-chrome-nscc` IS that product — this is the shorthand spelling of it, not a second one. bowmanNsccIsItsOwnProduct.test.ts already pins 'Bowman NSCC' to this destination, and the census's own sample titles for the key are all '<year> Bowman Chrome National Convention Baseball'. 854 checklist rows fold onto the ruled key rather than splitting its pool." },

  // BLACK DIAMOND. The vocabulary's CF-UD-INSERT-LINES rule deliberately
  // anchors the bare key: [/upper-deck-black-diamond|(?:^|-)black-diamond/].
  // Bare `black-diamond` -> `upper-deck-black-diamond` was DESIGNED, and the
  // census's own sample titles are all "Upper Deck Black Diamond".
  "black-diamond": { to: "upper-deck-black-diamond",
    why: "CF-UD-INSERT-LINES (Drew 2026-08-10) anchors the bare spelling on purpose; productSetKeys.ts spells `upper-deck-black-diamond` as the product. Every sample title in the census is '<year> Upper Deck Black Diamond' — the maker is simply absent from the key, not from the product." },

  // ULTRA (Drew 2026-09-04). Ultra is a DISTINCT PRODUCT with its own pool and
  // never folds into `fleer` — CF-ULTRA-IS-NOT-FLEER already guarantees that,
  // and it stays. The only open question was which of the two spellings names
  // it, and the standing rule answers it: count by source, not by row count.
  //
  // Measured read-only against prod on 2026-09-04:
  //   `ultra`        19,002 catalog rows, 1991-2007, across TWELVE sources
  //                  (baseballcardpedia 9,031 + -graded 5,125, sales-attested
  //                  2,160, ingest-auto-seed, tcdb, bccp...) and 66,071 pool
  //                  rows over six sports.
  //   `fleer-ultra`   3,672 catalog rows from ONE ingest window
  //                  (checklistinsider 2026-08-27/28, 3,639 of them 2025
  //                  hockey) and FOUR pool rows — all four Marvel/Spider-Man
  //                  trading cards, not the sports product at all.
  //
  // The checklist weight, the era spread and the pool are all on the bare key,
  // so `ultra` is the fixed point and the maker-prefixed form is the alias.
  // This is the same shape as `nba-hoops` over `panini-hoops` in the header:
  // house style loses to the spelling a checklist actually stands behind.
  "fleer-ultra": { to: "ultra",
    why: "Drew 2026-09-04 ruled Ultra its own product with its own pool; CF-ULTRA-IS-NOT-FLEER keeps it out of `fleer` and is unchanged. The SPELLING is decided by source: `ultra` holds 19,002 catalog rows across twelve sources spanning 1991-2007 plus 66,071 pool rows, while `fleer-ultra` holds 3,672 rows from a single checklistinsider window (3,639 of them 2025 hockey) and four pool rows that are Marvel/Spider-Man non-sport cards. Counting by source, the bare key is canonical and the maker-prefixed form folds onto it rather than splitting the pool." },

  // EXQUISITE (Drew 2026-09-04). Upper Deck Exquisite Collection is a DISTINCT
  // PRODUCT and must never fold into `upper-deck` — a 2003-04 Exquisite RPA
  // LeBron is not a 2003-04 Upper Deck base card, and fusing those pools
  // prices a four-figure rookie patch auto off a base-card comp.
  //
  // The canonical is `upper-deck-exquisite`: 705 checklist rows (hobbymonitor
  // 2026-09-04, all 2003) against 439 under `exquisite-collection`
  // (baseballcardpedia, all 2006) — and the maker-prefixed form is house style
  // where a checklist backs it, which here it does, by weight and as the newer
  // deliberate ingest. The other four spellings fold onto it so the product
  // keeps ONE pool.
  //
  // `exquisite-collection` is the one that costs something: it holds 439 real
  // checklist rows, so folding it is a MOVE of a backed key, not a cleanup of
  // an empty one. It is declared here rather than left a fixed point precisely
  // so the product does not keep two checklists under two names.
  "upper-deck-exquisite-collection": { to: "upper-deck-exquisite",
    why: "Drew 2026-09-04: the full product name, same product. One cardhedge row (2020), zero checklist rows, zero pool rows — it exists only as a spelling." },
  "exquisite-collection": { to: "upper-deck-exquisite",
    why: "Drew 2026-09-04: 'Exquisite Collection' with the maker elided. 439 checklist rows (baseballcardpedia, all 2006) vs 705 under `upper-deck-exquisite` (hobbymonitor 2026-09-04, all 2003) — one product, two checklists, two eras. Folded so the pool is not split by which source wrote the row; the 439 rows are rekey work, reported in the PR body." },
  "exquisite": { to: "upper-deck-exquisite",
    why: "Drew 2026-09-04: bare shorthand — '2006 Exquisite Basketball' is the Upper Deck product. Two sales-attested catalog rows and two pool rows, both John Stockton Exquisite patch autos." },
  "ud-exquisite-collection": { to: "upper-deck-exquisite",
    why: "Drew 2026-09-04: 'UD' is the maker abbreviation vendors write in titles ('2005 Ud Exquisite Collection Football'). Two sales-attested catalog rows." },
  "exquisite-collection-rookie-signatures": { to: "upper-deck-exquisite",
    why: "Drew 2026-09-04: a SUBSET name, not a product — Rookie Signatures is an insert line inside Exquisite Collection, and the parallel/subset axis carries it, not the setKey. One bccp-product-structure row, zero checklist rows." },

  // ALLEN & GINTER SPELLING. `and` vs `&` is orthography, not product.
  "topps-allen-and-ginter-chrome": { to: "topps-allen-ginter-chrome",
    why: "SPELLING ONLY ('and' vs the vocabulary's elided form). The CHROME SUBSET ITSELF IS DISTINCT and is declared a fixed point below — this entry exists so the two spellings of that one subset do not split its pool." },
  // ---------------------------------------------------------------------
  // DREW RULED 2026-09-04. The five keys #1699 shipped as still-open.
  // ---------------------------------------------------------------------

  // THE THREE SHORT BOWMAN SPELLINGS — "KEEP THE COLLAPSE" (Drew 2026-09-04).
  //
  // These three already collapsed, via ALREADY_RULED_COLLAPSES, and #1699 left
  // them in `needs-ruling` because the CATALOG DISAGREED: 47,218 checklist rows
  // are filed under the short keys, and for 2025 Sapphire the short spelling
  // (8,962 pool rows) outnumbers the long one (2,805) better than 3:1. A
  // collapse that survives only because a prior test pins it, while the corpus
  // votes the other way, is a collapse nobody has actually re-affirmed.
  //
  // Drew re-affirmed it: they are SPELLINGS, not products. So they move OUT of
  // "a prior decision we are not revisiting" and INTO the declared alias table,
  // where the canonical is stated and the evidence travels with it. Nothing
  // about the deriver's OUTPUT changes — `bowman-sapphire` folded to
  // `bowman-chrome-sapphire` before this ruling and folds there after it. What
  // changes is that the catalog's disagreement is now EXPLAINED rather than
  // filed as an unanswered question: these keys are re-keyed by the catalog
  // reconciliation, not honoured by the vocabulary.
  //
  // The card-coincidence test — the one Drew uses every time — points the same
  // way. Mega Box #52 Ohtani vs Bowman Chrome #52 Wetherholt is what made
  // `bowman-chrome-mega-box` DISTINCT FROM `bowman-chrome`, and that ruling is
  // untouched. Within the mega-box line itself there is no such split: "2023
  // Bowman Chrome Mega Box" and "2020 Bowman Mega Box Chrome" are the same
  // cards under two word orders, so the alias fuses nothing.
  "bowman-mega-box": { to: "bowman-chrome-mega-box",
    why: "Drew 2026-09-04 KEEP THE COLLAPSE: a spelling of `bowman-chrome-mega-box`, not a product. CF-BOWMAN-MEGA-BOX-DISTINCT (Drew 2026-08-12) makes the mega-box LINE distinct from bowman-chrome, and that stands — but within the line the short key names the same cards. 33,137 checklist rows across 2022-2026 and ZERO pool rows at the key: the catalog writes the short spelling, the market writes the long one, and the sample titles ('2023 Bowman Chrome Mega Box Baseball', '2020 Bowman Mega Box Chrome Baseball') are one release each year." },
  "bowman-mega-box-chrome": { to: "bowman-chrome-mega-box",
    why: "Drew 2026-09-04 KEEP THE COLLAPSE: the third word order of the same product (6,359 checklist rows, 2021-2022, zero pool rows at the key). 'Mega Box Chrome' and 'Chrome Mega Box' are the same release — the census's own sample titles carry both spellings for consecutive years of one line." },
  "bowman-sapphire": { to: "bowman-chrome-sapphire",
    why: "Drew 2026-09-04 KEEP THE COLLAPSE, re-affirming CF-SAPPHIRE-ONE-NAME ('there is no standalone Bowman Sapphire product') against the corpus that disagrees: 7,722 checklist rows from four independent Beckett scrapes sit under the short key, and '2025 Bowman Sapphire Baseball' (8,962 pool rows) outnumbers '2025 Bowman Chrome Sapphire Baseball' (2,805) better than 3:1. The market's shorthand is still shorthand — the catalog rows are re-keyed, not honoured." },

  // TOPPS NSCC / BOWMAN NATIONAL CONVENTION — ALIAS (Drew 2026-09-04).
  //
  // #1699 left this open because it reads both ways, and the ambiguity was
  // real: the key names BOTH makers, and the vocabulary's NSCC rule is
  // Bowman-scoped precisely "so it cannot capture a Topps National promo" —
  // yet it captures this key anyway, on the `bowman-national-convention`
  // substring. Either the rule is working or it is leaking, and the census
  // cannot tell which.
  //
  // Drew ruled ALIAS: this is the Bowman National release, and the stray
  // "topps" is the parent company on a Bowman product, not a second maker.
  // Declaring it here means the key now folds BY DECLARATION — an exact-token
  // map hit that returns before the regex vocabulary is ever consulted — so
  // the outcome no longer depends on the substring leak the comment warns
  // about. The vocabulary rule is separately re-anchored (see
  // hobbyIqCardId.service.ts) so its Bowman scope is explicit rather than
  // incidental; this entry is what makes THIS key's fold independent of it.
  "topps-nscc-bowman-national-convention": { to: "bowman-chrome-nscc",
    why: "Drew 2026-09-04: the Bowman National release, with 'topps' present as the parent company rather than a second maker — an ALIAS onto the #1612 product key. 221 checklist rows, all 2021, and every census sample title for the key is '<year> Bowman Chrome National Convention Baseball'. Declared here so the fold is BY DECLARATION and no longer rides on the `bowman-national-convention` substring leak the NSCC rule's own comment warns about." },

  // BELLINGHAM MARINERS — `bellingham-mariners` IS THE KEY (Drew, 2026-08-30,
  // re-affirmed as R1 on 2026-09-04).
  //
  // ONE CARD. THREE POOLS. Measured read-only against prod sold_comps on
  // 2026-09-04: 228 rows of the SAME card — 1987 Bellingham Mariners #15, Ken
  // Griffey Jr.'s team-issue rookie — split across three stored slugs:
  //
  //   hiq:baseball:1987:bellingham:15:base:no-auto                163 rows
  //   hiq:baseball:1987:1987-bellingham-baseball:15:base:no-auto   41 rows
  //   hiq:baseball:1987:unknown:15:base:no-auto                    24 rows
  //
  // That is `feedback_one_card_one_row_one_pool` stated as damage: three trend
  // lines for one card, so whichever pool a surface reads, the FMV is computed
  // from a third of the evidence. The titles say which product it is and they
  // are not ambiguous — "1987 Bellingham Mariners Team Issue #15 Ken Griffey Jr
  // RC", "1987 International Sportcard Bellingham Mariners - Ken Griffey Jr
  // #15" — and the checklist Drew ruled on 2026-08-30 already exists in the
  // catalog: `hiq:baseball:1987:bellingham-mariners:15:base:no-auto`, source
  // `drew-ruling-checklist-2026-08-30`.
  //
  // WHY THE CENSUS DISAGREES, AND WHY THE RULING WINS. The 2026-09-03 census
  // called `1987-bellingham-baseball` a `catalog-key-malformed` whose canonical
  // is `bellingham` — mechanically correct (the key does carry a year prefix
  // and a trailing sport word) and the WRONG DESTINATION. `bellingham` is the
  // town, not the product; stripYearAndSport produced it from a malformed
  // catalog key and nothing ever ruled it. Guard (0) in buildTables exists for
  // exactly this: a verdict DERIVED from a key's shape must never outrank a
  // decision a human stated with evidence.
  //
  // THE ALIAS IS DECLARED ON THE STRIPPED FORM, AND THAT IS DELIBERATE.
  // `stripYearAndSport` runs BEFORE the reconciliation inside normalizeSetKey,
  // so `1987-bellingham-baseball` has already become `bellingham` by the time
  // this map is consulted — declaring the long spelling alone would never fire.
  // Both spellings are named anyway: the stripped one is what actually folds,
  // and the long one is named so the day the strip changes the pin says so
  // rather than the fold silently disappearing.
  bellingham: { to: "bellingham-mariners",
    why: "Drew 2026-08-30 (R1): `bellingham-mariners` is THE key for the 1987 Bellingham Mariners team issue. `bellingham` is the town, not the product — it exists only because stripYearAndSport reduced the malformed catalog key `1987-bellingham-baseball`, and the 2026-09-03 census named it canonical on that shape alone. 163 pool rows of ONE card (#15 Griffey Jr. RC) sit under it against a checklist-backed `bellingham-mariners` row (source drew-ruling-checklist-2026-08-30); the census's own sample titles are '1987 Bellingham Mariners Team Issue'." },
  "1987-bellingham-baseball": { to: "bellingham-mariners",
    why: "The same ruling, named in its unstripped catalog spelling. This entry does not fire on its own — stripYearAndSport reduces the key to `bellingham` before the reconciliation is consulted — and it is declared so the ruling is discoverable under the spelling the CATALOG actually stores (4 rows), and so a change to the strip surfaces as a failing pin instead of a silently vanished fold. 41 pool rows." },
  "bellingham-mariners-team-issue": { to: "bellingham-mariners",
    why: "Drew 2026-08-30 (R1): 'Team Issue' is what the set IS, not a second product — the phrase names the distribution (a club-issued team set) and is how sellers spell it in the pool's own titles. A normalizeSetKey non-fixed-point that resolves to the ruled key, so a title reading '1987 Bellingham Mariners Team Issue' lands on the same row as one reading '1987 Bellingham Mariners'." },

  // ── SALES-SIDE SPELLINGS (Drew 2026-09-05, from the checklist-gap census) ──
  //
  // The census offered 172 "safe rekey" pairs. Verified one by one against
  // prod card_catalog BY SOURCE (read-only, 2026-09-05), only these five are
  // aliases. What disqualified the rest is recorded in
  // docs/runbooks/alias-reslug-2026-09-05.md; the short version is that 86% of
  // the rows were ALREADY resolved by the deriver (the census compared STORED
  // slugs, never running them through normalizeSetKey), and most of the
  // remainder are splits, cross-manufacturer word collisions, or pairs that
  // contradict a standing ruling.
  //
  // Each entry below passes the same five gates: the destination has strict
  // checklist rows for the same sport-years; the alias key has ZERO strict
  // checklist rows of its own; no ruled collapse/distinct entry is
  // contradicted; neither side is a bowman-*<->topps-* fold; and the
  // destination is a normalizeSetKey fixed point.

  // NBA HOOPS. This file's own header already ruled it — "`nba-hoops` holds
  // 26,355 checklistinsider rows and `panini-hoops` holds ZERO, so `nba-hoops`
  // is the key and the prefixed form is the alias" — but the alias was never
  // DECLARED, so the vocabulary went on deriving the prefixed spelling and the
  // pool stayed split. Re-measured 2026-09-05 and the header is exactly right:
  //   `nba-hoops`     26,355 rows, ALL checklistinsider-2026-08-27/28/29.
  //   `panini-hoops`   2,680 rows, ZERO strict — 2,086 ingest-auto-seed-graded,
  //                    396 sales-attested, 194 sales-attested-graded. Minted
  //                    from the very sales that need the checklist.
  // The split is provable end to end: normalizeSetKey('2024 Panini NBA Hoops
  // Basketball') -> `panini-hoops` while normalizeSetKey('2024 NBA Hoops') ->
  // `nba-hoops`. One product, two pools, decided by whether the seller typed
  // the maker — which is CF-ONE-CARD-ONE-ROW-ONE-POOL stated as damage.
  "panini-hoops": { to: "nba-hoops",
    why: "Counted by source 2026-09-05: `nba-hoops` holds 26,355 rows, every one checklistinsider; `panini-hoops` holds 2,680 rows and ZERO strict checklist rows (ingest-auto-seed + sales-attested only, i.e. seeded from the sales themselves). House style loses to the spelling a checklist stands behind — the same doctrine as `ultra` over `fleer-ultra`. Declared because this file's header already ruled it while the vocabulary (hobbyIqCardId.service.ts) still derives `panini-hoops` from a title carrying the maker, splitting one product across two pools." },

  // LEATHER & LUMBER. The cleanest case in the batch: the prefixed spelling
  // has ZERO catalog rows of ANY kind, so it is a pure sales-side spelling
  // with nothing behind it at all.
  "panini-leather-lumber": { to: "leather-lumber",
    why: "Measured 2026-09-05: `panini-leather-lumber` holds ZERO card_catalog rows of any kind, against 5,931 on `leather-lumber` (3,827 baseballcardpedia-ladders-2026-09-04 + 2,101 -09-05, all strict). A key no checklist has ever written is a spelling, not a product — the same reasoning ERA_SPLIT_TABLE gives for refusing to invent `panini-score`/`panini-leaf` destinations. 98 pool rows, baseball 2019." },

  // BARE ABBREVIATIONS. Two keys that are an abbreviation of their destination
  // rather than a product: `ud` is how sellers write Upper Deck, and a bare
  // `chrome` is Topps Chrome. Both hold ZERO strict rows. `chrome` is declared
  // to `topps-chrome` and NOT to `bowman-chrome`: the census offered both
  // (143 rows vs 2), and a bare-key fold into a Bowman product is exactly the
  // Bowman/Topps merge that stays refused — see the contested list in the
  // runbook. Topps Chrome takes it on weight of evidence alone.
  ud: { to: "upper-deck",
    why: "`ud` is the seller's abbreviation of Upper Deck, not a product. It carries 13 pool rows across five baseball sport-years (1992-2002) and no strict checklist rows; `upper-deck` is the spelled-out key the catalog uses. Declared so the abbreviation lands in the same pool as the spelled form rather than minting a parallel one." },
  chrome: { to: "topps-chrome",
    why: "A bare `chrome` is Topps Chrome. Measured 2026-09-05: the key holds EIGHT card_catalog rows in total (2 ingest-auto-seed-graded, 2 ebay-user-purchase, 2 ebay-browse, 1 user-verified, 1 -graded) — zero strict, nothing checklist-backed, and the sales are spread 2008-2025. The destination is the 159,897-strict-row `topps-chrome`. The census also offered `chrome -> bowman-chrome` on 2 rows; that direction is REFUSED (a bare key may not fold into a Bowman product — CF-BOWMAN-TAXONOMY), and the Topps destination carries 143 of the 145 rows besides." },
});

/**
 * DISTINCT PRODUCTS — fixed points. The deriver must stop collapsing these.
 *
 * Drew's standing rule: distinct products are NEVER collapsed. Each entry
 * names the evidence that these are separate products whose cards do not
 * coincide with the destination's.
 */
const RULED_DISTINCT: Readonly<Record<string, string>> = Object.freeze({
  // NSCC. #1612 ruled Bowman NSCC its own product, and the vocabulary's
  // CF-BOWMAN-NSCC-DISTINCT states the pricing reason outright: convention
  // redemption scarcity does not price like flagship parallel scarcity (a
  // 2018 BNR-AJ Judge /3 sold at $500 BGS 9, BELOW his ordinary #100 Gold
  // /50). These two keys name NSCC releases; they must not fold into a
  // flagship, and `bowman-chrome-nscc` is itself a distinct product.
  // NOTE ON `topps-nscc-bowman-national-convention` — RULED 2026-09-04, and
  // it is an ALIAS, so it lives in RULED_ALIASES rather than here. #1699 left
  // it open because it read both ways: the key names BOTH makers, and the
  // vocabulary's NSCC rule is deliberately Bowman-scoped "so it cannot
  // capture a Topps National promo" — yet it captured this key anyway, on the
  // 'bowman-national-convention' substring, which is the leak that comment
  // warns about. Drew ruled it the 2021 Bowman National release with 'topps'
  // present as the parent company, so the rule was WORKING and not leaking.
  // Two things now make that outcome independent of the substring: the alias
  // declaration folds the key before the vocabulary is consulted at all, and
  // the NSCC rule itself is re-anchored in hobbyIqCardId.service.ts so its
  // Bowman scope is explicit rather than incidental.

  // ALLEN & GINTER SUBSETS. The Chrome subset needed no ruling — the census
  // already calls `topps-allen-ginter-chrome` distinct on 21,442 checklist
  // rows, and checklist-parallel-names.json carries it as a key of its own.
  // What DID need answering was the 'and' spelling of it, which is an alias
  // (above) so the one subset does not price out of two pools. The die-cuts
  // are their own release:
  "topps-allen-and-ginters-national-die-cuts":
    "A National-convention die-cut release (146 checklist rows, all 2015), not the flagship Ginter set. Convention exclusives price on their own scarcity — the CF-BOWMAN-NSCC-DISTINCT reasoning applies unchanged.",

  // eTOPPS. The strongest evidence in the batch: parseTitleIdentity.service
  // ALREADY treats eTopps as its own product ("eTopps must precede /topps/
  // since the brand name is a substring of it"), while normalizeSetKey has no
  // rule and lets the bare /topps/ pattern swallow it. Two services
  // disagreeing is a defect, and the one that ruled deliberately wins.
  "etopps":
    "parseTitleIdentity.service.ts already rules eTopps a distinct product (`if (/\\betopps\\b/i.test(t)) return 'eTopps'`, with a comment saying it must precede /topps/). eTopps was a digital-delivery IPO line with its own cards and its own scarcity; collapsing 187 checklist rows into the 3.49M-row `topps` pool is the largest fuse in this table.",
  "etopps-cards-that-never-were":
    "Same line, a named 2007 eTopps subset (17 checklist rows). Distinct for the same reason, and it must not fall into flagship `topps` either.",

  // SCORE FAMILY. Two 1980s-90s releases that are not the Score flagship.
  "scoreboard-mantle":
    "1997 Scoreboard Mickey Mantle is a Classic/Scoreboard single-player tribute set, not a Score release — the census's own sample title is '1997 Scoreboard Mickey Mantle Baseball' (125 rows). It reaches `score` only because the bare brand pattern matches the prefix of 'scoreboard'. 153 checklist rows, all 1997.",
  "scoremasters":
    "1989 Scoremasters is its own 1989 release (44 checklist rows), captured by the same prefix accident — 'score' is a prefix of 'scoremasters'. A prefix match is not an identity; the whole point of this file is that unanchored brand patterns swallow products whose names contain the brand.",

  // PRIZM PERENNIAL DRAFT PICKS. 2013-14 baseball, disjoint in year AND sport
  // from the destination's live range.
  "panini-prizm-perennial-draft-picks":
    "3,748 checklist rows, 2013-2014, BASEBALL. `panini-prizm-draft-picks` is a football/basketball line whose census sample titles are 2019-2025 (13,910 football 2025, 41,091 basketball 2024). Different sport, different decade — the collapse would fuse a 2013 baseball pool into a modern football one.",

  // BOWMAN MEGA (2026 spelling). CF-BOWMAN-MEGA-BOX-DISTINCT is the ruling
  // that mega box cards do NOT coincide with Bowman Chrome cards (Mega Box
  // #52 Ohtani vs Bowman Chrome #52 Wetherholt). It is a distinct product;
  // the 2026 short spelling names that same distinct product.
  "bowman-mega":
    "CF-BOWMAN-MEGA-BOX-DISTINCT (Drew 2026-08-12): 'Mega box is different from 2026 bowman and 2026 bowman is a different product.' 412 checklist rows, all 2026 — the year's short spelling of the mega-box line, and a fixed point for the same reason the line itself is one.",

  // TOPPS UPDATE JAPAN. A Japan-market release is not the US Update series;
  // the Japanese-code ruling is the same shape (the market's own key wins).
  "topps-update-japan":
    "A Japan-market release, not US Topps Update Series. 1 checklist row (2025) — small, but Drew's standing rule is that a small number is never dismissed as noise, and the Japanese-market ruling elsewhere in this file says the market's own key wins. Folding it into the 206,546-row `topps-update-series` pool would price a Japanese release off US comps.",
  // BLACK DIAMOND ROOKIE EDITION — DISTINCT (Drew 2026-09-04).
  //
  // #1699 left this open between two readings: "Rookie Edition" as a subset
  // name that CF-UD-INSERT-LINES rightly folds, or a separately-released
  // product the bare `black-diamond` pattern swallows. Drew ruled DISTINCT:
  // its own product, and it must NEVER fold into `upper-deck-black-diamond`.
  //
  // The census shows the fusion this stops. Black Diamond Rookie Edition is a
  // rookie-only release with its own checklist — 194 checklist rows, all 2000,
  // from baseballcardpedia — while the destination pool holds the base sets
  // ("1999 Upper Deck Black Diamond Baseball", 857 rows; "1999 Upper Deck
  // Black Diamond Basketball", 594). A rookie-only pool and a base pool price
  // differently by construction: the base set is a full veteran checklist and
  // the Rookie Edition is first-year cards only, so a fused pool would drag a
  // rookie card's FMV toward veteran comps and back again. That is precisely
  // the "one card, one row, one pool" damage the whole reconciliation exists
  // to stop, and it is the same shape as CF-BOWMAN-NSCC-DISTINCT: a separate
  // release with its own scarcity does not price off the flagship's trend.
  //
  // Note the sample titles also carry "1998 Upper Deck Black Diamond Rookie
  // Edition Football" (176 pool rows) sitting in the destination pool today —
  // rows this ruling stops adding to.
  //
  // CF-UD-INSERT-LINES MUST NOT CAPTURE IT. That rule's second branch is
  // `(?:^|-)black-diamond`, which matches this key on its own prefix. Two
  // things now stop it, and the redundancy is deliberate: this entry makes the
  // key a fixed point that returns from `reconcileSetKey` BEFORE the regex
  // vocabulary runs, and the rule itself is re-anchored in
  // hobbyIqCardId.service.ts with an explicit negative lookahead so it cannot
  // reach the key even if the reconciliation is ever unloaded (the loader
  // degrades to an EMPTY doc by design, so "the table is absent" is a state
  // that really occurs).
  "black-diamond-rookie-edition":
    "Drew 2026-09-04: its OWN PRODUCT — a rookie-only Upper Deck release (194 checklist rows, all 2000, baseballcardpedia), never `upper-deck-black-diamond`. The destination pool is the base sets ('1999 Upper Deck Black Diamond Baseball', 857 rows), and a rookie-only checklist fused into a full veteran one prices both wrong. Pinned against CF-UD-INSERT-LINES, whose `(?:^|-)black-diamond` branch would otherwise capture it on the prefix.",
});

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
  // NOTE (Drew 2026-09-04): `bowman-sapphire`, `bowman-mega-box` and
  // `bowman-mega-box-chrome` USED TO LIVE HERE. They were the three keys
  // #1699 could not close: a prior test pinned the collapse, but the catalog
  // disagreed with 47,218 checklist rows, so they stayed `needs-ruling` and
  // this list kept their behaviour by default. Drew ruled KEEP THE COLLAPSE
  // and they moved to RULED_ALIASES, where the canonical is DECLARED and the
  // evidence travels with it. They are deliberately not repeated here — a key
  // in both lists is one truth in two places, and this list means "a decision
  // nobody has re-affirmed", which is exactly what these no longer are. The
  // deriver's output is unchanged either way; only the explanation moved.
  "bowman-draft-sapphire-chrome": "bowman-draft-sapphire",
  "topps-chrome-sapphire-edition": "topps-chrome-sapphire",
  "flair-showcase": "flair",
  // NOTE (Drew 2026-09-04): `fleer-ultra` USED TO LIVE HERE. Drew ruled Ultra
  // a DISTINCT PRODUCT with its own pool — which it already was, since
  // CF-ULTRA-IS-NOT-FLEER keeps it out of `fleer` entirely. What that ruling
  // settled is the SPELLING, and a spelling with a declared canonical is an
  // alias, not an undeclared collapse. It moved to RULED_ALIASES, where the
  // canonical is stated and the evidence travels with it. Not repeated here:
  // a key in both lists is one truth in two places, and this list means "a
  // decision nobody has re-affirmed", which this no longer is.
  // The sapphire ruling in the vocabulary, applied to its "Edition" spelling.
  "bowman-chrome-sapphire-edition": "bowman-chrome-sapphire",
  "bowman-draft-sapphire-edition": "bowman-draft-sapphire",
  "panini-contenders-optic": "panini-contenders",
  "donruss-champions": "panini-donruss",
});

/** The keys a prior ruling already decided, with the destination it ruled. */
/** The keys this PR ruled an ALIAS from evidence, with the reason. */
export function ruledAliases(): Array<{ setKey: string; canonical: string; why: string }> {
  return Object.entries(RULED_ALIASES)
    .map(([setKey, v]) => ({ setKey, canonical: v.to, why: v.why }))
    .sort((a, b) => a.setKey.localeCompare(b.setKey));
}

/** The keys this PR ruled a DISTINCT product from evidence, with the reason. */
export function ruledDistinct(): Array<{ setKey: string; why: string }> {
  return Object.entries(RULED_DISTINCT)
    .map(([setKey, why]) => ({ setKey, why }))
    .sort((a, b) => a.setKey.localeCompare(b.setKey));
}

export function alreadyRuledCollapses(): Array<[string, string]> {
  return Object.entries(ALREADY_RULED_COLLAPSES).sort((a, b) => a[0].localeCompare(b[0]));
}

// -- the alias table and the fixed points ------------------------------------

// Built lazily alongside the doc, for the same reason: nothing in this module
// may run — or throw — while it is merely being imported.
let _aliases: Map<string, string> | null = null;
let _fixedPoints: Set<string> | null = null;

function buildTables(): void {
  if (_aliases && _fixedPoints) return;
  const ALIASES = new Map<string, string>();
  const FIXED_POINTS = new Set<string>();

  for (const e of entries()) {
  const key = e.setKey;
  // (0) A DECLARED RULING OUTRANKS EVERY MECHANICAL VERDICT.
  //
  //     RULED_ALIASES used to be consulted only under `needs-ruling`, on the
  //     reasoning that a ruling answers an OPEN question. Drew's 2026-09-04
  //     Ultra ruling is the case that breaks it: the census had already
  //     decided `fleer-ultra` mechanically (`distinct`, because `ultra` is an
  //     ancestor and family collapse is forbidden), so the entry never reached
  //     the ruling and the key became a fixed point — splitting the pool the
  //     ruling exists to keep whole. A verdict DERIVED from the key's shape
  //     must never outrank a decision a human stated with evidence; that is
  //     the same principle guard (3) already applies to ALREADY_RULED_
  //     COLLAPSES, just applied to the list that also names the destination.
  //
  //     Both directions are honoured here, so `distinct` and `needs-ruling`
  //     alike defer to a ruling. The `needs-ruling` branch below is now
  //     unreachable for ruled keys and kept only for its reasoning.
  const declaredAlias = RULED_ALIASES[key];
  if (declaredAlias && declaredAlias.to !== key) { ALIASES.set(key, declaredAlias.to); continue; }
  if (RULED_DISTINCT[key]) { FIXED_POINTS.add(key); continue; }
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
  // WHAT IS LEFT -- `distinct` and `mis-sported` -- means "do not rewrite this
  // key". Three guards stand in front of that, and each exists because a
  // verdict derived from the key's SHAPE must not overrule a decision made
  // from something the census cannot see.
  //
  // (1) AN OPEN QUESTION CHANGES NOTHING -- BUT MOST OF THEM ARE NOT OPEN.
  //     The first cut sent all 20 `needs-ruling` keys to Drew. Reading the
  //     evidence answered 16 of them: a productSetKeys entry, a standing CF
  //     ruling in the vocabulary, a sibling service that already disagrees,
  //     or checklist counts and sample titles that only fit one reading.
  //     Those verdicts are declared in RULED_ALIASES / RULED_DISTINCT above,
  //     each carrying the evidence that settled it, and they are applied here
  //     rather than asked again.
  //
  //     What is left genuinely IS open, and for those the original reasoning
  //     stands unchanged: a verdict meaning "I could not decide this
  //     mechanically" has no authority to overturn a deliberate decision, so
  //     an unruled key keeps today's behaviour and travels to Drew as a
  //     question. Changing it would be acting on the ABSENCE of a rule.
  if (e.verdict === "needs-ruling") {
    const ruledAlias = RULED_ALIASES[key];
    if (ruledAlias && ruledAlias.to !== key) { ALIASES.set(key, ruledAlias.to); continue; }
    if (RULED_DISTINCT[key]) { FIXED_POINTS.add(key); continue; }
    continue;
  }
  //
  // (2) AN ERA KEY IS NOT A FIXED POINT -- IT IS A KEY THAT NEEDS A YEAR.
  //     `donruss` is stale precisely BECAUSE normalizeSetKey rewrites it. But
  //     normalizeSetKey has no year, and with no year the modern spelling is
  //     the right default (CF-PANINI-IS-ANACHRONISTIC-BEFORE-2009);
  //     `resolveSetKeyForSlug("baseball", "Donruss", 1987)` already answers
  //     `donruss` because IT has the year. The split is resolved by
  //     spellSetKeyForEra at the call sites that know the year, and pinning
  //     the bare key here would break the year-less default while fixing
  //     nothing the year-aware path gets wrong.
  if (e.verdict === "era-split") continue;
  //
  // (3) A DECISION BEATS A DERIVATION. Where somebody already ruled this
  //     collapse and pinned it with a test that states the reasoning, the
  //     ruling stands and the verdict is report-only.
  if (ALREADY_RULED_COLLAPSES[key]) continue;

  // AND A FIXED POINT STILL HAS TO EARN IT. Count by source, not by row count:
  // the checklist is what confers the authority to be a fixed point. Without
  // one the verdict rests on the key's shape alone -- and shape is exactly
  // what the vocabulary has already ruled on deliberately, in the file header:
  // "Bowman Chrome Prospects" folds to `bowman-chrome`, "Bowman Draft Chrome"
  // to `bowman-draft`, "Upper Deck SPx Finite" to `spx-finite`. All three hold
  // ZERO checklist rows, so promoting them would overturn a ruling on no
  // evidence at all -- the same error as letting a derived catalog row
  // adjudicate. 514 of the 686 distinct keys are checklist-backed.
  if (e.evidence.checklistRows > 0) FIXED_POINTS.add(key);
  }

  // A RULING ON A KEY THE CENSUS NEVER LISTED STILL COUNTS.
  //
  // The loop above can only see keys in the data file, and the data file holds
  // the STALE keys — the ones normalizeSetKey did not already leave alone. A
  // key that WAS a fixed point when the census ran is therefore absent, and
  // Drew's 2026-09-04 Exquisite ruling turns exactly such keys into aliases:
  // `exquisite-collection` (439 baseballcardpedia checklist rows) and
  // `exquisite` both derived to themselves on 2026-09-03, so neither appears
  // in the 2,646. Without this pass they would be ruled in the source and
  // missing from the table the tests and the rematch actually read.
  //
  // Declared last so a key the census DID list keeps the evidence-carrying
  // path above; this only fills in what that loop could not see.
  for (const [key, v] of Object.entries(RULED_ALIASES)) {
    if (v.to !== key && !ALIASES.has(key)) ALIASES.set(key, v.to);
  }
  for (const key of Object.keys(RULED_DISTINCT)) {
    if (!ALIASES.has(key)) FIXED_POINTS.add(key);
  }
  // An alias target is a fixed point by definition — it is the spelling that
  // WON. Declaring it explicitly keeps the no-chains invariant true for a
  // canonical the census never listed either (`upper-deck-exquisite` is one:
  // its 705 rows landed the day after the census ran).
  for (const to of ALIASES.values()) {
    if (!ALIASES.has(to)) FIXED_POINTS.add(to);
  }

  _aliases = ALIASES;
  _fixedPoints = FIXED_POINTS;
}

function aliases(): Map<string, string> {
  buildTables();
  return _aliases as Map<string, string>;
}

function fixedPoints(): Set<string> {
  buildTables();
  return _fixedPoints as Set<string>;
}

/** Every alias, as [from, to]. Sorted, for the tests and for reporting. */
export function setKeyAliases(): Array<[string, string]> {
  return [...aliases().entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Every key the reconciliation declares a fixed point — a product the
 *  deriver must stop collapsing into its family. */
export function reconciledFixedPoints(): string[] {
  return [...fixedPoints()].sort();
}

/** The reconciliation entry for a key, or null. */
export function reconciliationEntry(setKey: string | null | undefined): ReconciliationEntry | null {
  const s = String(setKey ?? "").trim().toLowerCase();
  if (!s) return null;
  return byKey().get(s) ?? null;
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
  const alias = aliases().get(s);
  if (alias) return { key: alias, final: true };
  if (fixedPoints().has(s)) return { key: s, final: true };
  return { key: s, final: false };
}

/** The open questions, largest first — for the PR body and for Drew. */
export function needsRulingQuestions(): Array<{ setKey: string; question: string; checklistRows: number }> {
  return entries()
    // A key this PR ruled from evidence is no longer a question. What remains
    // is the genuinely split set: the ones where the evidence points both ways
    // and only Drew can choose.
    .filter((e) => e.verdict === "needs-ruling" && !RULED_ALIASES[e.setKey] && !RULED_DISTINCT[e.setKey])
    .map((e) => ({
      setKey: e.setKey,
      question: e.question ?? "",
      checklistRows: e.evidence.checklistRows,
    }))
    .sort((a, b) => b.checklistRows - a.checklistRows);
}

/** The counts, for reporting. */
export function reconciliationTotals(): Record<string, number> {
  return doc().totals.verdicts;
}
