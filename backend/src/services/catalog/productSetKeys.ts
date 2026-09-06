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

  // -- Upper Deck -------------------------------------------------------------
  P("upper-deck"),
  S("upper-deck-series-1", { names: ["upper-deck-series-one"], family: "upper-deck", parent: "upper-deck", refines: "upper-deck" }),
  S("upper-deck-series-2", { names: ["upper-deck-series-two"], family: "upper-deck", parent: "upper-deck", refines: "upper-deck" }),
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
    "panini-diamond-kings"].map((k) => P(k, { parent: "panini" })),
  // NBA HOOPS is a Panini product spelled by its CHECKLIST (Drew 2026-09-05).
  // It stays a child of `panini` — the family link is what lets the matcher
  // widen — but the KEY is the bare one, because `nba-hoops` holds 26,355
  // checklistinsider rows and `panini-hoops` zero strict rows. The prefixed
  // spelling is carried as a NAME so a title reading "Panini NBA Hoops" still
  // resolves to this product rather than to no entry at all.
  P("nba-hoops", { parent: "panini", names: ["panini-hoops", "hoops"] }),

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
  P("ultra"),
  P("skybox"),
  ...["skybox-metal-universe", "skybox-thunder", "skybox-premium", "skybox-molten-metal"].map((k) => P(k, { parent: "skybox" })),
  P("metal-universe"),
  P("pinnacle"),
  P("pinnacle-aficionado", { parent: "pinnacle" }),
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
