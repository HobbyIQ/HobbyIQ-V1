// CF-HOBBYIQ-CARDID (Drew, 2026-07-23, issue #706). HobbyIQ's own
// canonical card identifier. Vendor-independent, deterministic,
// human-readable. The "we set the market" identity primitive.
//
// FORMAT
//   hiq:{sport}:{year}:{setKey}[:sub-{subsetSlug}]:{cardNumber}:{parallelSlug}:{autoFlag}[:num-{printRun}]
//
// EXAMPLES
//   hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto:num-50
//   hiq:baseball:2026:bowman-chrome:bcp-102:orange-shimmer-refractor:no-auto
//   hiq:basketball:2024:panini-prizm:1:silver-prizm:no-auto:num-99
//   hiq:pokemon:2023:sv1:151:full-art:no-auto
//   hiq:basketball:2000:topps-chrome:sub-cards-that-never-were:mj1:refractor:no-auto
//   hiq:basketball:2000:topps-chrome:sub-johnson-reprints:mj1:refractor:no-auto
//
// DESIGN CONSTRAINTS
//   - Deterministic: same normalized inputs ALWAYS produce the same slug.
//   - Reversible enough for debugging: a human reader can look at the
//     slug and know what card it is.
//   - Uniqueness: sport is the top-level namespace so cardNumbers don't
//     collide across sports. Print run distinguishes numbered parallels
//     (Gold /50 ≠ Gold /25 ≠ Gold unnumbered).
//   - No dependency on any vendor identifier — CH, Cardsight, eBay all
//     map to the same hobbyiqCardId via their attributes.
//
// NORMALIZATION RULES (canonical — do NOT change without a migration)
//   sport         → lowercase, ASCII, no spaces
//   year          → 4-digit integer, as-is
//   setKey        → slug: lowercase, strip punctuation, spaces→hyphens,
//                   collapse repeated hyphens. Uses the SHORTEST canonical
//                   name from a controlled vocabulary when possible
//                   (e.g. "2026 Bowman Chrome Prospects" → "bowman-chrome")
//   cardNumber    → lowercase, kept literal (letters, digits, hyphens)
//   parallelSlug  → slug of the specific variant (NOT the lossy label —
//                   caller must pass the specific variant, extracted from
//                   the title if necessary)
//   subsetSlug    → "sub-{slug}" optional segment, present ONLY for a card
//                   whose number is shared by more than one named subset of
//                   the same product. The caller states the clash; this
//                   module never infers one. See
//                   CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE.
//   autoFlag      → "auto" | "no-auto"  (never omitted)
//   printRun      → "num-{N}" optional suffix (omitted when card is
//                   unnumbered, e.g. Base or general Refractor)
//
// This module has ZERO side effects. Import + call is safe anywhere.

import { chromeRefractorSuffixForVariation, normalizeVariationSlug } from "../catalog/variationVocabulary.js";
import { POKEMON_SET_ALIASES } from "../catalog/pokemonSetAliases.js";
import { YUGIOH_SET_ALIASES, MTG_SET_ALIASES } from "../catalog/tcgSetAliases.js";
import { JAPANESE_POKEMON_SET_ALIASES } from "../catalog/japanesePokemonAliases.js";
import { productParentOf, productSetKeyForName, spellForEra } from "../catalog/productSetKeys.js";
import { reconcileSetKey } from "../catalog/setKeyReconciliation.js";
import { normalizePokemonCardNumber } from "../catalog/pokemonCardNumber.js";
import { isMakerlessCatchAllSetKey, makerlessCatchAllMessage } from "../catalog/makerlessCatchAll.js";
export interface HobbyIqCardIdComponents {
  sport: string;              // e.g. "baseball"
  year: number;               // e.g. 2026
  setKey: string;             // e.g. "bowman" (canonical short form)
  cardNumber: string;         // e.g. "CPA-EHA"
  parallel: string;           // e.g. "Gold Refractor" (SPECIFIC variant, not lossy)
  isAuto: boolean;
  printRun?: number | null;   // e.g. 50 for /50 numbered; null/undefined for unnumbered
  /** Caller knows the product for certain (a published checklist), so the
   *  cardNumber-prefix repair for untrusted vendor text must NOT fire. See
   *  CF-AUTHORITATIVE-SETKEY. Vendor paths leave this unset. */
  authoritativeSetKey?: boolean;
  /** CF-PLAYER-IS-THE-NUMBER. Required ONLY for genuinely unnumbered cards.
   *  See UNNUMBERED_CARD_NUMBER below for why. */
  playerName?: string | null;
  /** CF-UNPARSED-IS-NOT-UNNUMBERED. The caller has a CHECKLIST that lists this
   *  card with no number, so a blank cardNumber is an ANSWER and the
   *  player-as-the-number shape is correct. Vendor paths never set this: for
   *  them a blank cardNumber is a parse failure and the identity is refused. */
  unnumberedByChecklist?: boolean;
  /** CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE. The named subset
   *  this card belongs to ("Cards That Never Were"). Carried for EVERY row
   *  that has one — it is display data on most of them. Blank/absent means
   *  UNKNOWN, never "no subset" and never "Base". */
  subsetName?: string | null;
  /** The CLASH FLAG, and the only thing that puts the subset in the slug.
   *  True when the checklist for this (year, setKey) lists this cardNumber
   *  under MORE THAN ONE subset at this rung. Derived at ingest from the
   *  catalog and persisted on the catalog row; never inferred here, and never
   *  read off a sale title. See below. */
  subsetInId?: boolean;
  /** CF-THE-CHECKLIST-SPELLS-THE-NUMBER (Drew, 2026-09-04). The width THIS
   *  set's checklist spells bare card positions in, from
   *  `checklistNumberWidth` over its checklist-backed catalog rows. Pokemon
   *  only, and only the caller that has read the checklist may set it:
   *  a positive width pads (`94` -> `094`), `0` means the checklist spells
   *  positions verbatim (`004` -> `4`), and ABSENT/null means the set has no
   *  checklist to ask -- the number is then left exactly as stated, because
   *  padding on a guess mints an identity no checklist published. */
  pokemonChecklistNumberWidth?: number | null;
}

/**
 * CF-PLAYER-IS-THE-NUMBER (Drew, 2026-08-18: "did they even have card
 * numbers then?").
 *
 * They did not. Vendors write `NNO` — "no number" — and it is ACCURATE data,
 * not a parse failure. Measured across the 50,989 affected sold_comps rows,
 * the sets are ones that genuinely never carried numbers:
 *
 *   6,025  1909-11 T206                    famously unnumbered
 *   8,347  Magic Alpha/Beta/Arabian/Dark   pre-collector-number era
 *   3,487  Leaf & Donruss Signature Series autograph sets
 *     954  1964 Topps Stand-Up
 *     654  1966 Topps Rub-Offs
 *
 * Only 6.4% of those rows have any `#number` in their title, and on inspection
 * most of those are certs (#3538117020) or print runs (#788/1000), not card
 * numbers.
 *
 * Treating `nno` as an identity collapsed every unnumbered card in a set onto
 * ONE slug — 395 players in a single pool spanning $3.49 to $103,700. Refusing
 * it (slugGuard) stopped the damage but left those cards unpriceable forever,
 * because the number they are missing does not exist to be recovered.
 *
 * For a card with no number, the PLAYER is the identifier — that is how
 * collectors refer to them ("T206 Wagner", not "T206 #___"). So the player
 * takes the cardNumber slot, prefixed `player-` so it can never be mistaken
 * for, or collide with, a real card number.
 *
 * NOT `p-`, which was the first choice and was wrong: promo cards genuinely
 * carry card numbers like P-1 and P-45, which slugify to `p-1` / `p-45`. A
 * card numbered P-1 would then have produced the same segment as an unnumbered
 * card of a player slugging to "1". No real card number is the literal word
 * "player", so the longer prefix makes the separation total rather than likely.
 *
 * SAFE BECAUSE THE NAMES ARE CLEAN. Of 3,997 distinct playerNames in this
 * population, exactly 20 groups differ only by case or punctuation — and
 * slugify folds every one of them:
 *
 *   "Kiki Cuyler" / "KiKi Cuyler" / "\"Kiki\" Cuyler"  -> kiki-cuyler
 *   "Lebron James" / "LeBron James"                    -> lebron-james
 *
 * Digits survive slugify, so "Checklist 1-154" and "Checklist 547-653" stay
 * DISTINCT — they are different cards, and collapsing them would recreate the
 * pooling this fixes.
 */
const UNNUMBERED_CARD_NUMBER: ReadonlySet<string> = new Set([
  "nno", "no-number", "nonumber", "n-a", "na", "none", "unnumbered",
]);

/**
 * CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04: "blank means UNKNOWN,
 * never a value").
 *
 * These two facts were one function and they are opposites:
 *
 *   UNNUMBERED  the source SAYS the card has no number -- a vendor writing
 *               `nno`, a checklist listing a card with no number column. That
 *               is an ANSWER, and CF-PLAYER-IS-THE-NUMBER encodes it as
 *               `player-<name>`.
 *   UNPARSED    nothing was found. No vendor field, no `#` in the title,
 *               nothing the parser could read. That is the ABSENCE of an
 *               answer, and it must produce NO identity at all.
 *
 * The old `isUnnumberedCardNumber` returned true on `!s` -- an empty string --
 * so a PARSE FAILURE was read as "this card has no number" and fell straight
 * into the pseudo-number shape. A 1987 Topps Traded Tiffany Maddux PSA 10
 * whose title states `#70T` was filed at
 * `hiq:baseball:1987:topps:player-todd-worrell:base:no-auto` -- a card number
 * the title spelled out, thrown away, and replaced with a player the VENDOR
 * mis-attributed. Two wrongs, and the first one is what let the second land:
 * absence beats wrong, so a row the parser could not read must stay unkeyed
 * and be re-derived later, never minted onto a pseudo-number.
 *
 * 89,138 pool rows carry the `player-` shape. The census (scripts/
 * census-player-pseudo-number.cjs) is what says which of them were the
 * genuine article and which were this defect.
 */
const UNPARSED_SENTINELS: ReadonlySet<string> = new Set(["null", "undefined"]);

/** True when the source SAID the card has no number (`nno`, `unnumbered`, ...).
 *  An empty/absent cardNumber is NOT this -- see isUnparsedCardNumber. */
export function isUnnumberedCardNumber(raw: string | null | undefined): boolean {
  const s = slugify(String(raw ?? ""));
  if (!s) return false;                      // absence is not an answer
  return UNNUMBERED_CARD_NUMBER.has(s);
}

/** True when nothing readable was supplied: blank, whitespace, or a stringified
 *  null/undefined a vendor feed wrote literally. The identity is UNDERIVABLE. */
export function isUnparsedCardNumber(raw: string | null | undefined): boolean {
  const s = slugify(String(raw ?? ""));
  return !s || UNPARSED_SENTINELS.has(s);
}

/** The cardNumber segment for an unnumbered card, or null when there is no
 *  player to identify it by — in which case the card has no identity at all
 *  and slugGuard must refuse it. */
export function unnumberedCardSegment(playerName: string | null | undefined): string | null {
  const p = slugify(String(playerName ?? ""));
  return p ? `player-${p}` : null;
}

/** Turn an arbitrary label into a URL-safe slug fragment.
 *  - lowercase
 *  - strip characters other than a-z0-9 and space/hyphen
 *  - spaces → hyphens
 *  - collapse repeated hyphens
 *  - trim leading/trailing hyphens
 *
 *  Deterministic — same input always produces the same output. */
export function slugify(raw: string): string {
  return String(raw ?? "")
    .toLowerCase()
    .normalize("NFKD")             // handle unicode variants (é → e, etc.)
    .replace(/[^\w\s-]/g, "")      // strip punctuation (excl underscore/hyphen)
    .replace(/_/g, "-")            // underscore → hyphen (uniform)
    .replace(/\s+/g, "-")          // spaces → hyphens
    .replace(/-+/g, "-")           // collapse repeats
    .replace(/^-|-$/g, "");        // trim
}

/** Normalize sport to the canonical lowercase form. */
function normalizeSport(sport: string): string {
  const s = slugify(sport);
  // Aliases → canonical (defensive; upstream should already normalize)
  if (s === "nfl") return "football";
  if (s === "nba") return "basketball";
  if (s === "mlb") return "baseball";
  if (s === "nhl") return "hockey";
  return s;
}

