/**
 * CF-THE-ID-CARRIES-THE-PRODUCT (D23; Drew, 2026-08-30 19:50Z, ruled in
 * detail): "the id's setKey is the product as the checklist names it."
 *
 * THE DEFECT THIS ENDS. computeHobbyIqCardId collapsed the product into its
 * family: "2024 Topps Series 1" minted `topps`, "Topps Update Series" minted
 * `topps-update`, "Topps Chrome Update Series" minted `topps-chrome`,
 * "Bowman Draft 1st Edition" minted `bowman-draft`, "Upper Deck Series 1"
 * minted `upper-deck`, "Topps Heritage High Number" minted `topps-heritage`,
 * every Leaf product minted `leaf` -- while the row's own setKey FIELD kept
 * the real product. Measured 2026-08-30, read-only, un-graded rows whose id
 * disagrees with their own setKey field: 1,231,457 across the ruled keys
 * (topps-series-2 216,000 / topps-series-1 213,796 / topps-chrome-update-
 * series 152,996 / topps-update-series 142,993 / leaf-metal 109,618 /
 * leaf-vivid 109,224 / topps-heritage-high-number 39,820 / upper-deck-
 * series-2 17,162 / upper-deck-series-1 11,558 / bowman-draft-1st-edition
 * 3,427; Donruss 208,036 -- see the era rule below). The movers (isAuto,
 * one-of-one, the cross-source fold) refused about half their rows on it,
 * because a key needs both halves and these rows had two.
 *
 * THE RULINGS, as data:
 *   (a) the id carries the full product exactly as the checklist names it,
 *       ONE spelling per product -- this table is where the spellings live;
 *       `names` are the other spellings the checklists and the sellers use,
 *       written as slugify emits them (year and sport stripped), because a
 *       rule written against a product's NAME rather than against what
 *       slugify actually produces for it never fires
 *       (CF-PANINI-PRODUCTS-MISSING-FROM-VOCAB);
 *   (b) the maker prefix is KEPT on Panini-era products ("2025 Panini
 *       Donruss" -> panini-donruss; a 1990 Donruss checklist says Donruss ->
 *       donruss). Measured 2026-08-30: every baseball checklist source names
 *       the modern product "Donruss" (519,422 rows; checklistcenter,
 *       checklistinsider, baseballcardpedia, beckett all), "Panini Donruss"
 *       appears only in football (cardboardconnection, hobbymonitor) and in
 *       derived rows -- so the NAME cannot carry the ruling by itself and
 *       the ERA does: DONRUSS_SPELLING_POLICY below, a named policy Drew can
 *       flip, default `panini-era` (the acquisition year decides, exactly
 *       the 2009 boundary CF-PANINI-IS-ANACHRONISTIC-BEFORE-2009 pinned),
 *       alternative `as-named` (the name decides, year-independent);
 *   (c) the product FAMILY (`topps` contains `topps-series-1`; `bowman-chrome`
 *       contains its prospects/updates/mega-box spellings; `bowman-draft` is
 *       NOT `bowman-draft-1st-edition`; sapphire never crosses) exists ONLY
 *       for pricing fallbacks (crossSetKeyRule via productFamilyKey) and for
 *       narrowing (the matcher's family step, the reference ladder), never
 *       for identity -- and it is read from THIS table, never derived from a
 *       string prefix of the key (`split("-").slice(0, 2)` was the family;
 *       it made `topps-series-1` and `topps-sapphire` siblings and could not
 *       say that 1st Edition is another set);
 *   (d) card-number spelling keeps the checklist's hyphen; every match is
 *       hyphen-insensitive (sameCardNumber / cardNumberVariants in
 *       hobbyIqCardId.service).
 *
 * WHAT IS NOT HERE. The regex vocabulary in hobbyIqCardId.service still
 * handles every product this table does not name, catch-alls included, so a
 * product the table does not know is still collapsed to its brand by the
 * `/topps/`, `/bowman/`, `/leaf/` rules. Naming a product is one row here;
 * the Leaf rows below were taken from the measured field spellings of
 * 2026-08-30 for exactly that reason. This module imports nothing from the
 * slug generator, so it can be read by everything that does.
 */

export type DonrussSpellingPolicy = "panini-era" | "as-named";

/** Drew's ruling (b), as a switch: `panini-era` -- Donruss from 2009 on is
 *  `panini-donruss` and before it `donruss`, whatever the text said;
 *  `as-named` -- "Panini Donruss" is `panini-donruss` and "Donruss" is
 *  `donruss` in every year. Compile-time on purpose: an identity policy read
 *  from the environment would mint different ids on different machines. */
export const DONRUSS_SPELLING_POLICY: DonrussSpellingPolicy = "panini-era";
/** Panini acquired Donruss in 2009 (CF-PANINI-IS-ANACHRONISTIC-BEFORE-2009). */
export const PANINI_DONRUSS_FROM_YEAR = 2009;

/**
 * CF-THERE-IS-NO-FLEER-TIFFANY (Drew, 2026-09-05).
 *
 * "Tiffany" is a TOPPS line. Fleer's factory/coated products of the 1980s are
 * FLEER GLOSSY -- the 1987-1989 Glossy Tin ("Custom Coated Collector's
 * Edition"), plus Fleer Update Glossy 1987-1988. There is no 1980s Fleer
 * Tiffany product, and there never was; #1748 already staged those five years
 * under `fleer-glossy` / `fleer-update-glossy` and pinned that 1990/1991 have
 * no Glossy page at all.
 *
 * The market does not know that. Measured on the pool 2026-09-04, nine 1987
 * sales carry BOTH words -- "1987 Fleer **GLOSSY** #369 Bo Jackson ROOKIE
 * TIFFANY", "1987 Fleer Update Glossy (Tiffany) Greg Maddux RC #U-68". Those
 * titles already resolve correctly, because `glossy` wins the vocabulary when
 * both words appear. The gap is the title that says Tiffany and NOTHING else:
 *
 *     normalizeSetKey("1987 Fleer Tiffany") -> "fleer-tiffany"
 *
 * -- a product that does not exist in 1987, so the sale lands in a pool with
 * no checklist behind it and no other sale to price against. This maps it to
 * the product the seller is actually describing.
 *
 * WHY AN ERA RULE AND NOT A REWRITE. `fleer-tiffany` IS a real product from
 * 1996 -- 1996/1997 Fleer Tiffany (the pack-inserted coated parallel),
 * 1997-98 Fleer Tiffany basketball, 2002 Fleer Tiffany (/200), and the source
 * serves every one of them at its own set page under that name. 848 pool rows
 * sit on the key today and ALL 848 have titles that say "Tiffany"; not one is
 * from the 1980s. A blanket rewrite would destroy a real product's pool to fix
 * a nine-row misnomer. The year is what separates them, so the year is what
 * decides -- exactly as it does for Donruss above.
 *
 * The boundary is the last year Fleer made a coated set under the Glossy name.
 * Below it a Tiffany key is a misnomer for Glossy; from it, the key is the
 * product the source names.
 */
export const FLEER_TIFFANY_IS_GLOSSY_BEFORE_YEAR = 1996;

/** The 1980s Glossy products a "Fleer Tiffany" text is a misnomer for. */
const FLEER_TIFFANY_ERA_MISNOMERS: Readonly<Record<string, string>> = Object.freeze({
  "fleer-tiffany": "fleer-glossy",
  "fleer-update-tiffany": "fleer-update-glossy",
});

/**
 * CF-METAL-UNIVERSE-NAME-WAS-REVIVED (Drew, 2026-09-12, #2060 follow-on).
 *
 * THE SHAPE IS THE FLEER-TIFFANY SHAPE, NOT A KEY-SPELLING TWIN. R22 ("a
 * key-spelling twin folds onto the checklist key") was the first read of this
 * defect: sportscardchecklist's 1996-1998 baseball checklists for Metal
 * Universe are filed bare (`metal-universe`), while a "1997 Skybox Metal
 * Universe" title normalizes to `skybox-metal-universe` — looks like the same
 * product under two spellings. It is not. Measured read-only against prod
 * card_catalog 2026-09-12, `skybox-metal-universe` is a REAL, currently
 * produced Upper Deck hockey/multi-sport revival with its own checklists:
 *
 *     skybox-metal-universe  2020-2025  19,462 hockey + ~250 basketball/
 *                            multi-sport/other rows, checklistcenter-2026-09-06
 *                            (8,326) and checklistinsider (10,830 more) —
 *                            genuinely checklist-backed, its own product.
 *     skybox-metal-universe  1996-1999  ~45 baseball + ~86 football rows,
 *                            sources `ingest-auto-seed`/`sales-attested`/
 *                            `user-verified` ONLY — zero checklist rows.
 *                            Sample content is garbage (an "ingest-auto-seed"
 *                            row at #23 reads "Michael Jordan Championship").
 *     metal-universe         1996-1999  5,237 baseball rows, the plurality
 *                            `sportscardchecklist-2026-09-06` and
 *                            `baseballcardpedia*` — checklist-backed. Chipper
 *                            Jones #31 lives here (`hiq:baseball:1997:
 *                            metal-universe:31:base:no-auto`).
 *
 * A blanket `skybox-metal-universe` -> `metal-universe` alias — R22 applied
 * literally — would fold 19,700+ real modern hockey/multi-sport checklist
 * rows into the 1990s baseball pool: the opposite of "one card, one row, one
 * pool". Even SPORT alone does not separate the two eras cleanly: baseball
 * itself carries a 12-row 2021 cohort under the same key, alongside the real
 * 1997-1999 vintage cohort.
 *
 * THE RULE THIS ACTUALLY IS. Exactly CF-THERE-IS-NO-FLEER-TIFFANY's shape:
 * "Skybox Metal Universe" written on a card from BEFORE Skybox's 2020s revival
 * is a misnomer for the one Metal Universe product that existed then — Fleer
 * printed it as plain "Metal Universe" from 1996 (Skybox and Fleer were both
 * Marvel Entertainment brands by then; sportscardchecklist's own checklist
 * pages for 1996-1998 carry no maker qualifier at all, see
 * data/checklists/scraped/1996–1998-metal-universe-baseball.csv). FROM the
 * revival's first year the key is the product the source actually names, and
 * passes through untouched — exactly as a post-1996 "Fleer Tiffany" does.
 *
 * THE BOUNDARY. 2000 — a full year past the last vintage checklist year found
 * (1999) and two decades before the earliest revival-era row found (2020), so
 * there is no evidence on either side of the boundary to contradict it; unlike
 * Donruss/Fleer-Tiffany this date is not itself Drew-ruled, only bounded by
 * measurement, so treat it as an ASSUMPTION the way ERA_SPLIT_TABLE's
 * unruled entries already are.
 *
 * `fleer-metal-universe` is NOT included here. It carries a single
 * `user-verified` catalog row (1996) and zero checklist rows on either side —
 * no measured collision to rule on, and CF-NO-SYNTHETIC-PARALLELS means this
 * table does not invent a destination a checklist has not written.
 */
export const METAL_UNIVERSE_REVIVAL_FROM_YEAR = 2000;

/** The vintage Fleer/Skybox-era product a "Skybox Metal Universe" text
 *  before the revival is a misnomer for. */
const METAL_UNIVERSE_ERA_MISNOMERS: Readonly<Record<string, string>> = Object.freeze({
  "skybox-metal-universe": "metal-universe",
});

/**
 * R51 AMENDED (Drew, 2026-09-18): THE 2006 "GREATS OF THE GAME" IS FLEER'S.
 *
 * The product prints NO MAKER. 4,796 of its 4,797 checklist-backed catalog
 * rows spell the setName "2006 Greats of the Game" — no Fleer, no Upper Deck —
 * which is why R51's original attribution to Upper Deck was doubted and sent
 * back: the 2006 `upper-deck` pool holds ZERO rows titled Greats of the Game.
 * Drew's amendment keys it to `fleer-greats-of-the-game`, the maker the line
 * belongs to and the key #2232 already registered for 2000-2004.
 *
 * IT IS YEAR-GATED BECAUSE THE KEY IS NOT 2006-ONLY, which a glance would
 * miss. `greats-of-the-game` carries 4,801 rows: the 4,797 from 2006, plus ONE
 * each in 2000, 2001, 2002 and 2004. Those four are `bccp-product-structure`
 * stubs — no player, no card number, no hiq id, ids of the form
 * `product-structure:2001-greats-of-the-game`. They are placeholders for
 * products whose own checklists are an open acquisition (2001/2002 are #2234's
 * subject), NOT 2006 cards, and folding them into a 2006 ruling would attribute
 * four other years' products on no evidence.
 *
 * So the rule is gated to the ONE year Drew ruled on, and an absent year
 * decides nothing — the same refusal the two tables above already make.
 * Every other "Greats of the Game" spelling is untouched: `donruss-greats`
 * (2005, 1,302 checklist rows) and `sports-illustrated-greats-of-the-game`
 * (1999, 416) are registered fixed points from #2232 and never reach here.
 */
export const GREATS_OF_THE_GAME_FLEER_YEAR = 2006;

/** The bare key the 2006 release is spelled with, and the maker key it is. */
const GREATS_OF_THE_GAME_ERA_MAKER: Readonly<Record<string, string>> = Object.freeze({
  "greats-of-the-game": "fleer-greats-of-the-game",
});

/**
 * R75 (Drew, 2026-09-19): TWO Bowman Mega Box product keys from 2026, ONE
 * before. Through 2025 a "Bowman Mega Box" title (with or without the word
 * "Chrome") names ONE product, `bowman-chrome-mega-box` — unchanged by this
 * ruling, still the vocabulary's own year-agnostic fold and still the pinned
 * outcome in tests/setKeyReconciliation.test.ts. From 2026 the two releases
 * ship as separate products with DIFFERENT rosters at the SAME card numbers
 * (#52 Shohei Ohtani, plain Mega Box, May 2026 vs #52 JJ Wetherholt, Chrome
 * Mega Box, Sept 2026) — the same card-coincidence test
 * CF-BOWMAN-MEGA-BOX-DISTINCT already used to split Mega Box from flagship
 * Bowman Chrome in the first place.
 *
 * The actual redirect (bare "Bowman Mega Box" text, year >= this boundary,
 * no "chrome" in the title -> `bowman-mega`) lives in
 * hobbyIqCardId.service.ts's resolveSetKeyForSlug, the one call site with
 * both the raw setName text and the year in hand — spellForEra only ever
 * receives the already-vocabulary-collapsed setKey, which cannot be told
 * apart from a genuine "Bowman Chrome Mega Box" title by the time it gets
 * here. This constant is the shared boundary so the two files cannot drift.
 */
export const BOWMAN_MEGA_BOX_SPLIT_FROM_YEAR = 2026;

/**
 * CF-A-CHECKLIST-ROW-SPELLS-ITS-ERA-LIKE-A-SALE-DOES (Drew, 2026-09-05).
 *
 * THE DEFECT. `ERA_SPLIT_TABLE` (setKeyReconciliation.ts) rules that Score,
 * Leaf, Fleer and Skybox take the BARE key in every year — `makerKey: null`,
 * "no synthetic products": a maker prefix no checklist has ever written is not
 * a destination we may invent. That table had NO code consumer. It was
 * evidence for a boundary, read only by `build-reconciliation.cjs`, while the
 * actual spelling decision lived in `spellForEra` — which knew about Donruss
 * and Fleer-Tiffany and nothing else. A ruling with no call site is a comment.
 *
 * So the vocabulary's strict Panini tier kept minting the key the table
 * forbids. `normalizeSetKey` matches `/panini-score/` BEFORE `/(?:^|-)score/`,
 * so "2025 Panini Score Football" — the product's own published title, and
 * exactly what a checklist page is called — resolved to `panini-score`, and
 * `spellForEra` passed it straight through. Measured on prod 2026-09-05:
 *
 *     card_catalog panini-score   3,702 rows (3,300 STRICT, hobbymonitor-2026-09-04)
 *     card_catalog score         58,985 rows (19,395 of 2025 football alone,
 *                                             all checklistinsider — STRICT)
 *     sold_comps   :panini-score: 35,174 pool rows
 *
 * One product, two spellings, two pools, and the FMV of a 2025 Score card
 * depends on which spelling its sale happened to parse into. That is the
 * split-pool failure `one card, one row, one pool` exists to prevent.
 *
 * THE RULE. The era table's never-acquired brands are enforced HERE, in the
 * one deriver every seam already calls, so a checklist row and a sale spell
 * the year identically. `makerKey: null` means the prefix is stripped in every
 * year, which is why this needs no year to fire — unlike the Donruss split
 * below, which has a real boundary to sit on.
 *
 * NOT A NEW VOCABULARY. This is the era table's own ruling, given the call
 * site it never had. Donruss is deliberately absent: it is the one brand with
 * a REAL two-owner split (`makerKey: "panini-donruss"`, 292,792 rows against
 * 116,723), and the year-boundary rule below already spells it.
 *
 * Measured the same day, the other three are already clean — `panini-leaf`,
 * `panini-fleer` and `panini-skybox` hold ZERO card_catalog rows of any kind,
 * against 41,365 / 118,756 / 6,564 on the bare keys. They are pinned here so
 * the next source that writes one is corrected at mint rather than discovered
 * in a census months later, which is how `panini-score` was found.
 */
const NEVER_ACQUIRED_MAKER_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  "panini-score": "score",
  "panini-leaf": "leaf",
  "panini-fleer": "fleer",
  "panini-skybox": "skybox",
});

/**
 * CF-SOCCER-PRIZM-IS-PRIZM-FIFA (Drew, 2026-09-05).
 *
 * THE DEFECT IS THE BARE TITLE, AND ONLY THE BARE TITLE. Measured on the
 * baseline 2026-09-05, an EXPLICIT FIFA title already resolves correctly:
 * `normalizeSetKey("2025 Panini Prizm FIFA") === "panini-prizm-fifa"`, because
 * that key is a RECONCILED FIXED POINT (reconcileSetKey returns final:true)
 * and short-circuits ahead of the unanchored `/panini-prizm/` pattern that
 * would otherwise swallow the qualifier. So the vocabulary is not broken and
 * this ruling does not rewrite it.
 *
 * What the vocabulary CANNOT do is read a title that says only "Panini Prizm".
 * It is sport-blind by construction, and the bare text is genuinely ambiguous:
 * it is the FLAGSHIP in football and basketball and the FIFA release in
 * soccer 2025. Only a deriver that knows the SPORT can tell those apart. That
 * is the entire gap this rule closes, and it is why the rule lives at
 * `resolveSetKeyForSlug` and NOT in `normalizeSetKey`.
 *
 * Measured read-only against prod 2026-09-05:
 *
 *   card_catalog soccer/2025  setKey `panini-prizm-fifa`  30,773 rows, ALL
 *                             STRICT (checklistinsider-2026-08-27/29) — and
 *                             EVERY ONE carries the id stem
 *                             `hiq:soccer:2025:panini-prizm:`. The checklist
 *                             ingest wrote the right FIELD and the deriver
 *                             collapsed the id, which is the whole defect in
 *                             one row.
 *   card_catalog soccer/2025  setKey `panini-prizm`  21 rows, all
 *                             self-derived (ingest-auto-seed / -graded), ZERO
 *                             strict.
 *   sold_comps   soccer/2025  segment 3 exactly `panini-prizm`  2,385 rows.
 *
 * So the checklist weight is entirely on `panini-prizm-fifa` and the pool is
 * entirely on `panini-prizm`: one product, two spellings, and a 2025 FIFA
 * card's FMV depends on which spelling its sale parsed into. That is the
 * split-pool failure CF-ONE-CARD-ONE-ROW-ONE-POOL exists to prevent.
 *
 * WHY THIS IS SPORT-SCOPED AND NOT AN ALIAS. `panini-prizm` is the CORRECT,
 * fixed-point key for FOOTBALL and BASKETBALL Prizm — the flagship of both,
 * with millions of pool rows. A flat alias `panini-prizm -> panini-prizm-fifa`
 * in RULED_ALIASES would move every NFL and NBA Prizm sale into a soccer
 * product. Drew ruled this explicitly: "a SPORT-SCOPED (and year-scoped)
 * resolution, not a global alias". The SPORT is what separates them, exactly
 * as the YEAR separates Donruss's two owners and Fleer Tiffany from Fleer
 * Glossy above — the same shape, a different axis.
 *
 * ABSENT BEATS WRONG. Panini and Topps both publish other soccer competition
 * products (Prizm Premier League, Topps UEFA Club Competitions). A title whose
 * COMPETITION NAMES THE PRODUCT is not this release and must not fold into it.
 * Note carefully what that does NOT mean: a league word describing the
 * PLAYER'S CLUB is not a product name. Measured on the same pool, six titles
 * read "Panini Prizm FIFA ... Jude Bellingham #186 Real Madrid La Liga" — a
 * Prizm FIFA card whose title mentions where the player plays. A naive
 * "mentions another competition -> park" rule would have parked genuine FIFA
 * cards, so the test is adjacency to the PRODUCT word, and FIFA present
 * anywhere settles it.
 *
 * A BARE SOCCER PRIZM IS THIS PRODUCT. Drew ruled that a 2025 soccer title
 * saying only "Panini Prizm" resolves here too: 98.8% of the pool is FIFA by
 * title, Panini published no other bare-Prizm soccer release that year, and
 * the 30,773-row checklist is the only soccer/2025 Prizm checklist we hold.
 *
 * THE YEAR. 2025 is the measured release (2025-26). The boundary is a
 * constant rather than an open range so a future soccer Prizm release under a
 * different competition cannot be swallowed by a rule nobody revisited.
 */
export const PRIZM_FIFA_SPORT = "soccer";
/** The release years the soccer ruling covers (the 2025-26 product). */
export const PRIZM_FIFA_YEARS: ReadonlySet<number> = new Set([2025]);
/** The flagship spelling a soccer Prizm sale collapses into today. */
const PRIZM_FIFA_SOURCE_KEYS: ReadonlySet<string> = new Set(["panini-prizm"]);
/** The one spelling of the FIFA product. */
export const PRIZM_FIFA_KEY = "panini-prizm-fifa";

/**
 * True when this (sport, year) cell is the one Drew's soccer ruling covers.
 * Football and basketball answer FALSE here in every year, which is the whole
 * point: `panini-prizm` stays the fixed point of the FB/BK flagship.
 */
export function isPrizmFifaCell(sport: string | null | undefined, year: number | null | undefined): boolean {
  if (String(sport ?? "").trim().toLowerCase() !== PRIZM_FIFA_SPORT) return false;
  const y = Number(year);
  return Number.isFinite(y) && PRIZM_FIFA_YEARS.has(y);
}

/**
 * The soccer ruling as a spelling: inside the ruled (sport, year) cell a
 * `panini-prizm` key IS `panini-prizm-fifa`. Outside it — every football and
 * basketball row, every other year — the key passes through untouched.
 *
 * Deliberately separate from `spellForEra`: that function takes (setKey,
 * year) and is called from three seams, only one of which knows the sport.
 * Widening its signature would silently pass `undefined` for sport at the
 * other two and make the rule fire nowhere. Instead this is applied at
 * `resolveSetKeyForSlug`, the ONE deriver that has the sport in hand and
 * through which every seam already computes an id.
 */
export function spellForSport(setKey: string, sport: string | null | undefined, year: number | null | undefined): string {
  const k = String(setKey ?? "").trim().toLowerCase();
  if (!k) return setKey;
  if (!PRIZM_FIFA_SOURCE_KEYS.has(k)) return setKey;
  return isPrizmFifaCell(sport, year) ? PRIZM_FIFA_KEY : setKey;
}

/**
 * Does this sale title name a DIFFERENT competition's PRODUCT?
 *
 * Used by the pool lane to decide, per row, whether a `panini-prizm` soccer
 * sale is this release. `true` means PARK the row where it is: absent beats
 * wrong, and a Topps UEFA card must never be filed as Panini Prizm FIFA.
 *
 * The FIFA words win outright wherever they appear, because a title that says
 * FIFA has named the product; the competition test only ever decides a title
 * that does not. And the competition must sit ADJACENT TO THE PRODUCT WORD —
 * "Prizm Premier League", "Topps UEFA" — never merely be mentioned, or the
 * six measured "Prizm FIFA ... Real Madrid La Liga" rows would park.
 */
const RX_FIFA_STATED = /\bfifa\b|\bworld\s*cup\b/i;
/**
 * A SIBLING FIFA-BRANDED RELEASE that is NOT this product.
 *
 * MEASURED 2026-09-05, and it is why this predicate is not simply "does the
 * title say FIFA". The id stem `hiq:soccer:2025:panini-prizm:` carries THREE
 * products in the catalog, collapsed by the same bare-title defect:
 *
 *     30,773  setKey `panini-prizm-fifa`                  <- Drew's ruling
 *     18,230  setKey `panini-prizm-fifa-club-world-cup`   <- ANOTHER product
 *      4,111  setKey `panini-prizm-k-league`              <- ANOTHER product
 *
 * and the pool carries them too: of the 2,383 rows on the flagship segment,
 * 496 are Club World Cup by title. Those 496 SAY "FIFA" -- "2025 Panini Prizm
 * FIFA Club World Cup Endrick Real Madrid #159" -- so the FIFA test alone
 * would fold them into the wrong pool. That is the split-pool failure this
 * ruling exists to prevent, made worse by FUSING TWO REAL PRODUCTS.
 *
 * The Club World Cup is a distinct tournament with a distinct 18,230-row
 * checklist under its own key, and `normalizeSetKey` already spells it
 * correctly whenever the title carries the FIFA word; what it cannot spell is
 * the bare "Panini Prizm Club World Cup" form, which collapses to the
 * flagship exactly as the plain bare title does. So these rows PARK: they are
 * not this product, their own key exists, and moving them here would be
 * wrong. Folding them onto their OWN key is a separate scope and a separate
 * ruling -- absent beats wrong.
 */
const RX_SIBLING_FIFA_RELEASE = new RegExp([
  String.raw`\bclub\s*world\s*cup\b`,
  String.raw`\bk-?league\b`,
].join("|"), "i");
/** Another competition ADJACENT TO the product word — the product, not the
 *  player's club. */
