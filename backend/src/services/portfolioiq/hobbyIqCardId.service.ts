// CF-HOBBYIQ-CARDID (Drew, 2026-07-23, issue #706). HobbyIQ's own
// canonical card identifier. Vendor-independent, deterministic,
// human-readable. The "we set the market" identity primitive.
//
// FORMAT
//   hiq:{sport}:{year}:{setKey}:{cardNumber}:{parallelSlug}:{autoFlag}[:num-{printRun}]
//
// EXAMPLES
//   hiq:baseball:2026:bowman:cpa-eha:gold-refractor:auto:num-50
//   hiq:baseball:2026:bowman-chrome:bcp-102:orange-shimmer-refractor:no-auto
//   hiq:basketball:2024:panini-prizm:1:silver-prizm:no-auto:num-99
//   hiq:pokemon:2023:sv1:151:full-art:no-auto
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
//   autoFlag      → "auto" | "no-auto"  (never omitted)
//   printRun      → "num-{N}" optional suffix (omitted when card is
//                   unnumbered, e.g. Base or general Refractor)
//
// This module has ZERO side effects. Import + call is safe anywhere.

export interface HobbyIqCardIdComponents {
  sport: string;              // e.g. "baseball"
  year: number;               // e.g. 2026
  setKey: string;             // e.g. "bowman" (canonical short form)
  cardNumber: string;         // e.g. "CPA-EHA"
  parallel: string;           // e.g. "Gold Refractor" (SPECIFIC variant, not lossy)
  isAuto: boolean;
  printRun?: number | null;   // e.g. 50 for /50 numbered; null/undefined for unnumbered
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
// "bowman-chrome-draft" doesn't collapse to "bowman".
function knownSetKeyPatterns(): Array<[RegExp, string]> {
  return [
    // Sapphire is a distinct product LINE, not a parallel. Must match
    // BEFORE the base bowman-chrome / topps-chrome patterns.
    // CF-CATALOG-SAPPHIRE-ORDER (Drew, 2026-08-04, per baseballcardpedia).
    // Both "Chrome Sapphire" and "Sapphire Chrome" appear in vendor
    // titles for the same product. Also "Bowman Draft Sapphire Chrome".
    [/bowman-draft-(?:chrome-sapphire|sapphire-chrome)/, "bowman-draft-sapphire"],
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
    [/bowman-(?:chrome-draft|draft-chrome)/, "bowman-chrome"],
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
    // CF-BOWMAN-MEGA-BOX-IS-CHROME (Drew, 2026-08-01). Bowman Mega Box
    // IS Bowman Chrome — same insert set, just retail-exclusive
    // distribution channel. Collapses to bowman-chrome (matches your
    // "buyers don't distinguish subset" rule from chrome-draft/chrome
    // collapse). Must match BEFORE the generic /^bowman/ regex or Mega
    // Box sales get mis-pooled with paper Bowman flagship.
    [/bowman-mega-box|bowman-mega/, "bowman-chrome"],
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
    // CF-CHROME-SUBSET-COLLAPSE (Drew, 2026-07-31). Topps Chrome Update
    // is one market with Topps Chrome — subset distinction doesn't matter
    // for pricing. Sapphire (matched above) + Platinum + Black are the
    // distinct product lines we preserve; Update collapses to parent.
    [/topps-chrome-update/, "topps-chrome"],
    [/topps-chrome/, "topps-chrome"],
    [/topps-heritage/, "topps-heritage"],
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
    [/topps/, "topps"],
    // Panini — STRICT tier (fully-qualified "panini-X"). See two-tier
    // comment on knownSetKeyPatterns. National Treasures is included
    // here as a bare match because the name is uniquely Panini.
    [/panini-prizm/, "panini-prizm"],
    [/panini-select/, "panini-select"],
    [/panini-mosaic/, "panini-mosaic"],
    [/panini-donruss-optic/, "panini-optic"],
    [/panini-donruss/, "panini-donruss"],
    [/panini-optic/, "panini-optic"],
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
    // CF-PRODUCT-LINES-V3-EXPANSION (Drew, 2026-07-30). New product-line
    // vocab from parallel-vocabulary.json productLines section. Fixes
    // the ~5-6K rows the setKey audit found with raw-slugified titles
    // (Flair, Goudey, SP/SP Prospects, Pinnacle Aficionado).
    // Order matters — more specific before less specific.
    [/pinnacle-aficionado/, "pinnacle-aficionado"],
    [/pinnacle/, "pinnacle"],
    [/goudey/, "goudey"],
    [/flair-showcase|flair/, "flair"],
    [/sp-prospects/, "sp-prospects"],
    [/sp-authentic/, "sp-authentic"],
    // NOTE: bare "sp" is NOT in strict tier — "SP" collides with the
    // short-print abbreviation. Only qualified sp-prospects / sp-authentic
    // land here. Bare "SP" resolves via the routingRule downstream.
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
    [/(?:^|-)donruss-studio|(?:^|-)studio/, "donruss-studio"],
    [/(?:^|-)circa-thunder/, "circa-thunder"],
    [/(?:^|-)score-select/, "score-select"],
    [/(?:^|-)select-certified/, "score-select"],
    [/(?:^|-)score/, "score"],
    [/(?:^|-)leaf-limited/, "leaf-limited"],
    [/(?:^|-)leaf/, "leaf"],
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
    [/(^|-)optic(-|$)/, "panini-optic"],
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
 *  Chains (each row: setKey → parent):
 *    topps-traded-tiffany → topps-traded
 *    topps-traded         → topps
 *    topps-tiffany        → topps
 *    topps-update-sapphire → topps-update
 *    topps-update         → topps
 *    topps-chrome-sapphire → topps-chrome
 *    topps-chrome-platinum → topps-chrome
 *    topps-chrome-black    → topps-chrome
 *    topps-chrome         → topps
 *    bowman-chrome-sapphire → bowman-chrome
 *    bowman-chrome        → bowman
 *    bowman-draft-paper   → bowman-draft
 *    bowman-draft         → bowman
 *    every other topps-*  → topps
 *    every other bowman-* → bowman
 *    every panini-*       → panini
 *
 *  Callers use this for FMV fallback: if a Traded Tiffany card has thin
 *  comps, walk up the chain to Traded, then to flagship Topps for a
 *  wider comparison pool. Also useful for aggregation queries. */
export function deriveParentSetKey(setKey: string): string | null {
  if (!setKey) return null;
  // Traded/Tiffany chain (Traded Tiffany is a variant of Traded).
  if (setKey === "topps-traded-tiffany") return "topps-traded";
  if (setKey === "topps-traded") return "topps";
  if (setKey === "topps-tiffany") return "topps";
  // Update chain.
  if (setKey === "topps-update-sapphire") return "topps-update";
  if (setKey === "topps-update") return "topps";
  // Chrome variants under Topps Chrome.
  if (setKey === "topps-chrome-sapphire") return "topps-chrome";
  if (setKey === "topps-chrome-platinum") return "topps-chrome";
  if (setKey === "topps-chrome-black") return "topps-chrome";
  // Bowman Chrome variants.
  if (setKey === "bowman-chrome-sapphire") return "bowman-chrome";
  // Bowman Draft variants.
  if (setKey === "bowman-draft-paper") return "bowman-draft";
  if (setKey === "bowman-draft") return "bowman";
  // Bowman paper.
  if (setKey === "bowman-paper") return "bowman";
  // Roots.
  if (setKey === "topps" || setKey === "bowman" || setKey === "panini") return null;
  if (setKey === "o-pee-chee") return null;
  if (setKey === "upper-deck" || setKey === "fleer" || setKey === "pinnacle" || setKey === "goudey") return null;
  // Fallback: strip last-segment for hyphenated topps-*/bowman-* → parent brand.
  if (setKey.startsWith("topps-")) return "topps";
  if (setKey.startsWith("bowman-")) return "bowman";
  if (setKey.startsWith("panini-") || setKey === "national-treasures") return "panini";
  if (setKey.startsWith("upper-deck-") || setKey === "sp-authentic" || setKey === "sp-prospects") return "upper-deck";
  if (setKey.startsWith("fleer-") || setKey === "flair") return "fleer";
  if (setKey.startsWith("pinnacle-")) return "pinnacle";
  return null;
}

/** Normalize setKey — accepts either an already-normalized short form
 *  ("bowman-chrome") or a longer product string ("2026 Bowman Chrome
 *  Prospects Baseball") and returns the canonical short form. Falls back
 *  to slugified full name when no known pattern matches (preserves
 *  determinism). Callers that need STRICT matching (return null on
 *  unknown) should use matchKnownProductLine below. */
export function normalizeSetKey(setName: string): string {
  const s = slugify(setName);
  for (const [re, canonical] of knownSetKeyPatterns()) {
    if (re.test(s)) return canonical;
  }
  for (const [re, canonical] of bareAliasPatterns()) {
    if (re.test(s)) return canonical;
  }
  return s;
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
 *  appears in the parallel language of every Panini product. */
export function matchKnownProductLine(text: string): string | null {
  const s = slugify(text);
  for (const [re, canonical] of knownSetKeyPatterns()) {
    if (re.test(s)) return canonical;
  }
  for (const [re, canonical] of bareAliasPatterns()) {
    if (re.test(s)) return canonical;
  }
  return null;
}

/** Normalize cardNumber: lowercase, kept literal. Preserves letters,
 *  digits, and internal hyphens (CPA-EHA → cpa-eha, BCP-102 → bcp-102). */
function normalizeCardNumber(cardNumber: string): string {
  return slugify(cardNumber);
}

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
  // Strip leading "True " (case-insensitive, whitespace-boundary).
  // Only matches when "true" is a standalone leading word, so parallels
  // like "TrueSonic" (hypothetical brand) aren't accidentally altered.
  const hadTruePrefix = /^true\s+/i.test(raw);
  const stripped = raw.replace(/^true\s+/i, "");
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
  if (s === "" || s === "base" || s === "none" || s === "no-parallel") {
    return "base";
  }
  // CF-MOJO-IMPLIES-REFRACTOR (Drew, 2026-08-01). "Mojo" alone (or
  // "Blue Mojo", "Green Mojo", "Red Mojo" etc.) is a market shortening
  // of "Mojo Refractor". Colored Mojos are common Mega Box parallels
  // (Blue Mojo /50, Green Mojo /99, Red Mojo /25). Ensure any slug
  // ending in "-mojo" (or bare "mojo") gets the "-refractor" suffix
  // so it pools with "Mojo Refractor" and "Mega Refractor" variants.
  if (/(^|-)mojo$/.test(s)) {
    s = `${s}-refractor`;
  }
  // CF-MEGA-IS-MOJO (Drew, 2026-08-01). Now that sub-channel captures
  // the Mega Box product context separately, bare "Mega" (or
  // "Blue Mega", "Red Mega" etc.) in the parallel field is safely
  // treated as an alias for Mojo — same physical parallel, different
  // card-language. Collapses to <color>-mojo-refractor.
  if (/(^|-)mega$/.test(s)) {
    s = s.replace(/mega$/, "mojo-refractor");
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
  if (hadTruePrefix && !/(^|-)refractor(-|$)/.test(s)) {
    s = `${s}-refractor`;
  }
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
  { fromSetKey: "bowman-draft",       cardNumberPrefix: /^bdc(?:-|\d)/i,   toSetKey: "bowman-chrome" },
  { fromSetKey: "bowman-draft",       cardNumberPrefix: /^bdcpa(?:-|\d)/i, toSetKey: "bowman-chrome" },
  { fromSetKey: "bowman-draft",       cardNumberPrefix: /^cda(?:-|\d)/i,   toSetKey: "bowman-chrome" },
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
  { fromSetKey: "bowman",             cardNumberPrefix: /^bda(?:-|\d)/i,   toSetKey: "bowman-draft-paper" },
  { fromSetKey: "bowman-draft",       cardNumberPrefix: /^bda(?:-|\d)/i,   toSetKey: "bowman-draft-paper" },
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

/** Compute the canonical hobbyiqCardId slug for a card. Same inputs
 *  ALWAYS produce the same slug — the function has no side effects and
 *  no I/O. */
export function computeHobbyIqCardId(components: HobbyIqCardIdComponents): string {
  const sport = normalizeSport(components.sport);
  const year = Number.isFinite(components.year) ? Math.trunc(components.year) : 0;
  const baseSetKey = normalizeSetKey(components.setKey);
  const cardNumber = normalizeCardNumber(components.cardNumber);
  // CF-CHROME-PREFIX-OVERRIDE-NARROW (Drew, 2026-08-10). Cards with
  // BCP-/CPA-/BDC-/TCPA-/CRA- cardNumbers get upgraded from bare to
  // chrome family. See CHROME_PREFIX_OVERRIDES for the rule table +
  // rationale for why this override is narrow (only unambiguous pairs).
  const setKey = applyChromePrefixOverride(baseSetKey, cardNumber);
  let parallelSlug = normalizeParallel(components.parallel);
  // CF-CHROME-AUTO-BASE-IS-REFRACTOR (Drew, 2026-08-10). CardHedge (and
  // some other vendors) label the /499 baseline CPA-/TCPA-/CRA- Auto as
  // "Base Auto" because colored refractors get their own parallel names
  // (Blue /150, Gold /50, etc.). But in these product lines the /499
  // baseline IS on refractor stock — collectors uniformly call it
  // "Refractor" and "Base" implies a non-refractor variant that doesn't
  // exist for these subsets. Fragmenting the pool between "Base Auto"
  // and "Refractor Auto" silently splits the /499 comps in half.
  // Confirmed by Drew 2026-08-10: "a base does not equal a refractor" —
  // canonicalize by upgrading Base → Refractor for the chrome-auto
  // subsets so they land in one pool.
  if (
    parallelSlug === "base" &&
    components.isAuto === true &&
    /^(cpa|tcpa|cra)(?:-|\d)/i.test(cardNumber) &&
    (setKey === "bowman-chrome" || setKey === "topps-chrome")
  ) {
    parallelSlug = "refractor";
  }

  // CF-CHROME-COLOR-IMPLIES-REFRACTOR (Drew, 2026-08-07). See CHROME_STOCK
  // constants above — on known chrome product lines, any non-base parallel
  // that doesn't already carry "-refractor" gets it appended so "Blue",
  // "Blue Shimmer", "Blue Wave", "Blue Ray Wave" all share one FMV pool
  // with "Blue Refractor", "Blue Shimmer Refractor", etc.
  if (
    parallelSlug !== "base" &&
    !/(^|-)refractor(-|$)/.test(parallelSlug) &&
    isChromeStockSetKey(setKey)
  ) {
    parallelSlug = `${parallelSlug}-refractor`;
  }

  const autoFlag = components.isAuto ? "auto" : "no-auto";
  const printRun = formatPrintRun(components.printRun);
  return `hiq:${sport}:${year}:${setKey}:${cardNumber}:${parallelSlug}:${autoFlag}${printRun}`;
}

/** Best-effort reverse parse of a hobbyiqCardId. Returns null when the
 *  slug doesn't match the expected format. Used for debugging + audit
 *  trails; not a general-purpose deserializer. */
export function parseHobbyIqCardId(hiqId: string): HobbyIqCardIdComponents | null {
  if (typeof hiqId !== "string" || !hiqId.startsWith("hiq:")) return null;
  const parts = hiqId.split(":");
  // Minimum: hiq + 6 fields = 7 parts. With print run = 8.
  if (parts.length !== 7 && parts.length !== 8) return null;
  const [, sport, yearStr, setKey, cardNumber, parallelSlug, autoFlag, printRunPart] = parts;
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
  };
}