// The controlled vocabulary.
//
// Two tiers (CF-CROSS-PRODUCT-MIS-SLUG-FIX, Drew, 2026-07-30):
//   1. STRICT — matches fully-qualified product names ("panini-select",
//      "topps-chrome"). Every Panini title includes "prizm" as parallel
//      language ("Blue Prizm", "Gold Prizm") even when the product is
//      Select/Playoff/Mosaic; matching bare "prizm" first stole every
//      cross-product row for panini-prizm. Strict tier prevents that.
//   2. BARE — fallback aliases for titles that omit the brand prefix
//      ("2024 Prizm Silver ..."). Only consulted when strict tier
//      returns nothing.
//
// Order matters WITHIN each tier: more-specific patterns first so
// "bowman-draft" doesn't collapse to "bowman".
function knownSetKeyPatterns(): Array<[RegExp, string]> {
  return [
    // Sapphire is a distinct product LINE, not a parallel. Must match
    // BEFORE the base bowman-chrome / topps-chrome patterns.
    // CF-CATALOG-SAPPHIRE-ORDER (Drew, 2026-08-04, per baseballcardpedia).
    // Both "Chrome Sapphire" and "Sapphire Chrome" appear in vendor
    // titles for the same product. Also "Bowman Draft Sapphire Chrome".
    // CF-SAPPHIRE-DROPPED-AT-INGEST (Drew, 2026-08-23). This was manufacturing
    // the very misfiling the refile sweeps have been cleaning up.
    //
    // "Bowman Draft Sapphire" — no "chrome" in the name — matched NEITHER of
    //    these, fell through to the plain /bowman-draft/ rule far below, and
    //    normalised to "bowman-draft". The word sapphire was silently dropped,
    //    so every such sale was filed into the base Draft set at ingest. That
    //    is 6,417 of the sapphire sales the refile sweep is now moving back;
    //    without this line the sweep would clean them up and the ingest would
    //    recreate them tomorrow.
    //
    [/bowman-draft-(?:chrome-sapphire|sapphire-chrome|sapphire)/, "bowman-draft-sapphire"],
    // The bare `sapphire` alternative stays. I removed it as a suspected
    // Bowman/Bowman-Chrome merge and it broke an existing test that states the
    // reasoning outright: vendors write "Bowman Sapphire" as shorthand for
    // Bowman Chrome Sapphire, so the collapse is intended, not a bug. There is
    // no standalone Bowman Sapphire product. The 6,227 bowman-sapphire catalog
    // rows therefore came from some path that does not run through here, which
    // is a catalog question and not a normaliser one.
    [/bowman-(?:chrome-sapphire|sapphire-chrome|sapphire)/, "bowman-chrome-sapphire"],
    [/topps-(?:chrome-sapphire|sapphire-chrome)/, "topps-chrome-sapphire"],
    // Topps Chrome Update Sapphire — subset ordering variants.
    [/topps-(?:chrome-update-sapphire|update-sapphire-chrome|sapphire-chrome-update)/, "topps-chrome-update-sapphire"],
    // CF-CHROME-SUBSET-COLLAPSE (Drew, 2026-07-31). Bowman Chrome Draft
    // and Bowman Chrome are ONE market — buyers don't distinguish the
    // subset. Collapse both orderings ("Bowman Chrome Draft" or "Bowman
    // Draft Chrome") to canonical `bowman-chrome`. Sapphire is preserved
    // above as its own product line. Paper Bowman Draft (BDA-XX autos)
    // still lands at `bowman-draft` via the paper rule below — the paper
    // vs chrome distinction is preserved by the cardNumber-prefix
    // override in computeHobbyIqCardId.
    // CF-BOWMAN-MEGA-BOX-DISTINCT (Drew, 2026-08-12). SUPERSEDES
    // CF-BOWMAN-MEGA-BOX-IS-CHROME (Drew, 2026-08-01), which collapsed Mega
    // Box into bowman-chrome as "same insert set, retail-exclusive channel".
    //
    // That held only while Mega Box was the ONLY source of 2026 Bowman Chrome
    // cards. Standalone 2026 Bowman Chrome released 2026-08-12 with its own
    // 100-card base checklist, and the two numbering schemes collide head-on:
    //
    //     Mega Box      #52 = Shohei Ohtani      #9 = Munetaka Murakami
    //     Bowman Chrome #52 = JJ Wetherholt RC   #9 = Cody Bellinger
    //
    // The collapse put 695 Mega Box comps onto Bowman Chrome base cards, so
    // Ohtani's sales were valuing Wetherholt's rookie. Drew: "Mega box is
    // different from 2026 bowman and 2026 bowman is a different product".
    //
    // Ordering is load-bearing: this MUST precede /bowman-chrome/ below, or
    // "Bowman Chrome Mega Box" — the canonical name parseTitleIdentity returns
    // — is swallowed as plain bowman-chrome. The regex stays Bowman-scoped so
    // it cannot capture Topps Holiday Mega Box.
    //
    // NOTE: this re-pools prior years too. 2024/2025 Mega Box comps previously
    // scored as bowman-chrome now route to their own product. That is the
    // intended correction — distinct checklists, distinct prices — but it does
    // move existing comps out of the Bowman Chrome pool for those years.
    [/bowman-(?:chrome-)?mega(?:-box)?/, "bowman-chrome-mega-box"],
    // CF-BOWMAN-NSCC-DISTINCT (Drew, 2026-08-31: "isn't it under bowman chrome
    // set?" — asked of BNR-VGJ, then "ok, do it"). The National Sports
    // Collectors Convention wrapper-redemption promo says "Bowman Chrome" on
    // the card, so the question is fair. It is still its own product, by the
    // same test the Mega Box rule above applies:
    //
    //   Numbering does NOT collide — every card is BNR- prefixed, while
    //   Bowman Chrome base is 1..N and BCP1..BCP250. So unlike Mega Box this
    //   collapse corrupts no individual card.
    //
    //   Prices do. 2018 #BNR-AJ, an Aaron Judge signed National card /3, sold
    //   at $500 BGS 9 — BELOW his ordinary #100 Gold /50 at $725-$900 PSA 10.
    //   Convention-exclusive redemption scarcity does not price like flagship
    //   parallel scarcity, and FMV projects the next sale from a pool's trend.
    //
    // The catalog already settled this: 780 rows across 2017-2023 are keyed
    // bowman-chrome-nscc from baseballcardpedia, INCLUDING
    // hiq:baseball:2018:bowman-chrome-nscc:bnr-vgj:base:no-auto. They hold
    // zero comps, because without this rule ingest normalises the key to
    // bowman-chrome and the two sides can never meet. This connects stranded
    // rows to their sales rather than minting a new product.
    //
    // Ordering is load-bearing for the same reason Mega Box is: this MUST
    // precede /bowman-chrome/ below or the phrase is swallowed as plain
    // bowman-chrome. Bowman-scoped so it cannot capture a Topps National
    // promo, and "national" alone is never enough to match — Panini National
    // Treasures owns that word further down.
    //
    // CF-NSCC-BOWMAN-SCOPE-IS-EXPLICIT (Drew 2026-09-04). The Bowman scope
    // above was REAL but INCIDENTAL: the pattern was unanchored, so "bowman"
    // only had to appear SOMEWHERE in the key. #1699 found the case that
    // exposes it — `topps-nscc-bowman-national-convention` matched on the
    // trailing `bowman-national-convention` substring, and the reconciliation
    // could not tell whether that was the rule working or the very leak this
    // comment warns about. Drew ruled it the 2021 BOWMAN National release
    // (the "topps" is the parent company, not a second maker), so the rule was
    // working — but a scope you cannot read off the pattern is a scope that
    // will be re-litigated the next time a key carries both makers.
    //
    // The `(?:^|-)` prefix makes it explicit: "bowman" must start the key or
    // start a segment of it. Every real spelling still matches (`bowman-nscc`,
    // `bowman-chrome-nscc`, `2021-bowman-national-convention`, and the ruled
    // `topps-nscc-bowman-national-convention`, which folds by DECLARATION in
    // setKeyReconciliation.ts before this pattern is ever consulted). What it
    // now refuses is a mid-word accident — `superbowman-nscc` — which is the
    // same prefix-match-is-not-an-identity defect that put `scoremasters` in
    // the `score` pool.
    [/(?:^|-)bowman-(?:chrome-)?(?:nscc|national-sports-collectors-convention|national-convention|national-wrapper-redemption|national-promo)/, "bowman-chrome-nscc"],
    // CF-MATCH-THE-CATALOG (Drew, 2026-08-16: "it shuld fold into Draft since
    // it is draft" ... "they should match to the CATALOG"). This mapped Bowman Draft Chrome onto plain bowman-chrome,
    // which pools a Draft card with the standalone Bowman Chrome product —
    // different checklists, different players, different prices. Draft Chrome
    // is the chrome half OF Bowman Draft, so it keeps the draft identity in
    // its own key: the PRODUCT the checklist names (Drew, 2026-08-16: "we
    // match the PRODUCT from bowman in the checklist!!").
    //
    // Counted by SOURCE on 2026-08-16, which is the count that matters —
    // total rows flatter a key that only vendors use:
    //
    //     bowman-draft          336,463 rows, 277,616 CHECKLIST-backed
    //     bowman-draft-chrome    23,899 rows,       0 CHECKLIST-backed
    //                                              (23,892 cardhedge-graded,
    //                                               an EXCLUDED source)
    //
    // So bowman-draft-chrome is a vendor artifact, not a product. Draft chrome
    // cards belong to bowman-draft, where the checklist actually is.
    //
    // CF-DPP-IS-ITS-OWN-PRODUCT (Drew, 2026-08-23: "the name should be the set
    // name" ... "the actual full name of the card is correct and what bowman
    // says the name of the set is" ... "in most cases ebay is giving us the
    // correct name").
    //
    // THESE MUST PRECEDE THE DRAFT-CHROME RULE BELOW, and that ordering is the
    // whole fix. The rule below is UNANCHORED, so "Bowman Chrome Draft Picks &
    // Prospects" slugified to bowman-chrome-draft-picks-and-prospects matched on
    // its bowman-chrome-draft PREFIX and was truncated to "bowman-draft" —
    // a rule written for a different product swallowing this one's name. The
    // paper version had no rule at all and fell through to the bare
    // /bowman-draft/ further down, losing "picks and prospects" the same way.
    //
    // MEASURED 2026-08-23. Draft Picks & Prospects is not a vendor artifact —
    // it is a published product whose checklist we already hold, and the catalog
    // already separates the two stocks cleanly:
    //
    //     bowman-draft-picks-and-prospects         155,555 cards, all setName
    //                                              "Bowman Draft Picks And Prospects"
    //     bowman-chrome-draft-picks-and-prospects      110 cards, all setName
    //                                              "Bowman Chrome Draft Picks And Prospects"
    //
    // while 8,682 sales whose own eBay setName NAMES the product sat under
    // bowman-draft (7,169 paper + 1,246 chrome) and bowman-chrome (267). The
    // incoming data was right and the translator discarded it.
    //
    // THIS DOES NOT REVERSE CF-MATCH-THE-CATALOG. That ruling concerns "Bowman
    // Draft Chrome", which still folds to bowman-draft on the rule below. DPP
    // is a different product, and the catalog holds it under its own keys.
    //
    // The "&" is handled either way: whether slugify renders it "and" or drops
    // it, both -picks-and-prospects and -picks-prospects match. That also folds
    // the ampersand-dropped setKeys the catalog already carries
    // (bowman-draft-picks-prospects, bowman-chrome-draft-picks-prospects) onto
    // the canonical spelling. Trailing "-prospects" is optional so the truncated
    // "Bowman Draft Picks" spelling lands on the product rather than fragmenting.
    [/bowman-chrome-draft-picks(?:-and)?(?:-prospects)?/, "bowman-chrome-draft-picks-and-prospects"],
    [/bowman-draft-picks(?:-and)?(?:-prospects)?/, "bowman-draft-picks-and-prospects"],
    [/bowman-(?:chrome-draft|draft-chrome)/, "bowman-draft"],
    [/bowman-chrome/, "bowman-chrome"],
    // CF-CHROME-PROSPECTS-IS-BOWMAN-CHROME (Drew, 2026-07-29). CH tags
    // the BCP-XX subset as setName="Chrome Prospects" (their own naming
    // for the top-prospects insert within Bowman Chrome). Same for
    // "Chrome Prospects Autographs" (CPA-XX). Both are Bowman Chrome
    // — subsets, not distinct product lines — and their FMV pool
    // must unify with the parent bowman-chrome slug. Without this
    // rule, normalizeSetKey falls through to slugify → "chrome-prospects"
    // fragmenting the pool. Must come AFTER the bowman-chrome rule so
    // "Bowman Chrome Prospects" full spellings still match cleanly first.
    // Match all variants: chrome-prospect, chrome-prospects,
    // chrome-prospect-autographs, chrome-prospects-autographs.
    [/chrome-prospects?(?:-autographs?)?/, "bowman-chrome"],
    // CF-BOWMAN-PAPER-SETKEY (Drew, 2026-07-29). BPA-XX / BDA-XX
    // cardNumbers indicate the paper-stock autograph subset. These get
    // their own setKeys so paper-auto FMV pools don't blend with paper
    // base or chrome variants. "Bowman Draft Paper" MUST match before
    // "Bowman Draft" to preserve stock specificity.
    [/bowman-draft-paper/, "bowman-draft-paper"],
    // CF-1ST-EDITION-IS-ANOTHER-SET (D22, Drew 2026-08-30: "bobby witt came
    // out of bowman draft … first edition is another bowman set"). Before
    // this line "2020 Bowman Draft 1st Edition" fell through to the plain
    // bowman-draft rule and every 1st Edition sale pooled under the plain
    // Draft card (holding 3fe98abe's only pool row). Must precede it.
    [/bowman-draft-(?:1st|first)-edition/, "bowman-draft-1st-edition"],
    [/bowman-draft/, "bowman-draft"],
    [/bowman-paper/, "bowman-paper"],
    [/bowman-sterling/, "bowman-sterling"],
    // CF-BOWMAN-HERITAGE-DISTINCT (Drew, 2026-08-08). Bowman Heritage is
    // its own product line (different design, different release, own
    // print run). Without this, "Bowman Heritage" fell through to the
    // bare /bowman/ collapse below and 2005 Bowman Heritage cards
    // clobbered 2005 Bowman entries on upsert during the checklist
    // batch fill. Symmetric to /topps-heritage/ below.
    [/bowman-heritage/, "bowman-heritage"],
    // CF-BOWMAN-MEGA-BOX-DISTINCT (Drew, 2026-08-12). SUPERSEDES
    // CF-BOWMAN-MEGA-BOX-IS-CHROME (Drew, 2026-08-01), which collapsed Mega
    // Box into bowman-chrome as "same insert set, retail-exclusive channel".
    //
    // That held only while Mega Box was the ONLY source of 2026 Bowman Chrome
    // cards. Standalone 2026 Bowman Chrome released 2026-08-12 with its own
    // 100-card base checklist, and the two numbering schemes collide head-on:
    //
    //     Mega Box     #52 = Shohei Ohtani      #9 = Munetaka Murakami
    //     Bowman Chrome #52 = JJ Wetherholt RC  #9 = Cody Bellinger
    //
    // Collapsing them made 695 Mega Box comps price Bowman Chrome base cards
    // — Ohtani's sales valuing Wetherholt's rookie. Drew: "Mega box is
    // different from 2026 bowman and 2026 bowman is a different product".
    //
    // Routes to bowman-chrome-mega-box, the canonical name parseTitleIdentity
    // already returns for "Bowman Mega Box" and the key the 2024/2025 catalog
    // rows already carry. Still matches BEFORE the generic /^bowman/ or Mega
    // Box sales would land in the paper Bowman flagship pool.
    //
    // CF-BOWMANS-BEST-DISTINCT (Drew, 2026-08-17). Bowman's Best is a premium
    // product line with its own checklist, not a Bowman variant, and there was
    // no rule for it — so it fell to the generic /bowman/ below.
    //
    // Measured 2026-08-17: 130,273 sold_comps rows whose own setName says
    // Bowman's Best ("2024 Bowman's Best Baseball", "Bowman's Best") sit on the
    // bare `bowman` key, while card_catalog already carries 80,193 rows under
    // `bowmans-best`. So the sales and the checklist were filed under different
    // keys for the same product — the pool could never meet its own catalog.
    //
    // The market prices these very differently: a Bowman's Best refractor auto
    // is not a base Bowman common, and pooling them drags both estimates.
    //
    // slugify already folds the apostrophe ("Bowman's Best" -> bowmans-best), so
    // one pattern covers both spellings. University FIRST — bowman-best-university
    // is a separate product with 158 catalog rows of its own, and the general
    // rule would otherwise swallow it.
    // CF-COLLAPSED-SETKEY-AUDIT: Bowman Platinum is its own product with
    // 111,878 catalog rows; 12,748 sales sat on bare bowman.
    [/bowman-platinum/, "bowman-platinum"],
    [/bowmans?-best-university/, "bowman-best-university"],
    [/bowmans?-best/, "bowmans-best"],
    [/bowman-(?:1st|first)-edition/, "bowman-1st-edition"],
    [/^bowman/, "bowman"],
    [/bowman/, "bowman"],
    // CF-TOPPS-CHROME-PLATINUM-DISTINCT (Drew, 2026-08-01). Topps Chrome
    // Platinum is its OWN product line (different insert, different
    // release, different price range). Must match BEFORE the generic
    // /topps-chrome/ regex or it gets swallowed. Regression: 2026-08-01
    // discovered that Platinum sales were being collapsed into the
    // regular Topps Chrome pool.
    [/topps-chrome-platinum/, "topps-chrome-platinum"],
    [/topps-chrome-black/, "topps-chrome-black"],
    // CF-PRODUCT-FAMILY-COLLAPSE-IS-FORBIDDEN (Drew, 2026-09-03). This rule
    // used to read `[/topps-chrome-update/, "topps-chrome"]` under
    // CF-CHROME-SUBSET-COLLAPSE (Drew, 2026-07-31: "one market with Topps
    // Chrome"). That ruling is REVERSED. The Great Rematch census measured the
    // cost across all 32 shards: `topps-chrome-update-series -> topps-chrome`
    // is the single largest setKey CONFLICT in the pool at ~287,655 rows —
    // more than Platinum (~229,345) and more than Allen & Ginter (~214,366).
    //
    // A collapse is not a cheaper pool, it is a WRONG one. Update Series is a
    // separate release with its own checklist (192,014 checklist-backed
    // catalog rows under `topps-chrome-update-series`, against 199,838 total),
    // its own US-prefixed card numbers, and its own price curve. Pooling it
    // into flagship Chrome splits neither pool — it MERGES two different
    // cards onto one slug, which is the exact defect the rematch exists to
    // end, arriving from the direction the derivation itself created.
    //
    // Ordered before the generic /topps-chrome/ rule, symmetric with Platinum
    // and Black above. `productSetKeyForName` already answered this correctly
    // (the D23 product table names the product); this line is what made
    // `matchKnownProductLine` — which does NOT consult the table — disagree
    // with `normalizeSetKey` on the same title.
    [/topps-chrome-update-series|topps-chrome-update/, "topps-chrome-update-series"],
    [/topps-chrome/, "topps-chrome"],
    [/topps-heritage/, "topps-heritage"],
    // CF-TOPPS-GOLD-LABEL-DISTINCT (Drew, 2026-08-13). Topps Gold Label is its
    // own premium line — Class 1/2/3, its own design, its own price tier — but
    // it fell through to the generic /topps/ rule below and normalized to
    // "topps", pooling it with flagship. Two consequences, both seen in prod:
    //
    //   - Matching: a 2017 Gold Label #86 "Blue" passed the same-set check
    //     against flagship Topps and matched
    //     topps:86:father-s-day-powder-blue, because both sides read "topps".
    //   - Pricing: Gold Label comps pool with flagship comps for the same
    //     card number, which are different cards at different prices.
    //
    // Must precede the generic /topps/ rule. Symmetric with
    // topps-chrome-platinum and topps-heritage above.
    [/topps-gold-label/, "topps-gold-label"],
    [/topps-finest/, "topps-finest"],
    [/topps-pristine/, "topps-pristine"],
    // CF-CATALOG-TRADED-TIFFANY (Drew, 2026-08-04, per baseball-almanac
    // set list). Topps Traded ran annually 1974-2005 (rookies + midseason
    // trades). Topps Tiffany (1984-1991) was the glossy premium print
    // variant. Traded Tiffany combines both. Without these patterns,
    // "Topps Traded" fell through to bare `topps`, collapsing Fred McGriff
    // XRC and every Traded rookie into the flagship pool. Must match
    // BEFORE bare `/topps/` catchall. Order: 3-word variants first.
    [/topps-traded-tiffany/, "topps-traded-tiffany"],
    [/topps-traded/, "topps-traded"],
    [/topps-tiffany/, "topps-tiffany"],
    // CF-CATALOG-UPDATE-TOTAL (Drew, 2026-08-04). Topps Update = successor
    // to Traded (2006+). Topps Total ran 2002-2005 (990-card jumbo set).
    [/topps-update-sapphire/, "topps-update-sapphire"],
    [/topps-update/, "topps-update"],
    [/topps-total/, "topps-total"],
    [/topps-pro-debut/, "topps-pro-debut"],
    [/o-pee-chee/, "o-pee-chee"],
    // CF-TOPPS-PRODUCT-LINES (Drew, 2026-07-29). Full Topps taxonomy.
    [/topps-transcendent/, "topps-transcendent"],
    [/topps-dynasty/, "topps-dynasty"],
    [/topps-tribute/, "topps-tribute"],
    [/topps-inception/, "topps-inception"],
    [/topps-definitive/, "topps-definitive"],
    [/topps-five-star/, "topps-five-star"],
    [/topps-museum-collection/, "topps-museum-collection"],
    [/topps-gypsy-queen/, "topps-gypsy-queen"],
    [/topps-archives/, "topps-archives"],
    [/topps-big-league/, "topps-big-league"],
    [/topps-bunt/, "topps-bunt"],
    [/allen-(and-)?ginter/, "topps-allen-ginter"],
    [/stadium-club/, "topps-stadium-club"],
    // CF-COLLAPSED-SETKEY-AUDIT batch 1 (Drew, 2026-08-17). Distinct Topps
    // product lines that fell to the bare-topps catch-all below. Each already
    // has its OWN key in card_catalog, so the sales and the checklist for one
    // product were filed apart and the pool could never meet its catalog:
    //
    //     Topps Cosmic Chrome   65,366 sales   34,184 catalog rows
    //     Topps Now             23,247 sales   14,226 catalog rows
    //
    // Keys match the catalog rather than being invented here.
    [/topps-cosmic-chrome|cosmic-chrome/, "topps-cosmic-chrome"],
    [/topps-now/, "topps-now"],
    // CF-COLLAPSED-SETKEY-AUDIT batch 2 (Drew, 2026-08-17). More distinct Topps
    // lines that fell to the bare-topps catch-all, each with its own catalog key:
    //
    //     Topps Signature Class   21,840 sales    1,329 catalog rows
    //     Topps Resurgence        17,471 sales      129 catalog rows
    //     Topps Composite         12,776 sales      330 catalog rows
    //
    // Deliberately requires the topps- prefix. Bare "resurgence" and "composite"
    // also name INSERTS inside those products (resurgence-signatures,
    // composite-patch-autographs) which hold their own catalog keys, so an
    // unanchored match would collapse those in the opposite direction.
    [/topps-signature-class/, "topps-signature-class"],
    [/topps-resurgence/, "topps-resurgence"],
    [/topps-composite/, "topps-composite"],
    // Topps Cracker Jack is a MODERN Topps product, distinct from the 1915
    // vintage Cracker Jack line. Must precede bare topps or it is swallowed.
    [/topps-cracker-jack/, "topps-cracker-jack"],
    [/topps/, "topps"],
    // Panini — STRICT tier (fully-qualified "panini-X"). See two-tier
    // comment on knownSetKeyPatterns. National Treasures is included
    // here as a bare match because the name is uniquely Panini.
    // CF-COLLAPSED-SETKEY-AUDIT: Prizm Draft Picks is its own product with its
    // own checklist (36,108 catalog rows) — 65,582 sales sat on panini-prizm.
    // MUST precede the base prizm rule or the qualifier is swallowed.
    // CF-COLLAPSED-SETKEY-AUDIT batch 2: Prizm WNBA is a different league with
    // its own checklist — 51,933 sales sat on panini-prizm. Monopoly WNBA is a
    // FURTHER distinct product (its own catalog key), so it matches first or it
    // is swallowed here.
    [/prizm-monopoly-wnba|monopoly-wnba/, "panini-prizm-monopoly-wnba"],
    [/prizm-wnba/, "panini-prizm-wnba"],
    [/prizm-(perennial-)?draft-picks/, "panini-prizm-draft-picks"],
    [/panini-prizm/, "panini-prizm"],
    // CF-COLLAPSED-SETKEY-AUDIT: Elite is its own line (236,976 catalog rows),
    // and Elite Extra Edition is a further distinct product (394,549) — so the
    // Extra Edition pattern MUST come first or it is swallowed by plain Elite.
    [/donruss-elite(?!-extra)|(?:^|-)elite(?!-extra)(?:-|$)/, "donruss-elite"],
    [/panini-select/, "panini-select"],
    [/panini-mosaic/, "panini-mosaic"],
    // CF-OPTIC-WITHOUT-PANINI (Drew, 2026-08-17). This required the `panini-`
    // prefix, so "Panini Donruss Optic" resolved correctly while bare "Donruss
    // Optic" — how the product is almost always written — fell past it to the
    // generic donruss rule and landed on panini-donruss.
    //
    // Measured 2026-08-17: 196,345 sold_comps rows whose own setName says
    // Donruss Optic sat on panini-donruss. Optic is chrome stock with its own
    // checklist and its own prices; pooling it with paper Donruss moves both.
    // Largest single collapse in the CF-COLLAPSED-SETKEY-AUDIT worklist.
    // D31, Drew 2026-08-31: the product is donruss-optic -- ONE product, the
    // key the checklists name. panini-optic was the minted spelling and the
    // checklists never used it: 142,352 un-graded catalog rows and 344,978
    // pool rows carry a :panini-optic: id stem against ZERO pool rows on
    // :donruss-optic:, while the checklist rows all sit on donruss-optic
    // (FB2023 16,055 / FB2024 15,988 / FB2025 19,466 / BB2024 30,998).
    // Both spellings mint the one key from here; rename-setkey-to-product
    // moves the stored rows to it.
    [/(?:panini-)?donruss-optic/, "donruss-optic"],
    [/panini-donruss/, "panini-donruss"],
    [/panini-optic/, "donruss-optic"],
    [/panini-contenders/, "panini-contenders"],
    [/panini-immaculate/, "panini-immaculate"],
    [/panini-flawless/, "panini-flawless"],
    [/national-treasures/, "panini-national-treasures"],
    [/panini-absolute/, "panini-absolute"],
    // CF-CHRONICLES-VARIANT (Drew, 2026-07-30). CH has "Panini Chronicled"
    // (participle form) for some 2025 basketball products (Caitlin Clark).
    // Same product family as Chronicles — pool together.
    [/panini-chronicled|panini-chronicles/, "panini-chronicles"],
    [/panini-phoenix/, "panini-phoenix"],
    [/panini-illusions/, "panini-illusions"],
    [/panini-obsidian/, "panini-obsidian"],
    [/panini-spectra/, "panini-spectra"],
    [/panini-revolution/, "panini-revolution"],
    [/panini-crown-royale/, "panini-crown-royale"],
    [/panini-one-one/, "panini-one-one"],
    [/panini-playoff/, "panini-playoff"],
    [/panini-score/, "panini-score"],
    [/panini-classics/, "panini-classics"],
    [/panini-legacy/, "panini-legacy"],
    [/panini-threads/, "panini-threads"],
    [/panini-rookies-and-stars/, "panini-rookies-and-stars"],
    [/panini-zenith/, "panini-zenith"],
    [/panini-court-kings/, "panini-court-kings"],
    [/panini-origins/, "panini-origins"],
    [/panini-encased/, "panini-encased"],
    [/panini-eminence/, "panini-eminence"],
    // CF-PANINI-PRODUCTS-MISSING-FROM-VOCAB (Drew, 2026-08-16: "fix it all").
    //
    // These products had no rule at all, so normalizeSetKey fell through to
    // slugify and returned a YEAR-PREFIXED ONE-OFF — the same failure the
    // Pokemon alias table was built to stop:
    //
    //     "2025 Panini Rookies & Stars Football" -> 2025-panini-rookies-stars-football
    //     "2025 Panini Certified Football"       -> 2025-panini-certified-football
    //
    // Two harms at once. The year is duplicated into a segment the slug already
    // carries, and every spelling becomes its own product, so one product
    // fragments across as many keys as sellers have phrasings. 48,819 comps
    // were sitting on keys like these, 10,107 of them 2025 football alone.
    //
    // ROOKIES & STARS IS THE INSTRUCTIVE ONE. A rule for it already existed —
    // /panini-rookies-and-stars/ — and never fired, because slugify drops "&"
    // and produces "rookies-stars", not "rookies-and-stars". The vocabulary was
    // written against the product's NAME rather than against what slugify
    // actually emits for it. Both spellings are matched now.
    [/panini-rookies-(?:and-)?stars/, "panini-rookies-and-stars"],
    // Totally Certified is a separate product and MUST match first, or the
    // certified rule below swallows it.
    [/panini-totally-certified|totally-certified/, "panini-totally-certified"],
    [/panini-certified/, "panini-certified"],
    [/panini-crusade/, "panini-crusade"],
    // NBA HOOPS is spelled by its CHECKLIST, not by the maker prefix
    // (Drew 2026-09-05). `nba-hoops` holds 26,355 checklistinsider rows and
    // `panini-hoops` ZERO strict rows, so the ruled key is the bare one and
    // RULED_ALIASES folds the prefixed spelling onto it. This rule emits the
    // ruled key DIRECTLY: a title carrying the maker ("2024 Panini NBA Hoops")
    // and one that omits it ("2024 NBA Hoops") must reach the same pool, and
    // before this they did not — the vocabulary answered `panini-hoops` and
    // returned before the reconciliation was ever consulted.
    [/panini-hoops/, "nba-hoops"],
    [/panini-prestige/, "panini-prestige"],
    [/panini-elite-extra-edition/, "panini-elite-extra-edition"],
    // CF-PRODUCT-LINES-V3-EXPANSION (Drew, 2026-07-30). New product-line
    // vocab from parallel-vocabulary.json productLines section. Fixes
    // the ~5-6K rows the setKey audit found with raw-slugified titles
    // (Flair, Goudey, SP/SP Prospects, Pinnacle Aficionado).
    // Order matters — more specific before less specific.
    [/pinnacle-aficionado/, "pinnacle-aficionado"],
    [/pinnacle/, "pinnacle"],
    [/goudey/, "goudey"],
    // Flair Showcase pools into flair DELIBERATELY (pinned by
    // hobbyIqCardId.test.ts "both variants pool"). The collapsed-setkey audit
    // flags it because it compares words, not intent — see that script's header.
    [/flair-showcase|flair/, "flair"],
    [/sp-prospects/, "sp-prospects"],
    [/sp-authentic/, "sp-authentic"],
    // NOTE: bare "sp" is NOT in strict tier — "SP" collides with the
    // short-print abbreviation. Only qualified sp-prospects / sp-authentic
    // land here. Bare "SP" resolves via the routingRule downstream.
    // CF-UD-INSERT-LINES (Drew, 2026-08-10, via 4 missing Griffey holdings
    // + baseballcardpedia checklists). Late-90s Upper Deck insert products
    // are distinct product lines with their own comp pools — pooling them
    // with plain "upper-deck" fragments pricing (a 1999 UD Black Diamond
    // Double #76 Griffey is a wholly different card from a 1999 UD main-set
    // #76). Order matters — these must match BEFORE the bare /upper-deck/
    // catchall below.
    //
    // CF-BLACK-DIAMOND-ROOKIE-EDITION-DISTINCT (Drew 2026-09-04). Black
    // Diamond Rookie Edition is its OWN PRODUCT and must never fold into the
    // base line — a rookie-only checklist fused into a full veteran one drags
    // a rookie card's FMV toward veteran comps and back. It matched here on
    // its own prefix, so it is excluded by an explicit negative lookahead and
    // given the rule ABOVE, where it must stay: a longer product name always
    // precedes the family pattern it contains, exactly as Mega Box and NSCC
    // precede /bowman-chrome/. setKeyReconciliation.ts also declares it a
    // fixed point, which returns before this vocabulary runs at all; this
    // anchor is what holds if that table is ever absent (its loader degrades
    // to an EMPTY doc by design, so "absent" is a state that really occurs).
    [/(?:^|-)(?:upper-deck-)?black-diamond-rookie-edition/, "black-diamond-rookie-edition"],
    [/(?:^|-)(?:upper-deck-)?black-diamond(?!-rookie-edition)/, "upper-deck-black-diamond"],
    [/upper-deck-retro/, "upper-deck-retro"],
    [/(?:^|-)spx-finite/, "spx-finite"],
    [/(?:^|-)spx/, "spx"],
    [/upper-deck-choice/, "upper-deck-choice"],
    // CF-COLLAPSED-SETKEY-AUDIT: distinct Upper Deck lines that fell to the
    // bare catch-all. Collector's Choice carries 184,716 catalog rows under a
    // BARE key (not upper-deck-prefixed), so the rule matches the catalog.
    [/collector-?s?-choice/, "collectors-choice"],
    [/upper-deck-mvp|(?:^|-)ud-mvp/, "upper-deck-mvp"],
    // CF-EXQUISITE-IS-ITS-OWN-PRODUCT (Drew 2026-09-04). Upper Deck Exquisite
    // Collection is a distinct product with its own pool and must NEVER fold
    // into `upper-deck`. The stakes are the highest of any collapse in this
    // file: Exquisite is the 2003-04 rookie-patch-auto product (LeBron, Wade,
    // Carmelo, Kobe), and pooling a four-figure RPA with UD base-set comps
    // prices both wrong in both directions.
    //
    // It had THREE fates before this rule, measured read-only on 2026-09-04
    // over the 3,670 Exquisite-product pool rows:
    //   "2003 Upper Deck Exquisite ..." -> `upper-deck`   (270 rows) — the
    //      bare catch-all below swallowed it on the maker word;
    //   "2003-04 UD Exquisite ..."      -> `bowman` (707) / `unknown` (2,669)
    //      — no rule named Exquisite at all, so the key came from elsewhere.
    //      NONE of those 707 titles contains the word "Bowman".
    //   "2006 Exquisite Basketball"     -> `exquisite-collection` — the only
    //      form that landed on a key of its own.
    // One product, four pools, and the largest share on `unknown`.
    //
    // Anchored on segment boundaries and placed ABOVE the bare /upper-deck/
    // catch-all, exactly as Black Diamond and MVP are — a longer product name
    // always precedes the family pattern that contains it. The maker word is
    // OPTIONAL because vendors elide it ("2006 Exquisite Basketball") and
    // abbreviate it ("UD Exquisite"); `exquisite` alone is specific enough to
    // be safe, since it is not a word any other product name contains.
    //
    // Deliberately NOT disturbed: the CF-UD-INSERT-LINES rules above still own
    // Black Diamond, SPx, Collector's Choice and MVP, and a plain UD insert
    // line with no Exquisite in its name still folds to `upper-deck` below.
    [/(?:^|-)exquisite(?:-|$)|exquisite-collection/, "upper-deck-exquisite"],
    [/upper-deck/, "upper-deck"],
    // CF-FLEER-STICKERS (Drew, 2026-07-29). Distinct from base Fleer;
    // basketball's iconic debut product line (1986 Michael Jordan
    // Sticker #8) plus other sport/year Fleer sticker inserts.
    [/fleer-stickers?/, "fleer-stickers"],
    // CF-VINTAGE-BRANDS (Drew, 2026-08-05). Vintage 90s-era brand lines
    // that previously slugified with a year prefix ("1997 Skybox Metal
    // Universe" → "1997-skybox-metal-universe") because no pattern
    // caught them. Match on both prefix ("YYYY-brand") and bare brand.
    // Fleer Metal Universe and Skybox Metal Universe are distinct
    // products despite the shared "Metal Universe" name; keep them
    // separate. Studio ran under Donruss from 1991-1998 — collapses
    // to donruss-studio for pool unification.
    [/(?:^|-)fleer-metal-universe/, "fleer-metal-universe"],
    [/(?:^|-)skybox-metal-universe/, "skybox-metal-universe"],
    [/(?:^|-)skybox-thunder/, "skybox-thunder"],
    [/(?:^|-)skybox-premium/, "skybox-premium"],
    [/(?:^|-)skybox-molten-metal/, "skybox-molten-metal"],
    [/(?:^|-)skybox/, "skybox"],
    [/(?:^|-)metal-universe/, "metal-universe"],
    // CF-VINTAGE-PRODUCT-RULES (Drew, 2026-08-17). Vintage and oddball products
    // that had NO rule, so they slugified year-prefixed and slugGuard correctly
    // refused every one. Measured over 6.2h of post-fix ingest: ~17,300 sports
    // rows land unkeyed per day for exactly this reason, and the same handful
    // of products recur every single day — so each rule here pays forever.
    //
    // NOTE ON THE CATALOG. For several of these the catalog's own key is ALSO
    // year-prefixed (1909-11-t206-baseball, 1962-post-cereal-baseball,
    // 1961-golden-press-hall-of-fame-baseball) — the catalog carries the same
    // pollution from the same root cause. These rules resolve to the CLEAN
    // product name, which is the canonical form the catalog rows should also be
    // repaired onto. Where a clean catalog key already exists it is used as-is:
    // kelloggs (482 rows), cracker-jack (168), diamond-kings (38,183).
    //
    // Ordering matters twice over: topps-cracker-jack and panini-diamond-kings
    // are DIFFERENT modern products from the vintage lines, so the qualified
    // patterns lead.
    [/(?:^|-)cracker-jack/, "cracker-jack"],
    [/all-time-diamond-kings/, "all-time-diamond-kings"],
    [/panini-diamond-kings/, "panini-diamond-kings"],
    [/(?:^|-)diamond-kings/, "diamond-kings"],
    [/(?:^|-)t206/, "t206"],
    [/(?:^|-)play-ball/, "play-ball"],
    [/(?:^|-)kellogg-?s?/, "kelloggs"],
    [/(?:^|-)post-cereal/, "post-cereal"],
    [/(?:^|-)golden-press/, "golden-press"],
    [/(?:^|-)goudey/, "goudey"],
    [/(?:^|-)donruss-studio|(?:^|-)studio/, "donruss-studio"],
    [/(?:^|-)circa-thunder/, "circa-thunder"],
    [/(?:^|-)score-select/, "score-select"],
    [/(?:^|-)select-certified/, "score-select"],
    [/(?:^|-)score/, "score"],
    [/(?:^|-)leaf-limited/, "leaf-limited"],
    [/(?:^|-)leaf/, "leaf"],
    // CF-ULTRA-IS-NOT-FLEER (Drew, 2026-08-17). Ultra is its own product line,
    // not a Fleer variant, and it MUST be matched before the bare-fleer
    // catch-all below or "1995-96 Fleer Ultra" lands on `fleer`.
    //
    // It did. Measured 2026-08-17: 55,373 of 352,825 sold_comps rows on a
    // `fleer` setKey (15.7%) carry "Ultra" in their own title or setName, and
    // card_catalog held ZERO rows under any ultra setKey for 1995 basketball —
    // every Ultra card was filed as Fleer.
    //
    // The two are different cards with different rosters at the same numbers.
    // 1995-96 Fleer and 1995-96 Ultra Gold Medallion share the #1-200 range but
    // agree on the player only 41 times in 197 (20.8%), because each orders its
    // own checklist alphabetically by team. So the collapse did not merely blur
    // a brand — it pooled Ultra sales into Fleer comps for cards that are not
    // the same card. #25 is Michael Jordan in Ultra and Will Perdue in Fleer.
    //
    // Anchored on segment boundaries so "ultra" must be a whole segment:
    // "ultraviolet" does NOT match. "ultra-pro" DOES — that is a supplies
    // brand, never a setName, so it is accepted rather than special-cased.
    [/(?:^|-)ultra(?:-|$)/, "ultra"],
    // CF-COLLAPSED-SETKEY-AUDIT batch 2: Fleer Tradition is a large distinct
    // line (158,040 catalog rows, 7,631 sales) and Fleer Update another
    // (2,504 rows, 8,230 sales). Tradition Update and Tradition Glossy hold
    // their own keys, so the longer patterns lead — otherwise plain Tradition
    // swallows both.
    [/fleer-tradition-update/, "fleer-tradition-update"],
    [/fleer-tradition-glossy/, "fleer-tradition-glossy"],
    [/fleer-tradition|(?:^|-)tradition(?:-|$)/, "fleer-tradition"],
    [/fleer-update/, "fleer-update"],
    [/fleer/, "fleer"],
  ];
}