const RX_OTHER_COMPETITION = new RegExp([
  String.raw`\bprizm\s+(?:premier\s*league|epl|la\s*liga|serie\s*a|bundesliga|ligue\s*1|champions\s*league|uefa|mls|eredivisie|liga\s*mx|nwsl|wsl)\b`,
  String.raw`\b(?:premier\s*league|epl|la\s*liga|champions\s*league|uefa)\s+prizm\b`,
  String.raw`\btopps\s+(?:uefa|champions\s*league|premier\s*league)\b`,
  String.raw`\bpanini\s+(?:premier\s*league|la\s*liga|serie\s*a|bundesliga|mls|nwsl)\b`,
].join("|"), "i");

/** True when the title names another competition's product and never says
 *  FIFA — the row is PARKED rather than folded. */
export function titleNamesOtherCompetition(title: string | null | undefined): boolean {
  const t = String(title ?? "");
  if (!t) return false;
  // A SIBLING FIFA-branded release is checked FIRST, ahead of the FIFA test:
  // these titles DO say FIFA and are still not this product.
  if (RX_SIBLING_FIFA_RELEASE.test(t)) return true;
  if (RX_FIFA_STATED.test(t)) return false;
  return RX_OTHER_COMPETITION.test(t);
}

export interface ProductSetKey {
  /** The one spelling. */
  readonly setKey: string;
  /** True when THIS TABLE decides the product's spelling (the D23 products):
   *  the key and its `names` take part in productSetKeyForName, ahead of the
   *  regex vocabulary. Every other entry carries family / parent data only
   *  and leaves its spelling to the vocabulary's own ordering — "Bowman
   *  Chrome Prospects" must still fold to bowman-chrome and "Upper Deck SPx
   *  Finite" to spx-finite, and a `bowman-chrome` name matched as a segment
   *  run would pre-empt both. */
  readonly spelled?: boolean;
  /** Other spellings of the same product, as slugify emits them with the
   *  year and the sport already stripped. A single-segment name matches a
   *  product text only exactly; a multi-segment name also matches as a
   *  contiguous run of segments inside a longer text ("topps-update-series-
   *  hobby-box"), longest name first. Only consulted when `spelled`. */
  readonly names?: readonly string[];
  /** The pricing family. Defaults to the key itself: a product is its own
   *  family unless the table says otherwise. */
  readonly family?: string;
  /** The immediate parent for the reference / verify walk (the flagship this
   *  is a release of). Defaults to none. */
  readonly parent?: string | null;
  /** The plain product this one is a VERIFIED refinement of, for the
   *  matcher's widening (CF-VERIFIED-REFINEMENTS-ONLY): the series split and
   *  the update series of a flagship. 1st Edition is another set, not a
   *  refinement. */
  readonly refines?: string;
}

type Opts = { spelled?: boolean; names?: readonly string[]; family?: string; parent?: string | null; refines?: string };
const P = (setKey: string, o: Opts = {}): ProductSetKey => ({ setKey, ...o });
/** A product whose spelling THIS table decides (see `spelled`). */
const S = (setKey: string, o: Opts = {}): ProductSetKey => ({ setKey, spelled: true, ...o });