// BARE tier — vendor titles that omit the brand prefix ("2024 Prizm
// Silver ..."). Word-boundary-anchored so "prizm" the parallel word
// doesn't match inside "Blue Prizm". Only consulted when the strict
// tier returns nothing. Ordering within this tier still matters —
// more-specific bare aliases first.
function bareAliasPatterns(): Array<[RegExp, string]> {
  return [
    // CF-CATALOG-FIRST bare-Topps unification (Drew, 2026-08-04). Vendor
    // titles frequently drop the "Topps" brand word — bare "Finest",
    // "Heritage", "Gypsy Queen", "Big League", etc — and without a
    // bare-alias mapping these fall through to slugify() producing dupe
    // setKeys ("finest" AND "topps-finest" for the same card). Dedupe
    // script scheduled to fold existing dupe rows. See catalog-rollout-
    // tracker.md.
    [/(^|-)finest-flashbacks(-|$)/, "topps-finest-flashbacks"],
    [/(^|-)finest(-|$)/, "topps-finest"],
    [/(^|-)heritage(-|$)/, "topps-heritage"],
    [/(^|-)gypsy-queen(-|$)/, "topps-gypsy-queen"],
    [/(^|-)big-league(-|$)/, "topps-big-league"],
    [/(^|-)archives(-|$)/, "topps-archives"],
    [/(^|-)museum-collection(-|$)/, "topps-museum-collection"],
    [/(^|-)tribute(-|$)/, "topps-tribute"],
    [/(^|-)dynasty(-|$)/, "topps-dynasty"],
    [/(^|-)definitive(-|$)/, "topps-definitive"],
    [/(^|-)inception(-|$)/, "topps-inception"],
    [/(^|-)transcendent(-|$)/, "topps-transcendent"],
    [/(^|-)five-star(-|$)/, "topps-five-star"],
    [/(^|-)bunt(-|$)/, "topps-bunt"],
    [/(^|-)pristine(-|$)/, "topps-pristine"],
    // Panini bare aliases.
    [/(^|-)court-kings(-|$)/, "panini-court-kings"],
    [/(^|-)rookies-and-stars(-|$)/, "panini-rookies-and-stars"],
    [/(^|-)crown-royale(-|$)/, "panini-crown-royale"],
    [/(^|-)prizm(-|$)/, "panini-prizm"],
    [/(^|-)mosaic(-|$)/, "panini-mosaic"],
    [/(^|-)donruss(-|$)/, "panini-donruss"],
    [/(^|-)optic(-|$)/, "donruss-optic"],
    [/(^|-)contenders(-|$)/, "panini-contenders"],
    [/(^|-)immaculate(-|$)/, "panini-immaculate"],
    [/(^|-)flawless(-|$)/, "panini-flawless"],
    [/(^|-)absolute(-|$)/, "panini-absolute"],
    [/(^|-)chronicled(-|$)/, "panini-chronicles"],
    [/(^|-)chronicles(-|$)/, "panini-chronicles"],
    [/(^|-)phoenix(-|$)/, "panini-phoenix"],
    [/(^|-)illusions(-|$)/, "panini-illusions"],
    [/(^|-)obsidian(-|$)/, "panini-obsidian"],
    [/(^|-)spectra(-|$)/, "panini-spectra"],
    [/(^|-)revolution(-|$)/, "panini-revolution"],
    [/(^|-)playoff(-|$)/, "panini-playoff"],
    [/(^|-)classics(-|$)/, "panini-classics"],
    [/(^|-)legacy(-|$)/, "panini-legacy"],
    [/(^|-)threads(-|$)/, "panini-threads"],
    [/(^|-)zenith(-|$)/, "panini-zenith"],
    [/(^|-)encased(-|$)/, "panini-encased"],
    [/(^|-)eminence(-|$)/, "panini-eminence"],
    [/(^|-)origins(-|$)/, "panini-origins"],
    // Bare tier for the products added to STRICT above. "certified" is
    // deliberately NOT here: it is grading vocabulary as often as product
    // vocabulary ("PSA certified"), and the bare tier sees text we have not
    // confirmed names a product. "Panini Certified" is unambiguous; "certified"
    // alone is not, and a wrong product key is invisible forever once written
    // — see the only-improve doctrine.
    [/(^|-)rookies-(?:and-)?stars(-|$)/, "panini-rookies-and-stars"],
    [/(^|-)crusade(-|$)/, "panini-crusade"],
    [/(^|-)hoops(-|$)/, "nba-hoops"],
    [/(^|-)prestige(-|$)/, "panini-prestige"],
    [/(^|-)elite-extra-edition(-|$)/, "panini-elite-extra-edition"],
    // NOTE: "select" and "score" are excluded from bare tier — they
    // appear in too many false-positive contexts ("Select Level Blue
    // Prizm" isn't necessarily Panini Select the product; "Score" also
    // appears in random title text). Panini Select and Panini Score
    // rows must include the "Panini" brand word in the title to match
    // via the strict tier.
  ];
}

/** CF-CATALOG-BRAND-HIERARCHY (Drew, 2026-08-04). Roll a setKey up to
 *  its PARENT brand. Topps and Bowman are brands; Topps Chrome, Topps
 *  Heritage, Topps Finest, Bowman Chrome, Bowman Draft are children.
 *  Used to tag catalog docs so callers can filter/aggregate at brand
 *  level without listing every product family.
 *
 *  Returns "topps" | "bowman" | "panini" | "upper-deck" | "fleer" |
 *  "pinnacle" | "goudey" | "flair" | "opc" | "other".
 *
 *  Note: Bowman is manufactured by Topps Inc but marketed as its own
 *  brand — collectors treat them as separate. Keep them separate here.
 *  O-Pee-Chee is the Canadian licensee of Topps (French/English backs)
 *  but has its own collector market — treat as its own brand. */
export function deriveBrand(setKey: string): string {
  if (!setKey) return "other";
  if (setKey === "bowman" || setKey.startsWith("bowman-")) return "bowman";
  if (setKey === "topps" || setKey.startsWith("topps-")) return "topps";
  if (setKey === "o-pee-chee") return "opc";
  if (setKey === "panini" || setKey.startsWith("panini-") || setKey === "national-treasures") return "panini";
  if (setKey === "upper-deck" || setKey.startsWith("upper-deck-") || setKey === "sp-authentic" || setKey === "sp-prospects") return "upper-deck";
  if (setKey === "fleer" || setKey.startsWith("fleer-") || setKey === "flair") return "fleer";
  if (setKey === "pinnacle" || setKey.startsWith("pinnacle-")) return "pinnacle";
  if (setKey === "goudey") return "goudey";
  return "other";
}

/** CF-CATALOG-PARENT-CHAIN (Drew, 2026-08-04). Returns the immediate
 *  parent setKey — the base product this one is a variant or subset of.
 *  Top-level products (topps, bowman) return null.
 *
 *  CF-THE-ID-CARRIES-THE-PRODUCT (D23). The chain is READ FROM THE TABLE
 *  (productSetKeys.ts), never derived from a prefix of the key: the old
 *  fallback `startsWith("topps-") → "topps"` was the family as a string
 *  accident, and a product the table does not name has no parent rather
 *  than a guessed one. A legacy spelling (`topps-update`) answers with its
 *  product's parent. Callers use this for FMV fallback and for
 *  catalogVerify's family step: a Traded Tiffany card with thin comps walks
 *  to Traded, then to flagship Topps. */
export function deriveParentSetKey(setKey: string): string | null {
  return productParentOf(setKey);
}

/** Normalize setKey — accepts either an already-normalized short form
 *  ("bowman-chrome") or a longer product string ("2026 Bowman Chrome
 *  Prospects Baseball") and returns the canonical short form. Falls back
 *  to slugified full name when no known pattern matches (preserves
 *  determinism). Callers that need STRICT matching (return null on
 *  unknown) should use matchKnownProductLine below. */