/** The table. Order is irrelevant; lookups are by name and by key. */
export const PRODUCT_SET_KEYS: ReadonlyArray<ProductSetKey> = [
  // -- Topps flagship and its verified refinements ---------------------------
  P("topps"),

  /**
   * CF-A-NAMED-INSERT-SET-IS-ITS-OWN-CARD-SET, R48 (Drew, 2026-09-15).
   *
   * Three 2026 Topps Series 1 sections the pool carries as though they were
   * base PARALLELS. They are not: the source states `75 Years of Topps` at
   * /75 in its own ladder line, and `Chicks` and `Flowers` are named insert
   * sets, not finishes of the base card. Registered qualified so a bare
   * `chicks` can never answer for a card in some other product.
   *
   * KEYS ONLY, NO PACKAGE. Measured directly against the pool on 2026-09-15
   * rather than estimated: `chicks` 415 rows, `75-years-of-topps` 257,
   * `flowers` 54 -- 726 together. All three are under the 500-row bar that
   * decides whether a ladder package is worth building, so the keys land here
   * (they cost nothing and stop the rows folding onto base) and no checklist
   * is acquired for them yet.
   *
   * The earlier round-2 estimate put these at ~6,700 rows. That figure came
   * from scaling 500-row-per-class census samples, which ranks cells correctly
   * and sizes them badly -- it over-counted this group about 9x.
   */
  S("topps-chicks", { family: "topps", parent: "topps" }),
  S("topps-flowers", { family: "topps", parent: "topps" }),
  S("topps-75-years-of-topps", { family: "topps", parent: "topps" }),
  S("topps-series-1", { names: ["topps-series-one", "topps-s1"], family: "topps", parent: "topps", refines: "topps" }),
  S("topps-series-2", { names: ["topps-series-two", "topps-s2"], family: "topps", parent: "topps", refines: "topps" }),
  // "2024 Topps Series 1 1st Edition" is another set (as 1st Edition always
  // is); the sport word leaked into one measured spelling.
  S("topps-series-1-1st-edition", { names: ["topps-series-1-baseball-1st-edition", "topps-series-1-first-edition", "topps-1st-edition"], parent: "topps-series-1" }),
  S("topps-series-1-celebration-mega-box", { family: "topps-series-1", parent: "topps-series-1" }),
  S("topps-series-1-tokyo-series-mega-box", { family: "topps-series-1", parent: "topps-series-1" }),
  // Topps Update: baseballcardpedia names it "Topps Update" (630k rows),
  // checklistcenter / checklistinsider / beckett "Topps Update Series"; Drew
  // ruled the full name. 2006-2009 it was "Topps Updates & Highlights", a
  // different name for a different release, kept as the checklist names it.
  S("topps-update-series", { names: ["topps-update", "topps-update-chrome"], family: "topps", parent: "topps", refines: "topps" }),
  S("topps-updates-and-highlights", { names: ["topps-updates-highlights", "topps-update-and-highlights", "topps-update-highlights"], family: "topps", parent: "topps", refines: "topps" }),
  // A vendor spelling with its own regex rule; spelled here so the longer
  // name wins over the `topps-update` alias above.
  S("topps-update-sapphire", { parent: "topps-update-series" }),
  // TOPPS THREE IS TOPPS 3 (Drew's Ruling 22, 2026-09-09). One product, two
  // spellings: hobbymonitor writes "2023/24 Topps Three Basketball", the
  // checklist writes "2023 topps 3". Count-by-source decides the spelling and
  // the checklist-backed side wins, so `topps-3` is canonical and
  // `topps-three` is its alias.
  //
  // AND THIS IS ALSO A CATCH-ALL FIX, which is why it belongs in the PRODUCT
  // table rather than only in RULED_ALIASES. Measured on this branch BEFORE
  // the change, "Topps Three" did not normalize to `topps-three` at all — it
  // fell through every rule to the bare `/topps/` family pattern and came back
  // `topps`, the flagship. That is CF-FLAGSHIP-CATCHALL-SWALLOWS-
  // SPECIALIZATIONS exactly: a specialized product answered by the family key,
  // which pools Topps Three cards with flagship Topps. Naming the product here
  // stops the catch-all before it can answer, and the alias folds the vendor
  // spelling onto the checklist's.
  S("topps-3", { names: ["topps-three"], family: "topps", parent: "topps", refines: "topps" }),
  P("topps-chrome", { parent: "topps" }),
  S("topps-chrome-update-series", { names: ["topps-chrome-update"], family: "topps-chrome", parent: "topps-chrome", refines: "topps-chrome" }),
  S("topps-chrome-updates-and-highlights", { names: ["topps-chrome-updates-highlights"], family: "topps-chrome", parent: "topps-chrome", refines: "topps-chrome" }),
  S("topps-chrome-update-sapphire", {
    names: ["topps-chrome-update-sapphire-edition", "topps-chrome-update-series-sapphire", "topps-chrome-update-series-sapphire-edition", "topps-update-sapphire-chrome", "topps-sapphire-chrome-update"],
    parent: "topps-chrome-update-series",
  }),
  P("topps-chrome-sapphire", { parent: "topps-chrome" }),
  P("topps-chrome-platinum", { parent: "topps-chrome" }),
  P("topps-chrome-black", { parent: "topps-chrome" }),
  // R64 (Drew, 2026-09-18). Two Chrome editions the title reader could not
  // see, so every sale naming them pooled with flagship Chrome. Registered so
  // the keys are deliberate rather than surviving by luck -- nothing claimed
  // them, but nothing declared them either.
  //
  // BEN BALLER: one product, two spellings, both fully checklist-backed over
  // the same years (2020-22) from DIFFERENT sources --
  //
  //   topps-chrome-ben-baller          7,301 rows   checklistcenter x3
  //   topps-chrome-ben-baller-edition  2,157 rows   baseballcardpedia, beckett
  //
  // Count by source decides the canonical spelling, so the `-edition` form is
  // an ALIAS, not a rival product. (`no synthetic parallels` at the product
  // level: two spellings of one release are not two releases.)
  S("topps-chrome-ben-baller", {
    names: ["topps-chrome-ben-baller-edition"],
    family: "topps-chrome", parent: "topps-chrome", refines: "topps-chrome",
  }),
  // SONIC LITE: "Sonic" and "Sonic Lite" are ONE release, verified against two
  // sources rather than assumed. Cardboard Connection's `2022-topps-chrome-
  // sonic-baseball-cards` URL serves the LITE page ("Topps Chrome Sonic LITE
  // bursts into hobby shops for the first time"), and checklistcenter names it
  // "2022 Topps Chrome Sonic Lite Baseball" with a 10-card Base Image
  // Variation Set at 1:6399 -- cards 35, 83, 113, 128, 133, 221-225 -- which
  // is exactly BCP's "Gimmicks | 10 | - | 1:6399" from Ruling 23. The catalog
  // agrees: `topps-chrome-sonic-lite` holds 6,293 checklist-backed rows and
  // `topps-chrome-sonic` holds ZERO. So the bare spelling is an alias because
  // there is no distinct product for it to name -- not because one was folded.
  S("topps-chrome-sonic-lite", {
    names: ["topps-chrome-sonic"],
    family: "topps-chrome", parent: "topps-chrome", refines: "topps-chrome",
  }),
  P("topps-heritage", { parent: "topps" }),
  S("topps-heritage-high-number", { names: ["topps-heritage-high-numbers", "heritage-high-number", "heritage-high-numbers"], family: "topps-heritage", parent: "topps-heritage", refines: "topps-heritage" }),
  P("topps-traded", { parent: "topps" }),
  P("topps-traded-tiffany", { parent: "topps-traded" }),
  P("topps-tiffany", { parent: "topps" }),
  // D36, Drew 2026-08-30: "the product is topps-finest -- the product as Topps
  // names it, not `finest`". Spelled here so the rename fleet moves the
  // baseballcardpedia rows still keyed `finest` (58,442 measured 2026-08-30,
  // against 221,498 already `topps-finest`) and so Drew's Finest holdings
  // resolve. The bare-alias rule in hobbyIqCardId already minted topps-finest
  // for NEW ids; this table is what the fleet and the family walk read.
  S("topps-finest", { names: ["finest"], parent: "topps" }),
  S("topps-finest-flashbacks", { names: ["finest-flashbacks"], family: "topps-finest", parent: "topps-finest" }),
  ...["topps-gold-label", "topps-pristine", "topps-total", "topps-pro-debut", "topps-transcendent", "topps-dynasty", "topps-tribute",
    "topps-inception", "topps-definitive", "topps-five-star", "topps-museum-collection", "topps-gypsy-queen", "topps-archives",
    "topps-big-league", "topps-bunt", "topps-allen-ginter", "topps-stadium-club", "topps-cosmic-chrome", "topps-now",
    "topps-signature-class", "topps-resurgence", "topps-composite", "topps-cracker-jack"].map((k) => P(k, { parent: "topps" })),
  P("o-pee-chee"),

  // -- Bowman -----------------------------------------------------------------
  P("bowman"),
  P("bowman-paper", { family: "bowman", parent: "bowman" }),
  P("bowman-chrome", { parent: "bowman" }),
  // Vendor spellings of Bowman Chrome subsets (the pool carries them):
  // one family, per the ladder the matcher honours.
  P("bowman-chrome-prospects", { family: "bowman-chrome", parent: "bowman-chrome" }),
  P("bowman-chrome-updates", { family: "bowman-chrome", parent: "bowman-chrome" }),
  P("bowman-chrome-mega-box", { family: "bowman-chrome", parent: "bowman-chrome" }),
  // R75 (Drew, 2026-09-19): "Bowman Mega Box" (plain, no Chrome) becomes its
  // OWN product from 2026 — the May 2026 release, numbered 1..N with a
  // different roster than the Sept 2026 Bowman Chrome Mega Box at the SAME
  // numbers (#52 Ohtani here, #52 Wetherholt on bowman-chrome-mega-box; see
  // CF-BOWMAN-MEGA-BOX-DISTINCT, 2026-08-12, which first ruled Mega Box
  // distinct from flagship Bowman/Bowman Chrome). Its OWN family, not
  // bowman-chrome's — the cards do not coincide with Bowman Chrome's at all,
  // only with themselves across years — but `parent: "bowman"` for the
  // reference/verify walk, the same retail-exclusive relationship
  // bowman-paper has to flagship Bowman. Before 2026 both spellings
  // ("Bowman Mega Box" and "Bowman Chrome Mega Box") name ONE product,
  // bowman-chrome-mega-box — see spellForEra's BOWMAN_MEGA_BOX_ERA_MISNOMERS
  // in this file and the year-aware routing in hobbyIqCardId.service.ts.
  P("bowman-mega", { parent: "bowman" }),
  // The NSCC wrapper-redemption promo — its own product (BNR- numbering, its
  // own price curve) but still a Bowman Chrome child, like Mega Box above.
  P("bowman-chrome-nscc", { family: "bowman-chrome", parent: "bowman-chrome" }),
  P("bowman-chrome-draft", { family: "bowman-chrome", parent: "bowman-chrome" }),
  P("bowman-chrome-sapphire", { parent: "bowman-chrome" }),
  P("bowman-chrome-draft-picks-and-prospects", { family: "bowman-chrome", parent: "bowman-draft-picks-and-prospects" }),
  P("bowman-draft", { parent: "bowman" }),
  P("bowman-draft-chrome", { family: "bowman-draft", parent: "bowman-draft" }),
  P("bowman-draft-paper", { family: "bowman-draft", parent: "bowman-draft" }),
  P("bowman-draft-picks-and-prospects", { family: "bowman-draft", parent: "bowman" }),
  P("bowman-draft-sapphire", { parent: "bowman-draft" }),
  // 1st Edition is another set (D22; Drew: "first edition is another bowman
  // set"): its own family, so the cross-setkey rung never reaches Draft.
  S("bowman-draft-1st-edition", { names: ["bowman-draft-first-edition"], parent: "bowman-draft" }),
  S("bowman-1st-edition", { names: ["bowman-first-edition"], parent: "bowman" }),
  P("bowman-sterling", { parent: "bowman" }),
  P("bowman-heritage", { parent: "bowman" }),
  P("bowman-platinum", { parent: "bowman" }),
  P("bowmans-best", { parent: "bowman" }),
  P("bowman-best-university", { parent: "bowmans-best" }),
  // CF-BOWMANS-BEST-PREVIEW-IS-ITS-OWN-PRODUCT (Drew, 2026-09-06). The 20-card
  // BBP1-BBP20 insert that PREVIEWS Bowman's Best, packed out in 1997 Bowman
  // (baseball) and 1997-98 Topps Stadium Club (basketball). ONE key for both
  // sports -- it is one insert, and the sport segment of the id already keeps
  // the two rosters apart.
  //
  // The parent is `bowmans-best` because that is the product it previews and
  // the ladder the family walk should reach, but it is NOT a rung of it: its
  // cards carry their own BBP numbering, which is exactly what the 2026-09-06
  // incident proved when the insert was minted onto the parent's key and its
  // 1-20 numbering collided with Bowman's Best #1-#20 -- twenty different
  // cards at twenty occupied addresses.
  P("bowmans-best-preview", { parent: "bowmans-best" }),

  // -- Upper Deck -------------------------------------------------------------
  P("upper-deck"),
  S("upper-deck-series-1", { names: ["upper-deck-series-one"], family: "upper-deck", parent: "upper-deck", refines: "upper-deck" }),
  S("upper-deck-series-2", { names: ["upper-deck-series-two"], family: "upper-deck", parent: "upper-deck", refines: "upper-deck" }),

  /**
   * CF-A-NAMED-INSERT-SET-IS-ITS-OWN-CARD-SET, R42 and R43 (Drew, 2026-09-15).
   *
   * Two same-numbered subsets in the staged Upper Deck hockey package
   * (`acq-2026-09-14-cardboardconnection`), each of which refused its whole
   * file until it had a key. Registered qualified, like the R38 block below,
   * because a bare `o-pee-chee-retro-update` or `1994-95-rookie-tribute-die-cuts`
   * would not say WHICH Upper Deck product it belongs to.
   *
   * R42 `1994-95 Rookie Tribute Die-Cuts` (2019-20 Series 1, 10 clashing
   * addresses). It restarts at card 1 with its OWN players: #1 is Cale Makar
   * where the base print's #1 is Auston Matthews, #2 Filip Zadina against
   * William Nylander. Ten base cards were answering for two cards each.
   *
   * R43 `O-Pee-Chee Retro Update` (2021-22 Series 2, 40 clashing addresses).
   * This one is NOT a parallel, and that is the whole ruling: it carries
   * O-Pee-Chee Update's card numbers and 39 of 40 the same players, so it looks
   * like a rung -- but it is a distinct retro-design product with its OWN
   * parallel ladder (Black Border, Neon Green Border) running beside Update's
   * (Blue Border, Red Border). A named variation is a distinct card, so it
   * cannot fold onto Update as a colour.
   */
  S("upper-deck-series-1-1994-95-rookie-tribute-die-cuts", {
    family: "upper-deck-series-1", parent: "upper-deck-series-1",
  }),
  S("upper-deck-series-2-o-pee-chee-retro-update", {
    family: "upper-deck-series-2", parent: "upper-deck-series-2",
  }),
  // THE CLASH IS BETWEEN THE ROOKIES SUBSETS, and both sides need a key.
  // Measured on the staged file: card #611 is William Eklund RC in BOTH
  // `o-pee-chee-update--rookies` and `o-pee-chee-retro-update--rookies`, so
  // 40 addresses answered for two cards each. Same numbers, same players --
  // and DIFFERENT LADDERS, which is what makes them two products rather than
  // one printed twice: Update's rookies carry Blue Border and Red Border,
  // Retro Update's carry Black Border /100 and Neon Green Border /50.
  //
  // Registering only the Retro parent would have left the pair still colliding,
  // because neither ROOKIES subset is the parent. Both are registered.
  S("upper-deck-series-2-o-pee-chee-update-rookies", {
    family: "upper-deck-series-2", parent: "upper-deck-series-2",
  }),
  S("upper-deck-series-2-o-pee-chee-retro-update-rookies", {
    family: "upper-deck-series-2", parent: "upper-deck-series-2",
  }),
  /**
   * R67 (Drew, ruling round of 2026-09-19): 2023-24 UPPER DECK SERIES 2
   * HOCKEY -- "PC's" AND "POPULATION COUNT 1000" ARE TWO DIFFERENT PRODUCTS
   * THAT SHARE A NUMBER PREFIX BY COINCIDENCE.
   *
   * Measured directly against the staged checklist (upperdeck.com's own
   * inline HTML table, held pending this registration -- the ingest
   * planner refuses the staged file over exactly this pair, reason
   * unregistered-set-keys, until both keys exist). Per R67 (same
   * (cardNumber -> player) roster on every shared number is a PARALLEL;
   * different players/own numbering is its own product), these two do NOT
   * fold: "PC's" runs #PC-1 through #PC-35 (e.g. #PC-31 Filip Forsberg,
   * 3 rungs: PC's / Sparkle Parallel / Gold Sparkle Parallel, 105 staged
   * rows) and "Population Count 1000" runs #PC-31 through #PC-60 (e.g.
   * #PC-31 Connor McDavid, 7 rungs stepping the stated print run down
   * 1000/500/100/50/25/10/1, 210 staged rows) -- overlapping on #PC-31
   * through #PC-35 with a DIFFERENT PLAYER at every one of those five
   * numbers. Two unrelated inserts printed their own numbering off the
   * same "PC-" stem; nothing here is a parallel of anything else.
   *
   * NAME MATTERS FOR REACHABILITY. slugify() strips punctuation outright
   * (it does not turn an apostrophe into a hyphen), so a sale titled
   * "...Upper Deck Series 2 PC's #PC-31..." slugifies to
   * "...-upper-deck-series-2-pcs-pc-31-..." -- the key is
   * `upper-deck-series-2-pcs` (no internal hyphen splitting "pc" and "s"),
   * confirmed by running slugify() on the exact staged-checklist title
   * shape before choosing this spelling, not guessed from the display
   * name. "Population Count" carries no punctuation to lose, so its own
   * segments slugify unchanged into the key below.
   */
  S("upper-deck-series-2-pcs", {
    family: "upper-deck-series-2", parent: "upper-deck-series-2",
  }),
  S("upper-deck-series-2-population-count-1000", {
    names: ["upper-deck-series-2-population-count"],
    family: "upper-deck-series-2", parent: "upper-deck-series-2",
  }),
  // D39 (Drew, 2026-08-31): the hockey umbrella folds onto its SERIES products,
  // and Extended Series is one of them. It was the only named destination the
  // table did not spell, so "2024-25 Upper Deck Extended Series" resolved to
  // the bare `upper-deck` umbrella -- measured 2026-08-31: 4,642 hockey 2024
  // catalog rows carry `upper-deck-extended-series` in their setKey FIELD while
  // every one of their ids says `upper-deck` (the D23 defect, on a product the
  // table had no row for). Without this entry the fold has nowhere to send the
  // 146 Extended Series sales it can name.
  S("upper-deck-extended-series", { names: ["upper-deck-extended"], family: "upper-deck", parent: "upper-deck", refines: "upper-deck" }),
  ...["upper-deck-black-diamond", "upper-deck-retro", "upper-deck-choice", "upper-deck-mvp"].map((k) => P(k, { family: "upper-deck", parent: "upper-deck" })),
  // CF-BLACK-DIAMOND-ROOKIE-EDITION-DISTINCT (Drew 2026-09-04). Black Diamond
  // Rookie Edition is its OWN product, not a spelling of the base line: a
  // rookie-only checklist (194 catalog rows, 2000, baseballcardpedia) against
  // a base line that is a full veteran set. `parent` is the Upper Deck root
  // rather than `upper-deck-black-diamond`, and there is deliberately NO
  // `refines` — refines() is for VERIFIED refinements (a series split, an
  // update series), and this table's own note says "1st Edition is another
  // set, not a refinement". A rookie-only release is another set by the same
  // reasoning, so the matcher must not widen from it into the base pool.
  // Its OWN family for the same reason: rookie-only and veteran checklists do
  // not share a price curve.
  P("black-diamond-rookie-edition", { parent: "upper-deck" }),
  // CF-EXQUISITE-IS-ITS-OWN-PRODUCT (Drew 2026-09-04). Upper Deck Exquisite
  // Collection is its OWN product with its own pool, never folded into
  // `upper-deck`. Same shape as Black Diamond Rookie Edition directly above,
  // and for a sharper version of the same reason: Exquisite is the 2003-04
  // rookie-patch-auto product, so `refines` is deliberately ABSENT — a matcher
  // that widened from an Exquisite RPA into the UD base pool would price a
  // four-figure LeBron rookie off base-card comps. Its OWN family: a
  // 99-copy patch auto and a base set do not share a price curve.
  // `parent` is the Upper Deck root for provenance only.
  P("upper-deck-exquisite", { parent: "upper-deck" }),
  P("sp-authentic", { parent: "upper-deck" }),
  P("sp-prospects", { parent: "upper-deck" }),
  P("spx"),
  P("spx-finite", { parent: "spx" }),
  P("collectors-choice"),
  /**
   * THE 1990s NAMED INSERTS AND FOOD ISSUES THE IMPROVE GATE FOLDED INTO THEIR
   * FLAGSHIP (GATE 3 slot-31 audit, 2026-09-04 -- 12 of 209 writable IMPROVE
   * rows wrong, and every one of them a collapse of one of these).
   *
   * Each of these is a SEPARATE PRODUCT that shares its flagship's brand word
   * and NOT its checklist. The derivation reads the brand, answers the
   * flagship, and a named insert's sale lands in the base card's pool:
   *
   *   "1995-96 Upper Deck Special Edition #31 Hakeem Olajuwon"  -> upper-deck:31
   *   "Upper Deck 1995 Jordan Collection ... #JC7"              -> upper-deck:JC7
   *   "1978 Topps Holsum #32 Ken Houston"                       -> topps:32
   *   "1995 UD Upper Deck Michael Jordan #1 Milk Cap"           -> upper-deck:1
   *
   * Upper Deck Special Edition #31 is Olajuwon; base 1995-96 Upper Deck #31 is
   * a different player entirely. Holsum is a 33-card FOOD ISSUE whose #32 has
   * nothing to do with the 528-card 1978 Topps set. Neither pool may be merged
   * with the flagship's, in either direction.
   *
   * WHAT THIS DECLARATION IS FOR, AND WHAT IT IS NOT. These are `P` rows, so
   * they are a FAMILY/PARENT registry and NOT a spelling: they do not make
   * "Upper Deck Special Edition" resolve to `upper-deck-special-edition`, and
   * it still normalizes to `upper-deck` exactly as it does on main today
   * (verified by running the function, the #1748 lesson). Promoting them to
   * `S` is a vocabulary decision with its own blast radius and is deliberately
   * NOT made here -- what these rows buy is that the rematch classifier's
   * GUARD 6 can name them as DECLARED CHILDREN of their flagship and REFUSE an
   * IMPROVE whose title states the child's words. Absent beats wrong: a row
   * GUARD 6 refuses stays exactly where it is and is reported to Drew.
   *
   * MEASURED BEFORE DECLARED, on the live catalog and pool 2026-09-04. Each
   * key holds ZERO card_catalog rows under EVERY spelling probed
   * (`upper-deck-special-edition`, `special-edition`, `upper-deck-se`,
   * `upper-deck-jordan-collection`, `jordan-collection`, `topps-holsum`,
   * `holsum`, `upper-deck-milk-caps`, `milk-caps`, `upper-deck-pogs`, `pogs`),
   * so unlike #1758's products there is no catalog spelling to defer to and no
   * populated rival to split. The SALES are real and sized:
   * 1,603 "Upper Deck ... Special Edition", 1,017 "Jordan Collection",
   * 18 "Holsum", 109 "milk cap". `collectors-choice-special-edition` is the
   * counter-example that proves the measurement: it holds 313
   * baseballcardpedia rows and is ALREADY a reconciliation fixed point, so it
   * is not re-declared here.
   *
   * The checklists are a separate acquisition. Declaring the key without one
   * is exactly the state that makes GUARD 6 refuse rather than redirect -- a
   * specialization needs its OWN checklist row before anything may land on it.
   */
  P("upper-deck-special-edition", { family: "upper-deck", parent: "upper-deck" }),
  P("upper-deck-jordan-collection", { names: ["ud-jordan-collection"], family: "upper-deck", parent: "upper-deck" }),
  P("upper-deck-milk-caps", { names: ["upper-deck-pogs"], family: "upper-deck", parent: "upper-deck" }),
  P("topps-holsum", { family: "topps", parent: "topps" }),

  /**
   * UPPER DECK HOCKEY SUB-BRANDS (2026-09-19, rekey-catalog-id-to-setkey
   * follow-up). A read-only census of `card_catalog` ids under
   * `hiq:hockey:<2019..2026>:upper-deck:` found ~118,000 checklist-sourced
   * (checklistcenter-2026-09-06) rows whose setKey FIELD already names one of
   * these products while their id stem still says the bare `upper-deck`
   * umbrella -- the same D23/CF-THE-ID-FOLLOWS-ITS-OWN-SETKEY-FIELD shape the
   * pilot fixed for Extended Series, but the rekey lane REFUSES an
   * unregistered target (`unregistered-setkey`), so these rows cannot move
   * until the table names them, exactly as the Leaf products above needed
   * their own rows before their lane could reach them.
   *
   * `S()`, spelled: each is the checklist's own product name and should
   * resolve from a title too (CF-THE-ID-CARRIES-THE-PRODUCT) -- before this,
   * "2023-24 Upper Deck Artifacts ..." normalized to the bare `upper-deck`
   * umbrella exactly like every other named release the table did not yet
   * spell; after, it resolves to `upper-deck-artifacts`. That is the intended
   * direction: a named product is its own key, and it is why a fresh sale of
   * one of these products will derive the SAME id the rekey lane gives its
   * matching catalog rows, rather than colliding with them one segment off.
   *
   * `parent: "upper-deck"` for provenance (the reference ladder, the reverse
   * walk), and it is the FULL WEIGHT of what these entries do to the
   * matcher. Deliberately NO `refines`: `refines` is CF-VERIFIED-REFINEMENTS-
   * ONLY (a series split or a ruled named edition sharing ONE continuous
   * numbering with its parent -- the header above `widenedSetKeys` is
   * explicit that a bare STARTSWITH would wrongly let a specialization's
   * ladder answer flagship comps, "the bowman-chrome != bowman merge in
   * mirror image"). Every one of these is its OWN checklist, its OWN
   * numbering and (mostly) its OWN print runs -- The Cup is a rookie-patch-
   * auto product, Artifacts/Ultimate Collection/Synergy/Trilogy/Clear Cut
   * are each a distinct release with a distinct price curve, CHL/AHL/PWHL/
   * Team Canada (Juniors) are league-licensed sets with no numbering
   * relationship to the NHL flagship, and the two centennial sets and the
   * promo/box-set/card-day issues are one-off releases. Registering these
   * with `refines` would be the SAME mistake Black Diamond Rookie Edition and
   * Exquisite were explicitly NOT given it for, just below, and would widen
   * the matcher's flagship-comps fallback into a rookie-patch-auto or a
   * league-set pool it was never measured against. Each also gets its OWN
   * `family` for the same reason those two do: these products do not share a
   * price curve with base Upper Deck (or with each other), so `family`
   * defaults to the key itself (the table's own default -- omitted here as
   * everywhere else that default applies).
   *
   * `upper-deck-extended-series` (registered D39, already `refines:
   * "upper-deck"`) and bare `upper-deck` are UNCHANGED -- not re-declared
   * here.
   *
   * NOT RE-REGISTERED: `upper-deck-parkhurst` (measured: the census rows are
   * all "upper deck parkhurst hockey", Upper Deck's own 2020-21 revival of
   * the Parkhurst name, not the unrelated vintage 1950s-60s Parkhurst
   * product) -- checked against a standalone `parkhurst` key first
   * (`productEntry("parkhurst")` returns null; no existing registration to
   * collide with), so it is registered below like every other sub-brand
   * rather than folded onto something that does not exist in this table.
   * `o-pee-chee` (registered, standalone, no `parent`) is a SEPARATE Topps-
   * era Canadian product line and shares no census setKey with anything
   * here; checked and left alone.
   */
  S("upper-deck-the-cup", { parent: "upper-deck" }),
  S("upper-deck-premier", { parent: "upper-deck" }),
  S("upper-deck-allure", { parent: "upper-deck" }),
  S("upper-deck-credentials", { parent: "upper-deck" }),
  S("upper-deck-artifacts", { parent: "upper-deck" }),
  S("upper-deck-chl", { parent: "upper-deck" }),
  S("upper-deck-team-canada-juniors", { parent: "upper-deck" }),
  S("upper-deck-ultimate-collection", { parent: "upper-deck" }),
  S("upper-deck-clear-cut", { parent: "upper-deck" }),
  S("upper-deck-synergy", { parent: "upper-deck" }),
  S("upper-deck-parkhurst", { parent: "upper-deck" }),
  S("upper-deck-team-canada", { parent: "upper-deck" }),
  S("upper-deck-ice", { parent: "upper-deck" }),
  S("upper-deck-engrained", { parent: "upper-deck" }),
  S("upper-deck-stature", { parent: "upper-deck" }),
  // upper-deck-engrained-icons: NOT nested under upper-deck-engrained despite
  // the name similarity -- the census shows overlapping but not identical
  // card numbers (171 of ~800-934 shared) between the two, which is not the
  // "one continuous numbering" a series-split parent/child needs, and this
  // task's job is to register what the checklist source's OWN setKey field
  // already asserts, not to rule a taxonomy relationship neither the source
  // nor Drew has stated. Sibling under `upper-deck`, same as every other
  // sub-brand here, until someone rules otherwise.
  S("upper-deck-engrained-icons", { parent: "upper-deck" }),
  S("upper-deck-trilogy", { parent: "upper-deck" }),
  S("upper-deck-boston-bruins-centennial", { parent: "upper-deck" }),
  S("upper-deck-ahl", { parent: "upper-deck" }),
  S("upper-deck-chronology-volume-2", { parent: "upper-deck" }),
  S("upper-deck-pwhl", { parent: "upper-deck" }),
  S("upper-deck-detroit-red-wings-centennial", { parent: "upper-deck" }),
  S("upper-deck-tim-hortons", { parent: "upper-deck" }),
  S("upper-deck-nhl-star-rookies-box-set", { parent: "upper-deck" }),
  S("upper-deck-spring-promo", { parent: "upper-deck" }),
  S("upper-deck-spring-expo-promo", { parent: "upper-deck" }),
  S("upper-deck-fall-expo-promo", { parent: "upper-deck" }),
  S("upper-deck-rookie-box-set", { parent: "upper-deck" }),
  S("upper-deck-nhl-star-rookies", { parent: "upper-deck" }),
  S("upper-deck-national-hockey-card-day", { parent: "upper-deck" }),

  // -- Leaf: every product the catalog's own field spellings name (measured
  //    2026-08-30; the bare `leaf` rule collapsed all of them). Own family
  //    each -- Leaf products do not share a numbering -- under the Leaf root.
  P("leaf"),
  S("leaf-vivid", { names: ["leaf-vivid-baseball"], parent: "leaf" }),
  S("leaf-metal", { names: ["leaf-metal-baseball"], parent: "leaf" }),
  S("leaf-metal-draft", { names: ["leaf-metal-draft-baseball"], family: "leaf-metal", parent: "leaf-metal" }),
  S("leaf-metal-perfect-game-all-american-classic", { names: ["leaf-metal-perfect-game-all-american"], family: "leaf-metal", parent: "leaf-metal" }),
  S("leaf-trinity", { names: ["leaf-trinity-baseball"], parent: "leaf" }),
  S("leaf-trinity-mega-box", { family: "leaf-trinity", parent: "leaf-trinity" }),
  S("leaf-valiant", { names: ["leaf-valiant-baseball"], parent: "leaf" }),
  S("leaf-draft", { names: ["leaf-draft-baseball-blaster", "leaf-draft-baseball"], parent: "leaf" }),
  S("leaf-rookies-and-stars", { names: ["leaf-rookies-stars"], parent: "leaf" }),
  S("leaf-limited", { parent: "leaf" }),
  S("leaf-limited-rookies", { family: "leaf-limited", parent: "leaf-limited" }),
  S("leaf-certified-materials", { parent: "leaf" }),
  S("leaf-certified-materials-samples", { family: "leaf-certified-materials", parent: "leaf-certified-materials" }),
  S("leaf-a-bronx-legacy", { parent: "leaf" }),
  S("leaf-a-bronx-legacy-series-2", { family: "leaf-a-bronx-legacy", parent: "leaf-a-bronx-legacy" }),
  ...["leaf-optichrome", "leaf-perfect-game-national-showcase", "leaf-baseball-nation", "leaf-perfect-game-bonus-box",
    "leaf-perfect-game-all-american-classic", "leaf-lumber", "leaf-lumber-kings", "leaf-electrum", "leaf-exotic",
    "leaf-exotic-multi-sport", "leaf-signature-series", "leaf-signature-series-nscc-multisport", "leaf-eclectic",
    "leaf-seasons-in-the-sun", "leaf-flash", "leaf-spectacular", "leaf-century", "leaf-ultimate-draft",
    "leaf-decadence-multi-sport", "leaf-pete-rose-legacy", "leaf-fractal-materials", "leaf-collections",
    "leaf-certified", "leaf-preferred"].map((k) => S(k, { parent: "leaf" })),

  // -- Donruss: one product line across two owners; the era decides the
  //    spelling (DONRUSS_SPELLING_POLICY, applied by spellForEra once the
  //    year is known). Not `spelled` here: the vocabulary's own ordering
  //    keeps "Donruss Optic" / "Donruss Elite" / "Studio" apart from the
  //    flagship, and its bare alias gives the modern spelling to a text with
  //    no year. One pricing family, so a sale keyed under the other era's
  //    spelling still prices the card.
  P("donruss", { family: "donruss" }),
  P("panini-donruss", { family: "donruss" }),
  P("donruss-elite"),
  P("donruss-studio"),
  // D31, Drew 2026-08-31: "panini-optic and donruss-optic are ONE product,
  // canonical key donruss-optic" -- the product as every checklist names it.
  // Measured read-only 2026-08-31: donruss-optic holds the checklist rows
  // (FB2023 16,055 un-graded, FB2024 15,988, FB2025 19,466, BB2024 30,998;
  // checklistcenter 28,939 + 2,155, checklistinsider 2,054 + 420,
  // beckett-checklist 206) while the panini-optic FIELD holds 5,718 un-graded
  // rows and ONE checklist-backed FB2023 row -- yet 142,352 un-graded catalog
  // rows and 344,978 pool rows still carry a :panini-optic: id STEM (54,873
  // of them FB2023), against zero pool rows on :donruss-optic:. Same split
  // pool, opposite direction from Finest: there the id was already right and
  // the field lagged; here the FIELD is right and the ID lags.
  //
  // NO ERA RULE. Donruss needs spellForEra because the line spans two owners
  // (1981 Donruss, 2009+ Panini Donruss). Optic does not: it launched in 2016,
  // wholly inside the Panini era. Measured 2026-08-31 -- donruss-optic spans
  // 2016-2025 with ZERO rows before 2016, and the only two pre-2016
  // panini-optic rows are a sales-attested mis-parse ("2003 Panini Optic
  // Basketball", a product that never existed). One spelling in every year, so
  // the Donruss policy precedent applies by NOT applying: an era switch here
  // would have no boundary to sit on.
  //
  // The neighbours that must NOT collapse into it (measured the same day):
  // panini-contenders-optic 12,133, leaf-optichrome 81,298,
  // panini-chronicles-optic, and the contenders-optic-* insert keys. "Optic"
  // names a stock those products borrow; it is not this product.
  S("donruss-optic", { names: ["panini-optic", "panini-donruss-optic"], parent: "panini" }),
  // R-PENDING (Drew, ruling round of 2026-09-15): DONRUSS OPTIC INSERT SETS.
  //
  // HOLD -- the key FORM is not yet ruled. Registered here as
  // `donruss-optic-<insert>` because D31 made `donruss-optic` the canonical
  // product (with `panini-optic` / `panini-donruss-optic` as aliases), so the
  // alias form would read as a second product.
  //
  // WHY THEY MUST BE KEYS. card_catalog holds these as PARALLELS of
  // donruss-optic -- parallel "Passing Grade Ice" on a base-product row --
  // because the pre-#2112 ingester ignored insert sets, and the vocabulary
  // corpus inherited the shape because it is built from the catalog. A named
  // insert is a distinct CARD SET (R38/R48), so the name belongs on the setKey
  // axis and only the finish stays a parallel.
  //
  // REGISTRATION IS WHAT MAKES THEM ADDRESSABLE. normalizeSetKey rewrites any
  // key containing the segment `optic` to bare `donruss-optic`
  // (bareAliasPatterns), and the ingest guard refuses a key that is not a
  // normalizeSetKey fixed point. productSetKeyForName answers BEFORE those
  // patterns, so registering a key is precisely what makes it survive -- the
  // same mechanism that keeps `panini-mosaic-jam-masters` while unregistered
  // `panini-prizm-fireworks` collapses.
  //
  // Measured read-only from card_catalog on 2026-09-15: 53 headings over
  // football 2023/2024/2025 and basketball 2023/2024, 17,147 catalog rows, zero
  // destination collisions. Verbatim headings and their cells:
  //
  //   "Alter Ego"                                    basketball 2024
  //   "Best Tuddys"                                  football 2023, football 2024, football 2025
  //   "Blazers"                                      football 2023
  //   "Captain in Charge"                            football 2023, football 2024, football 2025
  //   "Chain Reaction"                               football 2023, football 2024, football 2025
  //   "Diamond Hands"                                football 2023, football 2024, football 2025
  //   "Dominators Signatures"                        basketball 2023, basketball 2024
  //   "Donruss Threads"                              football 2023, football 2024, football 2025
  //   "Downtown!"                                    basketball 2024, football 2023, football 2024
  //   "Downtown Duos"                                football 2024, football 2025
  //   "Downtown Legends"                             football 2024, football 2025
  //   "Duos"                                         football 2025
  //   "Elite Dominators"                             basketball 2023, basketball 2024
  //   "Express Lane"                                 basketball 2023, basketball 2024
  //   "Fast Break Signatures"                        basketball 2023
  //   "First Year Fresh"                             football 2024
  //   "Hidden Potential"                             football 2023, football 2024, football 2025
  //   "International Downtown"                       football 2023
  //   "Legends"                                      football 2025
  //   "Light it Up"                                  football 2023, football 2024, football 2025
  //   "Lights Out"                                   basketball 2023, basketball 2024
  //   "My House!"                                    basketball 2023, basketball 2024, football 2023, football 2024, football 2025
  //   "Mythical"                                     basketball 2024, football 2023
  //   "Net Marvels"                                  basketball 2024
  //   "Opti-Graphs"                                  basketball 2023
  //   "Opti-Graphs Choice"                           basketball 2024
  //   "Optic Update I: Rated Rookies RPS Autographs" football 2023
  //   "Optical Illusions"                            basketball 2023, basketball 2024
  //   "Passing Grade"                                football 2023, football 2024, football 2025
  //   "Phazes"                                       basketball 2024
  //   "Play Action"                                  football 2023, football 2024, football 2025
  //   "Raining 3s"                                   basketball 2023
  //   "Red Hot Rookies"                              basketball 2023, basketball 2024
  //   "Retro Series"                                 football 2023
  //   "Retro Series Signatures"                      basketball 2023, basketball 2024
  //   "Rising Suns"                                  basketball 2023, basketball 2024
  //   "Rookie Dominators Signatures"                 basketball 2023, basketball 2024
  //   "Rookie Dual Signatures"                       basketball 2023, basketball 2024
  //   "Rookie Kings"                                 basketball 2024, football 2023, football 2024, football 2025
  //   "Rookie Phenoms"                               football 2024
  //   "Rookie Primary Colors"                        football 2023, football 2024, football 2025
  //   "Rookie Recruits"                              football 2023, football 2024, football 2025
  //   "RPS Autographs"                               football 2024
  //   "Signature Series"                             basketball 2023
  //   "Slammy!"                                      basketball 2024
  //   "Splash"                                       basketball 2023, basketball 2024
  //   "Sunday Kings"                                 football 2024
  //   "Super Bowl Downtown"                          football 2023
  //   "The Elite Series Signatures"                  basketball 2023, basketball 2024
  //   "The Rookies"                                  basketball 2023, basketball 2024
  //   "Uptowns"                                      football 2024
  //   "White Hot Rookies"                            basketball 2023, basketball 2024
  //   "Winner Stays"                                 basketball 2023, basketball 2024
  //
  // NOT REGISTERED, pending the ruling:
  //   "RPS"        -- a fragment of "RPS Autographs", not a set (32 rows).
  //   "Variation"  -- a card attribute, not a set name (13 rows).
  //   "2015 Retro" -- 6 colour children in the corpus but NO checklist-backed
  //                   catalog rows, so it cannot be shown to be an insert.
  ...[
    "alter-ego", "best-tuddys", "blazers", "captain-in-charge",
    "chain-reaction", "diamond-hands", "dominators-signatures",
    "donruss-threads", "downtown", "downtown-duos", "downtown-legends",
    "duos", "elite-dominators", "express-lane", "fast-break-signatures",
    "first-year-fresh", "hidden-potential", "international-downtown",
    "legends", "light-it-up", "lights-out", "my-house", "mythical",
    "net-marvels", "opti-graphs", "opti-graphs-choice",
    "optic-update-i-rated-rookies-rps-autographs", "optical-illusions",
    "passing-grade", "phazes", "play-action", "raining-3s",
    "red-hot-rookies", "retro-series", "retro-series-signatures",
    "rising-suns", "rookie-dominators-signatures", "rookie-dual-signatures",
    "rookie-kings", "rookie-phenoms", "rookie-primary-colors",
    "rookie-recruits", "rps-autographs", "signature-series", "slammy",
    "splash", "sunday-kings", "super-bowl-downtown",
    "the-elite-series-signatures", "the-rookies", "uptowns",
    "white-hot-rookies", "winner-stays",
  ].map((sub) => S(`donruss-optic-${sub}`, { family: "donruss-optic", parent: "donruss-optic" })),

  // -- Panini (the maker is the parent; every product its own family) --------
  P("panini"),
  P("panini-prizm", { parent: "panini" }),
  P("panini-prizm-draft-picks", { family: "panini-prizm", parent: "panini-prizm" }),
  P("panini-prizm-wnba", { family: "panini-prizm", parent: "panini-prizm" }),
  // CF-SOCCER-PRIZM-IS-PRIZM-FIFA (Drew 2026-09-05). The World Cup release,
  // 30,773 STRICT checklistinsider rows in soccer/2025. Its own family: a FIFA
  // card does not price off an NFL Prizm comp, exactly as Prizm WNBA does not.
  // `parent` records the flagship it is a release of, for provenance only.
  // NOT `spelled` — the sport-scoped rule (spellForSport) decides this key,
  // not a name match, because the NAME "panini-prizm" belongs to FB/BK.
  P("panini-prizm-fifa", { parent: "panini-prizm" }),
  P("panini-prizm-monopoly-wnba", { family: "panini-prizm", parent: "panini-prizm" }),
  ...["panini-select", "panini-mosaic", "panini-contenders", "panini-immaculate", "panini-flawless",
    "panini-national-treasures", "panini-absolute", "panini-chronicles", "panini-phoenix", "panini-illusions",
    "panini-obsidian", "panini-spectra", "panini-revolution", "panini-crown-royale", "panini-one-one", "panini-playoff",
    "panini-score", "panini-classics", "panini-legacy", "panini-threads", "panini-rookies-and-stars", "panini-zenith",
    "panini-court-kings", "panini-origins", "panini-encased", "panini-eminence", "panini-totally-certified",
    "panini-certified", "panini-crusade", "panini-prestige", "panini-elite-extra-edition",
    "panini-diamond-kings",
    // R67 PREREQUISITE (Drew, 2026-09-19): registered so its own named insert
    // sets (below) have a parent to nest under. Previously unregistered but
    // already a normalizeSetKey fixed point via the corpus fallback (pinned by
    // aBrandSubstringIsNotAProduct.test.ts); this makes it a table entry too.
    "panini-photogenic"].map((k) => P(k, { parent: "panini" })),
  // R50 / R52 / GREATS-OF-THE-GAME (Drew, 2026-09-15). A named product is its
  // own card set, and these four were never registered — so the two that
  // survived did so only because no family catch-all happened to name them,
  // and the one that did not was being swallowed:
  //
  //   fleer-greats-of-the-game               -> fleer        COLLAPSED
  //   upper-deck-greats-of-the-game          -> upper-deck   COLLAPSED
  //   sports-illustrated-greats-of-the-game  -> itself       (by luck)
  //   donruss-greats                         -> itself       (by luck)
  //
  // That is CF-FLAGSHIP-CATCH-ALL-SWALLOWS-SPECIALIZATIONS: a bare brand
  // regex discarding the qualifier. Measured read-only 2026-09-15, the cost
  // is 2,961 POOL rows titled "… Greats of the Game" addressed to bare
  // `fleer` — 1,518 in 2001 and 1,443 in 2002 — because no other destination
  // resolves.
  //
  //   sports-illustrated-greats-of-the-game  1999   416 checklist-backed rows,
  //                                                 131 auto, baseballcardpedia
  //                                                 + baseballcardpedia-graded
  //   donruss-greats                         2005 1,302 checklist-backed rows,
  //                                                 126 auto, same two sources
  //   fleer-greats-of-the-game               2000-2004, Fleer by name in every
  //                                                 source; its checklists are
  //                                                 an acquisition (2001/2002
  //                                                 have ZERO checklist rows)
  //
  // 2006 IS DELIBERATELY ABSENT. Its 4,797 checklist-backed rows are spelled
  // "2006 Greats of the Game" in 4,796 of them — no maker in the name — and
  // the 2006 `upper-deck` pool holds ZERO rows titled Greats of the Game. The
  // key form for that year is with Drew; registering a guess would move 4,797
  // rows to a name no source writes.
  P("fleer-greats-of-the-game", { family: "fleer", parent: "fleer" }),
  P("sports-illustrated-greats-of-the-game", { family: "sports-illustrated-greats-of-the-game" }),
  P("donruss-greats", { family: "donruss", parent: "panini-donruss" }),
  // R62 (Drew, 2026-09-15): PLAYOFF CONTENDERS OPTIC IS ITS OWN PRODUCT.
  //
  // `panini-contenders-optic` was named in D31's own list of neighbours that
  // must NOT collapse into donruss-optic ("panini-contenders-optic 12,133,
  // leaf-optichrome 81,298 ... 'Optic' names a stock those products borrow; it
  // is not this product") -- but it was never REGISTERED, so it collapsed
  // anyway, one product to its left: normalizeSetKey took it to
  // `panini-contenders` via the bare `/(^|-)contenders(-|$)/` alias.
  //
  // Measured read-only from card_catalog, 2026-09-15 -- 18,397 checklist-backed
  // rows already carry this setKey, from three independent sources:
  //
  //   football    2023   7,133 rows   42 parallels   checklistinsider,
  //                                                  checklistcenter
  //   football    2024   5,537 rows   80 parallels   + hobbymonitor
  //   basketball  2023   5,727 rows   94 parallels
  //
  // The scrapes corroborate it as its own checklist: C:/tmp/ci/csv2 ships
  // 2023-panini-contenders-optic-football.csv (6,435 rows, 66 sub-sets),
  // 2024-panini-contenders-optic-football.csv (5,851 rows, 59 sub-sets) and
  // 2023-24-panini-contenders-optic-basketball.csv (148 sub-sets) as FILES of
  // their own -- Season Ticket, Rookie Ticket, Rookie Ticket Autographs, X's
  // and O's, All-Time Contenders, MVP Contenders, Lottery Ticket, Induction
  // Ticket Autographs. That is a product's checklist, not a parallel ladder.
  //
  // ITS INSERT KEYS ARE NOT REGISTERED HERE. 123 sub-set stems are attested
  // across those three files, but the derivation still carries colour rungs
  // (`-international-jade`, `-gold-lazer`, `-black-and`) and a source typo
  // (`hoop-deams` beside `hoop-dreams`), so registering them now would mint
  // colours as card sets -- the defect #2195 and #2208 exist to stop. They are
  // reported for a follow-up ruling in the R60 form
  // (`panini-contenders-optic-<insert>`), measured the same way the 53 Optic
  // keys were.
  P("panini-contenders-optic", { family: "panini-contenders", parent: "panini-contenders" }),
  // R67 (Drew, 2026-09-19): A NAMED INSERT SET IS ITS OWN PRODUCT KEY.
  //
  // aBrandSubstringIsNotAProduct.test.ts anchored two rules that would
  // otherwise fold these three keys onto a DIFFERENT manufacturer's product
  // (`topps-tribute`, `panini-contenders-optic`) purely on an unanchored
  // substring match. Anchoring alone only stops the WRONG fold; the vocabulary
  // still emits the key, so productFamilyIsATable's wholeness check refuses
  // until the table knows it too (productEntry(k) for every
  // vocabularyDestinations() key).
  //
  //   panini-photogenic-troops-tribute
  //     2024 Panini Photogenic's own insert, "Troops Tribute" -- named after
  //     the checklist, not a Topps release. Nested under panini-photogenic,
  //     registered above alongside the flagship (R67 follow-up).
  //   panini-zenith-contenders-optic-rookie-ticket-rps-preview
  //   panini-zenith-contenders-optic-rookie-ticket-variation-rps-preview
  //     2024 Panini Zenith's own inserts previewing another product's Rookie
  //     Ticket RPS parallel -- the name quotes Contenders Optic, the checklist
  //     is Zenith's. Nested under panini-zenith, which this table already
  //     registers (family "panini", parent "panini").
  S("panini-photogenic-troops-tribute", { family: "panini-photogenic", parent: "panini-photogenic" }),
  S("panini-zenith-contenders-optic-rookie-ticket-rps-preview", { parent: "panini-zenith" }),
  S("panini-zenith-contenders-optic-rookie-ticket-variation-rps-preview", { parent: "panini-zenith" }),
  /**
   * R67 (Drew, ruling round of 2026-09-19): 2024 PANINI PHOTOGENIC FOOTBALL --
   * THE NAMED INSERT SETS.
   *
   * Measured directly against the staged checklist (checklistinsider,
   * `2024-panini-photogenic-football.csv`, held on PR #2272 pending this
   * registration -- #2272 refuses to ingest one insert, `Rookie Portrait`,
   * whose colour rungs collide with base on a blank parallel until its key
   * exists). The module's own production fold (`insert-set-key.cjs`
   * `rungFoldingFor`, run over every row of the file, never re-derived by
   * hand) resolved every category to a root or a colour rung by the R67
   * roster test -- players and card numbers split on "/", trimmed, lowercased,
   * de-duplicated, sorted, then compared: a child whose roster is a SUBSET of
   * its root on the same numbers is a colour rung (parallel axis only); a
   * child with numbers or players the root lacks is its own key.
   *
   * Every colour-suffixed category folded as a subset of its plain-spelled
   * root with zero exceptions -- `insert-a-different-view-{black,blue,gold,
   * orange,pink,purple,red,silver}` onto `a-different-view`, and the same
   * shape for draft-snapshots, for-the-cure, in-the-action-autographs,
   * progressions, rookie-instants-signatures, rookie-introductions, rookie-
   * pix, rookie-portrait-autographs, snapshots-autographs and troops-tribute
   * (troops-tribute registered above, ahead of this block, since it doubles
   * as the anchoring fix's own key).
   *
   * FIFTEEN ROOTS SURVIVED the fold as their own product (sixteen measured,
   * troops-tribute already registered):
   *
   *     a-different-view                    10 rows,  8 colour rungs
   *     avatars                              20 rows (no colour rungs printed)
   *     draft-snapshots                      10 rows,  8 colour rungs
   *     for-the-cure                         10 rows,  8 colour rungs
   *     in-motion                            10 rows (no colour rungs printed)
   *     in-the-action-autographs             25 rows,  5 colour rungs
   *     progressions                         20 rows,  8 colour rungs
   *     rookie-instants-signatures           20 rows,  5 colour rungs
   *     rookie-introductions                 20 rows,  8 colour rungs
   *     rookie-photo-bomb-autographs         48 rows (auto- prefixed, own roster)
   *     rookie-pix                           20 rows,  8 colour rungs
   *     rookie-portrait                     450 rows (the product's own insert;
   *                                                    NOT the -autographs sibling)
   *     rookie-portrait-autographs           35 rows,  5 colour rungs -- SAME
   *                                                    numbers/players as
   *                                                    rookie-portrait, but the
   *                                                    signed subset is its own
   *                                                    product per CF-A-COLOUR-
   *                                                    RUNG-IS-NEVER-A-CARD-SET-
   *                                                    KEY's "tail says SIGNED"
   *                                                    rule -- isAuto is its own
   *                                                    axis, never a parallel.
   *     snapshots-autographs                 35 rows,  5 colour rungs
   *     the-shoe-game                        20 rows (no colour rungs printed)
   *
   * KNOWN OPEN QUESTION, STATED RATHER THAN SILENCED. The acquisition-queue
   * estimate for this product was 13 own-key roots; independently re-measuring
   * against the roster test above (not re-reading the estimate) finds 15,
   * all fifteen backed by their own checklist rows with zero roster
   * disagreement in the fold. If two of these are meant to fold together or
   * be excluded on evidence this file does not carry (attestation, a
   * duplicate name, or a Drew ruling not reflected in the staged CSV), that is
   * a follow-up on this same table, not a reason to under-register a measured
   * root now -- an unregistered root refuses ingestion (safe); a wrongly
   * folded one loses rows silently (the R67/#2271 defect class).
   *
   * `family` left at the default (each insert its own pricing family) --
   * consistent with the Illusions precedent above, which also gives each of
   * its five named inserts its own family, not the flagship's.
   */
  S("panini-photogenic-a-different-view", { parent: "panini-photogenic" }),
  S("panini-photogenic-avatars", { parent: "panini-photogenic" }),
  S("panini-photogenic-draft-snapshots", { parent: "panini-photogenic" }),
  S("panini-photogenic-for-the-cure", { parent: "panini-photogenic" }),
  S("panini-photogenic-in-motion", { parent: "panini-photogenic" }),
  S("panini-photogenic-in-the-action-autographs", { parent: "panini-photogenic" }),
  S("panini-photogenic-progressions", { parent: "panini-photogenic" }),
  S("panini-photogenic-rookie-instants-signatures", { parent: "panini-photogenic" }),
  S("panini-photogenic-rookie-introductions", { parent: "panini-photogenic" }),
  S("panini-photogenic-rookie-photo-bomb-autographs", { parent: "panini-photogenic" }),
  S("panini-photogenic-rookie-pix", { parent: "panini-photogenic" }),
  S("panini-photogenic-rookie-portrait", { parent: "panini-photogenic" }),
  S("panini-photogenic-rookie-portrait-autographs", { parent: "panini-photogenic" }),
  S("panini-photogenic-snapshots-autographs", { parent: "panini-photogenic" }),
  S("panini-photogenic-the-shoe-game", { parent: "panini-photogenic" }),
  /**
   * R67 (Drew, ruling round of 2026-09-19): 2024 PANINI ZENITH FOOTBALL --
   * THE NAMED INSERT SETS.
   *
   * Measured directly against the fixture already on main
   * (`tests/fixtures/checklist-category/zenith-2024-fb-categories.json`,
   * 6,214 rows, the real 2024 Zenith football checklist). Same method as the
   * Photogenic registration above: the module's own production fold
   * (`insert-set-key.cjs`'s `rungFoldingFor`, run over every row, never
   * re-derived by hand) resolves the standard colour-prefix cases; the R67
   * roster test -- cardNumber + player, players split on "/", trimmed,
   * lowercased, de-duplicated, sorted -- resolves everything else BY HAND,
   * because Zenith uses two naming shapes the module's prefix-only fold
   * cannot see on its own:
   *
   *   TIER/RETAILER NAMES, not colours, sharing NO common prefix. Nine
   *   category spellings -- 1st Down, 2nd Down, 3rd Down, 4th Down, Hobby,
   *   No Huddle, Retail, Touchdown, Two-Minute Drill -- plus the module's own
   *   already-derived `rookies-red-zone` (its 4 colour files: Blue/Gold/Red/
   *   White) are ALL the exact same 100-card Rookies checklist: every shared
   *   number names the same player, zero disagreements, so under R67's own
   *   rule ("the roster decides", not the word used) these are ten parallel
   *   spellings of ONE root, `rookies` -- exactly the "siblings name the set
   *   even with no base tier" shape, just spelled with retailer names instead
   *   of colours. The signed side is the same shape one level down: `Rookies
   *   Autographs No Huddle` (63 rows) and `... Two-Minute Drill` (59 rows)
   *   plus the module's own `rookies-red-zone-autographs` root (base + 4
   *   colours) all measure the SAME signed subset (0.79-1.00 pairwise overlap,
   *   the residual gap being real short-print scarcity, not different
   *   players) -- one root, `rookies-autographs`.
   *
   *   A NAME WORD IN THE MIDDLE, not a suffix. `High Point Kaboom
   *   Signatures`, `... Lightning Signatures` and `... Spokes Signatures`
   *   are not colour-SUFFIXED spellings the module's stripper can reach
   *   ("Kaboom" sits between "High Point" and "Signatures", not at the tail);
   *   measured, `High Point Signatures` (20), `Lightning Signatures` (25) and
   *   `Spokes Signatures` (21) are each an EXACT SUBSET of `Kaboom
   *   Signatures` (26, the largest print run) on the same numbers -- one
   *   root, `high-point-signatures` (named for the plain spelling, per the
   *   convention `z-graphs` and `zoom-blue` already use one level up).
   *
   * TWENTY-SEVEN ROOTS SURVIVED, after both hand-verified clusters:
   *
   *     a-to-z                        26 rows,  5 colour rungs
   *     alphas                        25 rows,  1 colour rung (gold ice)
   *     behind-the-numbers            25 rows,  4 colour rungs
   *     chalk-talk                    25 rows,  4 colour rungs
   *     color-guard                   20 rows,  4 rungs (laundry-tag x3 + prime)
   *     first-look                    25 rows,  1 colour rung (gold ice)
   *     high-point-signatures         20 rows -- CLUSTER: kaboom(26)/
   *                                              lightning(25)/spokes(21) all
   *                                              subsets on the same numbers
   *     idols                         20 rows,  5 colour rungs
   *     pinnacle-inscriptions         19 rows (silver kept separate, below)
   *     pinnacle-inscriptions-silver  25 rows -- roster is NOT a subset of
   *                                              plain (extra numbers), so it
   *                                              stands per R67's own-key rule
   *     rookie-patch-autographs      152 rows,  colour rungs blue/gold/red
   *                                              (module-folded); ice (37) and
   *                                              white (39) are ALSO parallels
   *                                              of this root -- RESOLVED, see
   *                                              below (not registered either,
   *                                              a parallel is never a key)
   *     rookies                      100 rows -- CLUSTER: 1st/2nd/3rd/4th-
   *                                              down, hobby, no-huddle,
   *                                              retail, touchdown, two-
   *                                              minute-drill, red-zone
   *                                              blue/gold/red/white -- ten
   *                                              spellings, one 100-card
   *                                              roster, zero disagreement
   *     rookies-autographs            62-75 rows -- CLUSTER: autographs-no-
   *                                              huddle(63)/two-minute-
   *                                              drill(59), red-zone-
   *                                              autographs + its 4 colours --
   *                                              one signed Rookies subset
   *     splash                        25 rows,  4 colour rungs
   *     state-of-the-art              24 rows,  5 colour rungs
   *     the-shield                    25 rows,  1 colour rung (gold ice)
   *     turning-pro-memorabilia       20 rows,  4 rungs (laundry-tag x3 + prime)
   *     z-graphs                      31 rows,  3 rungs (kaboom/lightning/spokes
   *                                              -- module-folded, true SUFFIX
   *                                              spellings, unlike High Point)
   *     z-jersey                      40 rows,  4 rungs (laundry-tag x3 + prime)
   *     z-jersey-autographs           27 rows,  4 colour rungs
   *     z-marquee                     30 rows,  5 colour rungs
   *     z-summit-autographs           16 rows,  4 colour rungs
   *     z-team                        25 rows,  4 colour rungs
   *     zoned-in                      20 rows,  4 rungs (laundry-tag x3 + prime)
   *     zoom-blue                     10 rows,  3 rungs (kaboom/lightning/spokes)
   *     zoom-gold                      8 rows,  2 rungs (kaboom/spokes)
   *     zoom-red                      10 rows,  3 rungs (kaboom/lightning/spokes)
   *
   * RESOLVED (Drew, researched follow-up ruling, 2026-09-19): Ice and White
   * are PARALLELS of the one 39-card Rookie Patch Autographs set (#201-242;
   * Ice /50, White 1/1), never keys -- NOT registered, same as every other
   * colour rung in this file (a parallel rides the parallel field, it is
   * never a setKey).
   *
   *     rookie-patch-autographs-ice     37 rows
   *     rookie-patch-autographs-white   39 rows
   *
   *   Both had a BLANK parallel column, so the module's own strip rule
   *   correctly left them unfolded on the first pass (blue/gold/red DO carry
   *   a matching parallel column and fold cleanly into the 152-row
   *   `rookie-patch-autographs` root). The roster mismatch that looked like
   *   two different checklists was a SOURCE ARTIFACT, not a different card
   *   set: sportscardchecklist renumbers every colour page from 1, so Ice's
   *   own file reads #1-42 while the product's real numbers are #201-242.
   *   Verified: Ice #N -> main #(N+200) matches on player for all 37 rows,
   *   zero disagreement -- e.g. Ice #1 Michael Penix Jr. is main #201 Michael
   *   Penix Jr. #229 (Jaylen Wright) is the one number Ice-shifted has that
   *   the merged blue/gold/red pool lacks -- the "extra" signer the roster
   *   check flagged before this fix, not a different card. White already
   *   used the product's real 201-242 numbers and matched on identity once
   *   its own multi-copy player-field formatting (`"Name/Name/Name/Name/
   *   Name"`, a scrape artifact, not five co-signers) is split and
   *   de-duplicated the same way every other roster comparison in this file
   *   already does.
   *
   *   THE FIXTURE'S ICE ROWS ARE RENUMBERED BELOW (201-242, from 1-42) to
   *   correct the artifact at its source in this repo -- see
   *   tests/fixtures/checklist-category/zenith-2024-fb-categories.json. That
   *   fixture is a static snapshot of the real acquisition CSV
   *   (`2024-panini-zenith-football.csv`); this repo carries no separate
   *   converter or copy of that CSV to fix independently, so the fixture fix
   *   here does not, by itself, correct a live acquisition pipeline -- if
   *   this product is re-acquired from the same source, the same renumbering
   *   will need catching again at that scrape/staging step.
   *
   *   SWEPT: every other Zenith cluster this file folds was checked for the
   *   same renumber-from-1 artifact (child's number range vs its root's).
   *   Two other apparent mismatches turned out to be something else, not
   *   this defect: `high-point-signatures`/`spokes-signatures` are proper
   *   SUBSETS of `high-point-kaboom-signatures`'s own 1-28 range (real
   *   short-print gaps, same numbering scheme, not a shift); and
   *   `pinnacle-inscriptions-silver` names DIFFERENT PLAYERS than
   *   `pinnacle-inscriptions` at every shared number (#1 is Terrell Owens vs
   *   Aaron Rodgers) -- a genuinely different checklist, already registered
   *   separately above, not a renumbering question at all. No other cluster
   *   in this file showed the shift-from-1 shape.
   *
   * A THIRD ANCHORING GAP, FOUND WHILE MEASURING. #2273 anchored two Zenith
   * previews that were folding onto `panini-contenders-optic`
   * (`...rookie-ticket-rps-preview` and `...rookie-ticket-variation-rps-
   * preview`, both registered above). A third preview in the same fixture,
   * `Contenders Optic Veteran Ticket Preview` (16/15/15 rows across
   * Blue/Green/Red, no plain file -- the "siblings name the set" shape again),
   * collapses onto the same `panini-contenders-optic` today, verified by
   * running `normalizeSetKey`, not by reading the regex. `productSetKeyForName`
   * (spelled-name lookup) runs BEFORE the unanchored regex vocabulary
   * (`normalizeSetKey`, D23), so registering the spelled key below is
   * sufficient on its own -- no additional regex anchor needed, unlike
   * `troops-tribute` and the other two Contenders Optic previews, which had
   * to be anchored because their EXACT spelling was never registered before
   * #2273 wrote the rule. This one goes straight to the table.
   *
   * `family` left at the default (each insert its own pricing family), same
   * as the Photogenic and Illusions precedents.
   */
  S("panini-zenith-contenders-optic-veteran-ticket-preview", { parent: "panini-zenith" }),
  S("panini-zenith-a-to-z", { parent: "panini-zenith" }),
  S("panini-zenith-alphas", { parent: "panini-zenith" }),
  S("panini-zenith-behind-the-numbers", { parent: "panini-zenith" }),
  S("panini-zenith-chalk-talk", { parent: "panini-zenith" }),
  S("panini-zenith-color-guard", { parent: "panini-zenith" }),
  S("panini-zenith-first-look", { parent: "panini-zenith" }),
  S("panini-zenith-high-point-signatures", { parent: "panini-zenith" }),
  S("panini-zenith-idols", { parent: "panini-zenith" }),
  S("panini-zenith-pinnacle-inscriptions", { parent: "panini-zenith" }),
  S("panini-zenith-pinnacle-inscriptions-silver", { parent: "panini-zenith" }),
  S("panini-zenith-rookie-patch-autographs", { parent: "panini-zenith" }),
  S("panini-zenith-rookies", { parent: "panini-zenith" }),
  S("panini-zenith-rookies-autographs", { parent: "panini-zenith" }),
  S("panini-zenith-splash", { parent: "panini-zenith" }),
  S("panini-zenith-state-of-the-art", { parent: "panini-zenith" }),
  S("panini-zenith-the-shield", { parent: "panini-zenith" }),
  S("panini-zenith-turning-pro-memorabilia", { parent: "panini-zenith" }),
  S("panini-zenith-z-graphs", { parent: "panini-zenith" }),
  S("panini-zenith-z-jersey", { parent: "panini-zenith" }),
  S("panini-zenith-z-jersey-autographs", { parent: "panini-zenith" }),
  S("panini-zenith-z-marquee", { parent: "panini-zenith" }),
  S("panini-zenith-z-summit-autographs", { parent: "panini-zenith" }),
  S("panini-zenith-z-team", { parent: "panini-zenith" }),
  S("panini-zenith-zoned-in", { parent: "panini-zenith" }),
  S("panini-zenith-zoom-blue", { parent: "panini-zenith" }),
  S("panini-zenith-zoom-gold", { parent: "panini-zenith" }),
  S("panini-zenith-zoom-red", { parent: "panini-zenith" }),
  // R53(ii) (Drew, 2026-09-15): SELECT'S TIERS ARE THEIR OWN CARD SETS.
  //
  // Panini Select prints its base set in named tiers -- Concourse, Premier
  // Level, Field Level. The question the ruling turned on is whether a tier is
  // a PARALLEL of one checklist or a card set of its own, and the answer is in
  // the numbering. Measured read-only on card_catalog, 2026-09-15:
  //
  //   baseball 2023   concourse 100 + premier level 100 = 200 distinct numbers
  //                   ZERO shared numbers -- the tiers partition the set
  //   baseball 2025   likewise, 200 distinct, zero overlap
  //   baseball 2024   concourse 100, premier level 100, but only 100 distinct
  //                   numbers: all 100 are SHARED, and 36 of them name a
  //                   DIFFERENT PLAYER in each tier --
  //                     #21  Rhett Lowder    vs  Homer Bush Jr.
  //                     #10  Kyle Manzardo   vs  Paul Skenes
  //                     #98  Zach DeLoach    vs  Robert Hassell
  //
  // That is the whole argument. If a tier were a finish, #10 would be the same
  // card in both; it is not. Two different players at one number is two cards,
  // so the tier rides the setKey axis, not the parallel axis -- and on the
  // parallel axis those 36 pairs would collide into one id and one pool.
  //
  // 24,505 checklist-backed rows carry a tier name today (baseball 2023/2024/
  // 2025 and soccer 2025 Field Level), all on the bare `panini-select` key.
  // Registration makes the keys addressable: like every other specialisation
  // under a family catch-all, an unregistered `panini-select-concourse`
  // normalizes straight back to `panini-select`.
  //
  // The UNTIERED rows stay where they are. This registers the destinations; it
  // moves nothing.
  ...["panini-select-concourse", "panini-select-premier-level",
    "panini-select-field-level"].map((k) =>
    P(k, { family: "panini-select", parent: "panini-select" })),
  // R71 (owner, 2026-09-19): THE REST OF SELECT'S TIERS, SAME RULING (R53(ii)/
  // R67), REGISTERED FOR THE PRODUCTS THE COMMITTED CHECKLIST DATA ACTUALLY
  // SHOWS. Tiers differ by SPORT and by YEAR -- measured against the
  // checklistinsider/hobbymonitor packages under backend/data/checklists and
  // backend/data/checklist-parallel-names.json, not assumed from the name:
  //
  //   FOOTBALL 2024 (checklistinsider, confidence 0.9, 27,324 rows; manifest
  //   provenance: "27,324 rows across the Concourse/Club Level/Suite Level/
  //   Premier Level/Field Level tiers"). Five tiers, each its own disjoint
  //   100-card block, zero shared numbers:
  //     insert-base-concourse       #1-100
  //     insert-base-premier-level   #101-200
  //     insert-base-club-level      #201-300
  //     insert-base-suite-level     #301-400
  //     insert-base-field-level     #401-500
  //   Concourse/Premier Level/Field Level were already registered above under
  //   #2231; this adds the two the football checklist also carries, CLUB
  //   LEVEL and SUITE LEVEL (see the R67 comment further down in this file,
  //   "This file's base card ladders across five tiers", which already
  //   names all five and says explicitly they are registered "under #2231" --
  //   that comment is ahead of the actual table; this entry is what makes it
  //   true). FOOTBALL 2018 (sportscardchecklist, 300 rows) independently
  //   confirms Concourse/Premier Level/Field Level at #1-100/101-200/201-300,
  //   zero overlap -- the same three tiers #2231 registered, one product-year
  //   earlier, before Club Level and Suite Level existed as tiers.
  //
  //   BASKETBALL 2024 (hobbymonitor, 25,999 rows, `insert-base-*` categories
  //   authoritative). FOUR tiers, each its own disjoint 100-card block, zero
  //   shared numbers -- NOT the three this ruling's own text guessed
  //   (Concourse/Premier Level/Courtside skips Mezzanine Level, which the
  //   data carries):
  //     insert-base-concourse        #1-100
  //     insert-base-premier-level    #101-200
  //     insert-base-courtside        #201-300
  //     insert-base-mezzanine-level  #301-400
  //   `Courtside` ALSO appears in the `panini-select-wnba` 2024/2025 blocks of
  //   checklist-parallel-names.json, but there it is a named INSERT set
  //   (`insertSets[].categories: ["insert-courtside"]`, alongside unrelated
  //   inserts like "Crunch Time" and "Downtown"), not a base-card tier -- it
  //   does not partition WNBA's numbering the way it partitions the flagship
  //   basketball product. Not registered for WNBA; `panini-select-wnba` is
  //   a separate, already-registered product key and this PR does not touch
  //   it.
  //
  //   SOCCER / SELECT FIFA. `panini-select-fifa` is a real, checklist-backed
  //   product (soccer 2023: 25 colour parallels / 7,006 seen; 2024: 34 colour
  //   parallels / 9,708 seen, both in checklist-parallel-names.json) but had
  //   NO product-set-key registration at all before this PR. Searched for
  //   tier names the way this ruling names them (Terrace, Mezzanine, Field
  //   Level, ...) across every committed checklist source
  //   (backend/data/checklists/**, checklist-parallel-names.json, and the
  //   whole backend/src + backend/scripts tree): NONE FOUND. FIFA's committed
  //   data is colour-parallel vocabulary only, no base-card tier structure
  //   like football's or basketball's. Per this ruling's own instruction not
  //   to invent a tier the data does not show, FIFA gets its bare product key
  //   ONLY -- no tier children -- until a real FIFA tier checklist is
  //   acquired.
  //
  //   `spelled: true` (via `S`, not `P`, unlike the three keys above): the
  //   prior PR's own comment on those three explains why P() alone is not
  //   enough -- `productSetKeyForName` resolves by SPELLED name and answers
  //   BEFORE the regex vocabulary in normalizeSetKey, so marking these
  //   `spelled` makes them normalizeSetKey FIXED POINTS through the EXISTING
  //   `productSetKeyForName` call, without adding a new regex to
  //   hobbyIqCardId.service.ts (a DERIVATION_INPUTS file). This is the same
  //   mechanism already used for every `panini-select-*` named insert
  //   registered elsewhere in this file (`panini-select-signatures`,
  //   `panini-select-alter-ego`, etc.) -- proven safe at that shape already.
  //   It does NOT retrofit the three #2231 keys, which stay P() and keep
  //   depending on their explicit regex; changing their mechanism is out of
  //   this PR's scope.
  S("panini-select-club-level", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-suite-level", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-courtside", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-mezzanine-level", { family: "panini-select", parent: "panini-select" }),
  // `S`, not `P`: a bare P() entry only survives normalizeSetKey when the
  // input string IS its own slug already (the identity fallback at the end
  // of the function) -- it is NOT a real fixed point against a title with
  // other words in it. Measured: with P(), "2023-24 Panini Select FIFA
  // Mezzanine #124 Player" fell all the way through to bare `panini-select`
  // (Mezzanine has no FIFA-tier registration -- see the comment above, no
  // data names one), and even a plain "2023-24 Panini Select FIFA" title
  // (no tier word) ALSO fell through to `panini-select` rather than
  // `panini-select-fifa`, because productSetKeyForName never got a spelled
  // name to run-match against. `S` fixes the second case: `panini-select-
  // fifa` is now reachable from a real title the same way `panini-select-
  // signatures` already is. It does not, and cannot, invent a tier reading —
  // that is the separate title-reader gap this PR's NOTE calls out.
  S("panini-select-fifa", { family: "panini-select", parent: "panini-select" }),
  // NBA HOOPS is a Panini product spelled by its CHECKLIST (Drew 2026-09-05).
  // It stays a child of `panini` — the family link is what lets the matcher
  // widen — but the KEY is the bare one, because `nba-hoops` holds 26,355
  // checklistinsider rows and `panini-hoops` zero strict rows. The prefixed
  // spelling is carried as a NAME so a title reading "Panini NBA Hoops" still
  // resolves to this product rather than to no entry at all.
  P("nba-hoops", { parent: "panini", names: ["panini-hoops", "hoops"] }),

  /**
   * ROOKIES & STARS AUTOGRAPH SUBSETS ARE CARD SETS (R30, Drew 2026-09-13).
   *
   * "A same-numbered autograph SUBSET is its own card set within the product,
   * the way a named insert set is."
   *
   * 2025 Panini Rookies & Stars publishes eight autograph subsets that EACH
   * RESTART NUMBERING AT 1 -- "Airborne Signatures" #1, "Crusade Signatures"
   * #1, "Great American Signatures" #1. Under one shared key they are not
   * merely ambiguous, they are WRONG: the checklist produced 1,296 duplicate
   * slugs, 41 of which merged different players onto a single address --
   * Shedeur Sanders, Odell Beckham Jr., Travis Hunter and CeeDee Lamb all on
   * `...:2:base:auto:num-99`. That is the SCC-collision shape and
   * one-card-one-row forbids it.
   *
   * The subset is what separates them, so under R30 the subset becomes the
   * key. Registration here is not bookkeeping -- it is the mechanism: every
   * one of these keys collapsed straight back to `panini-rookies-and-stars`
   * through the unanchored flagship rule before it was declared (the
   * flagship-catch-all class, #1715), and a key that is not a normalizeSetKey
   * FIXED POINT cannot hold a pool. `spelled` is what makes
   * productSetKeyForName answer for them, ahead of the regex vocabulary.
   *
   * THE COLOUR VARIANTS ARE NOT HERE, deliberately. The workbook lists 26
   * autograph sections; 18 are colour rungs of these 8 ("Rookies Signatures
   * Gold" is the Gold rung of "Rookies Signatures"). A named parallel is a
   * distinct CARD, not a distinct SET, so the colour rides the parallel axis
   * ON these keys. Within one subset key, number + rung is unique again.
   */
  ...["airborne-signatures", "base-signatures", "crusade-signatures",
    "great-american-signatures", "patrick-mahomes-autograph-collection",
    "rookies-signatures", "stellar-rookies-signatures", "thrillers-signatures",
  ].map((sub) => S(`panini-rookies-and-stars-${sub}`, {
    family: "panini-rookies-and-stars",
    parent: "panini-rookies-and-stars",
  })),

  /**
   * THE 2026-09-13 CARDBOARDCONNECTION ACQUISITION — 43 SAME-NUMBERED SUBSETS
   * ACROSS FIVE PRODUCTS (R30, Drew 2026-09-13).
   *
   * The same ruling as the Flair Showcase Rows, the Rookies & Stars autograph
   * subsets above, and the 2014 World Cup inserts: a same-numbered subset is
   * its own card set. cardboardconnection ships ONE FILE PER SUBSET (207 files,
   * 68,329 rows), and #2112's cell-wide guard measured 1,803 contested
   * addresses inside five product cells:
   *
   *     nba-hoops 2022             10,111 rows ->  9,703 ids   200 contested
   *     panini-prizm-draft-picks    9,591 rows ->  7,748 ids   835 contested
   *     panini-spectra             11,766 rows -> 11,033 ids   485 contested
   *     panini-donruss             10,715 rows -> 10,420 ids   124 contested
   *     nba-hoops 2023             10,166 rows ->  9,739 ids   159 contested
   *
   * `hiq:basketball:2022:nba-hoops:1:base:auto` is claimed by Great
   * Significance #1 (Joe Ingles), Hoops Art Signatures #1 (Paolo Banchero),
   * Hoops Ink #1 (Cade Cunningham) and Hot Signatures Hyper Gold #1 (Luka
   * Doncic). In NOT ONE of the 1,803 does an unclaimed row take part -- every
   * contested address is claimed by two or more NAMED subsets, the R30 shape
   * exactly.
   *
   * THE COLOUR RUNGS ARE NOT HERE, and that is the whole reason this list is 43
   * and not 170. cardboardconnection folds the colour into the manifest's
   * `subset` and leaves the parallel column BLANK, so #2112's deriver first
   * proposed 110 colour keys -- `...-college-penmanship-prizms-gold`,
   * `...-aspiring-patch-autographs-neon-splatter`. #2119 measures them instead:
   * a subset that reprints its root's roster (same number -> same player, zero
   * disagreements across 111 cells and 4,146 rows) is a RUNG, and its colour
   * rides the parallel axis on the root's key.
   *
   * THREE SUFFIXED KEYS ARE HERE ANYWAY, because the rosters refused the fold
   * and Drew ruled them card sets: the source publishes Hot Signatures Rookies
   * (98 different players from Hot Signatures), Art Signatures Horizontal and
   * Art Signatures Vertical (disjoint numbering) as separate checklists with
   * their own rosters.
   *
   * `panini-spectra-dual-patch-autographs` HAS NO BASE TIER. The source prints
   * fourteen "Dual Patch Autographs <colour>" files and no uncoloured one; all
   * fourteen name the set, so it is ONE card set with the colours on the
   * parallel axis and NO base row minted (Drew 2026-09-13). Blank stays unknown.
   *
   * NOT REGISTERED, deliberately: `2021 Spectra Football Vested Veterans
   * Autographs`, which cardboardconnection lists on the 2022 Spectra page. A
   * card set's year is the PRODUCT's year and a key never carries a year or a
   * sport word, so those 65 rows are a 2021 set carried over onto the 2022 page
   * and are HELD in the staged directory until the 2021 product can hold them.
   */
  ...["calligraphy-signatures", "great-significance", "hoops-art-signatures",
    "hoops-art-signatures-horizontal", "hoops-art-signatures-vertical",
    "hoops-ink", "hot-signatures", "hot-signatures-rookies",
    "private-signings", "rookie-ink",
  ].map((sub) => S(`nba-hoops-${sub}`, { family: "nba-hoops", parent: "nba-hoops" })),

  ...["action-all-pros-autographs", "all-pro-kings-autographs",
    "all-time-gridiron-kings-autographs", "canton-kings-autographs",
    "champ-is-here-autographs", "dominators-autographs",
    "fans-of-the-game-autographs", "franchise-future-autographs",
    "gridiron-kings-autographs", "highlights-autographs",
    "inducted-autographs", "jersey-kings-autographs",
    "leather-kings-autographs", "power-plus-autographs",
    "retro-1992-autographs", "retro-2002-autographs",
    "rookie-gridiron-kings-autographs", "rookie-phenom-jersey-autographs",
    "signature-marks", "the-elite-series-autographs",
    "the-legends-series-autographs", "the-rookies-autographs",
    "white-hot-rookies-autographs",
  ].map((sub) => S(`panini-donruss-${sub}`, { family: "panini-donruss", parent: "panini-donruss" })),

  /**
   * CF-A-NAMED-INSERT-SET-IS-ITS-OWN-CARD-SET, R38 (Drew, 2026-09-15).
   *
   * 120 insert-set keys for the 2019-2021 Donruss and Mosaic packages staged in
   * `acq-2026-09-14-cardboardconnection-2` (PR #2157). Those 8 files carry
   * 77,333 cards and were REFUSED by lib/insert-set-key.cjs because 4,193
   * addresses on the bare product key were claimed by two or more different
   * cards: every one of these products numbers its named insert sets from 1
   * with its OWN players. 2019 Donruss Football #1 is Patrick Mahomes II in
   * `base`, Todd Gurley II in `action-all-pros` and Peyton Manning in
   * `all-time-gridiron-kings`.
   *
   * THE KEY IS QUALIFIED, `<parent>-<subset>`, because a bare subset name
   * COLLIDES ACROSS SPORTS: `jersey-kings` and `the-rookies` each appear in
   * both a basketball and a football product, and `retro-series` in five cells
   * across both. 64 of the 122 keys span more than one (sport, year) cell.
   * Measured on main before this change: 0 of the 122 bare names was a
   * registered key, while 2 of the qualified forms already were
   * (`panini-donruss-rookie-phenom-jersey-autographs`,
   * `panini-donruss-signature-marks`) -- so this block registers 120, not 122.
   *
   * REGISTERING WITH `S` IS BOTH HALVES. lib/insert-set-key.cjs requires a key
   * to be a `normalizeSetKey` FIXED POINT, or the rows land where nothing can
   * reach them. `normalizeSetKey` consults `productSetKeyForName`, which reads
   * this table, and only `spelled` products answer -- so `S` (not `P`) is what
   * makes the key answer as itself. Verified by running the function on main
   * before the change: `normalizeSetKey("panini-donruss-rated-rookies")`
   * returned `panini-donruss` -- a fold PAST the subset onto the bare parent,
   * exactly the defect this prevents.
   *
   * BRAND-REPEAT NAMES ARE KEPT AS PRINTED (Drew, R38). The insert printed
   * inside Donruss really is called "Donruss Threads", so the key is
   * `panini-donruss-donruss-threads`. Trimming it to `panini-donruss-threads`
   * would invent a name the source does not use.
   *
   * Every subset below is a section title printed on the cardboardconnection
   * checklist for its product; the per-key row counts and the cells each spans
   * are in `data/checklist-rulings/2026-09-15-r38-insert-set-keys-for-ruling.json`.
   */
  ...["2019-super-bowl-signatures-prizm",
    "2020-super-bowl-mvp-signatures", "action-all-pros",
    "all-pro-kings", "all-time-gridiron-kings",
    "all-time-league-leaders", "canton-kings", "celebration-ink",
    "champ-is-here", "champions", "changing-stripes",
    "choice-signatures", "complete-players", "craftsmen",
    "crunch-time", "defying-gravity", "dominator-signatures",
    "dominators", "donruss-threads", "downtown", "duos",
    "fans-of-the-game", "fantasy-stars", "franchise-features",
    "great-x-pectations", "gridiron-greats", "gridiron-kings",
    "gridiron-marvels", "hall-dominator-signatures", "highlights",
    "inducted", "jersey-kings", "jersey-series", "league-leaders",
    "leather-kings", "legends-of-the-fall", "liftoff", "magicians",
    "marvels", "net-marvels", "next-day-autographs", "nicknames",
    "night-moves", "optic-rated-rookie-preview",
    "optic-rated-rookie-preview-blue",
    "optic-rated-rookie-preview-green",
    "optic-rated-rookie-preview-holo",
    "optic-rated-rookie-preview-pink",
    "optic-rated-rookie-preview-purple",
    "optic-rated-rookie-preview-red", "optic-rookie-preview",
    "out-of-this-world", "passing-the-torch-jerseys", "power-formulas",
    "power-in-the-paint", "production-line", "rated-rookies",
    "red-hot-rookies", "retro-1989", "retro-1990", "retro-1991",
    "retro-1999", "retro-2000", "retro-2001", "retro-series",
    "rise-n-shine-magnet", "road-to-the-super-bowl-championship",
    "road-to-the-super-bowl-conference-championship",
    "road-to-the-super-bowl-divisional-round",
    "road-to-the-super-bowl-wild-card", "rookie-dominator-signatures",
    "rookie-gridiron-kings", "rookie-holiday-sweater",
    "rookie-jersey-kings", "rookie-phenom-jerseys",
    "rookie-revolution", "rookies", "signature-highlights",
    "signature-series", "super-bowl-mvp", "team-pride-holo-horizontal",
    "team-pride-holo-vertical", "team-pride-horizontal",
    "team-pride-vertical", "team-supreme-horizontal",
    "team-supreme-vertical", "the-elite-series", "the-legends-series",
    "the-rookies", "vortex", "white-hot-rookies", "zero-gravity"
  ].map((sub) => S(`panini-donruss-${sub}`, { family: "panini-donruss", parent: "panini-donruss" })),

  ...["autographs-fast-break", "autographs-mosaic",
    "award-winning-autographs", "bang", "blue-chips", "center-stage",
    "elevate", "give-and-go", "got-game", "holofame",
    "in-it-to-win-it", "international-men-of-mastery", "introductions",
    "introductions-mosaic-red", "jam-masters", "men-of-mastery",
    "montage", "old-school", "overdrive", "rookie-autographs-mosaic",
    "rookie-private-signings-association-version",
    // The source prints "Rookie Private Signings Icon Version" only as its Gold
    // and Platinum rungs — there is no plain Icon Version section. Folding the
    // rungs onto the set they name (rather than minting
    // `...-icon-version-gold` as a card set) needs the root key registered, or
    // both rows fall back to the base product and collide with the Association
    // Version rows at card 12.
    "rookie-private-signings-icon-version", "rookie-scripts",
    "scripts", "stained-glass", "stare-masters", "straight-fire",
    "swagger", "will-to-win",
    "rookie-variations",
    ].map((sub) => S(`panini-mosaic-${sub}`, { family: "panini-mosaic", parent: "panini-mosaic" })),

  /**
   * 2024 PANINI MOSAIC FOOTBALL -- EIGHTEEN NAMED INSERT SETS (R67 method,
   * same as Illusions/Select/Zenith above; #2337, 2026-09-19).
   *
   * MEASURED against Beckett's own S3-hosted checklist (11,468 rows). The
   * offline planner names 20 unregistered keys; two (`center-stage-mosaic`,
   * `overdrive-mosaic`) are a trailing-"Mosaic" spelling of the ALREADY-
   * registered `panini-mosaic-center-stage` / `panini-mosaic-overdrive`
   * (both in the basketball-era block immediately above) and are fixed in
   * #2337's converter, not registered here a second time under a duplicate
   * spelling. The eighteen below have NO already-registered sibling under
   * any spelling -- each is genuinely new to this file.
   *
   * EVERY ONE IS `role: own-cards` in the converter's own classifier
   * (`classifySections`, the same production code every prior registration
   * in this file was measured against): no fold candidate was found for any
   * of them, meaning none is a numeric subset of any anchor on the file
   * (base or otherwise). Combined with each having Beckett's own distinct
   * section header, own "N cards." count and own numbering, this is the
   * "a named insert set is its own card set" shape (R60/R67), not a rung of
   * anything.
   *
   *     panini-mosaic-in-focus-signatures      194 rows (Autographs, signed)
   *     panini-mosaic-notoriety                175 rows (Inserts)
   *     panini-mosaic-capital-gains-mosaic     150 rows (Inserts -- "Mosaic"
   *                                                       is part of THIS
   *                                                       insert's own name,
   *                                                       unlike the two
   *                                                       spelling artefacts
   *                                                       above: no bare
   *                                                       "Capital Gains"
   *                                                       section exists on
   *                                                       this sheet at all)
   *     panini-mosaic-moments-in-time          150 rows (Inserts)
   *     panini-mosaic-showtime-signatures      150 rows (Autographs, signed)
   *     panini-mosaic-epic-performers          140 rows (Inserts)
   *     panini-mosaic-touchdown-masters        140 rows (Inserts)
   *     panini-mosaic-splash-mosaic            120 rows (Inserts, same "Mosaic
   *                                                       is the real name"
   *                                                       shape as Capital
   *                                                       Gains above)
   *     panini-mosaic-carbon-copy               90 rows (Inserts)
   *     panini-mosaic-storm-mosaic              90 rows (Inserts, same shape)
   *     panini-mosaic-kaleidoscopic             25 rows (Inserts)
   *     panini-mosaic-micro-mosaic              25 rows (Inserts, same shape)
   *     panini-mosaic-money                     25 rows (Inserts)
   *     panini-mosaic-signatures-highlights     14 rows (Autographs, signed)
   *     panini-mosaic-gridiron-greats           13 rows (Inserts)
   *     panini-mosaic-pinnacle-inscriptions      10 rows (Autographs, signed)
   *     panini-mosaic-franchise-numbers          1 row  (Autographs, signed)
   *     panini-mosaic-super-bowl-signatures      1 row  (Autographs, signed)
   *
   * "Capital Gains", "Splash" and "Storm" are each registered WITH "Mosaic"
   * in the key, not stripped, because Beckett's own workbook has no bare
   * ("Capital Gains" / "Splash" / "Storm") section at all on this file --
   * unlike Center Stage and Overdrive, which have BOTH a plain, already-
   * registered spelling on other Mosaic releases AND this file's own
   * "... Mosaic" suffix, "Mosaic" here is simply the whole name Beckett
   * printed for a 2024-football-only insert.
   *
   * `family` left at the default (each insert its own pricing family), same
   * as every prior R60/R67 registration; `parent: "panini-mosaic"` throughout.
   */
  S("panini-mosaic-in-focus-signatures", { parent: "panini-mosaic" }),
  S("panini-mosaic-notoriety", { parent: "panini-mosaic" }),
  S("panini-mosaic-capital-gains-mosaic", { parent: "panini-mosaic" }),
  S("panini-mosaic-moments-in-time", { parent: "panini-mosaic" }),
  S("panini-mosaic-showtime-signatures", { parent: "panini-mosaic" }),
  S("panini-mosaic-epic-performers", { parent: "panini-mosaic" }),
  S("panini-mosaic-touchdown-masters", { parent: "panini-mosaic" }),
  S("panini-mosaic-splash-mosaic", { parent: "panini-mosaic" }),
  S("panini-mosaic-carbon-copy", { parent: "panini-mosaic" }),
  S("panini-mosaic-storm-mosaic", { parent: "panini-mosaic" }),
  S("panini-mosaic-kaleidoscopic", { parent: "panini-mosaic" }),
  S("panini-mosaic-micro-mosaic", { parent: "panini-mosaic" }),
  S("panini-mosaic-money", { parent: "panini-mosaic" }),
  S("panini-mosaic-signatures-highlights", { parent: "panini-mosaic" }),
  S("panini-mosaic-gridiron-greats", { parent: "panini-mosaic" }),
  S("panini-mosaic-pinnacle-inscriptions", { parent: "panini-mosaic" }),
  S("panini-mosaic-franchise-numbers", { parent: "panini-mosaic" }),
  S("panini-mosaic-super-bowl-signatures", { parent: "panini-mosaic" }),

  ...["college-penmanship", "draft-picks-autographs", "freshman-signatures",
    "sensational-signatures",
  ].map((sub) => S(`panini-prizm-draft-picks-${sub}`, {
    family: "panini-prizm-draft-picks", parent: "panini-prizm-draft-picks",
  })),

  ...["aspiring-patch-autographs", "dual-patch-autographs",
    "full-spectrum-autographs", "retrospect-autographs", "rookie-autographs",
    "signatures",
  ].map((sub) => S(`panini-spectra-${sub}`, { family: "panini-spectra", parent: "panini-spectra" })),

  /**
   * BASEBALLCARDPEDIA'S SAME-NUMBERED INSERT SETS (R30, 2026-09-13).
   *
   * The bcp 2026-09-13 acquisition refused ten files for `unregistered-set-
   * keys` after its variation axis was applied. These seven keys are what
   * those files need, and every one was verified on the source as a
   * SEPARATELY-NUMBERED named set with its own checklist -- measured by
   * COLLISION, not by name:
   *
   *   BR-1  "St. Mary's Industrial School Student"  The Babe Ruth Story
   *   BR-1  "Babe Ruth"                             Baseball Royalty
   *   S-AH  "Aaron Hicks"                           DK Signatures
   *   S-AH  "Austin Hays"                           DK Rookie Signatures
   *
   * Two different players, one card number, one product key -- so one of them
   * would overwrite the other and the last writer would decide which card the
   * address holds. That is R30's shape exactly.
   *
   * THE COLOUR RUNGS OF THESE SETS ARE NOT HERE, DELIBERATELY. The guard also
   * named `diamond-kings-dk-materials-holo-gold`, `...-holo-blue`,
   * `...-holo-silver`, `auto-dk-signatures-purple`, `...-masterpiece` and
   * `donruss-rookie-year-materials-jerseys-jersey-number`. The source's own
   * prose calls those PARALLELS ("Each DK Materials is also available in a
   * one-of-one Masterpiece parallel"; "...are also available in a Jersey
   * Number parallel") and prints them as subsections of their set. A colour
   * rung is never a card set key, so they fold onto their root with the colour
   * on the parallel axis and are NOT registered -- registering them would
   * split one pool per colour.
   */
  S("topps-baseball-history", { family: "topps", parent: "topps" }),
  S("topps-baseball-royalty", { family: "topps", parent: "topps" }),
  S("topps-the-babe-ruth-story", { family: "topps", parent: "topps" }),
  S("topps-cal-ripken-jr-refractor", { family: "topps", parent: "topps" }),
  S("topps-factory-set-rookie-variations", { family: "topps", parent: "topps" }),
  S("diamond-kings-dk-signatures", { family: "diamond-kings", parent: "diamond-kings" }),
  S("diamond-kings-dk-rookie-signatures", { family: "diamond-kings", parent: "diamond-kings" }),

  /**
   * PANINI HAUNTED HOOPS IS ITS OWN PRODUCT (#1715 class, 2026-09-07).
   *
   * The Halloween release is a SEPARATE product from Panini NBA Hoops: its own
   * 300-card checklist, its own parallels (Slime, Holo Bats, Holo Webs, Holo
   * Trick-or-Treat), its own print runs and its own market. It is the
   * flagship-catch-all class exactly -- `nba-hoops` carries the family word
   * "Hoops", so every unanchored Hoops rule swallowed the specialization.
   *
   * MEASURED READ-ONLY AGAINST PROD, 2026-09-07. The damage was not one-sided,
   * which is why the fix is a ruled key rather than a repair list alone:
   *
   *   card_catalog  1,825 rows setName "2024 panini haunted hoops"
   *                            (checklistinsider-2026-08-27) at `nba-hoops`
   *                 2,100 rows setName "2024/25 Panini Haunted Hoops
   *                            Basketball" (hobbymonitor-2026-09-04) already
   *                            at `panini-haunted-hoops`
   *   sold_comps    4,653 sales whose own titles read "Panini Haunted Hoops"
   *                            priced inside the NBA Hoops flagship pool
   *                            (2023: 3,539; 2024: 1,114) against 112 correct
   *
   * ONE PRODUCT, TWO POOLS, AND THE PARSER PICKED THE POOL BY PUNCTUATION.
   * Both catalog populations are the SAME 300-card checklist -- 1,200 identity
   * keys (number|parallel|auto|printRun) appear in both and the player agrees
   * on all 1,200, zero disagreements. They diverged only because
   * normalizeSetKey answered three different ways for one product name:
   *
   *   "2024 panini haunted hoops"              -> panini-haunted-hoops (slugify
   *                                               fallthrough, by luck)
   *   "2024/25 Panini Haunted Hoops Basketball"-> nba-hoops   (the slash form)
   *   "Haunted Hoops Basketball"               -> nba-hoops   (the bare form)
   *
   * The key `panini-haunted-hoops` therefore already holds 2,100 rows while
   * being DECLARED NOWHERE -- it existed only as an accident of slugify, which
   * is precisely the state a ruled key must replace: a key nothing declares is
   * one parser edit away from vanishing.
   *
   * SPELLED (`S`), for the Fleer-coated-reprint reason stated above. Only a
   * spelled product answers productSetKeyForName, the leg of normalizeSetKey
   * that runs BEFORE the unanchored brand patterns; declared with `P` this key
   * still collapses onto `nba-hoops`, verified by running the function rather
   * than by reading it.
   *
   * `parent: "nba-hoops"` records the family it is a release of, so the matcher
   * may widen up the ladder, while `family` keeps its pool its own. It is NOT
   * given the name "hoops": that name belongs to the flagship, and handing it
   * here would re-create the swallow in the opposite direction.
   */
  S("panini-haunted-hoops", { family: "nba-hoops", parent: "nba-hoops" }),

  /**
   * NBA HOOPS PREMIUM STOCK IS ITS OWN PRODUCT (same class, same day). The
   * SECOND specialization `nba-hoops` was swallowing, and the larger of the
   * two by checklist rows.
   *
   * MEASURED READ-ONLY, 2026-09-07. `nba-hoops` holds exactly five distinct
   * (setName, source, year) shapes, and two of them are not the flagship:
   *
   *     26,219  "2024 nba hoops"                 checklistinsider-2026-08-27
   *     14,970  "2023 nba hoops premium stock"   checklistinsider-2026-08-27
   *      1,825  "2024 panini haunted hoops"      checklistinsider-2026-08-27
   *         20  "2024 nba hoops"                 checklistinsider-2026-08-28
   *         11  "2024 nba hoops"                 checklistinsider-2026-08-29
   *
   * It is a DIFFERENT CHECKLIST, not a parallel run of the flagship's: its own
   * 1-300 with its own roster, and its 300 numbers share no player-at-number
   * agreement with the flagship rows (0 of 0 comparable -- the strict flagship
   * rows are 2024 and Premium Stock is 2023, so there is no year in which the
   * two could be confused for one checklist). Every parallel it carries is
   * Prizm-family stock (Premium Nebula Prizm, Red Seismic Prizm, Gold Vinyl
   * Prizm, Red Ice Prizm) -- the Prizm-stock insert product, not the paper
   * flagship. 9,205 pool titles say "Premium Stock".
   *
   * THE NAME IS SHARED, WHICH IS WHY THE RULE IS HOOPS-GATED. "Premium Stock"
   * names a STOCK several Panini products borrow: normalizeSetKey("2023 Panini
   * Prizm Premium Stock") answers `panini-prizm` today and must keep doing so.
   * So the vocabulary rule anchors on "hoops premium stock", never on the
   * stock words alone -- the same discipline as `optic`, a stock other
   * products borrow, being ruled only where it names the product.
   *
   * Same shape as Haunted Hoops above: `S` so productSetKeyForName answers
   * before the unanchored Hoops patterns, `parent` for the ladder, and NOT the
   * name "hoops", which belongs to the flagship.
   */
  S("nba-hoops-premium-stock", { family: "nba-hoops", parent: "nba-hoops" }),

  /**
   * 2024 PANINI ILLUSIONS -- THE FIVE NAMED INSERT SETS (R60, Drew: a named
   * insert set is its own card set, keyed `<product>-<insert>`; R38 registers
   * Panini keys en bloc).
   *
   * MEASURED, not proposed. The committed checklistinsider file
   * `2024-panini-illusions-football.csv` is REFUSED WHOLE by the ingester's
   * id-integrity guard -- `files REFUSED, id integrity 1 (10,871 rows)`, zero
   * written -- and the guard names exactly these five keys, each with the
   * categories that produce it:
   *
   *     panini-illusions-trophy-collection                        2,300 rows
   *     panini-illusions-mystique-autographs                        270
   *     panini-illusions-immortalized-jersey-autographs             197
   *     panini-illusions-rookie-reflections-dual-patch-autographs     81
   *     panini-illusions-illusionists-autographs                      34
   *
   * Every one of them answers `panini-illusions` today -- verified by RUNNING
   * normalizeSetKey, not by reading it -- so all five products' cards would
   * land on the flagship's addresses. 10,871 rows would have taken 8,653
   * distinct ids; the guard is what stops that, and registration is what
   * clears the guard. The whole file is held until all five exist: the unit of
   * refusal is the FILE, never half a product.
   *
   * SPELLED (`S`), for the reason Haunted Hoops states above: only a spelled
   * product answers productSetKeyForName, the leg that runs BEFORE the
   * unanchored brand patterns. Declared with `P` these keys still collapse
   * onto `panini-illusions`.
   *
   * `parent: "panini-illusions"` records the release they belong to so the
   * matcher may widen up the ladder, while `family` keeps each pool its own.
   * None is given the bare name "illusions" -- that belongs to the flagship,
   * and handing it here re-creates the swallow in the opposite direction.
   *
   * ILLUSIONISTS IS THE PRODUCT'S SIGNATURE SET and the one the R31/R33 title
   * refusals kept naming; `-illusionists-autographs` is the SIGNED sibling and
   * a different card set, not a rung of it.
   *
   * R67 (2026-09-19) SUPERSEDES R60's UNSIGNED-ILLUSIONISTS EXCLUSION. This
   * comment used to say the unsigned `Illusionists` rows "carry a blank
   * parallel and stay on the product key, exactly as the base ladder does" --
   * that premise no longer matches the staged data. `insert-illusionists`
   * rows carry their OWN stated parallel ("Illusionist", not blank), and
   * there is a real same-number/different-player fact against base: base #1
   * is Kyler Murray, Illusionists #1 is Caleb Williams. R67's own rule (a
   * named insert set is its own product key) reaches this exactly like every
   * other insert in the file, and now registers it below, alongside its
   * already-registered signed sibling.
   */
  S("panini-illusions-trophy-collection", { family: "panini-illusions", parent: "panini-illusions" }),
  S("panini-illusions-mystique-autographs", { family: "panini-illusions", parent: "panini-illusions" }),
  S("panini-illusions-immortalized-jersey-autographs", { family: "panini-illusions", parent: "panini-illusions" }),
  S("panini-illusions-rookie-reflections-dual-patch-autographs", { family: "panini-illusions", parent: "panini-illusions" }),
  S("panini-illusions-illusionists-autographs", { family: "panini-illusions", parent: "panini-illusions" }),
  S("panini-illusions-illusionists", { family: "panini-illusions", parent: "panini-illusions" }),

  /**
   * R67 (Drew, ruling round of 2026-09-19): 2024 PANINI ILLUSIONS FOOTBALL --
   * THE REST OF THE NAMED INSERT SETS.
   *
   * The five above were registered under R60 to clear the ingester's
   * id-integrity guard (a genuine card-number COLLISION with base). This
   * batch answers a different question -- not "does the id collide", but R67's
   * own: "a named insert set is its own product key", so it prices in its own
   * pool rather than the flagship's, whether or not its rows' addresses
   * already happen to be safe. Measured directly against the same staged
   * checklist (`2024-panini-illusions-football.csv`, already on main) with
   * the module's own production fold (`insert-set-key.cjs`'s
   * `rungFoldingFor`), same method as Photogenic and Zenith.
   *
   * VERIFIED WITH THE REAL PRODUCTION ID, NOT A HAND APPROXIMATION.
   * `IS.planFile` run with `computeHobbyIqCardId` (not a simplified stand-in)
   * reports this file `verdict: pass`, 10,871 rows on 10,871 distinct ids,
   * ZERO collisions, with only the five keys above separated -- because every
   * insert here states its OWN parallel column, and the parallel is part of
   * the id. So none of the twenty-three below are needed to stop a
   * collision; they are needed so `panini-illusions-deja-vu` (for example)
   * does not price off the flagship's comp pool.
   *
   * THE SAME ROSTER TEST AS ZENITH -- cardNumber + player, players split on
   * "/", trimmed, lowercased, de-duplicated, sorted -- resolved most
   * colour-suffixed categories automatically via the module's fold (dual-
   * player cards like Déjà Vu's "Brock Purdy/Joe Montana" needed the SORTED
   * comparison specifically: the source spells the two names in a different
   * order between the plain file and its colour files, which the module's
   * own fold compares as literal strings and therefore missed -- the sorted
   * roster test is what catches it). Two clusters needed the roster test
   * applied by hand for that reason:
   *
   *   deja-vu (7 spellings -> 1 root): plain + black/blue/gold/green/purple/
   *     red, all the same 19-card roster once player order is normalized.
   *   rookie-idols-dual-memorabilia (7 spellings -> 1 root): plain +
   *     black/blue/gold/green/purple/red, same shape, 20-card roster.
   *
   * TWO MORE CLUSTERS, PLAIN COLOUR SUFFIXES THE MODULE'S OWN FOLD ALREADY
   * HANDLES, but the source SPELLED one of the five wrong:
   *
   *   inspirations (5 spellings -> 1 root, `inspirations-all-pro`):
   *     All-Pro/Conference/Division/Super Bowl/Wild Card, same roster.
   *   trophy-hunters (5 spellings -> 1 root, `trophy-hunters-all-pro`):
   *     All-Pro/Conference/Division/Super Bowl/Wild Card, same roster --
   *     EXCEPT the source's own category for the fifth is spelled
   *     `Trophy Huinters Wild Card` (transposed letters), a scraper
   *     transcription typo beside four correctly-spelled `Trophy Hunters`
   *     siblings. Registered under the CORRECT spelling
   *     (`trophy-hunters-all-pro`); the typo'd category still resolves to it
   *     through the roster fold, so no row is lost, and no misspelled key is
   *     minted.
   *
   * AUTO/SIGNED STATUS NEVER MERGES WITH ITS UNSIGNED SIBLING, even when the
   * roster is an exact match -- CF-A-COLOUR-RUNG-IS-NEVER-A-CARD-SET-KEY's
   * "tail says SIGNED" rule, same as Photogenic's rookie-portrait /
   * rookie-portrait-autographs and Zenith's several `-autographs` roots:
   *
   *   clutch / clutch-signatures: `Clutch Signatures` (9 rows, numbers 5-19)
   *     shares every number and player with `Clutch` (20 rows, numbers 1-20)
   *     where they overlap, but "Signatures" states the signed subset by
   *     name -- registered as its own key, not folded into Clutch.
   *   illusionists-autographs (already registered above) / illusionists:
   *     see the KNOWN DISCREPANCY below.
   *
   * TWENTY-THREE ROOTS, with row counts:
   *
   *     abracadabra                                20 rows
   *     amazing                                     25 rows
   *     bright-lights-signatures                    22 rows
   *     clutch                                      20 rows
   *     clutch-signatures                            9 rows -- signed sibling
   *                                                            of Clutch, own key
   *     deja-vu                                     19 rows, 6-way CLUSTER
   *     elusive-ink                                 11 rows
   *     first-impressions-autographed-memorabilia   35 rows (auto-prefixed,
   *                                                            own roster, blank
   *                                                            parallel but its
   *                                                            OWN print run per
   *                                                            card -- no collision)
   *     game-magicians                              25 rows
   *     great-expectations                         100 rows
   *     highlight-swatches                           20 rows
   *     holoheroes                                   30 rows
   *     holoheroes-rookies                           34 rows -- DIFFERENT
   *                                                            roster from
   *                                                            holoheroes,
   *                                                            zero overlap;
   *                                                            its own product,
   *                                                            not a rung
   *     inspirations-all-pro                        50 rows, 5-way CLUSTER
   *     prodigy-endorsements                         18 rows
   *     rookie-endorsements                          38 rows
   *     rookie-idols-dual-memorabilia                20 rows, 7-way CLUSTER
   *     rookie-signs                                 33 rows
   *     rookie-vision-signatures                     20 rows
   *     shining-stars                                25 rows
   *     superlatives                                 23 rows
   *     trophy-collection-signatures                  7 rows -- signed sibling
   *                                                            of Trophy
   *                                                            Collection (the
   *                                                            key registered
   *                                                            above); currently
   *                                                            COLLAPSES ONTO
   *                                                            IT via a
   *                                                            substring match,
   *                                                            measured with
   *                                                            normalizeSetKey
   *     trophy-hunters-all-pro                      50 rows, 5-way CLUSTER
   *                                                            (typo fixed, see
   *                                                            above)
   *
   * KNOWN DISCREPANCY, STATED RATHER THAN SILENCED. The R60 comment above
   * says unsigned `Illusionists` "carries a blank parallel and stays on the
   * product key" -- but the CURRENT staged CSV shows `insert-illusionists`
   * rows carrying their own stated parallel ("Illusionist"), not blank, and a
   * genuine same-number/different-player fact against base (`base #1` is
   * Kyler Murray; `Illusionists #1` is Caleb Williams). Because the parallel
   * IS part of the computed id, this does not collide -- `panini-illusions:
   * 1:base:no-auto` and `panini-illusions:1:illusionist:no-auto` are already
   * different addresses -- so the R60 test's premise (registering it would
   * "split the base pool") does not hold against today's data either way,
   * whatever it described when it was written. NOT REGISTERED HERE: the
   * existing test (`illusionsInsertSetsAreTheirOwnCardSets.test.ts`) PINS
   * `panini-illusions-illusionists` absent, and overriding a pinned ruling on
   * a hunch is exactly the failure mode R67 exists to prevent. Flagged for
   * Drew in this PR's description instead.
   *
   * `family` left at the default (each insert its own pricing family), same
   * as the Photogenic and Zenith precedents; `parent: "panini-illusions"`
   * throughout.
   */
  S("panini-illusions-abracadabra", { parent: "panini-illusions" }),
  S("panini-illusions-amazing", { parent: "panini-illusions" }),
  S("panini-illusions-bright-lights-signatures", { parent: "panini-illusions" }),
  S("panini-illusions-clutch", { parent: "panini-illusions" }),
  S("panini-illusions-clutch-signatures", { parent: "panini-illusions" }),
  S("panini-illusions-deja-vu", { parent: "panini-illusions" }),
  S("panini-illusions-elusive-ink", { parent: "panini-illusions" }),
  S("panini-illusions-first-impressions-autographed-memorabilia", { parent: "panini-illusions" }),
  S("panini-illusions-game-magicians", { parent: "panini-illusions" }),
  S("panini-illusions-great-expectations", { parent: "panini-illusions" }),
  S("panini-illusions-highlight-swatches", { parent: "panini-illusions" }),
  S("panini-illusions-holoheroes", { parent: "panini-illusions" }),
  S("panini-illusions-holoheroes-rookies", { parent: "panini-illusions" }),
  S("panini-illusions-inspirations-all-pro", { parent: "panini-illusions" }),
  S("panini-illusions-prodigy-endorsements", { parent: "panini-illusions" }),
  S("panini-illusions-rookie-endorsements", { parent: "panini-illusions" }),
  S("panini-illusions-rookie-idols-dual-memorabilia", { parent: "panini-illusions" }),
  S("panini-illusions-rookie-signs", { parent: "panini-illusions" }),
  S("panini-illusions-rookie-vision-signatures", { parent: "panini-illusions" }),
  S("panini-illusions-shining-stars", { parent: "panini-illusions" }),
  S("panini-illusions-superlatives", { parent: "panini-illusions" }),
  S("panini-illusions-trophy-collection-signatures", { parent: "panini-illusions" }),
  S("panini-illusions-trophy-hunters-all-pro", { parent: "panini-illusions" }),

  /**
   * 2024 PANINI ILLUSIONS FOOTBALL -- TWO MORE NAMED INSERT SETS, FOUND IN
   * BECKETT'S OWN CHECKLIST (2026-09-19), ABSENT FROM THE 28 ABOVE.
   *
   * The 28 keys above were all measured against the checklistinsider package
   * already on main (10,871 rows). #2337 acquired the SAME product from
   * Beckett's own S3-hosted checklist (7,094 rows, a different source with a
   * different sheet layout) and its offline planner names exactly two
   * unregistered keys, neither present in checklistinsider's own file at all:
   *
   *     panini-illusions-mystique          336 rows (Inserts sheet, "Mystique")
   *     panini-illusions-instant-impact    280 rows (Memorabilia sheet,
   *                                                  "Instant Impact")
   *
   * BOTH ARE THEIR OWN CARD SET, NOT A RUNG OF ANYTHING ALREADY REGISTERED
   * ABOVE. Beckett's own workbook prints each with its own header, its own
   * "N cards." count, and its own numbering (Mystique #1-42, Instant Impact
   * #1-40); the converter's classifier (`classifySections`, same production
   * code every other registration in this file was measured against) finds
   * NO fold candidate for either -- both land `role: "own-cards"`, meaning
   * their numbers never fully overlap any anchor (base or otherwise) on the
   * file. Confirmed distinct from each other too, not a duplicate listing of
   * one product under two names: Mystique #3 is Bo Nix, Instant Impact #3 is
   * Marvin Harrison Jr. -- different players at the same number, so neither
   * is a re-statement of the other.
   *
   * WHY THIS MATTERS. Both currently answer `panini-illusions` (verified by
   * running normalizeSetKey), so every one of their 616 combined rows would
   * price in the flagship base pool instead of their own -- and because
   * BOTH keys fall back to the identical address, they collide with base AND
   * with each other: 202 id-collision groups in #2337's own offline planner
   * run, every one of them a {base, insert-instant-impact, insert-mystique}
   * triple or pair fighting for `panini-illusions:<N>:base:no-auto`.
   * Registration alone clears every one of them -- no fold, no roster
   * ambiguity, both simply need their own address.
   */
  S("panini-illusions-mystique", { parent: "panini-illusions" }),
  S("panini-illusions-instant-impact", { parent: "panini-illusions" }),

  /**
   * 2024 PANINI SELECT FOOTBALL -- THE 33 NAMED INSERT SETS (R60 + R38).
   *
   * MEASURED. The committed checklistinsider package is REFUSED WHOLE --
   * `files REFUSED, id integrity 1 (27,324 rows)`, zero written -- on
   * unregistered-set-keys, and the guard names these 33. 27,324 rows would
   * have landed on 22,503 distinct ids.
   *
   * THE TIERS ARE NOT IN THIS LIST, AND THAT IS THE POINT. Select numbers its
   * base card by TIER -- `insert-base-concourse`, `-club-level`,
   * `-suite-level`, `-premier-level`, `-field-level`, 19,900 rows in all --
   * and #2231 already registered the tier destinations. Those rows are the
   * product's own base card and stay on the product key; none of them appears
   * in the refusal list.
   *
   * They also CANNOT collide, which is what separates this product from
   * Zenith. The tiers hold DISJOINT number ranges, measured:
   *
   *     concourse      #1   Tory Taylor      (1-200)
   *     club-level     #201 Xavier Rhodes    (201-300)
   *     suite-level    #301 Adonai Mitchell  (301+)
   *
   * Zenith's variants all reuse #1-100 with the same players, so they collapse
   * onto one id; Select's never meet. Registration alone therefore clears this
   * file, and the REPORT confirms it: REFUSED 0, 27,324 rows on 27,324 ids.
   *
   * `panini-select-signatures` AND `panini-select-select-signatures` are BOTH
   * here and both correct. They are two different sets in one product --
   * `insert-signatures-*` and `insert-select-signatures-*` -- so the doubled
   * word is the product's own naming, not a slug defect. Collapsing them would
   * merge two card sets.
   *
   * Ordered longest-first, as every one of these blocks is. No key here is a
   * prefix of another, no singular/plural twin, and none ends in a bare colour
   * -- all three checked and pinned by test.
   */
  S("panini-select-jumbo-rookie-signature-swatch-black-prizm-nfl-shield", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-jumbo-rookie-signature-swatch-black-prizm-brand-logo", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-jumbo-signature-swatch-black-prizm-nfl-shield", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-jumbo-signature-swatch-black-prizm-brand-logo", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-jumbo-rookie-signature-swatch-black-prizm-tag", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-jumbo-signature-swatch-black-prizm-tag", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-jumbo-rookie-signature-swatches", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-spectra-hof-signatures-prizm", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-rookie-signature-memorabilia", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-draft-selections-memorabilia", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-2025-xrc-mystery-autograph", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-select-certified-rookies", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-jumbo-signature-swatches", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-score-select-throwback", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-signature-memorabilia", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-jumbo-rookie-swatch", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-select-signatures", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-rookie-signatures", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-rookie-swatches", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-hall-selections", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-select-numbers", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-select-future", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-turbocharged", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-watercolors", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-color-wheel", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-signatures", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-phenomenon", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-neon-icons", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-multiverse", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-snapshots", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-alter-ego", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-starcade", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-sparks", { family: "panini-select", parent: "panini-select" }),

  /**
   * R67 (Drew, ruling round of 2026-09-19): 2024 PANINI SELECT FOOTBALL --
   * FOUR MORE NAMED INSERT ROOTS THE R60 GUARD DID NOT NEED.
   *
   * The 33 above were measured against this exact file to clear a genuine id
   * COLLISION (base's own tiers already have disjoint number ranges, so this
   * product never collides the way Zenith did -- registration alone clears
   * the whole file, REFUSED 0). This batch answers R67's separate question --
   * a named insert prices in its own pool -- for roots the module's own
   * prefix-based fold could not connect on its own, same method as
   * Illusions: the colour word sits in the MIDDLE of the category name
   * (`2025-XRC-BLACK-Prizm`, not a trailing suffix), and the parallel column
   * is blank on the plain tier, so `categorySubsetSlug`'s suffix-strip has
   * nothing to strip against.
   *
   *   panini-select-2025-xrc (4 spellings -> 1 root): plain + black/gold/
   *     tie-dye Prizm, exact roster subsets of the plain 20-card checklist.
   *     Distinct from the ALREADY-REGISTERED `panini-select-2025-xrc-
   *     mystery-autograph`, which is the SIGNED sibling -- same "tail says
   *     SIGNED" rule as every other product, unaffected by the shared
   *     "2025-xrc" name fragment.
   *
   *   panini-select-prime-selections-signatures (9 spellings -> 1 root):
   *     Prizm/Black Prizm (x4 tag variants)/Gold Prizm/Green Prizm/Neon
   *     Orange Pulsar Prizm/Tie-Dye Prizm Signatures. Zero disagreement on
   *     every shared number across all nine -- the size differences (34-42
   *     rows) are real short-print scarcity per colour/tag, the same shape
   *     Zenith's Rookie Patch Autographs measured, not different checklists.
   *
   * TWO REDEMPTION ROOTS, BOTH OWN-KEY, NEITHER A RUNG OF ITS NON-REDEMPTION
   * SIBLING. A "redemption" card physically occupies the SAME numbered slot
   * as the real card it stands in for -- `insert-2025-xrc-prizm-redemption`
   * reuses #501-520, exactly the non-redemption insert's own numbers -- but
   * the source spells the player as a POSITION SLOT ("QB1", "QB2", ...,
   * "XRCAuto1") rather than a real name, so EVERY shared number disagrees on
   * player. That is the R30/R67 defect a colour rung can never be: same
   * number, different card, and the roster rule's own "zero disagreement"
   * requirement is exactly what stops it from folding. Drew's ruling: these
   * are their own product, not a rung of `2025-xrc` or
   * `2025-xrc-mystery-autograph` respectively.
   *
   *   panini-select-2025-xrc-redemption (4 spellings -> 1 root): Redemption/
   *     Black Prizm Redemption/Gold Prizm Redemption/Tie-Dye Redemption, all
   *     twenty QB/RB/WR/TE/DEF placeholder slots, zero disagreement --
   *     colour rungs of EACH OTHER, never of the real-player `2025-xrc`.
   *   panini-select-2025-xrc-mystery-autograph-redemption (4 spellings -> 1
   *     root): the signed sibling's placeholder redemption, same shape,
   *     five XRCAuto slots. MEASURED BEFORE REGISTERING: this key currently
   *     COLLAPSES ONTO `panini-select-2025-xrc-mystery-autograph` (the real
   *     signed insert) via a substring match -- exactly the defect this
   *     registration fixes, verified by running normalizeSetKey.
   *
   * TIERS WERE A SEPARATE OPEN QUESTION AT THE TIME OF THIS COMMENT, NOT
   * ANSWERED HERE. This file's base card ladders across five tiers --
   * Concourse, Club Level, Field Level, Premier Level, Suite Level. At the
   * time this PR (R67) landed, only three were registered, under #2231 (see
   * the block above naming panini-select-concourse etc.); Club Level and
   * Suite Level were NOT yet registered, and a test in this file pinned that
   * gap open for Drew's ruling. R71 (owner, 2026-09-19) closed it -- all five
   * are now registered (see the R71 block above, immediately after the
   * #2231 one) -- so this comment's original claim that all five were
   * "already registered ... under #2231" is corrected here rather than left
   * to mislead the next reader. No Courtside Level tier appears in THIS
   * football file (Courtside is a basketball tier, registered separately by
   * R71 too). Nothing about the tiers is touched, folded, or renumbered by
   * the R67 keys below; they remain what they always were, four named insert
   * roots unrelated to the tier axis.
   */
  S("panini-select-2025-xrc", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-prime-selections-signatures", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-2025-xrc-redemption", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-2025-xrc-mystery-autograph-redemption", { family: "panini-select", parent: "panini-select" }),

  // -- Fleer / Skybox / Pinnacle / Score / vintage ----------------------------
  P("fleer"),
  ...["fleer-stickers", "fleer-tradition", "fleer-update", "fleer-metal-universe"].map((k) => P(k, { parent: "fleer" })),
  P("fleer-tradition-update", { family: "fleer-tradition", parent: "fleer-tradition" }),
  P("fleer-tradition-glossy", { family: "fleer-tradition", parent: "fleer-tradition" }),
  /**
   * THE FLEER COATED REPRINTS (#1745 follow-on, 2026-09-04). Each reprints its
   * parent's FULL checklist on coated stock at the parent's own numbers, and
   * each trades at its own price -- so each is a PRODUCT, `parallel` blank,
   * exactly as Topps Tiffany is (Drew 2026-09-01). Declared here because a
   * ruled key must be a normalizeSetKey fixed point; undeclared, all five fell
   * to the unanchored `fleer` family rule and collapsed onto the paper set.
   *
   * The repair lane of #1745 gates 1,339 catalog rows and 994 comps on these
   * keys existing with rows behind them -- "acquire before retire", because
   * retiring a Fleer Tiffany rung with no sibling product would delete the only
   * rows those cards have.
   *
   * TWO DISTRIBUTIONS, ONE DOCTRINE. `fleer-glossy` 1987-1989 is the tin
   * factory set ("Custom Coated Collector's Edition", 660 cards each year,
   * discontinued after 1989 -- there is NO 1990 or 1991 Fleer Glossy).
   * `fleer-tiffany` 1996/1997/2002 is pack-inserted (1996 one per pack across
   * all 600; 1997 one in 20 across 751; 2002 serial numbered to 200). The
   * distribution decides the scarcity, never the identity: both are the parent
   * checklist on coated stock, and both get their own row and their own pool.
   *
   * SPELLED (`S`), not `P`, and that is the whole point: only a spelled product
   * answers productSetKeyForName, which is the leg of normalizeSetKey that runs
   * BEFORE the unanchored brand patterns. Declared with `P` these keys still
   * collapsed to `fleer` -- verified by running the function, not by reading it.
   * They cannot take the reconciliation's route to a fixed point either: that
   * one is fed by the census, and a key with no catalog rows yet has no census
   * entry to be ruled from ("acquire before retire" means the rows arrive
   * after the ruling, not before).
   */
  S("fleer-tiffany", { family: "fleer", parent: "fleer" }),
  S("fleer-glossy", { family: "fleer", parent: "fleer" }),
  S("fleer-update-tiffany", { family: "fleer-update", parent: "fleer-update" }),
  S("fleer-update-glossy", { family: "fleer-update", parent: "fleer-update" }),
  S("fleer-tradition-tiffany", { family: "fleer-tradition", parent: "fleer-tradition" }),
  P("flair", { parent: "fleer" }),

  /**
   * 1997 FLAIR SHOWCASE IS THREE CARD SETS (R30, Drew 2026-09-13).
   *
   * The same ruling as the Rookies & Stars autograph subsets: a same-numbered
   * subset is its own card set. baseballcardpedia states it outright -- "all
   * 540 base cards (180 players from all three Rows) are available in a Legacy
   * and Masterpiece parallel" -- and 540 = 180 x 3. Rows 0, 1 and 2 are three
   * distinct 180-card sets that SHARE NUMBERS 1-180, so the number cannot tell
   * a Row 0 Griffey from a Row 2 Griffey and only the row can.
   *
   * Measured on the #2107 staged rows before this entry existed: 1,080 of
   * 1,620 minted ids collided, all three rows landing on
   * `hiq:baseball:1997:flair:1:base:no-auto`.
   *
   * REGISTRATION IS THE MECHANISM, NOT BOOKKEEPING. `normalizeSetKey` returned
   * `flair` for all three, because the strict-tier rule `/flair-showcase|flair/`
   * swallows every `flair-showcase-*` spelling. A key that is not a
   * normalizeSetKey FIXED POINT cannot hold a pool, so `spelled` is what makes
   * productSetKeyForName answer ahead of the regex vocabulary -- and the
   * anchored rule added beside that catch-all in hobbyIqCardId.service.ts is
   * what holds if this table is ever absent (its loader degrades to an EMPTY
   * doc by design, so "absent" is a state that really occurs).
   *
   * LEGACY COLLECTION (/100) AND MASTERPIECE (/1) ARE NOT ROWS. The same
   * sentence names them as parallels of every row, so they are rungs ON these
   * three keys rather than keys of their own, and there is no Row 3 -- only
   * 0, 1 and 2 appear anywhere on the page.
   *
   * THE BARE SPELLINGS STILL POOL INTO `flair`. "Flair Showcase" with no row,
   * and plain "Flair", are untouched and keep folding to `flair` exactly as
   * the pinned test requires; only a spelling that NAMES a row is separated.
   */
  ...["flair-showcase-row-0", "flair-showcase-row-1", "flair-showcase-row-2"]
    .map((k) => S(k, { parent: "flair" })),
  P("ultra"),
  P("skybox"),
  ...["skybox-metal-universe", "skybox-thunder", "skybox-premium", "skybox-molten-metal"].map((k) => P(k, { parent: "skybox" })),
  P("metal-universe"),
  // CF-A-NAMED-INSERT-SET-IS-ITS-OWN-PRODUCT (Drew, 2026-09-09). Heavy Metal
  // is a 10-card insert with its OWN numbering: its #2 is Barry Bonds while
  // the 250-card base set's #2 is Brady Anderson. It is `parent`ed to
  // metal-universe (it ships inside that release) but is its own product, so
  // rows minted for it stop landing on base-set addresses and absorbing into
  // another player's pool. See normalizeSetKey, where it precedes the
  // /metal-universe/ family pattern.
  P("metal-universe-heavy-metal", { parent: "metal-universe" }),
  P("pinnacle"),
  P("pinnacle-aficionado", { parent: "pinnacle" }),
  /**
   * 1992 PINNACLE'S SIX INSERT SETS ARE THEIR OWN CARD SETS (R30/R21,
   * 2026-09-13). Drew's ruling class: a same-numbered insert set that is not
   * a rung of the flagship's OWN checklist is a card set of its own, the way
   * an autograph subset that restarts numbering is (see the Panini Rookies &
   * Stars R30 entry above).
   *
   * THE INCIDENT THIS FIXES. Tonight's SCC universe driver APPLY run
   * (34732777018) staged and ingested six 1992 Pinnacle insert products —
   * Mickey Mantle (30 rows), Rookie Idols (18), Rookies (30), Slugfest (15),
   * Team 2000, Team Pinnacle — and the CHILD'S OWN COUNT said every one wrote
   * successfully (`catalog rows written 30`, etc.). The driver's verification
   * read the product back at ZERO rows for all six ("green ingest, 0 rows
   * landed" x6) and a direct Cosmos read confirmed why: every row landed
   * under `setKey: "pinnacle"`, `setName: "1992 Pinnacle Baseball"` — the
   * FLAGSHIP'S identity, not the insert's — merging six inserts silently
   * onto the base set at colliding card numbers.
   *
   * THE ROOT CAUSE IS UPSTREAM OF THIS TABLE, and worth naming so nobody re-
   * discovers it by reading this comment out of context: `computeHobbyIqCardId`
   * accepts `authoritativeSetKey: true` and its own doc comment there claims
   * "a caller that KNOWS the product ... keeps its setKey verbatim" — but the
   * code only skips the LATER chrome-prefix override with that flag.
   * `resolveSetKeyForSlug` still runs `normalizeSetKey(setName)` FIRST,
   * unconditionally, for every mainstream-sport call — so an authoritative,
   * checklist-backed `setKey: "pinnacle-mickey-mantle"` still collapses to
   * `pinnacle` exactly as an untrusted vendor guess would. That promise-
   * violation is a separate, wider defect (15+ scripts pass
   * authoritativeSetKey trusting the same false claim) and is NOT fixed here
   * — flagged for its own fix, out of scope for a card-set registration PR.
   *
   * REGISTERING HERE IS THE IMMEDIATE, SAFE FIX for these six products
   * specifically, because `normalizeSetKey` consults this table (via the
   * reconciliation route `S()` unlocks) BEFORE it ever reaches the
   * unanchored `/pinnacle/` regex that was collapsing them. `S`, not `P`, and
   * that is the whole point (see the Fleer Tiffany/Glossy note above): a
   * brand-new key with ZERO existing catalog rows has no census entry for
   * the reconciliation route to rule from, so only a SPELLED product answers
   * `productSetKeyForName` ahead of the regex. `P("pinnacle-aficionado")`
   * above is a fixed point today only because it already has catalog rows
   * and a standing reconciliation verdict — these six do not yet, so `P`
   * alone would silently reproduce tonight's incident.
   */
  ...["pinnacle-mickey-mantle", "pinnacle-rookie-idols", "pinnacle-rookies",
    "pinnacle-slugfest", "pinnacle-team-2000", "pinnacle-team-pinnacle",
  ].map((k) => S(k, { parent: "pinnacle" })),
  P("score"),
  P("score-select", { parent: "score" }),
  /**
   * THE 1990s BASEBALL PRODUCTS THE REMATCH COULD NOT PLACE (2026-09-04, IMPROVE
   * gate audit of #1758). ~61k 1990s baseball sales name products that hold ZERO
   * card_catalog rows, so every one of them refuses on L1 with nothing to match
   * against. The checklists ship in this PR; these are the keys they land on.
   *
   * THE CATALOG'S OWN SPELLING WINS, AND IT WAS MEASURED BEFORE IT WAS RULED.
   * The audit named six of these keys in the shape a slug would mint them
   * (`upper-deck-sp`, `upper-deck-sp-championship`, `upper-deck-minor-league`,
   * `pacific-prisms`). Every one of those is the WRONG spelling: the catalog
   * already holds baseballcardpedia-backed rows at exactly these years under
   * different keys, sampled 2026-09-04 --
   *
   *     sp                 300/300 rows baseballcardpedia   1993-1997  <- SP lives here
   *     upper-deck-minors  300/300 rows baseballcardpedia   1992,94,95
   *     pacific-prism      285/300 rows bcp + 14 sales      1995,96,99
   *     sp-championship      1 row  sales-attested          1995
   *
   * while the rival spellings hold ONE stray sales-attested row each
   * (`pacific-prisms` 1999 FOOTBALL, `upper-deck-sp` zero, `score-rookie-and-
   * traded` zero). Minting the slug's spelling would have created a SECOND
   * product beside a populated one and split every pool this PR exists to fill
   * -- "count by source, not row count", and the checklist-backed side is the
   * side with the source. The staged checklists are keyed to the catalog's
   * spelling.
   *
   * THE `names` ENTRIES HERE ARE THE SLUG SPELLINGS, AND THEY ARE A CLAIM
   * REGISTRY, NOT A RESOLVER. Verified by running the function: only `spelled`
   * products answer productSetKeyForName, so on the `P` rows below these
   * aliases do NOT make `upper-deck-sp` resolve to `sp` -- it still normalizes
   * to `upper-deck`. What they DO is make the collision loud: BY_NAME throws
   * if any other product ever claims the same alias, so a later ruling cannot
   * quietly mint `upper-deck-sp` as a second product beside this one. Turning
   * them into live aliases means promoting these rows to `S`, which is a
   * vocabulary decision with a blast radius (it changes what every title
   * containing "SP" resolves to) and is deliberately NOT made here.
   *
   * `pacific-prism` IS SINGULAR, and three independent authorities agree: the
   * catalog rows above, the sales (`1995 Pacific Prism Baseball #4 Base`), and
   * BaseballCardPedia, which redirects "1995 Pacific Prisms" to "1995 Pacific
   * Prism". Only the source's slug is plural.
   *
   * SPELLED (`S`) WHEREVER THE KEY IS NOT ALREADY A FIXED POINT, measured by
   * RUNNING normalizeSetKey rather than reading the table -- the #1748 lesson,
   * whose `P` declarations still collapsed because only a SPELLED product
   * answers productSetKeyForName, the leg that runs before the unanchored brand
   * patterns. On main today `score-rookie-and-traded` collapses to `score`; the
   * rest are already fixed points and take `P`. The test asserts the FUNCTION'S
   * OUTPUT for all of them.
   *
   * `sp` KEEPS ITS BARE KEY and gets no `refines`: 1993 SP is the Jeter-rookie
   * super-premium set, and a matcher widening from it into flagship Upper Deck
   * base comps would price a four-figure rookie off base cards -- the same
   * reason Exquisite above has none. `parent` is the Upper Deck root for
   * provenance only, matching `sp-authentic` and `sp-prospects` directly above.
   */
  P("pacific"),
  P("pacific-prism", { names: ["pacific-prisms"], family: "pacific", parent: "pacific" }),
  P("pacific-crown-collection", { family: "pacific", parent: "pacific" }),
  P("pacific-gold-crown-die-cuts", { family: "pacific", parent: "pacific" }),
  P("sp", { names: ["upper-deck-sp"], family: "sp", parent: "upper-deck" }),
  P("sp-championship", { names: ["upper-deck-sp-championship"], family: "sp", parent: "upper-deck" }),
  P("upper-deck-minors", { names: ["upper-deck-minor-league"], family: "upper-deck", parent: "upper-deck" }),
  S("score-rookie-and-traded", { names: ["score-rookie-traded", "score-traded"], family: "score", parent: "score" }),
  P("uc3", { names: ["pinnacle-uc3", "sportflix-uc3"], parent: "pinnacle" }),
  ...["goudey", "circa-thunder", "cracker-jack", "all-time-diamond-kings", "diamond-kings", "t206", "play-ball", "kelloggs",
    "post-cereal", "golden-press"].map((k) => P(k)),
  // CF-BELLINGHAM-MARINERS-IS-THE-KEY (Drew 2026-08-30, R1). The 1987
  // Bellingham Mariners team issue — Ken Griffey Jr.'s first card. A minor
  // league club-issued set, so it has no flagship to be a release of: no
  // `parent`, and its own family, exactly like the food issues above it.
  //
  // `spelled`, and the two `names` are the point of the entry. This is the
  // mirror of the setKeyReconciliation aliases (see RULED_ALIASES there for
  // the 228-row three-way pool split that motivated the ruling): `bellingham`
  // is the town that stripYearAndSport left behind when it reduced the
  // malformed catalog key `1987-bellingham-baseball`, and
  // `bellingham-mariners-team-issue` is how the pool's own sale titles spell
  // it. Both name THIS product. Declaring them here means productSetKeyForName
  // answers before the regex vocabulary, so the fold does not depend on the
  // reconciliation alone.
  S("bellingham-mariners", { names: ["bellingham", "bellingham-mariners-team-issue"] }),

  // -- Soccer league / competition products (#1863, Drew 2026-09-06) ----------
  //
  // THE RULING. All 66 are DISTINCT products, each a normalizeSetKey fixed
  // point since #1863, standing on 178,281 strict checklistcenter rows. In
  // every contested namespace the flagship they were collapsing into holds NO
  // strict soccer checklist rows of its own (`topps` 0 of 399, `topps-chrome`
  // 0 of 1,075, `topps-finest` 0 of 119, `topps-stadium-club` 0 of 344,
  // `panini-mosaic` 0 of 193) — CF-COUNT-BY-SOURCE-NOT-ROW-COUNT, so no fold
  // ruled here lands on a flagship a checklist stands behind.
  //
  // WHY THEY BELONG IN THIS TABLE. #1863 made them fixed points but registered
  // them nowhere, so `productAncestry` returned the bare key and the rematch's
  // SPECIALIZATION-STATED ladder (#1725) — which reads this table through the
  // mirror in rematch-classify.cjs — saw no parent and refused every row. A
  // ruled product the ladder cannot see is a ruling that repairs nothing.
  //
  // EACH IS ITS OWN PRICING FAMILY (no `family`, so it defaults to the key),
  // for the reason `panini-prizm-fifa` states four hundred lines above: a UEFA
  // card does not price off an NFL comp. `parent` is the flagship the title's
  // brand words name — the ladder the family walk should reach — and that is
  // the edge SPECIALIZATION-STATED needs.
  //
  // The damage this repairs, from the #1863 note: 2020 Topps Chrome UEFA,
  // Bundesliga and Match Attax Bundesliga all folded to `topps-chrome`, so
  // three different players held card #1 at one address and an ingest of 2,747
  // identities reported 803 "missing" that had in fact been written over.
  P("topps-uefa-club-competitions", { parent: "topps" }),
  P("topps-mls", { parent: "topps" }),
  P("topps-merlin-chrome-uefa-champions-league", { parent: "topps" }),
  P("topps-uefa-superstars", { parent: "topps" }),
  P("topps-merlin-collection-chrome", { parent: "topps" }),
  P("topps-bundesliga", { parent: "topps" }),
  P("topps-uefa-champions-league", { parent: "topps" }),
  P("topps-uefa-champions-league-japan-edition", { parent: "topps" }),
  P("topps-uefa-japan-edition", { parent: "topps" }),
  P("topps-uefa-champions-league-jade-edition", { parent: "topps" }),
  P("topps-jade-edition-uefa-club-competitions", { parent: "topps" }),
  P("topps-match-attax-uefa", { parent: "topps" }),
  P("topps-uefa-1st-edition-club-competitions", { parent: "topps" }),
  P("topps-carnaval-uefa-club-competitions", { parent: "topps" }),
  P("topps-uefa-1st-edition", { parent: "topps" }),
  P("topps-bundesliga-japan-edition", { parent: "topps" }),
  P("topps-liverpool-fc-team-set", { parent: "topps" }),
  P("topps-atletico-madrid-team-set", { parent: "topps" }),
  P("topps-renaissance-mls", { parent: "topps" }),
  P("topps-juventus-team-set", { parent: "topps" }),
  P("topps-deco-uefa", { parent: "topps" }),
  // `topps-tier-one` is a parser rule and a reconciliation key but was never a
  // table entry, so its Bundesliga release had no rung to hang from. #1863
  // files that release under `topps` because `topps` is the namespace the rows
  // were COLLAPSING into; the product it is actually a release OF is Tier One,
  // which is the key the title parser reads and the parent recorded here.
  P("topps-tier-one", { parent: "topps" }),
  P("topps-tier-one-bundesliga", { parent: "topps-tier-one" }),
  // Not one of the 66: a fixed point since the 2026-09-03 census (29,769
  // checklist rows) and named in #1863's note as the sibling that survives the
  // collapse. It survived the vocabulary but not the parser or this table, so
  // it carried the same defect and is repaired with them.
  P("topps-chrome-uefa-club-competitions", { parent: "topps-chrome" }),
  P("topps-chrome-uefa-champions-league", { parent: "topps-chrome" }),
  P("topps-chrome-bundesliga", { parent: "topps-chrome" }),
  P("topps-chrome-spfl", { parent: "topps-chrome" }),
  P("topps-chrome-match-attax-bundesliga", { parent: "topps-chrome" }),
  P("topps-chrome-uefa-womens-champions-league", { parent: "topps-chrome" }),
  P("topps-chrome-steve-aoki", { parent: "topps-chrome" }),
  P("topps-chrome-atletico-de-madrid-team-set", { parent: "topps-chrome" }),
  P("topps-chrome-paris-saint-germain", { parent: "topps-chrome" }),
  P("topps-chrome-borussia-dortmund-team-set", { parent: "topps-chrome" }),
  P("topps-chrome-bvb-borussia-dortmund", { parent: "topps-chrome" }),
  P("topps-chrome-x-real-sociedad", { parent: "topps-chrome" }),
  P("topps-chrome-sapphire-edition-uefa", { parent: "topps-chrome-sapphire" }),
  P("topps-chrome-sapphire-bundesliga", { parent: "topps-chrome-sapphire" }),
  P("topps-chrome-sapphire-edition-uefa-womens", { parent: "topps-chrome-sapphire" }),
  P("topps-finest-bundesliga", { parent: "topps-finest" }),
  P("topps-finest-uefa-champions-league", { parent: "topps-finest" }),
  P("topps-finest-uefa-club-competitions", { parent: "topps-finest" }),
  P("topps-stadium-club-chrome-uefa", { parent: "topps-stadium-club" }),
  P("topps-stadium-club-chrome-bundesliga", { parent: "topps-stadium-club" }),
  P("topps-museum-collection-uefa-champions-league", { parent: "topps-museum-collection" }),
  P("topps-museum-collection-uefa", { parent: "topps-museum-collection" }),
  P("topps-museum-collection-bundesliga", { parent: "topps-museum-collection" }),
  P("panini-mosaic-uefa-euro-2020", { parent: "panini-mosaic" }),
  P("panini-mosaic-serie-a", { parent: "panini-mosaic" }),
  P("panini-mosaic-laliga", { parent: "panini-mosaic" }),
  P("panini-mosaic-premier-league", { parent: "panini-mosaic" }),
  P("panini-mosaic-la-liga", { parent: "panini-mosaic" }),
  P("panini-mosaic-fifa-road-to-world-cup", { parent: "panini-mosaic" }),
  P("panini-prizm-fifa-world-cup-qatar", { parent: "panini-prizm" }),
  /**
   * The 2014 release's own product key. It was already a normalizeSetKey FIXED
   * POINT through `setkey-reconciliation.json` (verdict `distinct`, canonical
   * itself, 96,562 checklist rows, `final: true`) but was NOT in this table, so
   * it had no family or parent recorded. Registering the nine insert sets under
   * it makes that gap load-bearing: `family`/`parent` must name a key the table
   * spells (pinned by productFamilyIsATable), and a child cannot nest under a
   * product that is absent. `P`, not `S` — the reconciliation already decides
   * this key's spelling ahead of both the table and the vocabulary, so spelling
   * it here would add a second authority for one answer.
   */
  P("panini-prizm-fifa-world-cup", { parent: "panini-prizm" }),

  /**
   * 2014 PANINI PRIZM FIFA WORLD CUP — NINE INSERT SETS ARE NINE CARD SETS
   * (R30, Drew 2026-09-13; the same ruling as the Flair Showcase Rows and the
   * Rookies & Stars autograph subsets).
   *
   * TCDB's page for this product carries 136 sub-checklists, and NINE of the
   * insert families RESTART NUMBERING AT 1 alongside the 201-card base set.
   * Measured on the staged file (`acq-2026-09-13-tcdb`, 5,462 rows) before
   * #2112 existed:
   *
   *     5,462 upserts  ->  2,949 distinct documents
   *
   * Card number 1, blank parallel, no auto, no print run occurs TEN times —
   * the base card plus these nine inserts, nine different players — and all
   * ten computed `hiq:soccer:2014:panini-prizm-fifa-world-cup:1:base:no-auto`.
   * Rais M'Bolhi (base) was buried by Cristiano Ronaldo (Aerial Assault),
   * Lionel Messi (World Cup Stars), Gonzalo Higuain (Net Finders), the Fuleco
   * mascot and a Belo Horizonte stadium poster. The number cannot say which
   * card it is; only the insert set can.
   *
   * REGISTRATION IS THE MECHANISM, NOT BOOKKEEPING. Every one of these nine
   * folded PAST the product key onto the bare flagship before this entry
   * existed — `normalizeSetKey("panini-prizm-fifa-world-cup-guardians")` was
   * `panini-prizm`, through the unanchored `/panini-prizm/` rule — and a key
   * that is not a normalizeSetKey FIXED POINT cannot hold a pool. Writing
   * there would have been strictly worse than the collision it was meant to
   * fix, which is why #2112 refuses the file until these land. `spelled` is
   * what makes productSetKeyForName answer ahead of the regex vocabulary; the
   * anchored rules added above that catch-all in hobbyIqCardId.service.ts are
   * the second half.
   *
   * THE COLOUR RUNGS ARE NOT HERE, DELIBERATELY. The page publishes 13 Prizm
   * parallels of these inserts (Gold, Black, Purple, El Samba, ...), and TCDB
   * states each in the row's OWN `parallel` column. A named parallel is a
   * distinct CARD, not a distinct SET, so the colour rides the parallel axis
   * ON these nine keys. Within one insert key, number + rung is unique again.
   *
   * THE OTHER FOUR FAMILIES ARE NOT HERE EITHER, for the opposite reason.
   * Signatures, Combo Signatures, Fans of the Game and Eusebio Tribute number
   * their cards with a PREFIX (`S-XX`, `CS-BS`), so they never collided with
   * the base set and separating them would split pools that are already
   * correct — right guard, right scope.
   */
  ...["aerial-assault", "cup-captains", "fuleco", "guardians", "net-finders",
    "team-photos", "world-cup-matchups", "world-cup-posters", "world-cup-stars",
  ].map((sub) => S(`panini-prizm-fifa-world-cup-${sub}`, {
    family: "panini-prizm-fifa-world-cup",
    parent: "panini-prizm-fifa-world-cup",
  })),
  P("panini-select-uefa-euro-preview", { parent: "panini-select" }),
  P("panini-revolution-premier-league", { parent: "panini-revolution" }),
  P("panini-national-treasures-fifa-road-to-world-cup", { parent: "panini-national-treasures" }),
  P("donruss-elite-premier-league", { parent: "donruss-elite" }),
  P("donruss-elite-serie-a", { parent: "donruss-elite" }),
  P("donruss-elite-la-liga", { parent: "donruss-elite" }),
  P("donruss-elite-laliga", { parent: "donruss-elite" }),
  P("donruss-elite-fifa", { parent: "donruss-elite" }),
  P("score-premier-league", { parent: "score" }),
  P("score-serie-a", { parent: "score" }),
  P("score-ligue-1", { parent: "score" }),
  P("score-la-liga", { parent: "score" }),
  P("score-fifa", { parent: "score" }),
  P("bowman-mls", { parent: "bowman" }),
  // The one key of the 66 with rows outside soccer: 960 hockey (2019) beside
  // 7,173 soccer (2022), both checklistcenter. A real product in two
  // verticals, ruled distinct in both — so the entry carries no sport of its
  // own, exactly as `bowmans-best-preview` above carries none.
  P("leaf-ultimate", { parent: "leaf" }),

  /**
   * WAVE-1 ACQUISITION FOLLOW-ON (Drew, ruling round of 2026-09-19): FOUR
   * BECKETT/HOBBYMONITOR PACKAGES -- THE GENUINE NAMED INSERT/AUTO SETS THAT
   * WERE BLOCKING THEM (85 keys total: 23 + 16 + 19 + 27).
   *
   * Same R60/R67 method as #2276 (Zenith) and #2342 (Illusions/Mosaic): every
   * key below was measured by running the ingester's own offline planner
   * (`planStagedDirectory`, scripts/ingest-checklist-csv-to-catalog.cjs)
   * against the live staged CSV and registering EXACTLY the strings it
   * reports `unregistered`, never a hand-spelled guess. For each one this
   * comment also re-derived, directly from the CSV rather than trusting the
   * PR #2344 body: distinct card count, numbering, and roster overlap against
   * (a) the product's base set and (b) every other section whose name shares
   * a root word -- because a colour/finish rung that REPRINTS a root's roster
   * is a PARALLEL and must never get a key, even when the source spells it
   * with a tier or retailer name instead of a colour.
   *
   * 2024 PANINI PRIZM FOOTBALL (Beckett S3) -- 23 keys. All land
   * `role: own-cards` in the converter's own classifier; none is a subset of
   * Base>Base Set. One cluster was checked and correctly EXCLUDED: the
   * eighteen "Rookie Autographs Prizm <colour>" categories (silver, black
   * finite, black shimmer, blue shimmer, camo, gold, gold vinyl, green scope,
   * green shimmer, no huddle, no huddle black, no huddle gold, pink, purple
   * power, purple pulsar, red shimmer, red wave, white sparkle) are each a
   * 100% roster match, number-for-number and player-for-player, against
   * Base's own Rookies subset (#301-400) -- on-card autograph PARALLELS of
   * the base rookie cards, not a separate insert, exactly the Donruss
   * Rated-Rookies-Autographs shape below. The module's own colour-strip fold
   * already resolves all eighteen to root `rookie-autographs-prizm`, which
   * normalizes straight back to bare `panini-prizm` (verified: no
   * registration needed OR wanted -- registering it would mint a key for a
   * parallel). `Rookie Patch Autographs Prizm Silver` (144 rows) and `Rookie
   * Variations Prizms Silver` (294 rows) are NOT this shape: both use their
   * own independent 1-42 numbering with zero player overlap against Base or
   * against each other, so both are genuine, distinct own-cards sets.
   *
   *     fireworks                      275 rows  #1-25
   *     sensational-signatures         231 rows  #3-50
   *     emergent                       220 rows  #1-20
   *     prizmatic                      220 rows  #1-20
   *     hype                           165 rows  #1-15
   *     rookie-patch-autographs-prizm-silver  144 rows  #1-42 (own roster,
   *                                            zero overlap with Rookie
   *                                            Variations below)
   *     franchise-legends-signatures   112 rows  #3-25
   *     portals                        110 rows  #1-10
   *     prizm-break                    110 rows  #1-10
   *     all-purpose-prizms-silver      100 rows  #1-20
   *     flashback-autographs            91 rows  #1-24
   *     premier-jerseys                 87 rows  #1-29
   *     rookie-gear                     87 rows  #1-29
   *     lockdown-prizms-silver          85 rows  #1-18
   *     significant-signatures          83 rows  #2-99
   *     color-blast                     50 rows  #1-35
   *     prizm-flashback-prizms-silver   50 rows  #1-10
   *     prizmania                       30 rows  #1-30
   *     aurora                          20 rows  #1-20
   *     profiles                        20 rows  #1-20
   *     manga-horizontal                15 rows  #1-15
   *     manga-vertical                  15 rows  #1-15
   *     rookie-variations-prizms-silver 294 rows  #1-42 (own roster; the
   *                                            module fold leaves this
   *                                            unfolded because it carries NO
   *                                            isAuto="true" rows to match the
   *                                            autograph-patch shape above)
   *
   * 2024-25 PANINI PRIZM BASKETBALL (Beckett S3) -- 19 keys. Checked the same
   * base-roster trap that FB's Rookie Autographs cluster hit: zero of these 19
   * overlaps Base>Base Set (measured directly, not assumed) -- Prizm
   * Basketball signs its rookies through "Fast Break Rookie Autographs" and
   * "Rookie Signatures" style products with their OWN print-run numbering, not
   * an on-card colour rung of the base card. Checked the two same-root-word
   * pairs for a fold: `Fast Break Rookie Autographs` (39 rows) vs `Fast Break
   * Autographs` (59 rows) shares ZERO numbers (0% overlap) -- disjoint rookie
   * vs veteran signer pools, not a rung. `Signatures` (109 rows) vs
   * `Sensational Signatures` (89 rows) overlaps only 2 rows (1.8%/2.2%) --
   * two real, mostly-disjoint signer pools, not a fold. `Kaleidoscopic` (300
   * rows, #1-30) never appears as a `parallel` value on any base row in this
   * file -- confirmed by scanning every base row's parallel column -- so in
   * THIS product/year it is an insert, not a rung (the doctrine's own
   * warning that Prizm's names can be a parallel in one year and an insert in
   * another; this file settles it for 2024-25 by its own structure).
   *
   *     sensational-signatures       1,634 rows  #1-90
   *     signatures                   1,017 rows  #1-50
   *     kaleidoscopic                   300 rows  #1-30
   *     fast-break-autographs           295 rows  #1-60
   *     fireworks                       250 rows  #1-25
   *     emergent                        240 rows  #1-30
   *     talismen                        210 rows  #1-21
   *     dominance                       200 rows  #1-25
   *     instant-impact                  200 rows  #1-25
   *     fast-break-rookie-autographs    195 rows  #1-40 (0% overlap with
   *                                              fast-break-autographs above)
   *     penmanship                      156 rows  #1-50
   *     luck-of-the-lottery              140 rows  #1-14
   *     fractal                          100 rows  #1-10
   *     deep-space                        80 rows  #1-10
   *     global-reach                      80 rows  #1-10
   *     groovy                             30 rows  #1-30
   *     sublime                            30 rows  #1-30
   *     manga                              20 rows  #1-20
   *     prizmania                          20 rows  #1-20
   *
   * 2024 PANINI DONRUSS FOOTBALL, full workbook (Beckett S3) -- 16 of 18
   * unregistered keys. TWO ARE DELIBERATELY LEFT UNREGISTERED, not genuine
   * card sets (measured, not assumed):
   *
   *     rated-rookies-autographs (355 rows: folds "Rated Rookies Autographs"
   *       + "... Orange" + "... Purple") and optic-rated-rookies-preview-
   *       autographs (60 rows) are BOTH a 100% roster match, number-for-number
   *       and player-for-player, against Base's own Rated Rookies subset
   *       (#301-400) -- on-card autograph PARALLELS of the base rookie cards,
   *       same shape as Prizm FB's excluded cluster above. Left unregistered
   *       and unfolded pending a converter fix (needs converter fold / owner
   *       ruling) -- registering either would mint a key for a parallel and
   *       both keep the file at REFUSE.
   *
   * The 16 genuine keys below all land `role: own-cards`, no fold candidate
   * against any anchor on the file. Six pairs share a root word with a sibling
   * on this SAME file (retro-1994/-autographs, retro-2004/-autographs,
   * bomb-squad/-autographs, best-of-instant/-autographs, rated-rookies-retro/
   * -autographs, rated-rookies-throwback/-autographs) -- checked every pair:
   * each "-autographs" sibling is a 100% NUMBER-AND-PLAYER SUBSET of its plain
   * sibling's own roster (verified directly, not assumed), the exact "signed
   * subset of a real insert, not of base" shape #2276 registered for Zenith's
   * `rookies` / `rookies-autographs` -- so each pair gets ITS OWN two keys,
   * neither folded into the other. `red-hot-rookies-autographs` has no plain
   * sibling here to compare because the base `red-hot-rookies` key already
   * exists (R38, #2157) -- registering the signed side alone completes it.
   *
   *     rated-rookies-throwback          100 rows  #1-50 (insert)
   *     unleashed                         75 rows  #1-25 (insert)
   *     bomb-squad                        70 rows  #1-35 (insert; auto sibling
   *                                              is a 100% subset, 15/70)
   *     galaxy-of-stars                   60 rows  #1-15 (insert)
   *     best-of-instant                   54 rows  #1-27 (insert; auto sibling
   *                                              is a 100% subset, 7/54)
   *     retro-1994                        40 rows  #1-40 (insert; auto sibling
   *                                              is a 100% subset, 26/40)
   *     retro-2004                        40 rows  #1-40 (insert; auto sibling
   *                                              is a 100% subset, 27/40)
   *     rated-rookies-throwback-autographs 32 rows  #1-32 (100% subset of
   *                                              rated-rookies-throwback above)
   *     retro-2004-autographs              27 rows  100% subset of retro-2004
   *     retro-1994-autographs              26 rows  100% subset of retro-1994
   *     1-per-costco-bundle                21 rows  #1-21 (insert; brand-name
   *                                              kept as printed, R38 style)
   *     rated-rookies-retro                20 rows  #1-20 (insert; auto
   *                                              sibling is a 100% subset,
   *                                              9/20)
   *     bomb-squad-autographs               15 rows  100% subset of bomb-squad
   *     rated-rookies-retro-autographs        9 rows  100% subset of
   *                                              rated-rookies-retro
   *     best-of-instant-autographs            7 rows  100% subset of
   *                                              best-of-instant
   *     red-hot-rookies-autographs             7 rows  signed subset of the
   *                                              ALREADY-registered
   *                                              panini-donruss-red-hot-
   *                                              rookies (R38); this key
   *                                              completes the pair
   *
   * NOT REGISTERED (fold candidates, needs converter fold / owner ruling):
   *   rated-rookies-autographs, optic-rated-rookies-preview-autographs
   *
   * 2024 PANINI SELECT BASKETBALL (hobbymonitor, already committed to main as
   * `data/checklists/scraped/2024-panini-select-basketball.csv`) -- 27 keys,
   * derived from the offline planner exactly like the other three packages.
   * `Sparks Relics` (25 rows, #1-25) is checked against the ALREADY-
   * registered `panini-select-sparks` and is NOT a rung of it: this file has
   * no bare "Sparks" section at all (0 rows), so "Sparks" here belongs to a
   * different Select release entirely and "Sparks Relics" is its own,
   * unrelated 25-card memorabilia insert in THIS product.
   *
   *     rookie-jersey-autographs          640 rows  #1-40
   *     signature-selections              304 rows  #1-40
   *     in-flight-signatures               290 rows  #1-30
   *     youth-explosion-signatures         264 rows  #1-40
   *     neon-icon                          250 rows  #1-25
   *     rookie-revolution                  250 rows  #1-25
   *     jumbo-rookie-swatches               232 rows  #1-30
   *     autographed-memorabilia             203 rows  #1-30
   *     clutch                              200 rows  #1-25
   *     select-certified                    200 rows  #1-20
   *     throwback-memorabilia               200 rows  #1-25
   *     selection-committee-signatures      160 rows  #1-20
   *     sky-high                            160 rows  #1-20
   *     hot-stars                           150 rows  #1-15
   *     lodestars                           150 rows  #1-15
   *     en-fuego                            120 rows  #1-15
   *     select-pairings-signatures          100 rows  #1-10
   *     top-shelf-signatures                  75 rows  #1-15
   *     select-few-signatures                 50 rows  #1-10
   *     x-factor-memorabilia-signatures        29 rows  #1-30
   *     sparks-relics                          25 rows  #1-25 (own set, see
   *                                              above -- not a rung of
   *                                              panini-select-sparks)
   *     select-stars-jersey-autographs         20 rows  #1-20
   *     2024-origins-update-autographs         16 rows  #6-39
   *     solar-eclipse                          15 rows  #1-15
   *     artistic-selections                    10 rows  #1-10
   *     crown-jewels                           10 rows  #1-10
   *     2024-hoops-update-autographs             1 row   #1
   *
   * `family` left at the default (each insert its own pricing family), same
   * as every prior R60/R67 registration. `productSetKeys.ts` is not a
   * derivation-stamp input (verified: neither hash definition in
   * derivation-version.cjs lists this file), so this registration-only PR
   * does not move `currentStamp()`.
   */
  S("panini-prizm-fireworks", { parent: "panini-prizm" }),
  S("panini-prizm-sensational-signatures", { parent: "panini-prizm" }),
  S("panini-prizm-emergent", { parent: "panini-prizm" }),
  S("panini-prizm-prizmatic", { parent: "panini-prizm" }),
  S("panini-prizm-hype", { parent: "panini-prizm" }),
  S("panini-prizm-rookie-patch-autographs-prizm-silver", { parent: "panini-prizm" }),
  S("panini-prizm-franchise-legends-signatures", { parent: "panini-prizm" }),
  S("panini-prizm-portals", { parent: "panini-prizm" }),
  S("panini-prizm-prizm-break", { parent: "panini-prizm" }),
  S("panini-prizm-all-purpose-prizms-silver", { parent: "panini-prizm" }),
  S("panini-prizm-flashback-autographs", { parent: "panini-prizm" }),
  S("panini-prizm-premier-jerseys", { parent: "panini-prizm" }),
  S("panini-prizm-rookie-gear", { parent: "panini-prizm" }),
  S("panini-prizm-lockdown-prizms-silver", { parent: "panini-prizm" }),
  S("panini-prizm-significant-signatures", { parent: "panini-prizm" }),
  S("panini-prizm-color-blast", { parent: "panini-prizm" }),
  S("panini-prizm-prizm-flashback-prizms-silver", { parent: "panini-prizm" }),
  S("panini-prizm-prizmania", { parent: "panini-prizm" }),
  S("panini-prizm-aurora", { parent: "panini-prizm" }),
  S("panini-prizm-profiles", { parent: "panini-prizm" }),
  S("panini-prizm-manga-horizontal", { parent: "panini-prizm" }),
  S("panini-prizm-manga-vertical", { parent: "panini-prizm" }),
  S("panini-prizm-rookie-variations-prizms-silver", { parent: "panini-prizm" }),

  S("panini-prizm-signatures", { parent: "panini-prizm" }),
  S("panini-prizm-kaleidoscopic", { parent: "panini-prizm" }),
  S("panini-prizm-fast-break-autographs", { parent: "panini-prizm" }),
  S("panini-prizm-talismen", { parent: "panini-prizm" }),
  S("panini-prizm-dominance", { parent: "panini-prizm" }),
  S("panini-prizm-instant-impact", { parent: "panini-prizm" }),
  S("panini-prizm-fast-break-rookie-autographs", { parent: "panini-prizm" }),
  S("panini-prizm-penmanship", { parent: "panini-prizm" }),
  S("panini-prizm-luck-of-the-lottery", { parent: "panini-prizm" }),
  S("panini-prizm-fractal", { parent: "panini-prizm" }),
  S("panini-prizm-deep-space", { parent: "panini-prizm" }),
  S("panini-prizm-global-reach", { parent: "panini-prizm" }),
  S("panini-prizm-groovy", { parent: "panini-prizm" }),
  S("panini-prizm-sublime", { parent: "panini-prizm" }),
  S("panini-prizm-manga", { parent: "panini-prizm" }),
  // "signatures" and "sensational-signatures" both already registered by
  // the FB block above (bare panini-prizm parent, shared across FB/BK).
  // "prizmania" and "emergent" and "fireworks" likewise shared with FB.

  S("panini-donruss-rated-rookies-throwback", { parent: "panini-donruss" }),
  S("panini-donruss-unleashed", { parent: "panini-donruss" }),
  S("panini-donruss-bomb-squad", { parent: "panini-donruss" }),
  S("panini-donruss-galaxy-of-stars", { parent: "panini-donruss" }),
  S("panini-donruss-best-of-instant", { parent: "panini-donruss" }),
  S("panini-donruss-retro-1994", { parent: "panini-donruss" }),
  S("panini-donruss-retro-2004", { parent: "panini-donruss" }),
  S("panini-donruss-rated-rookies-throwback-autographs", { parent: "panini-donruss" }),
  S("panini-donruss-retro-2004-autographs", { parent: "panini-donruss" }),
  S("panini-donruss-retro-1994-autographs", { parent: "panini-donruss" }),
  S("panini-donruss-1-per-costco-bundle", { parent: "panini-donruss" }),
  S("panini-donruss-rated-rookies-retro", { parent: "panini-donruss" }),
  S("panini-donruss-bomb-squad-autographs", { parent: "panini-donruss" }),
  S("panini-donruss-rated-rookies-retro-autographs", { parent: "panini-donruss" }),
  S("panini-donruss-best-of-instant-autographs", { parent: "panini-donruss" }),
  S("panini-donruss-red-hot-rookies-autographs", { parent: "panini-donruss" }),

  S("panini-select-rookie-jersey-autographs", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-signature-selections", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-in-flight-signatures", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-youth-explosion-signatures", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-neon-icon", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-rookie-revolution", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-jumbo-rookie-swatches", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-autographed-memorabilia", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-clutch", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-select-certified", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-throwback-memorabilia", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-selection-committee-signatures", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-sky-high", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-hot-stars", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-lodestars", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-en-fuego", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-select-pairings-signatures", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-top-shelf-signatures", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-select-few-signatures", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-x-factor-memorabilia-signatures", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-sparks-relics", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-select-stars-jersey-autographs", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-2024-origins-update-autographs", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-solar-eclipse", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-artistic-selections", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-crown-jewels", { family: "panini-select", parent: "panini-select" }),
  S("panini-select-2024-hoops-update-autographs", { family: "panini-select", parent: "panini-select" }),
];

// -- lookups -----------------------------------------------------------------

const BY_KEY = new Map<string, ProductSetKey>();
const BY_NAME = new Map<string, ProductSetKey>();
for (const p of PRODUCT_SET_KEYS) {
  if (BY_KEY.has(p.setKey)) throw new Error(`productSetKeys: duplicate setKey ${p.setKey}`);
  BY_KEY.set(p.setKey, p);
}
for (const p of PRODUCT_SET_KEYS) {
  for (const n of [p.setKey, ...(p.names ?? [])]) {
    const prior = BY_NAME.get(n);
    if (prior && prior !== p) throw new Error(`productSetKeys: "${n}" names both ${prior.setKey} and ${p.setKey}`);
    BY_NAME.set(n, p);
  }
}
/** The spelled products' names — the only ones productSetKeyForName reads. */
const SPELLED_NAMES = new Map<string, ProductSetKey>([...BY_NAME.entries()].filter(([, p]) => p.spelled === true));
/** Multi-segment spelled names, longest first, so "topps-update-series" is
 *  tried before "topps-update" and "leaf-metal-draft" before "leaf-metal". */
const RUN_NAMES: ReadonlyArray<{ segs: string[]; product: ProductSetKey }> = [...SPELLED_NAMES.entries()]
  .filter(([n]) => n.includes("-"))
  .map(([n, product]) => ({ segs: n.split("-"), product }))
  .sort((a, b) => b.segs.length - a.segs.length || b.segs.join("-").length - a.segs.join("-").length);

function containsRun(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** The table entry for a key or for any of its spellings, or null. */
export function productEntry(setKeyOrName: string | null | undefined): ProductSetKey | null {
  const s = String(setKeyOrName ?? "").trim().toLowerCase();
  return s ? BY_NAME.get(s) ?? null : null;
}

/** True iff the key is the one spelling of a product in the table. */
export function isProductSetKey(setKey: string | null | undefined): boolean {
  return BY_KEY.has(String(setKey ?? "").trim().toLowerCase());
}

/**
 * The one spelling for a product text (slugified, year and sport stripped),
 * or null when the table does not spell it. Only `spelled` products answer.
 * Exact first; then the longest multi-segment name that appears as a
 * contiguous run of segments -- a single-segment name never matches inside a
 * longer text. Under the `as-named` Donruss policy the bare texts "donruss"
 * and "panini-donruss" answer as themselves; under `panini-era` they are
 * left to the vocabulary (the modern spelling) and spellForEra corrects
 * the year.
 */
export function productSetKeyForName(slug: string | null | undefined): string | null {
  const s = String(slug ?? "").trim().toLowerCase();
  if (!s) return null;
  if (DONRUSS_SPELLING_POLICY === "as-named" && (s === "donruss" || s === "panini-donruss")) return s;
  const exact = SPELLED_NAMES.get(s);
  if (exact) return exact.setKey;
  const segs = s.split("-");
  for (const { segs: needle, product } of RUN_NAMES) {
    if (containsRun(segs, needle)) return product.setKey;
  }
  return null;
}

/** Ruling (b) as code: which spelling Donruss takes in `year` under the
 *  policy. Every other key passes through untouched. */
export function spellForEra(setKey: string, year: number | null | undefined, policy: DonrussSpellingPolicy = DONRUSS_SPELLING_POLICY): string {
  // CF-THERE-IS-NO-FLEER-TIFFANY: before 1996 a Fleer "Tiffany" text names the
  // GLOSSY product (see FLEER_TIFFANY_IS_GLOSSY_BEFORE_YEAR). From 1996 the key
  // is a real product the source names, and passes through untouched. A year we
  // do not have cannot decide, so an absent year leaves the key alone.
  const misnomer = FLEER_TIFFANY_ERA_MISNOMERS[setKey];
  if (misnomer !== undefined) {
    if (typeof year !== "number" || !Number.isFinite(year) || year <= 0) return setKey;
    return year < FLEER_TIFFANY_IS_GLOSSY_BEFORE_YEAR ? misnomer : setKey;
  }
  // CF-METAL-UNIVERSE-NAME-WAS-REVIVED: before the 2020s Skybox revival a
  // "Skybox Metal Universe" text names the one vintage product that existed
  // then, plain "Metal Universe" (see METAL_UNIVERSE_REVIVAL_FROM_YEAR). From
  // the revival year the key is the real, separately checklist-backed modern
  // product and passes through untouched — same shape, same reason as
  // Fleer-Tiffany just above. An absent year cannot decide, so it leaves the
  // key alone rather than guessing an era.
  const metalUniverseMisnomer = METAL_UNIVERSE_ERA_MISNOMERS[setKey];
  if (metalUniverseMisnomer !== undefined) {
    if (typeof year !== "number" || !Number.isFinite(year) || year <= 0) return setKey;
    return year < METAL_UNIVERSE_REVIVAL_FROM_YEAR ? metalUniverseMisnomer : setKey;
  }
  // R51 AMENDED: the 2006 "Greats of the Game" is Fleer's, and ONLY 2006.
  // Same shape and same refusal as the two above — an absent or non-2006 year
  // leaves the bare key exactly as it is, so the four bccp product-structure
  // stubs in 2000/2001/2002/2004 are not attributed to a ruling about 2006.
  const greatsMaker = GREATS_OF_THE_GAME_ERA_MAKER[setKey];
  if (greatsMaker !== undefined) {
    if (typeof year !== "number" || !Number.isFinite(year) || year <= 0) return setKey;
    return year === GREATS_OF_THE_GAME_FLEER_YEAR ? greatsMaker : setKey;
  }
  // CF-A-CHECKLIST-ROW-SPELLS-ITS-ERA-LIKE-A-SALE-DOES: the era table's
  // never-acquired brands take the bare key in EVERY year, so this fires
  // without a year — there is no boundary to sit on, only a prefix to stop.
  const bare = NEVER_ACQUIRED_MAKER_PREFIXES[setKey];
  if (bare !== undefined) return bare;
  if (setKey !== "donruss" && setKey !== "panini-donruss") return setKey;
  if (policy === "as-named") return setKey;
  if (typeof year !== "number" || !Number.isFinite(year) || year <= 0) return setKey;
  return year >= PANINI_DONRUSS_FROM_YEAR ? "panini-donruss" : "donruss";
}

/** The pricing family of a key -- from the table; a key the table does not
 *  know is its own family. A legacy spelling ("topps-update") answers with
 *  its product's family, so pool rows keyed under an old spelling still
 *  price within the family while the rename fleet runs. */
export function productFamilyOf(setKey: string | null | undefined): string {
  const s = String(setKey ?? "").trim().toLowerCase();
  if (!s) return "";
  const p = BY_NAME.get(s);
  return p ? (p.family ?? p.setKey) : s;
}

/** The immediate parent (the flagship this is a release of), or null. */
export function productParentOf(setKey: string | null | undefined): string | null {
  const p = productEntry(setKey);
  return p ? (p.parent ?? null) : null;
}

/** The key, then its parents up to the root -- for a lookup that may fall
 *  back to the flagship (the reference ladder, catalogVerify's family step).
 *  A legacy spelling walks as its product. */
export function productAncestry(setKey: string | null | undefined): string[] {
  const s = String(setKey ?? "").trim().toLowerCase();
  if (!s) return [];
  const out: string[] = [s];
  let cur = productEntry(s);
  if (cur && cur.setKey !== s) out.push(cur.setKey);
  const seen = new Set(out);
  while (cur && cur.parent && !seen.has(cur.parent)) {
    out.push(cur.parent);
    seen.add(cur.parent);
    cur = BY_KEY.get(cur.parent) ?? null;
  }
  return out;
}

/** The verified refinements of a plain product -- every spelling of them,
 *  so rows not yet renamed are still found -- for the matcher's widening. */
export function productRefinementsOf(setKey: string | null | undefined): string[] {
  const s = String(setKey ?? "").trim().toLowerCase();
  if (!s) return [];
  const out: string[] = [];
  for (const p of PRODUCT_SET_KEYS) {
    if (p.refines === s) out.push(p.setKey, ...(p.names ?? []));
  }
  return out;
}

/**
 * SAME-NUMBER PARALLEL SETS (CF-A-TIFFANY-SALE-IS-A-TIFFANY-CARD, Drew
 * 2026-09-04 -- the ruling read onto the rematch's L5).
 *
 * A specialization is normally told from its flagship by the CARD NUMBER: the
 * 1987 Topps Traded set numbers its cards #70T and the flagship numbers its
 * own #70, so "does the flagship's checklist list this number?" separates the
 * two cards, and the rematch's L5 leg refuses any row where it does.
 *
 * A SAME-NUMBER PARALLEL SET breaks that test by design. Tiffany and Glossy
 * style sets are the flagship's checklist REPRINTED on a better stock, card
 * for card, ON THE SAME NUMBERS. 1988 Topps Tiffany #150 and 1988 Topps #150
 * are the same George Brett at the same number and two genuinely different
 * cards with two different markets. For these families the flagship checklist
 * ALWAYS lists the number -- that is what "parallel set" means -- so L5 fires
 * on every row by construction and refuses the whole family.
 *
 * Drew's ruling (commit eed10b9b, "a Tiffany sale is a Tiffany card", 2,760
 * rows moved out of the base pools): a sale whose title says Tiffany belongs
 * to the Tiffany product, full stop. Where the number cannot separate the two
 * cards, THE TITLE IS THE EVIDENCE -- and it is sufficient, because the
 * specialization's OWN checklist row still has to exist under a real scraped
 * source (the rematch's L3) before anything moves.
 *
 * So the pairs below declare, per (child, parent), "this child reprints its
 * parent's checklist on the parent's own numbers". The rematch's L5 reads THIS
 * DECLARATION and nothing else: a declared pair skips the flagship-lists test
 * (the answer is known to be yes and known to be uninformative); EVERY OTHER
 * FAMILY KEEPS L5 STRICT. That is the whole widening -- L1 through L4 are
 * untouched, and L3 in particular is what keeps a synthetic
 * `derived-from-base-checklist-*` row from qualifying as the child's checklist.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *   o-pee-chee     NOT a parallel set of topps. OPC is a separate Canadian
 *                  product with its own checklist and its own numbering, which
 *                  diverges from Topps in many years. The number DOES carry
 *                  information there, so L5 must keep asking.
 *   *-update, *-series-N, *-chrome, *-sapphire and every other refinement:
 *                  different checklists, different numbers. L5 separates them
 *                  correctly today and stays on.
 *
 * A family is added here only when someone has confirmed the child reprints the
 * parent card-for-card at the parent's numbers. Absent beats wrong.
 */
export const SAME_NUMBER_PARALLEL_SETS: ReadonlyArray<{ readonly setKey: string; readonly parent: string }> = [
  // Topps Tiffany, 1984-1991: the flagship checklist on white stock with a
  // glossy front, same numbers card for card. The 1987 set (792 cards) is the
  // one #1615 landed from Drew's hand-verified sheet.
  { setKey: "topps-tiffany", parent: "topps" },
  // Topps Traded Tiffany reprints the TRADED checklist (#1T-#132T), which is
  // itself numbered apart from the flagship -- so L5 already passes for these
  // rows against `topps`. Declared anyway for the `topps-traded` -> Tiffany
  // move, where the parent's numbers ARE the child's.
  { setKey: "topps-traded-tiffany", parent: "topps-traded" },
  // Bowman Tiffany, 1989-1991: same shape, same numbers (1989 Bowman lists
  // #220 and #27 and so does its Tiffany).
  { setKey: "bowman-tiffany", parent: "bowman" },
  // The Fleer coated reprints, same shape: the Tiffany/Glossy card carries the
  // paper card's number, so the number cannot tell them apart and only the
  // title can. 1996 Fleer Tiffany lists #1-600 and so does 1996 Fleer.
  { setKey: "fleer-tiffany", parent: "fleer" },
  { setKey: "fleer-glossy", parent: "fleer" },
  { setKey: "fleer-update-tiffany", parent: "fleer-update" },
  { setKey: "fleer-update-glossy", parent: "fleer-update" },
  { setKey: "fleer-tradition-tiffany", parent: "fleer-tradition" },
];

/** True iff `setKey` reprints `parent`'s checklist on `parent`'s own card
 *  numbers -- so the card number cannot tell the two cards apart and only the
 *  title can. Consumed by the rematch's L5 leg; every undeclared pair keeps
 *  the strict flagship-lists test. */
export function isSameNumberParallelSet(setKey: string | null | undefined, parent: string | null | undefined): boolean {
  const c = String(setKey ?? "").trim().toLowerCase();
  const p = String(parent ?? "").trim().toLowerCase();
  if (!c || !p) return false;
  return SAME_NUMBER_PARALLEL_SETS.some((e) => e.setKey === c && e.parent === p);
}

/** Every key the table spells -- for the guard that checks the vocabulary's
 *  destinations all have a family entry. */
export function productSetKeys(): string[] {
  return [...BY_KEY.keys()];
}