/* CF-ARBITRATION-HAS-NO-MECHANICAL-ANSWER (2026-08-23). Read this before
 * trying to make the pattern list safer — two obvious fixes were measured and
 * both are wrong.
 *
 * THE DEFECT THIS LIST MANUFACTURES. Measured 2026-08-23: 188 rules, 135
 * destinations, 49 destinations with rival rules, and 187 of the 188 patterns
 * UNANCHORED. First-match-wins over unanchored patterns means any product whose
 * name EXTENDS a shorter product's name can be swallowed by the shorter rule,
 * and which one wins is line order:
 *
 *     bowman-chrome-draft-picks-and-prospects
 *       /bowman-(?:chrome-draft|draft-chrome)/ matched its prefix -> bowman-draft
 *
 * Manufacturers name new products by extending old ones, so this generates a
 * fresh instance roughly once per release.
 *
 * ATTEMPT 1 — rank by how much of the INPUT a pattern matches. Diffed against
 * this function over all 14,918 distinct setNames in the pool: 71 disagreements,
 * 76,089 sales, and it LOST on the big ones. A greedy pattern eats more
 * characters while pointing at a less specific key:
 *     "2024 Panini Prizm WNBA"  panini-prizm-wnba -> panini-prizm   (52,078 sales)
 *
 * ATTEMPT 2 — rank by tokens in the DESTINATION. Much closer: 27 disagreements,
 * 849 sales, and 21 of them are improvements (skybox -> circa-thunder,
 * topps -> post-cereal). But it still loses 6, because token count conflates
 * "more words" with "more specific" and a hyphenated MANUFACTURER outranks a
 * one-word PRODUCT:
 *     "2008 Upper Deck Goudey"  goudey -> upper-deck   (533 sales across years)
 *
 * The lesson is not "find a third metric". These patterns encode products,
 * manufacturers and eras in one flat namespace, so arbitration between them has
 * no correct mechanical answer. resolveSetKeyFromCatalog does not arbitrate at
 * all — a checklist says which product a card is in. The path is to let the
 * catalog answer what it can and let this list shrink to a residual small
 * enough that its ordering stops mattering.
 *
 * Diff logs for both attempts are reproducible with scripts/comp-quality/ +
 * a GROUP BY on sold_comps.setName; the numbers above are from 2026-08-23. */
// CF-THE-PRODUCT-NAME-IS-NOT-THE-KEY (2026-08-29, identity triangulation
// baseline: holding -> same card 90.5%). A holding typed as the checklist names
// it -- "2024 Panini Prospect Edition Baseball" -- leaked the year and the
// sport into the set key (2024-panini-prospect-edition-baseball, not found).
// A season prefix ("2024-25 ") falls to the first-year-plus-bare-key ruling of
// 2026-08-28; a trailing sport word names the sport field, never the product.
const SET_KEY_YEAR_PREFIX = /^(?:19|20)\d{2}(?:-\d{2})?-/;
const SET_KEY_SPORT_SUFFIX = /-(?:baseball|football|basketball|hockey|soccer|wrestling|mma|golf|racing)$/;
export function stripYearAndSport(slug: string): string {
  let out = slug.replace(SET_KEY_YEAR_PREFIX, "");
  out = out.replace(SET_KEY_SPORT_SUFFIX, "");
  return out || slug;
}

/**
 * CF-THE-JAPANESE-CODE-IS-THE-KEY (Drew, 2026-09-01, ruling R2).
 *
 * The canonical setKey for a modern Japanese Pokemon set is its BARE OFFICIAL
 * CODE — `sv2a`, not `japanese-sv2a`. Two spellings reached the pool:
 *
 *   `japanese-<code>`  a "japanese" prefix glued onto the code by a minter that
 *                      already had the vertical from the sport field. The
 *                      prefix names the language, never the product, and it
 *                      split each set's pool in two.
 *   `swsh12a`          OUR OWN mistaken form of the JA VSTAR Universe code,
 *                      which is `s12a`. swsh12a was never a real set code.
 *
 * EXACT-TOKEN, and that is the whole guard. These are whole-key rewrites, not
 * patterns: the map is consulted with `===`, never a prefix or a substring
 * test. It matters most for swsh12a, because the EN Silver Tempest product is
 * `swsh12` and its Trainer Gallery is `swsh12tg` — a `startsWith("swsh12")`
 * rule would swallow both and merge an English set into a Japanese one. Those
 * keys are absent from this map and pass through untouched, which the unit
 * tests pin as negatives.
 *
 * DELIBERATELY NOT A BLANKET `japanese-*` STRIP. Only the three products Drew
 * ruled on are here. `1997-pokemon-japanese-rocket-gang` keeps its name — it is
 * a ruled key in its own right (R1) and stripping "japanese" from it would
 * produce a key naming no product at all.
 *
 * Applied BEFORE the product table and the regex vocabulary. 187 of the 188
 * vocabulary patterns are unanchored (see the arbitration note below), so a
 * bare code like `s12a` is exactly the kind of short token a longer unanchored
 * rule can capture; deciding it first makes the ruling immune to line order.
 */
const RULED_SET_KEY_REWRITES: Readonly<Record<string, string>> = Object.freeze({
  "japanese-sv2a": "sv2a",
  "japanese-sv8a": "sv8a",
  "japanese-s12a": "s12a",
  swsh12a: "s12a",
  // CF-THE-JAPANESE-CODE-IS-THE-KEY, the SWSH era (2026-09-04). swsh12a was
  // never the only one: the alias source spells twelve modern Japanese sets
  // with the EN-era `swsh` prefix of their own code, and the tcgdex-ja modern
  // lane stages all twelve under the bare official code. Measured read-only on
  // 2026-09-04: 29,075 live sold_comps rows whose titles name these sets, and
  // the stored slug segment on the plurality of each is the swsh spelling —
  // rows that could not reach their own checklist.
  //
  // NINE OF THE TWELVE ARE HERE. The other three are DELIBERATELY ABSENT and
  // this is the whole point of the entry:
  //
  //   swsh8   IS a real EN set — Fusion Strike   (the JA s8   is Fusion Arts)
  //   swsh11  IS a real EN set — Lost Origin     (the JA s11  is Lost Abyss)
  //   swsh9   IS a real EN set — Brilliant Stars (the JA s9   is Star Birth)
  //
  // verified against api.tcgdex.net/v2/en/sets (218 sets) and against the pool
  // itself, which holds live English rows under each: "2021 Pokemon SWSH
  // Fusion Strike #282 Training Court PSA 10", "2022 Pokemon Lost Origin #69",
  // "2022 Pokemon Brilliant Stars #TG03 Full Art". Rewriting those keys would
  // merge three ENGLISH pools into three JAPANESE ones — the exact failure the
  // note above this map warns about, and the reason a general `swsh` -> `s`
  // pattern is refused even though it holds for 28 of the 29 aliases. Those
  // three sets are reached by the TITLE alias instead
  // (japanesePokemonAliases: "fusion-arts" -> s8), which reads the Japanese
  // name and so cannot touch an English row.
  //
  // A `swsh` key is only rewritable when NO English set owns that id.
  swsh9a: "s9a",
  swsh10a: "s10a",
  swsh11a: "s11a",
  swsh6k: "s6k",
  swsh6h: "s6h",
  swsh5i: "s5i",
  swsh7d: "s7d",
  swsh10p: "s10p",
  swsh8b: "s8b",
});

/** The ruled canonical spelling of a setKey, or the key unchanged. Exact-token
 *  by construction — callers that hold a KEY (not a product name) use this
 *  without paying for slugify or the vocabulary. */
export function canonicalRuledSetKey(setKey: string | null | undefined): string {
  const s = String(setKey ?? "").trim().toLowerCase();
  return RULED_SET_KEY_REWRITES[s] ?? s;
}

export function normalizeSetKey(setName: string): string {
  const s = stripYearAndSport(slugify(setName));
  // CF-THE-JAPANESE-CODE-IS-THE-KEY (R2): a ruled key is decided here, before
  // any unanchored pattern can reach it.
  const ruled = RULED_SET_KEY_REWRITES[s];
  if (ruled) return ruled;
  // CF-A-RULED-KEY-IS-A-FIXED-POINT (2026-09-03, follow-on to #1689). The
  // reconciliation answers next, and it answers in BOTH directions:
  //
  //   an ALIAS      returns the CATALOG's spelling, because a key the catalog
  //                 uses must survive this function unchanged or the pool can
  //                 never name the checklist it already has;
  //   a FIXED POINT returns itself and STOPS, because 187 of the 188 patterns
  //                 below are unanchored and a brand rule would otherwise
  //                 swallow every product whose name contains the brand --
  //                 `topps-triple-threads` -> `topps`. Drew ruled 2026-09-03
  //                 that product-family collapse is forbidden.
  //
  // It sits ABOVE the product table for the same reason the Japanese-code
  // ruling does: these are whole-key decisions taken against the real catalog,
  // and a rule decided by measurement must not be re-litigated by line order.
  const reconciled = reconcileSetKey(s);
  if (reconciled.final) return reconciled.key;
  // CF-THE-ID-CARRIES-THE-PRODUCT (D23, Drew 2026-08-30). The product table
  // answers FIRST: "Topps Series 1" is topps-series-1, "Topps Update" and
  // "Topps Update Series" are one product (topps-update-series), "Bowman
  // Draft 1st Edition" is another set, "Leaf Metal" is leaf-metal. Every
  // one of these used to fall to a family rule below (`/topps/`, `/leaf/`)
  // and mint the family as the identity. The regex vocabulary keeps
  // everything the table does not name, its catch-alls included.
  const named = productSetKeyForName(s);
  if (named) return named;
  for (const [re, canonical] of knownSetKeyPatterns()) {
    if (re.test(s)) return canonical;
  }
  for (const [re, canonical] of bareAliasPatterns()) {
    if (re.test(s)) return canonical;
  }
  return s;
}

/** Every key the regex vocabulary can emit — for the guard that checks the
 *  product table knows the family of each of them. */
export function vocabularyDestinations(): string[] {
  const out = new Set<string>();
  for (const [, k] of knownSetKeyPatterns()) out.add(k);
  for (const [, k] of bareAliasPatterns()) out.add(k);
  return [...out].sort();
}


/** CF-CROSS-PRODUCT-MIS-SLUG-FIX (Drew, 2026-07-30). Strict variant of
 *  normalizeSetKey: returns the canonical short form ONLY when the input
 *  matches a known product-line pattern; returns null otherwise. Use
 *  this in backfill scripts that were previously defaulting to "bowman"
 *  when they couldn't extract setKey — silent "bowman" fallback landed
 *  Panini/Topps/other rows in the Bowman namespace. Callers should now
 *  fall back to the existing slug's setKey when this returns null,
 *  or skip the row entirely.
 *
 *  Two-pass: strict brand-qualified patterns (e.g. "panini-select") win
 *  over bare aliases (e.g. "prizm"). This prevents "Panini Playoff Blue
 *  Prizm 3/10" from being mis-classified as panini-prizm because "prizm"
 *  appears in the parallel language of every Panini product.
 *
 *  CF-PRODUCT-FAMILY-COLLAPSE-IS-FORBIDDEN (Drew, 2026-09-03). THE PRODUCT
 *  TABLE ANSWERS FIRST, exactly as it does in `normalizeSetKey`.
 *
 *  It did not, and that asymmetry was a collapse engine. `normalizeSetKey`
 *  consults `productSetKeyForName` before the regex vocabulary (D23,
 *  CF-THE-ID-CARRIES-THE-PRODUCT); this function went straight to the regexes,
 *  where a FAMILY catch-all like `/(?:^|-)leaf/` swallows every specialized
 *  product whose name begins with the flagship's. Measured on real titles, the
 *  two functions disagreed on the same string:
 *
 *    "2002 Leaf Certified Materials #62"  table: leaf-certified-materials
 *                                       regexes: leaf              <- collapse
 *    "1996 Leaf Signature Series #88"     table: leaf-signature-series
 *                                       regexes: leaf              <- collapse
 *    "2006 Leaf Rookies & Stars #10"      table: leaf-rookies-and-stars
 *                                       regexes: leaf              <- collapse
 *    "2023 Leaf Metal #10"                table: leaf-metal
 *                                       regexes: leaf              <- collapse
 *    "2003 Topps Finest Flashbacks #10"   table: topps-finest-flashbacks
 *                                       regexes: topps-finest      <- collapse
 *
 *  Every one of those is a DIFFERENT card with its own checklist and its own
 *  price curve. The backfill scripts that read this function were therefore
 *  filing specialized product sales into the flagship pool while the id minter
 *  filed them correctly — one card, two rows, a split pool, a wrong FMV.
 *
 *  Consulting the table here makes the two functions agree BY CONSTRUCTION
 *  rather than by keeping two vocabularies in sync by hand, and it cannot
 *  loosen the strictness this function exists for: the table is a closed list
 *  of named products, so a text that names none of them still falls through to
 *  the regexes and still returns null when they miss. */
export function matchKnownProductLine(text: string): string | null {
  const s = slugify(text);
  // The D23 product table decides a product it NAMES, ahead of the regex
  // vocabulary's family catch-alls. Same order as normalizeSetKey.
  const named = productSetKeyForName(s);
  if (named) return named;
  for (const [re, canonical] of knownSetKeyPatterns()) {
    if (re.test(s)) return canonical;
  }
  for (const [re, canonical] of bareAliasPatterns()) {
    if (re.test(s)) return canonical;
  }
  return null;
}

/** Normalize cardNumber: lowercase, kept literal. Preserves letters,
 *  digits, and internal hyphens (CPA-EHA → cpa-eha, BCP-102 → bcp-102).
 *  CF-THE-ID-CARRIES-THE-PRODUCT (D23, ruling d): the checklist's hyphen IS
 *  the canonical spelling of the segment (bd-152, cpa-tg); a source that
 *  drops it (bccp "BD152", a PSA label) is matched hyphen-insensitively by
 *  sameCardNumber / cardNumberVariants below, and folded onto the
 *  checklist's spelling by the rename fleet when the twin exists. */
function normalizeCardNumber(cardNumber: string): string {
  return slugify(cardNumber);
}

/** A card number with everything but its letters and digits removed,
 *  upper-cased: BD-152, bd152 and "BD 152" fold to BD152. Empty for an
 *  empty input. */
export function foldCardNumber(raw: string | null | undefined): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** CF-THE-ID-CARRIES-THE-PRODUCT (D23, ruling d): every card-number
 *  comparison is hyphen- and case-insensitive. bd152 ≡ BD-152 ≡ bd-152.
 *  Two empty numbers are NOT the same card. */
export function sameCardNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  const fa = foldCardNumber(a);
  return fa !== "" && fa === foldCardNumber(b);
}

/**
 * The spellings a stored card number may have for an index-friendly
 * `c.cardNumber IN (...)`: the raw text, upper, lower, the hyphen-free
 * fold, and — when the raw carries no hyphen and is letters-then-digits —
 * the checklist's hyphenated form (BD152 → BD-152). Equality against
 * literals uses the index; UPPER()/REPLACE() on the column would not
 * (CF-RESOLVER-INDEX-FRIENDLY). Deduped; never empty for a non-empty input.
 */
export function cardNumberVariants(raw: string | null | undefined): string[] {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  const upper = s.toUpperCase();
  const folded = foldCardNumber(s);
  const out = new Set<string>([s, upper, s.toLowerCase()]);
  if (folded) { out.add(folded); out.add(folded.toLowerCase()); }
  const m = /^([A-Z]+)(\d+)$/.exec(folded);
  if (m && !upper.includes("-")) { out.add(`${m[1]}-${m[2]}`); out.add(`${m[1]}-${m[2]}`.toLowerCase()); }
  return [...out].filter(Boolean);
}

/** `c.cardNumber IN (@n0, @n1, …)` and its parameters, for the variants
 *  above. Splice `sql` into ONE template literal so catalogQuerySchema's
 *  guard still sees the query. */
export function cardNumberInClause(raw: string | null | undefined, prefix = "@n"): { sql: string; params: Array<{ name: string; value: string }> } {
  const params = cardNumberVariants(raw).map((v, i) => ({ name: `${prefix}${i}`, value: v }));
  return { sql: params.map((p) => p.name).join(", "), params };
}

/**
 * The head-nouns a checklist pluralizes when it uses a parallel as a SECTION
 * HEADING ("Refractors", "Gold Refractors", "Printing Plates"). Matched only
 * as the FINAL word of a slug, so a colour/finish prefix is preserved
 * ("gold-refractors" → "gold-refractors" minus the s → "gold-refractor") and
 * a name that merely contains one is untouched.
 *
 * Closed on purpose. Every entry is a finish/format word that names HOW a card
 * is printed; none is a standalone parallel name whose singular is a different
 * card. Adding a word here merges two pools, so it is a vocabulary decision:
 * check data/checklist-parallel-names.json for a singular twin first.
 */
const PLURAL_PARALLEL_HEAD =
  /(^|-)(refractor|x-fractor|xfractor|fractor|superfractor|prizm|plate|printing-plate|parallel|mini|jumbo|wave|shimmer|holo|foil|sparkle|pulsar|mojo|insert|autograph|relic|patch|die-cut|short-print|printing-plate)s$/;

/** Normalize parallel to a canonical slug. Caller MUST pass the
 *  specific variant (not lossy vendor labels like "Refractor" for a
 *  Gold Refractor). Base/Base Refractor/no-parallel all normalize to
 *  "base".
 *
 *  CF-MARKET-LANGUAGE-ALIAS (Drew, 2026-07-23). The market uses "True
 *  {Color}" as a synonym for "{Color} Refractor" — the base colored
 *  refractor without a modifier (True Blue = Blue Refractor, True Green
 *  = Green Refractor, etc). This is distinct from "{Color} Shimmer
 *  Refractor" / "{Color} Lava Refractor" which are separate variants.
 *  We strip the leading "True " so both forms produce the same slug.
 *
 *  Also drops the redundant "Refractor" suffix when we already have a
 *  color+refractor pair. "Blue Refractor" → "blue" would collide with
 *  the ambiguous "Blue" holding, so we KEEP the "-refractor" suffix
 *  for now — CH's catalog and Cardsight both use the full "X Refractor"
 *  labels. Future migration might collapse further; today's rule is
 *  minimal-risk. */
export function normalizeParallel(parallel: string | null | undefined): string {
  const raw = String(parallel ?? "").trim();
  // CF-A-VARIATION-IS-A-CARD (D22). A variation name has its own vocabulary
  // (variationVocabulary.ts): "Image Variations" / "Photo Variation" / "SP
  // Variation" / "SSP" / "IV" are one card — image-variation(-ssp) — and a
  // named kind keeps its words singular. "True Photo Variation" is a named
  // kind, not the market's "True Blue"; the True-prefix rule does not apply.
  const isVariationText = /\b(?:variations?|var)\b/i.test(raw) || /^(?:ssp|iv|super\s+short\s+prints?)$/i.test(raw);
  // Strip leading "True " (case-insensitive, whitespace-boundary).
  // Only matches when "true" is a standalone leading word, so parallels
  // like "TrueSonic" (hypothetical brand) aren't accidentally altered.
  const hadTruePrefix = !isVariationText && /^true\s+/i.test(raw);
  const stripped = hadTruePrefix ? raw.replace(/^true\s+/i, "") : raw;
  let s = slugify(stripped);
  // Compound-variant unification: same market variant, different spelling
  // in the wild. Both forms must slug to the same canonical form or we
  // fragment the comp pool.
  //   "Ray Wave"  → ray-wave   (canonical)
  //   "Raywave"   → raywave    → ray-wave
  //   "X-Fractor" → x-fractor  (canonical)
  //   "Xfractor"  → xfractor   → x-fractor
  s = s.replace(/(^|-)raywave($|-)/g, "$1ray-wave$2");
  s = s.replace(/(^|-)xfractor($|-)/g, "$1x-fractor$2");
  // CF-MEGA-MOJO-ALIAS (Drew, 2026-07-29). "Mega Refractor" and "Mojo
  // Refractor" are the same physical parallel (orange stock with a
  // pattern), different market vocabulary. Collapse mega-refractor →
  // mojo-refractor at the slug layer so the two aliases produce the
  // same slug and share one FMV pool. Also handles COLORED variants:
  // "Blue Mega Refractor" → "blue-mojo-refractor", preserving the
  // color distinction. Bare "Mega" alone is NOT collapsed here —
  // too ambiguous (could be Bowman Mega Box product context).
  s = s.replace(/(^|-)mega-refractor($|-)/g, "$1mojo-refractor$2");
  // CF-A-LADDER-HEADING-IS-PLURAL (2026-08-31). A checklist SECTION heading is
  // written plural because it heads a list of cards -- "Refractors", "Gold
  // Refractors", "Printing Plates" -- while the parallel ONE card carries is
  // singular. Both spellings name the same physical parallel, so they must
  // reach one slug or the pool splits: 1993 Finest's "Refractors" heading
  // slugged `refractors` and would have stranded its cards beside the existing
  // 705-row `refractor` pool.
  //
  // Measured over data/checklist-parallel-names.json (36,699 checklist-sourced
  // names, 20,309 distinct): 584 end in a bare -s. Only the ones whose LAST
  // word is a parallel head-noun are safe to fold, so this is a CLOSED
  // vocabulary, not a trailing-s strip. The corpus says why a general rule
  // would be wrong -- "Canvas" is not a plural of "Canva" (both spellings are
  // in there, 6,957 vs 1,000), and "Stars" (1,944), "Rockets" (1,900),
  // "Crystals", "Wedges", "Spokes", "Fireworks", "Stars & Stripes" and
  // "Hieroglyphs" are all parallel NAMES whose singular is a different card.
  // Those keep their s. Only the head-noun list below folds.
  s = s.replace(PLURAL_PARALLEL_HEAD, (_m, lead: string, head: string) => lead + head);
  if (isVariationText) return normalizeVariationSlug(s);
  if (s === "" || s === "base" || s === "none" || s === "no-parallel") {
    return "base";
  }
  // CF-MOJO-IMPLIES-REFRACTOR (Drew, 2026-08-01). "Mojo" alone (or
  // "Blue Mojo", "Green Mojo", "Red Mojo" etc.) is a market shortening
  // of "Mojo Refractor". Colored Mojos are common Mega Box parallels
  // (Blue Mojo /50, Green Mojo /99, Red Mojo /25). Ensure any slug
  // ending in "-mojo" (or bare "mojo") gets the "-refractor" suffix
  // so it pools with "Mojo Refractor" and "Mega Refractor" variants.
  // CF-COLOUR-FOLLOWS-THE-CHECKLIST (Drew, 2026-08-30): the "-mojo" →
  // "-mojo-refractor" append (CF-MOJO-IMPLIES-REFRACTOR) is REMOVED with the
  // other vocabulary rules; "Mojo" is written as said and the catalog resolver
  // maps it onto "Mojo Refractor" only when that is the one mojo row the card has.
  // CF-MEGA-IS-MOJO (Drew, 2026-08-01). Now that sub-channel captures
  // the Mega Box product context separately, bare "Mega" (or
  // "Blue Mega", "Red Mega" etc.) in the parallel field is safely
  // treated as an alias for Mojo — same physical parallel, different
  // card-language. Collapses to <color>-mojo-refractor.
  // CF-COLOUR-FOLLOWS-THE-CHECKLIST (Drew, 2026-08-30): "Mega" is the market's
  // word for Mojo; whether the card's Mojo is a "Mojo Refractor" is the
  // catalog's to say, not the vocabulary's.
  if (/(^|-)mega$/.test(s)) {
    s = s.replace(/mega$/, "mojo");
  }
  // CF-TRUE-COLOR-IMPLIES-REFRACTOR (Drew, 2026-07-28). "True Blue"
  // (with no explicit "Refractor" suffix) is a market synonym for
  // "Blue Refractor" — same physical card, canonical form ends in
  // "-refractor". Prior code stripped "True" and stopped at "blue",
  // fragmenting the comp pool: "True Blue" sales landed at :blue: while
  // "Blue Refractor" sales landed at :blue-refractor:. Only applies
  // when we actually stripped a leading "True" AND the remainder isn't
  // already a refractor-tagged variant (so "True Blue Refractor" and
  // "True Blue Shimmer Refractor" pass through unchanged after their
  // own strip).
  // CF-COLOUR-FOLLOWS-THE-CHECKLIST (Drew, 2026-08-30): the forced
  // "-refractor" after a stripped "True" is REMOVED. "True Blue" is "Blue" as
  // the seller wrote it; the catalog resolver maps it onto "Blue Refractor"
  // only when that is the one blue row the card has.
  void hadTruePrefix;
  return s;
}

/** Format printRun suffix. Positive integer → "num-N"; anything else → "". */
function formatPrintRun(printRun: number | null | undefined): string {
  if (printRun === null || printRun === undefined) return "";
  if (!Number.isFinite(printRun) || printRun <= 0 || !Number.isInteger(printRun)) return "";
  return `:num-${printRun}`;
}

// CF-CHROME-PREFIX-OVERRIDE-NARROW (Drew, 2026-08-10). Prior attempt
// (2026-07-31) applied a blanket cardNumber-prefix→chrome override,
// which misclassified ~184 rows because prefixes like CPA-, FCA-, TC-
// are shared across product families (CPA- exists in both Bowman
// Chrome Prospects AND Topps Chrome Platinum Anniversary; FCA- is
// Topps Finest; TC- appears in Panini Donruss Champions). Reverted.
//
// But *doing nothing* left 92,362 sold_comps rows misslugged across
// 12,000+ distinct slugs — cards with BCP-XX / CPA-XX / BDC-XX
// cardNumbers whose vendor setName was just "Bowman" (paper) instead
// of "Bowman Chrome". Owen Carey CPA-OC pool was fragmented across 4
// slugs because of this. See audit output at
// backend/scripts/slug-frag-findings.json.
//
// Narrow fix: only override when the (bareSetKey, prefix) pair is
// unambiguous:
//   bowman + BCP-  → bowman-chrome     (BCP- only ever = Bowman Chrome)
//   bowman + CPA-  → bowman-chrome     (Topps CPA- has setKey=topps, not bowman)
//   bowman + BDC-  → bowman-chrome     (Bowman Draft Chrome; collapses per CF-CHROME-SUBSET-COLLAPSE)
//   bowman-draft + BDC- → bowman-chrome (same collapse)
//   topps  + TCPA- → topps-chrome      (Topps Chrome Prospect Auto)
//   topps  + CRA-  → topps-chrome      (Topps Chrome Rookie Auto)
// Skip ambiguous prefixes (FCA-, TC-, bare CPA/BCP without dash) —
// those still need setName as the disambiguator.
interface ChromePrefixRule {
  fromSetKey: string;
  cardNumberPrefix: RegExp;
  toSetKey: string;
}
// Regex shape uses `(?:-|\d)` after the prefix so both BCP-102 (modern
// dashed shape, 2020+) AND BCP150 (older no-dash shape, pre-2020) match.
// 2018 Vlad Guerrero rookie is BCP150; pre-fix rule missed it entirely
// because it only accepted the dashed form (found by testing, 2026-08-10).
//
// Expanded 2026-08-10 (Drew: "if we know it for a fact, we should clean it"):
// added CDA-/BCPA-/BDCPA- (all unambiguously bowman-chrome) and BSPA-
// (unambiguously bowman-chrome-sapphire, its own family).
const CHROME_PREFIX_OVERRIDES: readonly ChromePrefixRule[] = [
  // Sapphire — must come BEFORE the plain bowman-chrome rules so a
  // BSPA card doesn't get pre-empted.
  { fromSetKey: "bowman",             cardNumberPrefix: /^bspa(?:-|\d)/i,  toSetKey: "bowman-chrome-sapphire" },
  { fromSetKey: "bowman-chrome",      cardNumberPrefix: /^bspa(?:-|\d)/i,  toSetKey: "bowman-chrome-sapphire" },
  // Bowman Chrome family
  { fromSetKey: "bowman",             cardNumberPrefix: /^bcp(?:-|\d)/i,   toSetKey: "bowman-chrome" },
  { fromSetKey: "bowman",             cardNumberPrefix: /^cpa(?:-|\d)/i,   toSetKey: "bowman-chrome" },
  { fromSetKey: "bowman",             cardNumberPrefix: /^bcpa(?:-|\d)/i,  toSetKey: "bowman-chrome" },
  { fromSetKey: "bowman",             cardNumberPrefix: /^bdc(?:-|\d)/i,   toSetKey: "bowman-chrome" },
  { fromSetKey: "bowman",             cardNumberPrefix: /^bdcpa(?:-|\d)/i, toSetKey: "bowman-chrome" },
  { fromSetKey: "bowman",             cardNumberPrefix: /^cda(?:-|\d)/i,   toSetKey: "bowman-chrome" },
  { fromSetKey: "bowman-draft",       cardNumberPrefix: /^bdc(?:-|\d)/i,   toSetKey: "bowman-draft" },
  { fromSetKey: "bowman-draft",       cardNumberPrefix: /^bdcpa(?:-|\d)/i, toSetKey: "bowman-draft" },
  { fromSetKey: "bowman-draft",       cardNumberPrefix: /^cda(?:-|\d)/i,   toSetKey: "bowman-draft" },
  // CPA- on a Draft product is a Draft chrome prospect auto, not a Bowman
  // Chrome one. Without this it fell through to bare bowman-draft.
  { fromSetKey: "bowman-draft",       cardNumberPrefix: /^cpa(?:-|\d)/i,   toSetKey: "bowman-draft" },
  // Topps Chrome family
  { fromSetKey: "topps",              cardNumberPrefix: /^tcpa(?:-|\d)/i,  toSetKey: "topps-chrome" },
  { fromSetKey: "topps",              cardNumberPrefix: /^cra(?:-|\d)/i,   toSetKey: "topps-chrome" },
  // Paper family — Drew 2026-08-10: "paper is a different card number
  // prefix". BP- (Bowman Prospects paper), BPA- (Bowman Paper Auto),
  // BDA- (Bowman Draft paper Auto) are unambiguously paper. Anchoring
  // these prevents paper cards from being pooled with chrome via bare-
  // bowman ambiguity. Note: BDP- stays out because it's a legitimately
  // ambiguous prefix (2005 Bowman DP had both paper and chrome, e.g.
  // Verlander BDP129 is chrome per Drew).
  { fromSetKey: "bowman",             cardNumberPrefix: /^bpa(?:-|\d)/i,   toSetKey: "bowman-paper" },
  { fromSetKey: "bowman",             cardNumberPrefix: /^bp(?:-|\d)/i,    toSetKey: "bowman-paper" },
  // CF-MATCH-THE-CATALOG (Drew, 2026-08-16: "they should match to the
  // CATALOG"). BDA- used to route to "bowman-draft-paper", a key the catalog
  // barely has — 18 rows against bowman-draft's 336,404, counted 2026-08-16.
  // A slug nothing in the catalog shares is a card that matches nothing, so
  // the paper distinction is kept as intent but expressed with the key that
  // actually exists.
  { fromSetKey: "bowman",             cardNumberPrefix: /^bda(?:-|\d)/i,   toSetKey: "bowman-draft" },
  { fromSetKey: "bowman-draft",       cardNumberPrefix: /^bda(?:-|\d)/i,   toSetKey: "bowman-draft" },
];
function applyChromePrefixOverride(setKey: string, cardNumber: string): string {
  for (const rule of CHROME_PREFIX_OVERRIDES) {
    if (setKey === rule.fromSetKey && rule.cardNumberPrefix.test(cardNumber)) {
      return rule.toSetKey;
    }
  }
  return setKey;
}

// CF-CHROME-COLOR-IMPLIES-REFRACTOR (Drew, 2026-08-07). On chrome stock,
// bare colors like "Blue" and colored-pattern parallels like "Blue Shimmer"
// are market shorthand for "<color> Refractor" / "<color> Shimmer
// Refractor". Fragmenting the comp pool between "Blue Shimmer" and "Blue
// Shimmer Refractor" is exactly the fragmentation the catalog-as-hub
// backfill is meant to close. Paper products are the exception — "Blue"
// on paper is literally a blue paper card, not a refractor.
//
// SCOPE: Only Topps/Bowman chrome-family products. Panini uses "Prizm"
// as its stock indicator ("Silver Prizm" not "Silver Refractor"), so
// applying this rule to panini-prizm would produce nonsense like
// "silver-prizm-refractor". Same story for Panini Optic ("holo" =
// Panini's chrome). Keep those OFF this list; they have their own
// stock-vocab consolidation rules already in normalizeParallel.
const CHROME_STOCK_SETKEYS: ReadonlySet<string> = new Set([
  "bowman-chrome",
  "bowman-chrome-sapphire",
  "bowman-sterling",
  "topps-chrome",
  "topps-chrome-platinum",
  "topps-chrome-black",
  "topps-chrome-sapphire",
  "topps-chrome-update-sapphire",
  "topps-update-sapphire",
  "topps-finest",
  "topps-pristine",
  "topps-transcendent",
  "topps-dynasty",
  "topps-tribute",
]);

function isChromeStockSetKey(setKey: string): boolean {
  return CHROME_STOCK_SETKEYS.has(setKey);
}

// REVERTED (Drew, 2026-08-11): a PANINI_PRIZM_STOCK_SETKEYS +
// implies-prizm rule was drafted here after seeing the cross-parallel-
// ratios pair Silver↔Silver Prizm sitting near 1.00 (n=369). Drew
// corrected in-turn: "no silver and silver prizm different." On Panini
// flagship, bare "Silver" and "Silver Prizm" are distinct physical
// parallels — the near-parity ratio is a coincidence of market
// pricing, not a signal that they are the same card. Left this
// pointer so future me does not re-derive the same wrong rule.

// CF-AUTO-ONLY-PREFIXES (Drew, 2026-08-11). These cardNumber prefixes
// are auto-only by product definition — every card with a CPA-,
// BCPA-, BDCPA-, CDA-, TCPA-, CRA-, BSPA-, BPA-, BDA- prefix IS an
// autograph. Yet vendors sometimes emit these sales with isAuto=false
// (raw title parsing, CH short titles, etc.), so the SAME physical
// sale ends up written under both `:auto` and `:no-auto` slugs. That
// doubles the pool, corrupts medians, and breaks the contentHash
// dedup (which includes the slug in its hash). Force isAuto=true
// whenever the cardNumber matches an auto-only prefix so the sale
// always lands on the correct :auto slug regardless of vendor label.
// Discovered on CPA-EHA Eric Hartman Orange Shimmer /25 — 4 unique
// sales stored as 7 rows across :auto/:no-auto variants (Drew,
// 2026-08-11).
const AUTO_ONLY_CARDNUMBER_PREFIX = /^(cpa|bcpa|bdcpa|cda|tcpa|cra|bspa|bpa|bda)(?:-|\d)/i;

/**
 * CF-ONE-SETKEY-RESOLVER (Drew, 2026-08-17). THE sport-aware setKey
 * resolution. Exported because callers that GATE computeHobbyIqCardId must be
 * able to ask the exact question it will answer.
 *
 * WHY THIS IS EXPORTED RATHER THAN INLINE. slugGuard rejects a setKey that
 * still carries a leading year (`isRawVendorSetKey`), and soldCompsStore fed
 * that guard `normalizeSetKey(setName)` while this function resolved Pokemon
 * through POKEMON_SET_ALIASES first. The two disagreed on every Pokemon row:
 *
 *     "2024 Pokemon Scarlet & Violet Surging Sparks"
 *       normalizeSetKey -> 2024-pokemon-scarlet-violet-surging-sparks  REFUSED
 *       alias table     -> sv08                                        fine
 *
 * Measured 2026-08-17: of 860,462 null-slug Pokemon comps, the guard accepted
 * exactly 1, and 615,140 (71.5%) were refused on `setkey-raw-vendor-string`
 * despite resolving cleanly here. The guard was rejecting rows the function it
 * guards would have keyed correctly — one rule, two implementations, the
 * stricter one winning. Same failure shape as CF-ONE-OUTLIER-RULE.
 *
 * `sport` must already be canonical (normalizeSport / normalizeSportStrict).
 */
/**
 * Strip the leading year(s) and the vertical’s own name from a vendor setName.
 *
 *   "2024 Yu-Gi-Oh! Rage of the Abyss" -> "Rage of the Abyss"
 *   "1993 Magic The Gathering Beta"    -> "Beta"
 *   "2024 One Piece Two Legends"       -> "One Piece Two Legends"
 *
 * The year is dropped because slug segment 2 already carries it, and the
 * vertical is dropped because it IS the namespace — keeping either would mint a
 * different key for every spelling of the same set. One Piece keeps its line
 * name because the product name genuinely includes it.
 */
function stripVerticalPrefix(setName: string): string {
  let s = String(setName ?? "").trim();
  s = s.replace(/^((19|20)\d{2}(-\d{2})?\s+)+/g, "");
  s = s.replace(/^(yu-?gi-?oh!?|magic:?\s*the\s+gathering|magic)\s*/i, "");
  return s.trim();
}

/**
 * CF-JAPANESE-POKEMON-ALIASES (Drew, 2026-08-17). Resolve a Japanese Pokemon
 * set name to its canonical Japanese set code.
 *
 * Vendor names carry year + "Pokemon" + "Japanese" + the SERIES before the set:
 *
 *   "2023 Pokemon Japanese Scarlet & Violet 151"      -> sv2a
 *   "2022 Pokemon Japanese Sword & Shield VSTAR Universe" -> s12a
 *
 * so the lookup is tried twice: once with the series stripped (the set name
 * alone, which is how the source lists it) and once with it retained, because
 * a few sets genuinely include their series in the name.
 *
 * Matched 89.9% of Japanese sales when measured against live data.
 */
function resolveJapanesePokemonSet(setName: string): string | null {
  const stripped = String(setName ?? "")
    .replace(/^((19|20)\d{2}\s+)/, "")
    .replace(/^pokemon\s+/i, "")
    .replace(/^japanese\s+/i, "")
    .trim();
  const SERIES = /^(scarlet\s*&?\s*violet|sword\s*&?\s*shield|sun\s*&?\s*moon|xy|black\s*&?\s*white|diamond\s*&?\s*pearl|heartgold\s*&?\s*soulsilver|neo|gym|e-card|dp|platinum|legend|bw)\s+/i;
  const candidates = [stripped.replace(SERIES, "").trim(), stripped];
  for (const cand of candidates) {
    const key = slugify(cand);
    if (!key) continue;
    const exact = JAPANESE_POKEMON_SET_ALIASES[key];
    if (exact) return exact;
  }
  // Segment-boundary containment, so "151" finds "pokemon-card-151" without a
  // bare substring match dragging in an unrelated set.
  for (const cand of candidates) {
    const key = slugify(cand);
    if (!key || key.length < 2) continue;
    for (const [alias, code] of Object.entries(JAPANESE_POKEMON_SET_ALIASES)) {
      if (alias === key || alias.endsWith("-" + key) || alias.startsWith(key + "-")
        || alias.includes("-" + key + "-")) return code;
    }
  }
  return null;
}

export function resolveSetKeyForSlug(sport: string, setName: string, year: number): string {
  // GATED ON SPORT, deliberately. The alias table contains keys like "151"
  // (Scarlet & Violet 151) that would be actively dangerous applied to a
  // baseball set name. A non-Pokemon card can never reach this branch.
  // CF-NO-CROSS-VERTICAL-FALLBACK (Drew, 2026-08-17). A Pokemon alias MISS used
  // to fall through to normalizeSetKey — the SPORTS vocabulary — which happily
  // matched Pokemon set names against Panini products:
  //
  //     "2023 Pokemon Scarlet & Violet Obsidian Flames" -> panini-obsidian
  //     "Crown Zenith"                                  -> panini-zenith
  //     "XY Ancient Origins"                            -> panini-origins
  //     "EX FireRed & LeafGreen"                        -> leaf
  //
  // producing slugs like `hiq:pokemon:2023:panini-obsidian:106:base:no-auto` —
  // a Pokemon card pooled with Panini basketball comps. Measured 2026-08-17:
  // 59,748 Pokemon rows carried a sports/Panini setKey.
  //
  // The sports vocabulary has no jurisdiction here. On a miss, slugify the name
  // and stop: a year-prefixed result is refused by slugGuard and the row stays
  // honestly unkeyed, while a clean name yields a truthful pokemon-namespaced
  // key. Both beat a confident wrong one — the same doctrine slugGuard exists
  // for, applied one layer earlier.
  // CF-TCG-VERTICAL-VOCABULARY (Drew, 2026-08-17). Each TCG vertical resolves
  // against its OWN set table, never the sports vocabulary. Measured against
  // live unkeyed rows: Yu-Gi-Oh 97.8% of sales match YGOPRODeck, Magic ~98%
  // once the four manual aliases are applied. Before this every one of them
  // slugified year-prefixed and slugGuard refused it — ~84,000 sales a day.
  //
  // The year and the vertical name are stripped before lookup: the slug already
  // carries the year, and the vertical IS the namespace. One table entry per
  // set therefore covers every vendor spelling of it.
  if (sport === "yugioh" || sport === "tcg-other" || sport === "anime-tcg") {
    const bare = stripVerticalPrefix(setName);
    const table = sport === "yugioh" ? YUGIOH_SET_ALIASES
      : sport === "tcg-other" ? MTG_SET_ALIASES
      : null;
    const hit = table ? table[slugify(bare)] : undefined;
    // On a miss the CLEAN name still beats a year-prefixed one-off: it is
    // stable, it joins to itself across spellings, and the guard accepts it.
    // The sports vocabulary is never consulted here — CF-NO-CROSS-VERTICAL-FALLBACK.
    return hit ?? slugify(bare);
  }
  // CF-LONGTAIL-VERTICAL-FALLBACK (Drew, 2026-08-17). The verticals our sports
  // vocabulary was never built for.
  //
  // Most of their products ARE known — "2020 Topps Chrome F1 Racing" resolves
  // to topps-chrome because the manufacturer rule fires — so normalizeSetKey is
  // still tried first and still wins where it can. But when it falls through to
  // slugify, the result is year-prefixed and slugGuard refuses it, leaving a
  // real product (Marvel Masterpieces, Garbage Pail Kids, Netpro Tennis) with no
  // slug at all.
  //
  // The year is redundant — slug segment 2 already carries it — so stripping it
  // yields a truthful, stable key that joins to itself across spellings. That is
  // strictly better than no slug, and it is what the vendor actually named.
  //
  // SCOPED TO THESE VERTICALS ON PURPOSE. For the major sports a year-prefixed
  // key usually means a genuine parse failure, and refusing is the right answer
  // there (CF-SLUG-REFUSE-FALLBACKS). Here it only means we never wrote a rule.
  const LONGTAIL = new Set([
    "non-sport", "multi-sport", "tennis", "golf", "racing", "mma", "boxing", "wrestling",
  ]);
  if (LONGTAIL.has(sport)) {
    const viaVocabulary = normalizeSetKey(setName);
    if (viaVocabulary && !/^(19|20)\d{2}-/.test(viaVocabulary)) return viaVocabulary;
    const bare = stripVerticalPrefix(setName);
    return slugify(bare) || viaVocabulary;
  }
  // Japanese sets are looked up FIRST: a vendor name like "Pokemon Japanese
  // Scarlet & Violet 151" would otherwise hit the ENGLISH alias for 151
  // (sv03-5) and pool Japanese sales into the English card, which is a
  // different print with a different market.
  if (sport === "pokemon" && /japanese/i.test(setName)) {
    const jp = resolveJapanesePokemonSet(setName);
    // On a miss, the CLEAN name still beats a year-prefixed refusal and can
    // never collide with an English set id.
    if (jp) return jp;
    const bare = String(setName).replace(/^((19|20)\d{2}\s+)/, "").replace(/^pokemon\s+/i, "").trim();
    return slugify(bare);
  }
  const rawSetKey = sport === "pokemon"
    ? (POKEMON_SET_ALIASES[slugify(setName)] ?? slugify(setName))
    : normalizeSetKey(setName);
  // CF-PANINI-IS-ANACHRONISTIC-BEFORE-2009: Panini did not acquire Donruss
  // until 2009, so a 1987 "Donruss" card must not be stamped panini-donruss.
  // CF-THE-ID-CARRIES-THE-PRODUCT (D23, ruling b): the maker prefix is kept
  // on Panini-era products and the era decides the spelling — the rule and
  // its switch live in productSetKeys (DONRUSS_SPELLING_POLICY). Applied
  // after normalization so it corrects the canonical key rather than racing
  // the vocabulary that produces it.
  return spellForEra(rawSetKey, year);
}

/** Compute the canonical hobbyiqCardId slug for a card. Same inputs
 *  ALWAYS produce the same slug — the function has no side effects and
 *  no I/O. */
/**
 * CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE (Drew ruling,
 * 2026-09-04).
 *
 * THE DEFECT. The slug carries sport/year/setKey/cardNumber/parallel/isAuto/
 * printRun and NO subset. One product can publish two subsets that number
 * their cards alike, and then those cards share one slug — one pool holding
 * two different cards. Measured, not hypothesised (#1741): 2000-01 Topps
 * Chrome publishes both "Cards That Never Were" (MJ1-MJ10) and "Johnson
 * Reprints" (MJ1-MJ7), every row Magic Johnson, both Refractor. #1741 stopped
 * the merge by REFUSING the second write and counting it, which made the
 * collision a reported number instead of a silent pool — but left those cards
 * uningestable.
 *
 * THE RULING. For those cards, and ONLY those cards, the subset becomes part
 * of the identity: each gets its own pool. Everything else is unchanged — a
 * card whose number is unique within its product gets no subset segment, so
 * the ~31M slugs already in the catalog keep the shape they have. This is not
 * a new axis on every card; it is a disambiguator applied exactly where the
 * product forced a collision.
 *
 * THE DECISION IS THE CATALOG'S, NOT THE TITLE'S. `subsetInId` is computed at
 * ingest by asking the checklist for (year, setKey) whether this cardNumber
 * appears under more than one subset at this rung, and is PERSISTED on the
 * catalog row. This function never infers a clash, because the only place a
 * clash is visible is the whole product — one row cannot see it, and a sale
 * title certainly cannot. A matcher that read "Aptitude for Altitude" out of a
 * title and appended it would mint a subset-bearing id for a card that has no
 * clash, which is the fragmentation this rule exists to avoid.
 *
 * BLANK MEANS UNKNOWN. A row flagged `subsetInId` whose `subsetName` is blank
 * is REFUSED here rather than minted without the segment — minting it would
 * put it back on the plain id, which is the very slug the clash makes
 * ambiguous. That refusal is what #1741's counter goes on counting.
 *
 * WHY `sub-` AND WHY AFTER THE SETKEY. The segment reads product > subset >
 * card, which is how the checklist itself is organised. The `sub-` prefix
 * makes the segment self-describing, so parseHobbyIqCardId can tell a
 * 7-segment slug with a subset from a 7-segment slug with a print run without
 * counting fields — the same reason printRun carries `num-`. No card number
 * or parallel slug produced by this module can begin with `sub-` and be
 * mistaken for it, because both of those live in fixed positions AFTER it.
 */
function formatSubsetSegment(components: HobbyIqCardIdComponents): string {
  if (components.subsetInId !== true) return "";
  const slug = slugify(String(components.subsetName ?? ""));
  if (!slug) {
    // The caller says this number clashes across subsets but cannot say WHICH
    // subset this row is. Blank is unknown, never invented: refuse.
    throw new Error("hobbyiq-cardid: cardNumber clashes across subsets but the subset is UNKNOWN — identity is UNDERIVABLE (CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE)");
  }
  return `:sub-${slug}`;
}

export function computeHobbyIqCardId(components: HobbyIqCardIdComponents): string {
  const sport = normalizeSport(components.sport);
  const year = Number.isFinite(components.year) ? Math.trunc(components.year) : 0;
  // CF-POKEMON-CHECKLISTS (Pokemon set names arrive in as many shapes as
  // sellers can type, and fragment across every spelling) and
  // CF-PANINI-IS-ANACHRONISTIC-BEFORE-2009 (Panini did not acquire Donruss
  // until 2009, and stamping panini-donruss on a 1987 card split 16,776 comps
  // away from the 1,313-row 1987 donruss checklist) BOTH live in
  // resolveSetKeyForSlug. They are there rather than here so that slugGuard —
  // which decides whether this function may run at all — resolves the setKey
  // identically. See that function for the measurements.
  const baseSetKey = resolveSetKeyForSlug(sport, components.setKey, year);
  // CF-A-MAKER-LESS-CATCH-ALL-IS-NOT-A-PRODUCT (Drew, 2026-09-05). `draft` and
  // `flagship` are words a title uses ABOUT a product, and a key minted from
  // one names no card anybody can buy. They arrive through normalizeSetKey's
  // FALL-THROUGH rather than any vocabulary table: the title parser's
  // buildSetName(null, "draft") is the literal string "Draft".
  //
  // Refused HERE as well as in slugGuard, for the same reason the unparsed
  // cardNumber is: slugGuard is the gate callers SHOULD use, and this throw is
  // what makes a caller that skipped it fail loudly instead of minting. The
  // three ingest paths already wrap this in try/catch and skip the row.
  //
  // Exact-token — `bowman-draft` and `topps-chrome` are real products and pass
  // untouched. The refusal is checked AFTER resolveSetKeyForSlug so that a
  // resolver able to supply the maker is given its chance first.
  if (isMakerlessCatchAllSetKey(baseSetKey)) {
    throw new Error(
      `hobbyiq-cardid: ${makerlessCatchAllMessage(baseSetKey)} — identity is UNDERIVABLE`,
    );
  }
  // CF-PLAYER-IS-THE-NUMBER: an unnumbered card is identified by its player,
  // never by the shared literal "nno". Falls back to the plain normalized form
  // when there is no player, so slugGuard is the one place that refuses.
  //
  // CF-UNPARSED-IS-NOT-UNNUMBERED (Drew, 2026-09-04). The pseudo-number is
  // reachable ONLY from a source that SAID the card has no number -- an
  // explicit `nno`/`unnumbered` marker, or a caller asserting
  // `unnumberedByChecklist` because a published checklist lists the card with
  // no number. A cardNumber that is merely BLANK is a parse failure, and this
  // function refuses it outright rather than minting an identity out of a
  // player name. Refusing here (rather than returning a malformed `::` slug)
  // is what makes every call site fail the same way: the three ingest paths
  // already wrap this in try/catch and skip, and deriveHobbyIqSlug's guard
  // reports `cardnumber-unparsed` before it ever gets here.
  const unnumbered = isUnnumberedCardNumber(components.cardNumber)
    || (components.unnumberedByChecklist === true && isUnparsedCardNumber(components.cardNumber));
  if (!unnumbered && isUnparsedCardNumber(components.cardNumber)) {
    throw new Error("hobbyiq-cardid: cardNumber is unparsed — identity is UNDERIVABLE (CF-UNPARSED-IS-NOT-UNNUMBERED)");
  }
  // CF-THE-CHECKLIST-SPELLS-THE-NUMBER (Drew, 2026-09-04). A Pokemon title
  // states POS/TOTAL ("094/159"); slugify strips the slash and the segment
  // became `094159`, a number that names no card and matches no checklist row.
  // Drop the total (it is the SET's size, already carried by the setKey) and
  // spell the position the way this set's checklist spells it. See
  // pokemonCardNumber.ts for the measurements and for why the width is read
  // per set rather than assumed: tcgdex pads `sv*`/`swsh1x` to 3 and writes
  // `sm*`/`xy*` verbatim. With no checklist the number is left as stated.
  const statedCardNumber = sport === "pokemon"
    ? normalizePokemonCardNumber(components.cardNumber, components.pokemonChecklistNumberWidth ?? null)
    : components.cardNumber;
  const cardNumber = unnumbered
    ? (unnumberedCardSegment(components.playerName) ?? normalizeCardNumber(statedCardNumber))
    : normalizeCardNumber(statedCardNumber);
  // An unnumbered card with no player to name it has no identity either. The
  // old code let `normalizeCardNumber("nno")` through as the literal `nno`,
  // which is the shared-slug collapse CF-PLAYER-IS-THE-NUMBER was written to
  // end (395 players, one pool, $3.49 to $103,700).
  if (unnumbered && !cardNumber.startsWith("player-")) {
    throw new Error("hobbyiq-cardid: unnumbered card has no player to identify it — identity is UNDERIVABLE");
  }
  // CF-CHROME-PREFIX-OVERRIDE-NARROW (Drew, 2026-08-10). Cards with
  // BCP-/CPA-/BDC-/TCPA-/CRA- cardNumbers get upgraded from bare to
  // chrome family. See CHROME_PREFIX_OVERRIDES for the rule table +
  // rationale for why this override is narrow (only unambiguous pairs).
  // CF-AUTHORITATIVE-SETKEY (Drew, 2026-08-13). The chrome-prefix override
  // exists to repair UNTRUSTED vendor text: sale titles say "Bowman" for cards
  // that are really Bowman Chrome, and mapping bowman + CPA- → bowman-chrome
  // fixed 92,362 mis-slugged sold_comps rows across 12,000+ slugs.
  //
  // A published checklist is the opposite of untrusted — it IS the ground
  // truth for which product a card belongs to, and applying the override to it
  // actively destroys identity. 2026 Bowman and 2026 Bowman Chrome BOTH carry
  // Chrome Prospect Autos with overlapping numbers and different players:
  //
  //     CPA-AG in 2026 Bowman        = Adrian Gil      (173 CPA autos)
  //     CPA-AG in 2026 Bowman Chrome = Angeibel Gomez  (259 CPA autos)
  //
  // Forcing both to bowman-chrome collapses two different players onto one
  // slug and pools their comps — the same failure as the Mega Box collision.
  // Drew, asked which product a CPA pulled from a Bowman pack belongs to:
  // "bowman — it came out of Bowman".
  //
  // So a caller that KNOWS the product (checklist ingest) passes
  // authoritativeSetKey and keeps its setKey verbatim. Vendor paths pass
  // nothing and keep the repair behaviour unchanged.
  const setKey = components.authoritativeSetKey === true
    ? baseSetKey
    : applyChromePrefixOverride(baseSetKey, cardNumber);
  // CF-AUTO-ONLY-FORCE (Drew, 2026-08-11). Auto-only prefixes always
  // produce autograph cards — force isAuto=true so vendor label drift
  // (isAuto=false on a CPA- sale, etc.) can't fragment the pool.
  const isAuto = components.isAuto === true
    || AUTO_ONLY_CARDNUMBER_PREFIX.test(cardNumber);
  let parallelSlug = normalizeParallel(components.parallel);
  // CF-CHROME-STOCK-REDUNDANT-PREFIX (Drew, 2026-08-11). On chrome-family
  // setKeys, a leading "chrome-" on the parallel is vendor noise (CH
  // labels e.g. "Chrome Sky Blue Refractor" for what collectors call
  // "Sky Blue Refractor"). Strip it so both spellings land in the same
  // FMV pool. Also collapses bare "Chrome" to "base" on chrome stock —
  // there is no meaningful non-base "chrome" variant of a chrome card.
  // Not applied to non-chrome setKeys because "Chrome"/"Chrome Refractor"
  // are legitimate insert-set parallel names in products like Topps
  // Heritage. Fixes ~8% sold_comps slug fragmentation (cleanliness
  // canary 2026-08-11).
  if (isChromeStockSetKey(setKey)) {
    if (parallelSlug === "chrome") {
      parallelSlug = "base";
    } else if (parallelSlug.startsWith("chrome-")) {
      parallelSlug = parallelSlug.slice("chrome-".length);
    }
  }
  // CF-BASE-IS-NOT-A-REFRACTOR (Drew, 2026-08-23: "base is a refractor is
  // wrong"). REMOVED: CF-CHROME-AUTO-BASE-IS-REFRACTOR, which upgraded
  // parallel "Base" to "Refractor" for CPA-/TCPA-/CRA- autos on bowman-chrome
  // and topps-chrome.
  //
  // The rule cited Drew's own words as its justification and then did the
  // opposite of them. Its comment read: 'Confirmed by Drew 2026-08-10: "a base
  // does not equal a refractor" — canonicalize by upgrading Base → Refractor
  // ... so they land in one pool.' A quote saying two parallels are NOT equal
  // cannot support merging them; the rationale was inverted when written.
  //
  // This is the recurring shape in this file: a canonicalization that unifies a
  // pool by erasing a distinction collectors actually price on. Base and
  // Refractor are different cards and must stay different slugs, even when that
  // leaves each pool smaller. A smaller correct pool beats a larger wrong one —
  // the whole point of the comp pool is that everything in it is the same card.
  //
  // NOTE FOR THE REPAIR SWEEP: rows written while this rule was live carry
  // parallel "Base" on a slug whose parallel segment says "refractor". That
  // disagreement between the row's own parallel field and its slug is exactly
  // how those rows are found and separated again — sold_comps keeps the vendor
  // parallel, so the original value was never lost.
  //
  // CF-CHROME-COLOR-IMPLIES-REFRACTOR below is deliberately NOT affected: it
  // acts on non-base parallels only, so "Blue" still unifies with "Blue
  // Refractor" while "Base" stays "Base".

  // CF-CHROME-COLOR-IMPLIES-REFRACTOR (Drew, 2026-08-07). See CHROME_STOCK
  // constants above — on known chrome product lines, any non-base parallel
  // that doesn't already carry "-refractor" gets it appended so "Blue",
  // "Blue Shimmer", "Blue Wave", "Blue Ray Wave" all share one FMV pool
  // with "Blue Refractor", "Blue Shimmer Refractor", etc.
  //
  // Also skip when the slug already ends in `-fractor` (covers `x-fractor`,
  // `foilfractor`, `frozenfractor`, `superfractor` etc.) — those variants
  // ARE the refractor stock and appending `-refractor` produced e.g.
  // `x-fractor-refractor` which then fragmented against bare `x-fractor`
  // (n=581, cleanliness canary 2026-08-11).
  // CF-COLOUR-FOLLOWS-THE-CHECKLIST (Drew, 2026-08-30: "color does not always
  // mean refractor … remove rules, and follow it to the checklist or catalog").
  // The product-level append above this line ("on chrome stock, any non-base
  // parallel without -refractor gets it") is REMOVED. It minted twins the
  // checklist never had — 2025 Topps Tribute #56 "Blue" is stored as :blue:
  // from the checklist while every sale titled "Blue" was slugged
  // :blue-refractor:. The generator now writes the parallel as named; the
  // catalog resolver (catalogMatcher: the unique long-form candidate,
  // catalogSlugIfExists) maps "Gold" onto "Gold Refractor" only when that is
  // the one gold row the card has, and leaves it when the checklist lists
  // "Gold" — or both. chromeRefractorSuffixForVariation stays exported for the
  // resolver; it is no longer applied here.
  void chromeRefractorSuffixForVariation;

  // NOTE (Drew, 2026-08-11): resist the temptation to add a
  // Panini-analog "Silver → Silver Prizm" collapse. Even though the
  // cross-parallel-ratios pair Silver↔Silver Prizm sits near 1.00,
  // Drew confirmed on 2026-08-11 that these are DISTINCT parallels
  // (bare "Silver" ≠ "Silver Prizm" on Panini flagship). Ratio
  // similarity does not imply identity — some parallels legitimately
  // trade at comparable levels. Unification requires collector
  // confirmation, not a ratio heuristic.

  const autoFlag = isAuto ? "auto" : "no-auto";
  const printRun = formatPrintRun(components.printRun);
  // CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE: empty for every card
  // whose number is unique within its product, which is almost all of them.
  const subset = formatSubsetSegment(components);
  return `hiq:${sport}:${year}:${setKey}${subset}:${cardNumber}:${parallelSlug}:${autoFlag}${printRun}`;
}

/** Best-effort reverse parse of a hobbyiqCardId. Returns null when the
 *  slug doesn't match the expected format. Used for debugging + audit
 *  trails; not a general-purpose deserializer. */
export function parseHobbyIqCardId(hiqId: string): HobbyIqCardIdComponents | null {
  if (typeof hiqId !== "string" || !hiqId.startsWith("hiq:")) return null;
  const parts = hiqId.split(":");
  // Minimum: hiq + 6 fields = 7 parts. With print run OR a subset = 8, with
  // both = 9. The two optional segments are told apart by their PREFIXES
  // (`sub-` right after the setKey, `num-` at the end) rather than by counting
  // — a 8-part slug can be either one.
  if (parts.length < 7 || parts.length > 9) return null;
  const [, sport, yearStr, setKey] = parts;
  let rest = parts.slice(4);
  let subsetSlug: string | null = null;
  if (rest.length && rest[0].startsWith("sub-")) {
    subsetSlug = rest[0].slice("sub-".length);
    if (!subsetSlug) return null;
    rest = rest.slice(1);
  }
  if (rest.length !== 3 && rest.length !== 4) return null;
  const [cardNumber, parallelSlug, autoFlag, printRunPart] = rest;
  const year = Number(yearStr);
  if (!Number.isFinite(year) || year <= 0) return null;
  if (autoFlag !== "auto" && autoFlag !== "no-auto") return null;
  let printRun: number | null = null;
  if (printRunPart) {
    if (!printRunPart.startsWith("num-")) return null;
    const n = Number(printRunPart.slice(4));
    if (!Number.isFinite(n) || n <= 0) return null;
    printRun = n;
  }
  return {
    sport,
    year,
    setKey,
    cardNumber,
    parallel: parallelSlug,
    isAuto: autoFlag === "auto",
    printRun,
    // The slug carries the SLUG of the subset, not the checklist's words, so
    // this is the round-trippable form and not a display name. `subsetInId` is
    // stated because the segment being present IS the clash flag.
    ...(subsetSlug ? { subsetName: subsetSlug, subsetInId: true } : {}),
  };
}
