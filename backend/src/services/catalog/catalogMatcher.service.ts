/**
 * CF-CATALOG-FIRST (Drew, 2026-08-04). Canonical function every ingest
 * path calls to attach a card_catalog row to its incoming identity.
 *
 * Design doc: backend/docs/catalog-first-architecture.md
 *
 * Behavior:
 *   1. Compute canonical slug from input via computeHobbyIqCardId.
 *   2. Look up card_catalog by exact slug.
 *   3. Fuzzy match on parallel (True Blue → Blue Refractor per
 *      project_market_language_normalization).
 *   4. Fall through to product-family (bowman-chrome-updates →
 *      bowman-chrome per project_product_family_ladder).
 *   5. When nothing matches AND the caller is a trusted source
 *      (checklist / TCA / user-verified), seed a fresh row.
 *   6. Return { slug, found, confidence, matchedBy }.
 *
 * Never destructive — existing catalog rows are only READ or
 * UPSERT-updated (never deleted). Dedup is a separate one-off pass.
 */

import { CosmosClient, type Container } from "@azure/cosmos";
import {
  cardNumberInClause,
  computeHobbyIqCardId,
  normalizeSetKey,
  slugify,
  type HobbyIqCardIdComponents,
} from "../portfolioiq/hobbyIqCardId.service.js";
import { productFamilyOf, productRefinementsOf } from "./productSetKeys.js";
import { resolveIdentityToCatalogRow } from "./catalogIdentityResolver.js";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CATALOG_CONTAINER = process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog";

let _container: Container | null = null;

/** The card_catalog container for point reads by other services (null when no connection string). */
export async function getCatalogContainerForRead(): Promise<Container | null> {
  return getContainer();
}

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn)
      .database(COSMOS_DATABASE)
      .container(CATALOG_CONTAINER);
    return _container;
  } catch {
    return null;
  }
}

/** Source of the identity claim — determines whether we seed a fresh
 *  catalog row when no match exists. Untrusted sources return `found:
 *  false` and never create — that keeps the catalog clean. */
export type CatalogMatchSource =
  | "checklist"           // LLM-extracted from a published product checklist
  | "tca"                 // TCA sale with a stable identity
  | "cardhedge"           // CardHedge sale with a resolved cardId
  | "cardsight"           // Cardsight identity
  | "user-verified"       // User manually confirmed add-card identity
  | "ebay-user-purchase"  // User imported an eBay purchase they own
  | "ebay-user-sale"      // User sold on eBay — sale price is theirs
  | "manual-user-entry"   // User typed the sale by hand
  | "ebay-title"          // fuzzy title parse — NEVER seeds
  | "import"              // spreadsheet import (D12-b) — unverified user text, NEVER seeds
  | "unknown";            // NEVER seeds

const TRUSTED_SOURCES: ReadonlySet<CatalogMatchSource> = new Set([
  "checklist",
  "tca",
  "cardhedge",
  "cardsight",
  "user-verified",
  "ebay-user-purchase",
  "ebay-user-sale",
  "manual-user-entry",
]);

// CF-USER-SOURCES-SEED-EXEMPTION (Drew, 2026-08-08). Under CATALOG_MATCH_ONLY
// vendor ingest is gated (never grows catalog), but USER-flavored sources
// are trusted enough to seed: the user physically owns the card (add-card,
// eBay import) or is manually contributing (flagComp entry). Their identity
// is worth trusting to seed a low-confidence catalog entry that admin then
// verifies against a product checklist. See project directive from
// 2026-08-08 conversation: "every search and add goes THROUGH the catalog
// and then we promote new ones for review and we must look at checklists
// to confirm."
const USER_SEED_ALLOWED_SOURCES: ReadonlySet<CatalogMatchSource> = new Set([
  "user-verified",
  "ebay-user-purchase",
  "ebay-user-sale",
  "manual-user-entry",
]);

export interface CatalogMatchInput {
  sport: string;
  year: number;
  setName: string;         // raw set name, gets normalized
  cardNumber: string;
  parallel: string | null;
  isAuto: boolean;
  printRun?: number | null;
  player?: string | null;  // stamped on new rows when seeding
  source: CatalogMatchSource;
  sourceExternalId?: string | null;   // e.g. TCA product_id, CH cardId
}

export interface CatalogMatchResult {
  slug: string;
  found: boolean;         // true when a catalog row was matched (or freshly seeded and found on re-read)
  confidence: number;     // 0-1
  matchedBy: "exact" | "fuzzy-parallel" | "long-form" | "family-refined" | "family-fallback" | "seeded" | "not-found";
  catalogId?: string;
}

/** CF-MARKET-LANGUAGE-NORMALIZATION (memory rule). Canonicalize parallel
 *  labels that trade under multiple names in the wild. Applied BEFORE
 *  the slug is computed so all downstream paths agree on one form. */
const PARALLEL_ALIAS_MAP: Record<string, string> = {
  // CF-COLOUR-FOLLOWS-THE-CHECKLIST (Drew, 2026-08-30): "True {Color}" is the
  // market's word for {Color}; whether that colour is a Refractor on this card
  // is the checklist's to say — the resolver below picks the unique long-form
  // candidate when the card has only "{Color} Refractor", and leaves "{Color}"
  // when the checklist lists it (or both). The old "→ {Color} Refractor"
  // rewrite is gone.
  "true blue": "Blue",
  "true green": "Green",
  "true red": "Red",
  "true orange": "Orange",
  "true gold": "Gold",
  "true purple": "Purple",
  "true black": "Black",
  "true yellow": "Yellow",
  "true pink": "Pink",
  // "Mega" → "Mojo" (the refractor-ness is the catalog's)
  "mega mojo": "Mojo",
  // Bracketed base variants
  "[base]": "Base",
  "base refractor": "Refractor",
};

/** CF-PARALLEL-IS-IDENTITY. Tokens of a parallel slug, as an order-independent
 *  set. Empty and "base" collapse to the same thing so an absent parallel and
 *  an explicit "Base" compare equal. */
export function parallelTokenSet(slug: string): Set<string> {
  const toks = String(slug ?? "").split("-").map((t) => t.trim()).filter(Boolean);
  const meaningful = toks.filter((t) => t !== "base");
  return new Set(meaningful.length ? meaningful : ["base"]);
}

/** True only when two parallels carry exactly the same tokens. Deliberately
 *  NOT a subset test: "refractor" ⊂ "green-refractor", but a sale that says
 *  only "Refractor" is not evidence of a Green Refractor, and treating it as
 *  such is how a plain Refractor became a `common-green-refractor /75`. */
export function sameParallelTokens(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/**
 * CF-LONG-FORM-IS-ONE-FAMILY-WORD (Drew, 2026-08-28: "lets do it"). The
 * family words a checklist ladder appends to a colour: "Gold" and "Gold
 * Refractor" are one card on Chrome products, per the standing Colour ≡
 * Refractor ruling. The ruling is PER-CARD only — Panini Prizm carries bare
 * colours that are NOT refractors — which is exactly why the resolver below
 * demands a UNIQUE candidate: a card whose ladder holds both "gold" and
 * "gold-refractor" produces two candidates and is refused, never guessed.
 */
export const PARALLEL_FAMILY_WORDS = [
  "refractor", "prizm", "holo", "wave", "shimmer", "lava", "foil", "foilboard",
  "x-fractor", "sapphire", "chrome", "ice", "mojo", "camo", "pattern",
] as const;

/**
 * CF-VERIFIED-REFINEMENTS-ONLY (Drew rulings, 2026-08-28). The set keys a
 * plain product may widen into: the SERIES split (one continuous numbering,
 * measured — 2024 Topps S1 1,724 numbers, S2 443, ZERO overlap) and the
 * UPDATE series. A bare `STARTSWITH(setKey + "-")` would pull topps-chrome
 * into topps and let a chrome ladder answer flagship comps — the
 * bowman-chrome ≠ bowman merge in mirror image, refused here the same way
 * the batch mappers refuse it.
 *
 * CF-THE-ID-CARRIES-THE-PRODUCT (D23). The refinements are READ FROM THE
 * TABLE (productSetKeys `refines`), every spelling of them, as exact keys
 * for an `IN (...)` — not prefixes: `topps-series` as a prefix would have
 * admitted topps-series-1-1st-edition, which is another set.
 */
export function widenedSetKeys(setKey: string): string[] {
  return productRefinementsOf(setKey);
}

/**
 * The unique long-form rung rule, measured before it was written: across
 * 1.96M derived spellings the ambiguity rate of "text ± one family word hits
 * exactly one rung" was 0.2%. Both directions are tried — a sale saying
 * "Gold" matching the ladder's "Gold Refractor", and a sale saying "Gold
 * Refractor" matching a ladder that spells it bare — because checklist
 * sources disagree on which form they print. Returns the single matching
 * candidate, or null when zero or several match (several = refuse, the
 * Prizm guard).
 */
export function resolveLongFormRung<T extends { id: string; seg: string }>(
  want: Set<string>,
  candidates: ReadonlyArray<T>,
): T | null {
  const hits: T[] = [];
  for (const c of candidates) {
    const got = parallelTokenSet(c.seg);
    if (sameParallelTokens(got, want)) continue;   // equality is Step 2's job
    let match = false;
    for (const fam of PARALLEL_FAMILY_WORDS) {
      const famToks = fam.split("-");
      // ladder = want + family ("gold" -> "gold-refractor")
      const wantPlus = new Set([...want, ...famToks]);
      if (want.size + famToks.length === wantPlus.size && sameParallelTokens(got, wantPlus)) { match = true; break; }
      // ladder = want - family ("gold refractor" -> bare "gold")
      if (famToks.every((t) => want.has(t))) {
        const wantMinus = new Set([...want].filter((t) => !famToks.includes(t)));
        if (wantMinus.size > 0 && sameParallelTokens(got, wantMinus)) { match = true; break; }
      }
    }
    if (match) hits.push(c);
  }
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * CF-IMPLIED-REFRACTOR-EQUIVALENCE (2026-08-22).
 *
 * sameParallelTokens is deliberately strict, and must stay strict in the
 * direction it was written for: a sale saying only "Refractor" is not evidence
 * of a Green Refractor, and treating it as such is how a plain Refractor became
 * a common-green-refractor /75.
 *
 * The OPPOSITE direction is not the same claim. "Yellow" and "Yellow Refractor"
 * name one card — in a Chrome product the refractor finish is implied, which is
 * why stripRefr() treats "Blue" and "Blue Refractor" as one parallel everywhere
 * in the pricing path (canonicalFmv, peerPoolBuilder, parallelTitleMatch).
 *
 * The adoption invariant in canonicalize() did not know that, so it threw away
 * correct matches AFTER finding them. Measured 2026-08-22, re-matching the 18
 * unidentified holdings:
 *
 *   askedParallel "Yellow"  ->  hiq:...:ra-kg:yellow-refractor:auto
 *   matchedBy "exact", confidence 0.98, REJECTED
 *
 * Konnor Griffin, $535.36 paid, left with no identity and therefore no price.
 *
 * This permits ONE relaxation and nothing else: the two token sets are
 * identical apart from "refractor", AND the side lacking it still carries a
 * real qualifier. So:
 *
 *   {yellow} vs {yellow,refractor}   -> equivalent   (colour agrees)
 *   {refractor} vs {green,refractor} -> NOT          (would invent a colour)
 *   {base} vs {refractor}            -> NOT          (base is not a refractor)
 *   {blue} vs {gold,refractor}       -> NOT          (different colours)
 */
export function parallelsEquivalentForAdoption(a: Set<string>, b: Set<string>): boolean {
  if (sameParallelTokens(a, b)) return true;
  const withoutRefractor = (s: Set<string>) =>
    new Set([...s].filter((t) => t !== "refractor"));
  const ar = withoutRefractor(a);
  const br = withoutRefractor(b);
  // A side that is nothing but "refractor" carries no colour to agree on, and
  // "base" is a claim in its own right — neither may borrow the other's tokens.
  if (ar.size === 0 || br.size === 0) return false;
  if (ar.has("base") || br.has("base")) return false;
  return sameParallelTokens(ar, br);
}

/** Parallel segment of a canonical `hiq:` slug, or null if not one.
 *  Used to validate a catalog candidate by the id we would actually adopt. */
export function parallelSegmentOf(id: string): string | null {
  const p = String(id ?? "").split(":");
  return p.length >= 7 && p[0] === "hiq" ? (p[5] ?? "") : null;
}

// CF-CONFIDENCE-MUST-BE-HONOURED (Drew, 2026-08-14: "lets fix it").
//
// canonicalize() has always returned a confidence, and BOTH rebind sites
// ignored it:
//
//   if (resolved.found) slug = resolved.slug;
//
// So a 0.55 family-fallback guess rewrote a sale's identity exactly as
// authoritatively as a 0.98 exact match. That is worse than having no score at
// all, because the score's existence implies a check that was never performed.
//
// The threshold sits above family-fallback (0.55) and below fuzzy-parallel
// (0.72). Rationale: since CF-PARALLEL-IS-IDENTITY, a fuzzy-parallel match is
// parallel-verified — it can only differ in token ORDER — so adopting it is
// safe. family-fallback is the one that changes the PRODUCT
// (bowman-chrome-sapphire -> bowman-chrome), and Sapphire is not Chrome: those
// are different cards at different prices, so collapsing one into the other
// corrupts both pools exactly like the parallel bug did.
//
// A rejected rebind is not a dropped sale. The caller keeps its computed slug
// and seeds a checklist request — recoverable, and it asks for the checklist
// that would make the match exact next time.
export const MIN_REBIND_CONFIDENCE = 0.7;

export interface SlugAdoption {
  slug: string;
  rebound: boolean;
  /** Set when a match existed but was refused, so callers can log it. */
  refusedReason?: string;
}

/**
 * The ONE place a resolved slug may replace a computed one.
 *
 * Both ingest paths (recordSoldComp, persistVendorSalesToPool) had their own
 * copy of this decision, which is how the same invariant needed fixing twice.
 * Route every adoption through here so they cannot diverge again.
 */
export function adoptResolvedSlug(computedSlug: string, resolved: CatalogMatchResult): SlugAdoption {
  if (!resolved.found || !resolved.slug) return { slug: computedSlug, rebound: false };
  if (resolved.slug === computedSlug) return { slug: computedSlug, rebound: false };
  if (resolved.confidence < MIN_REBIND_CONFIDENCE) {
    return {
      slug: computedSlug,
      rebound: false,
      refusedReason: `confidence ${resolved.confidence} < ${MIN_REBIND_CONFIDENCE} (${resolved.matchedBy})`,
    };
  }
  return { slug: resolved.slug, rebound: true };
}

/**
 * CF-BORDER-IS-THE-SAME-CARD (Drew, 2026-08-15: "bingo! just someone using
 * different words"). Checklist sources disagree on whether the colour
 * parallel is called "Gold" or "Gold Border" — it is one card either way.
 *
 * Proven on 2024 Bowman #9, where the SAME card carries both:
 *   Gold Border /50   source=checklistcenter
 *   Gold        /50   source=bccp
 * Same print run, same card, two vocabularies. Across a sample of cards
 * holding both forms, 77 agreed on print run; the 20 that "differed" were
 * a null print run on one side, i.e. missing data rather than a second
 * parallel.
 *
 * DELIBERATELY NARROW — matches only the exact form "{Colour} Border" or
 * "{Colour} Bordered". The word "border" is NOT generally droppable, and a
 * blanket strip would corrupt real identities:
 *
 *   "Borderless", "Borderless Refractor"   opposite meaning
 *   "Gap in Border", "No Gap in Border"    printing varieties
 *   "Team Color Border Variation"          not a colour parallel
 *   "222 Pat Border", "Pat Borders / Ted Power"
 *                                          a PLAYER NAME sitting in the
 *                                          parallel field — ~4,900 rows of a
 *                                          separate data defect, untouched
 *   "Mini Black Border"                    qualified form, left alone
 *
 * Colour still distinguishes, so vintage "Black Border" and "White Border"
 * stay distinct from each other — they normalize to "Black" and "White".
 */
const COLOUR_BORDER_RE =
  /^(gold|black|blue|red|green|orange|purple|yellow|pink|white|silver|platinum|aqua|fuchsia)\s+border(ed)?$/i;

/**
 * CF-PRIZMS-WORD-ORDER (Drew, 2026-08-15: "now can we match it with what we
 * have?"). Yes — the parallels are already catalogued, under two word orders
 * from two scrapers:
 *
 *   Green Pulsar Prizm  /25   baseballcardpedia, bccp
 *   Prizms Green Pulsar /25   checklistcenter
 *   Glitter Prizm       /-    baseballcardpedia, bccp
 *   Prizms Glitter      /-    checklistcenter
 *
 * Same card, same print run, one source writing the family name first. The
 * matcher requires exact parallel-token equality, so a sale matched one form
 * and missed the other, and the catalog carries both as if they were separate
 * parallels: 51,335 rows in "Prizms X" against 444,219 in "X Prizm".
 *
 * Normalizing to the majority form ("X Prizm") collapses that split.
 *
 * NOT a general token strip. Bare "Prizm" is a real parallel in its own right
 * (2,360 rows), so treating "prizm" as droppable would collapse it into Base.
 * This only reorders; it never removes.
 */
const PRIZMS_PREFIX_RE = /^prizms\s+(.+)$/i;

/**
 * CF-PARALLEL-DESLUG (Drew, 2026-08-15: "normalize it and add it to vocab").
 *
 * 1,588 distinct parallel values are stored in slug form — "optic-red",
 * "1992-nba-mvp", "1st-day-issue" — and 1,455 of them (91.6%) have a
 * properly spaced twin elsewhere in the catalog. They come from the
 * sold-comps-stub seeding path, which wrote the SLUG into the display field
 * where a human-readable name belongs.
 *
 * SCOPE, honestly: this does NOT fix matching. The matcher compares
 * parallelSlug, and "optic-red" and "Optic Red" both slugify to "optic-red",
 * so they already match today. This is vocabulary hygiene — it stops the
 * catalog presenting two spellings of one parallel, and it means anything
 * grouping or displaying by `parallel` sees one value.
 *
 * Because the output re-slugifies to exactly what it came from, the change
 * is display-only and cannot move a card to a different slug.
 *
 * Acronyms are preserved deliberately: naive title-casing turns
 * "1992-nba-mvp" into "1992 Nba Mvp", which matches neither the twin
 * "1992 NBA MVP" nor how anyone writes it.
 */
const PARALLEL_ACRONYMS = new Set([
  "nba", "nfl", "mlb", "nhl", "mvp", "rc", "sp", "ssp", "gu", "usa", "hof",
  "rpa", "fotl", "1of1", "uk", "us", "au", "opc", "tv", "ud", "wbc", "asg",
]);

/** True only for an all-lowercase hyphenated token run, e.g. "optic-red". */
const SLUG_FORM_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

function deslugParallel(v: string): string {
  return v.split("-").filter(Boolean).map((w) => {
    if (PARALLEL_ACRONYMS.has(w)) return w.toUpperCase();
    // Ordinals and year-like tokens keep their own shape: 1st, 2026.
    if (/^\d+(?:st|nd|rd|th)?$/.test(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}

export function canonicalizeParallelName(raw: string | null): string {
  if (!raw) return "Base";
  const trimmed = String(raw).trim();
  if (!trimmed) return "Base";
  const lower = trimmed.toLowerCase();
  if (PARALLEL_ALIAS_MAP[lower]) return PARALLEL_ALIAS_MAP[lower];
  const border = lower.match(COLOUR_BORDER_RE);
  if (border) return border[1].charAt(0).toUpperCase() + border[1].slice(1);
  // "Prizms Green Pulsar" -> "Green Pulsar Prizm". Reorder only; the family
  // word is preserved because bare "Prizm" is itself a distinct parallel.
  const prizms = trimmed.match(PRIZMS_PREFIX_RE);
  if (prizms) {
    const rest = prizms[1].trim();
    if (rest && !/prizm$/i.test(rest)) return `${rest} Prizm`;
    if (rest) return rest;
  }
  // Slug-form display values get spelled back out. Re-slugifies identically,
  // so this can never move a card onto a different slug.
  if (SLUG_FORM_RE.test(trimmed)) return deslugParallel(trimmed);
  return trimmed;
}

/** Build a canonical HobbyIqCardIdComponents from arbitrary input. */
export function buildComponents(input: CatalogMatchInput): HobbyIqCardIdComponents {
  return {
    sport: String(input.sport ?? "").trim().toLowerCase(),
    year: input.year,
    setKey: normalizeSetKey(input.setName ?? ""),
    // CF-CARD-NUMBER-IS-CASE-INSENSITIVE (Drew, 2026-08-16: "yea, we should
    // see if it does").
    //
    // The catalog lookup compares `c.cardNumber = @n` — an exact, CASE-SENSITIVE
    // equality — and every checklist writes card numbers uppercase (4,000
    // sampled canonical rows: 4,000 uppercase, 0 with any lowercase). Vendors
    // do not. A sale arriving as "uk-4" could never match the catalog's "UK-4",
    // so it was recorded as unmatched and filed a seed asking for a checklist
    // we already had.
    //
    // Measured over the 241 unmatched sales whose card demonstrably IS in the
    // catalog: 61 of them — 25.3% — failed on nothing but letter case.
    //
    // Uppercasing the INPUT rather than wrapping the column in UPPER() keeps
    // the predicate index-accelerated; a function on the indexed column is what
    // made search scan 35.7M rows earlier today. A card number is a
    // case-insensitive identifier by nature — UK-4 and uk-4 are one card — and
    // the slug is unaffected because computeHobbyIqCardId lowercases it again
    // through normalizeCardNumber.
    cardNumber: String(input.cardNumber ?? "").trim().toUpperCase(),
    parallel: canonicalizeParallelName(input.parallel),
    isAuto: !!input.isAuto,
    printRun: typeof input.printRun === "number" ? input.printRun : null,
  };
}

/** The main entry point — resolve an identity claim to a canonical
 *  catalog slug. */
// CF-PARALLEL-INVARIANT-AT-THE-BOUNDARY (Drew, 2026-08-14: "should we clean
// the code so it doesn't do it again?").
//
// The parallel-identity bug took THREE edits to stamp out — Step 2, then Step
// 3, then the candidate-id check — because the rule lived in each step rather
// than in the function's contract. A Step 5 added later would reintroduce it,
// and nothing would notice until pools were already corrupted.
//
// So the rule is enforced ONCE, here, over every exit point (there are 8):
//
//   canonicalize() MUST NOT return a slug whose parallel differs from the
//   parallel it was asked about.
//
// Crossing SETS is still allowed — that is the product-family ladder's job.
// Changing WHICH CARD it is, is not.
//
// On violation we do not silently correct: the resolution is rejected
// (found:false), so the caller keeps its computed slug and seeds a checklist
// request. A wrong match corrupts the pool permanently; no match is
// recoverable and asks for the checklist that fixes it. The violation is
// logged loudly because it means a matcher step has a bug.
// CF-CATALOG-LOOKUP-CACHE (Drew, 2026-08-14: "we cant wait 18 days for data").
//
// Promotion runs ~1s per row, and that cost is NOT HTTP overhead — a local
// runner with no App Service ceiling was just as slow. It is the catalog
// lookups: canonicalize issues cross-partition queries against a 25.5M-row
// container, once per row.
//
// Staging rows repeat cards heavily — measured 5.4 rows per distinct card
// across the pending backlog (150,000 rows touching 27,934 cards). So most of
// those queries re-ask a question already answered, and memoising turns an
// 18-day drain into roughly 3.4 days; sharded 6 ways, ~14 hours.
//
// TTLs, not permanent memory, because checklists are being INGESTED WHILE THIS
// RUNS. A cached "not-found" that outlived the checklist that would satisfy it
// is the failure mode to avoid — it would silently pin a card as unmatchable
// for the length of the run. So negatives expire fast; positives are safe to
// hold longer, since a card that exists keeps existing.
const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 60_000;
const CACHE_MAX = 200_000;

interface CacheEntry { result: CatalogMatchResult; expires: number; }
const _matchCache = new Map<string, CacheEntry>();

function cacheKey(c: HobbyIqCardIdComponents): string {
  return [c.sport, c.year, c.setKey, c.cardNumber.toUpperCase(), c.parallel.toLowerCase(),
    c.isAuto ? "1" : "0", c.printRun ?? ""].join("|");
}

/** Exposed so a long-running drain can reclaim memory between phases. */
export function clearCatalogMatchCache(): void { _matchCache.clear(); }

/**
 * CF-MATCH-WITHOUT-CARDNUMBER (Drew, 2026-08-15: "not everyone is going to
 * put card numbers so we should be able to match too").
 *
 * Resolve a card number from the identity a seller DOES give:
 *   player + set + year + parallel + auto yes/no
 *
 * Returns the card number only when the catalog holds exactly ONE candidate.
 * Several candidates means we cannot tell which card this is, and picking one
 * would attach a sale — or a user's holding — to the wrong card. Absent beats
 * wrong, so ambiguity returns null.
 *
 * Ambiguity is real and worth the refusal. Within a single 2026 "bowman"
 * setKey a prospect can hold a Chrome auto, a Paper auto and a Mega-box auto:
 *
 *   Coy James 2026 bowman auto Base       -> CPA-CJ, BPA-CJ          (refuse)
 *   Coy James 2026 bowman auto Refractor  -> CPA-CJ                  (resolve)
 *   Marek Houston 2026 bowman auto Base   -> CPA-MHO, BPA-MH, BMA-MH (refuse)
 *   Owen Carey 2026 bowman auto Base      -> CPA-OC                  (resolve)
 *
 * The parallel is what usually breaks the tie, which is why it is part of the
 * key rather than an afterthought.
 */
export async function resolveCardNumberByPlayer(input: {
  year: number;
  setKey: string;
  player: string;
  isAuto: boolean;
  parallel?: string | null;
}): Promise<{ cardNumber: string | null; candidates: string[] }> {
  const container = await getContainer();
  if (!container) return { cardNumber: null, candidates: [] };
  const year = Number(input.year);
  const setKey = normalizeSetKey(input.setKey ?? "");
  const player = String(input.player ?? "").trim();
  if (!year || !setKey || !player) return { cardNumber: null, candidates: [] };

  const parallel = canonicalizeParallelName(input.parallel ?? null);
  try {
    const { resources } = await container.items.query<string>({
      query: `SELECT DISTINCT VALUE c.cardNumber FROM c
              WHERE c.year = @y AND c.setKey = @s AND c.playerName = @p
                AND c.isAuto = @a AND c.parallel = @par
                AND IS_DEFINED(c.cardNumber) AND NOT IS_NULL(c.cardNumber)`,
      parameters: [
        { name: "@y", value: year },
        { name: "@s", value: setKey },
        { name: "@p", value: player },
        { name: "@a", value: !!input.isAuto },
        { name: "@par", value: parallel },
      ],
    }).fetchAll();
    const candidates = (resources ?? []).filter(Boolean).map(String);
    return {
      cardNumber: candidates.length === 1 ? candidates[0] : null,
      candidates,
    };
  } catch {
    return { cardNumber: null, candidates: [] };
  }
}

// CF-CARD-IDENTITY-PLAYER (2026-08-22). A hiq: slug carries sport, year,
// setKey, cardNumber, parallel, auto and print run — everything except WHO the
// card is of. card_catalog knows: all 25 Blue Refractor rows for 2024 CPA-TG
// say "Theo Gillen".
//
// Without it the card page titles itself "2024 Bowman Draft #CPA-TG Blue
// Refractor Auto /150" with no player, and Add to portfolio 400s with "card
// identity missing player name" — so a card we can fully price cannot be
// added.
//
// Every row for one (year, setKey, cardNumber) is the same player, so the
// first non-empty name answers it. Cached for the process: this is checklist
// data, it does not change between requests.
const _playerNameCache = new Map<string, string | null>();

/** The identity fields of one catalog row, by its canonical slug.
 *
 *  CF-SELECTED-CARD-IS-THE-IDENTITY (Drew, 2026-08-23). When a user searches
 *  the catalog and picks a card, the holding must take that ROW's fields, not
 *  keep the ones parsed from an eBay title. Stamping the slug alone leaves the
 *  holding's own setName/parallel/cardNumber saying something else, and a row
 *  whose fields disagree with its slug is the defect behind the Theo Gillen bug
 *  — 8,412 catalog rows measured with exactly that disagreement.
 *
 *  Returns null when the slug names no row, so a caller can tell "not found"
 *  from "found but blank". */
export async function readCatalogIdentityBySlug(slug: string): Promise<{
  playerName: string | null;
  year: number | null;
  setKey: string | null;
  setName: string | null;
  cardNumber: string | null;
  parallel: string | null;
  isAuto: boolean | null;
  sport: string | null;
  /** CF-ACCEPT-CARRIES-PRINTRUN (2026-08-23). Without it, an accepted identity
   *  is re-canonicalized by the next PATCH from a holding that has no printRun,
   *  the slug loses its :num-N segment, and the acceptance is silently undone. */
  printRun: number | null;
  /** CF-ONE-VALUATION-PATH (D16): the row's image, so a pricing route's
   *  identity block needs no second catalog read. */
  imageUrl: string | null;
  /** CF-WE-DONT-WANT-SELF-DERIVED (Drew, 2026-09-04): the row's provenance, so
   *  the valuation gate can ask whether a checklist transcribed this identity
   *  or we minted it from our own sales — on the read it already makes, not a
   *  second one per holding priced. */
  source: string | null;
  /**
   * CF-A-MIGRATING-POOL-IS-NOT-A-THIN-POOL (Drew, 2026-09-04). The row's MINT
   * instant — `observedAt`, which `upsertCatalogEntry` writes as
   * `existing?.observedAt ?? now` and therefore never moves once set. It is
   * the only immutable clock on a catalog row (`lastSeenAt` is bumped on every
   * touch, including touches that change nothing), and the pricing path needs
   * it to tell a genuinely empty tier from one whose sales have not finished
   * migrating onto a freshly minted identity. Null when the row predates the
   * field or the read could not be made.
   */
  observedAt: string | null;
} | null> {
  const id = String(slug ?? "").trim();
  if (!id.startsWith("hiq:")) return null;
  try {
    const container = await getContainer();
    if (!container) return null;
    const { resources } = await container.items.query<Record<string, unknown>>({
      query: `SELECT c.playerName, c.cardYear, c.year, c.setKey, c.setName, c.cardNumber,
                     c.parallel, c.isAuto, c.sport, c.printRun, c.imageUrl, c.source,
                     c.observedAt
              FROM c WHERE c.id = @id`,
      parameters: [{ name: "@id", value: id }],
    }).fetchAll();
    const r = resources[0];
    if (!r) return null;
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const str = (v: unknown) => {
      const s = String(v ?? "").trim();
      return s ? s : null;
    };
    return {
      playerName: str(r.playerName),
      year: num(r.cardYear) ?? num(r.year),
      setKey: str(r.setKey),
      setName: str(r.setName),
      cardNumber: str(r.cardNumber),
      parallel: str(r.parallel),
      isAuto: typeof r.isAuto === "boolean" ? r.isAuto : null,
      sport: str(r.sport),
      printRun: num(r.printRun),
      imageUrl: str(r.imageUrl),
      source: str(r.source),
      observedAt: str(r.observedAt),
    };
  } catch {
    return null;
  }
}

/**
 * CF-A-DERIVED-SLUG-IS-ADOPTED-ONLY-FROM-THE-CATALOG (2026-08-29, checklist
 * D12a). Does the catalog hold a row for this slug? Returns the slug the
 * catalog holds -- the id itself, or its twin -- or null.
 *
 * CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30, holding deced7d3). The twin
 * now resolves in BOTH directions, through the one resolver
 * (catalogIdentityResolver.resolveIdentityToCatalogRow):
 *   - a NUMBERED id with no row whose un-numbered form is a row -> that row
 *     (a holding's title regex can add a print run the checklist does not
 *     carry; the #1509 direction, unchanged);
 *   - an UN-NUMBERED id with no row and exactly ONE `<id>:num-N` row -> that
 *     row (the un-numbered row was folded into it and the holding was not:
 *     Max Williams 2025 Bowman Draft CPA-MWI Refractor, 35 sales under
 *     :num-499 and a card page with no comps).
 * Two numbered twins resolve to NOTHING (null): two cards, a ruling.
 *
 * Every writer that gates a slug (gateSuppliedSlug, fillDerivedSlugFromCatalog,
 * resolveHiqCardIdToCatalogRow) and every reader that prices one
 * (resolveValuationIdentity, priceFromOurPool, the alert evaluator) goes
 * through here, so all of them write and price the catalog's form.
 *
 * Fails CLOSED: null when the container is unavailable or a read throws for
 * any reason other than 404 (the resolver's kind "unresolved") -- a WRITER
 * adopting a slug on this answer does not, during an outage, and says so.
 * The READERS (the valuation entry, soldCompsStore) call the resolver
 * directly and fail OPEN on "unresolved" -- they read the id as given.
 *
 * Cost: the resolver memoizes the twin lookup per stem (10 min, bounded) and
 * takes an optional print run that settles the twin with one point read, so
 * the callers here (gateSuppliedSlug, fillDerivedSlugFromCatalog,
 * priceFromOurPool, the alert evaluator, the rematch loops) pay the
 * cross-partition query once per stem per TTL, not per call.
 */
export async function catalogSlugIfExists(slug: string, opts: { printRun?: number | string | null } = {}): Promise<string | null> {
  const id = String(slug ?? "").trim();
  if (!id.startsWith("hiq:")) return null;
  return (await resolveIdentityToCatalogRow(id, { printRun: opts.printRun ?? null })).id;
}

/**
 * CF-A-VARIATION-IS-A-CARD (D22). The catalog's variation rows for one card
 * — the parallel slugs only — so a seam can corroborate a weak title marker
 * ("SP", "SSP", "IV", "Short Print") against the product's own checklist.
 * Empty when the container is unavailable or the read throws.
 */
export async function variationParallelsForCard(input: { sport: string; year: number; setKey: string; cardNumber: string }): Promise<string[]> {
  const container = await getContainer();
  if (!container) return [];
  try {
    // CF-THE-ID-CARRIES-THE-PRODUCT (D23, ruling d): hyphen-insensitive,
    // as an index-friendly IN over the spellings.
    const num = cardNumberInClause(input.cardNumber);
    const { resources } = await container.items.query<{ id: string; parallelSlug?: string }>({
      query: `SELECT c.id, c.parallelSlug FROM c WHERE c.sport = @s AND c.year = @y AND c.setKey = @k AND c.cardNumber IN (${num.sql}) AND CONTAINS(c.parallelSlug, 'variation') OFFSET 0 LIMIT 50`,
      parameters: [
        { name: "@s", value: String(input.sport).toLowerCase() },
        { name: "@y", value: input.year },
        { name: "@k", value: input.setKey },
        ...num.params,
      ],
    }).fetchAll();
    return (resources ?? []).map((r) => String(r.parallelSlug ?? parallelSegmentOf(r.id) ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

export async function lookupCatalogPlayerName(
  year: number | null | undefined,
  setKey: string | null | undefined,
  cardNumber: string | null | undefined,
): Promise<string | null> {
  const y = Number(year);
  const sk = String(setKey ?? "").trim().toLowerCase();
  const cn = String(cardNumber ?? "").trim().toUpperCase();
  if (!Number.isFinite(y) || !sk || !cn) return null;

  const key = `${y}|${sk}|${cn}`;
  const hit = _playerNameCache.get(key);
  if (hit !== undefined) return hit;

  try {
    const container = await getContainer();
    if (!container) return null;
    const { resources } = await container.items.query<{ playerName?: string | null }>({
      // No TOP N without ORDER BY — cosmosQueryHygiene forbids it, and rightly:
      // TOP without an order returns arbitrary rows. An ORDER BY here would be
      // cross-partition and is not worth it, so the filter alone bounds this
      // (one card number in one set — tens of rows) and the first non-empty
      // name is taken in code. Every row for this key is the same player.
      query: `SELECT c.playerName FROM c
              WHERE c.year = @y AND c.setKey = @sk AND UPPER(c.cardNumber) = @cn
                AND IS_DEFINED(c.playerName) AND c.playerName != null`,
      parameters: [
        { name: "@y", value: y },
        { name: "@sk", value: sk },
        { name: "@cn", value: cn },
      ],
    }).fetchAll();
    const found = resources
      .map((r) => (typeof r.playerName === "string" ? r.playerName.trim() : ""))
      .find((n) => n.length > 0) ?? null;
    _playerNameCache.set(key, found);
    return found;
  } catch {
    // Never block a price on this — a missing name degrades the title, an
    // exception would lose the whole response.
    return null;
  }
}

export async function canonicalize(input: CatalogMatchInput): Promise<CatalogMatchResult> {
  // Seeding sources MUST bypass the cache: canonicalize can CREATE a row for
  // them, and a cache hit would skip that side effect.
  const seeds = TRUSTED_SOURCES.has(input.source) && process.env.CATALOG_MATCH_ONLY_ENABLED !== "true";
  const key = seeds ? null : cacheKey(buildComponents(input));

  if (key) {
    const hit = _matchCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.result;
    if (hit) _matchCache.delete(key);
  }

  const result = applySetKeyInvariant(input, applyParallelInvariant(input, await canonicalizeImpl(input)));

  if (key) {
    // Cheap bound: drop the oldest insertion when full rather than track LRU.
    if (_matchCache.size >= CACHE_MAX) {
      const oldest = _matchCache.keys().next().value;
      if (oldest !== undefined) _matchCache.delete(oldest);
    }
    _matchCache.set(key, {
      result,
      expires: Date.now() + (result.found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
    });
  }

  return result;
}

/**
 * Reject a match whose parallel is not the one that was asked for.
 *
 * CF-INVARIANT-BEFORE-CACHE (2026-08-22). This used to run AFTER the cache
 * write and after the early return on a cache hit, which made canonicalize()
 * answer the same question two different ways:
 *
 *   call 1  miss -> compute -> cache{found} -> invariant rejects -> not-found
 *   call 2  hit  -> return cache{found}                          -> FOUND
 *
 * So the first caller got the rejection and every caller for the next TTL got
 * the match the invariant had just thrown out. A guard that runs on the miss
 * path but not the hit path is not a guard — it is a coin flip, and it hid
 * behind the fact that a rejection looks identical to "no such card".
 *
 * Observed on Andrew Fischer #CPA-AF: asked with no parallel, the matcher
 * returned `…:cpa-af:refractor:auto` at exact/0.98. Called once the answer was
 * not-found; called twice in a process it was FOUND, same input.
 *
 * Now the invariant is applied to the compute result BEFORE that result is
 * cached, so the cache stores exactly what a caller would have been given and
 * every path returns the same answer. Pure — no I/O, no cache access.
 */
/** The setKey segment of a canonical slug, or null for non-canonical ids. */
function setKeySegmentOf(slug: string | null | undefined): string | null {
  const parts = String(slug ?? "").split(":");
  return parts[0] === "hiq" && parts.length > 3 ? parts[3] : null;
}

/**
 * CF-MATCH-SETKEY-INVARIANT (2026-08-22). A match may not return a card from a
 * DIFFERENT product than the one that was asked for.
 *
 * The parallel invariant below has guarded the parallel segment since #1180.
 * The setKey segment had no such check, and it needed one, because catalog
 * rows routinely disagree with themselves: the row is FILTERED on its setKey
 * field but the matcher returns its `id`, and those two do not always encode
 * the same product. Measured on 2024 bowman-draft + bowman-chrome alone —
 * 125,044 rows:
 *
 *   id-slug agrees with the setKey field   94,788
 *   id-slug DISAGREES                       8,412
 *   id is not a canonical slug             21,844
 *
 *   e.g. id says "bowman-draft-chrome" while setKey says "bowman-draft"
 *
 * So a query correctly constrained to bowman-draft could hand back a slug for
 * another product, and every consumer downstream trusts the slug. That is how
 * a Theo Gillen Blue Refractor /150 added from its bowman-draft page became a
 * bowman-chrome holding — priced against a pool with none of its comps, which
 * made its only sale look like it had vanished.
 *
 * family-fallback is EXEMPT by design: crossing to a related product is what
 * that rung is for, and it reports itself honestly. This rejects the silent
 * crossings only.
 */
function applySetKeyInvariant(
  input: CatalogMatchInput,
  result: CatalogMatchResult,
): CatalogMatchResult {
  if (!result.found) return result;
  if (result.matchedBy === "family-fallback") return result;

  const got = setKeySegmentOf(result.slug);
  if (got === null) return result;          // non-canonical id, nothing to compare
  const want = normalizeSetKey(input.setName ?? "");
  if (!want || got === want) return result;

  console.warn(JSON.stringify({
    event: "catalog_match_setkey_invariant_violated",
    source: "catalogMatcher.canonicalize",
    matchedBy: result.matchedBy,
    confidence: result.confidence,
    askedSetKey: want,
    returnedSlug: result.slug,
    detail: "a matcher step returned a different product; rejecting the match",
  }));
  return {
    slug: computeHobbyIqCardId(buildComponents(input)),
    found: false,
    confidence: 0.3,
    matchedBy: "not-found",
  };
}

function applyParallelInvariant(
  input: CatalogMatchInput,
  result: CatalogMatchResult,
): CatalogMatchResult {
  if (!result.found) return result;

  const seg = parallelSegmentOf(result.slug);
  // Non-canonical ids (cardhedge::…) carry no parallel segment to check.
  if (seg === null) return result;

  const want = parallelTokenSet(slugify(canonicalizeParallelName(input.parallel)));
  // CF-IMPLIED-REFRACTOR-EQUIVALENCE: "Yellow" and "Yellow Refractor" are one
  // parallel. Anything beyond that single relaxation still fails the invariant.
  if (parallelsEquivalentForAdoption(parallelTokenSet(seg), want)) return result;

  console.warn(JSON.stringify({
    event: "catalog_match_parallel_invariant_violated",
    source: "catalogMatcher.canonicalize",
    matchedBy: result.matchedBy,
    confidence: result.confidence,
    askedParallel: input.parallel,
    returnedSlug: result.slug,
    detail: "a matcher step returned a different parallel; rejecting the match",
  }));
  return {
    slug: computeHobbyIqCardId(buildComponents(input)),
    found: false,
    confidence: 0.3,
    matchedBy: "not-found",
  };
}

async function canonicalizeImpl(input: CatalogMatchInput): Promise<CatalogMatchResult> {
  const components = buildComponents(input);
  const canonicalSlug = computeHobbyIqCardId(components);
  const container = await getContainer();
  if (!container) {
    // Cosmos unavailable — return the computed slug without a lookup so
    // the ingest can still record something; caller sees found:false.
    return {
      slug: canonicalSlug,
      found: false,
      confidence: 0.5,
      matchedBy: "not-found",
    };
  }

  // Step 1: exact match on the computed slug.
  try {
    const { resource } = await container.item(canonicalSlug, canonicalSlug).read();
    if (resource) {
      return {
        slug: canonicalSlug,
        found: true,
        confidence: 0.98,
        matchedBy: "exact",
        catalogId: resource.id,
      };
    }
  } catch {
    // Non-fatal — item not found → try fuzzy paths below.
  }

  // Step 2: parallel match — same year/set/cardNumber/isAuto, and the SAME
  // parallel, allowing only for token order and alias differences.
  const parallelSlug = slugify(components.parallel);
  if (parallelSlug && components.cardNumber) {
    try {
      // CF-FUZZY-PARALLEL-SAME-SET (Drew, 2026-08-13). This step's own comment
      // promises "same year/set/cardNumber", but the query never constrained
      // setKey — so a shared parallel TOKEN was enough to jump products. Real
      // results against prod, from Drew's MISSING holdings:
      //
      //   2017 Topps Gold Label #86 "Blue"        -> topps:86:father-s-day-powder-blue
      //   2022 Topps Chrome #221 "Image Variation"-> topps-chrome-sonic-lite:221:image-variations
      //
      // Right year, right number, wrong PRODUCT — "blue" and "variation" are
      // generic tokens that appear in every set's parallel vocabulary. Matching
      // a related set is legitimate, but that is Step 3's job (family-fallback,
      // 0.55), where the relationship is explicit and scored lower. Step 2 must
      // stay within the set it was given.
      //
      // Vendor-keyed and variant rows are also excluded: they are mirrors of
      // cards we hold canonically, and proposing `cardhedge::…` as a holding's
      // identity points pricing at a vendor's copy instead of the card. That is
      // how "2020 Bowman Witt #BD152" resolved to a cardhedge:: slug.
      // CF-PARALLEL-IS-IDENTITY (Drew, 2026-08-13: "why is it getting written
      // to the wrong card when it is clear what it is").
      //
      // This step used to reduce the parallel to ONE token and search on it:
      //
      //   parallelSlug.split("-").slice(-1)[0]   // "last token — usually the color"
      //   ... CONTAINS(LOWER(c.parallelSlug), @tok)
      //
      // The comment had it backwards. Real parallels are "<Color> <Family>", so
      // the LAST token is the generic family word every parallel in the set
      // shares, and the discarded prefix is the only part that identifies the
      // card:
      //
      //   mojo-refractor         -> "refractor"
      //   purple-prizm           -> "prizm"
      //   blue-pulsar-prizm      -> "prizm"
      //   mini-diamond-refractor -> "refractor"
      //
      // CONTAINS(parallelSlug,'refractor') then matches EVERY refractor in the
      // set, and `TOP 10` with no ORDER BY handed back an arbitrary sample from
      // which .find() took the first canonical row. Measured on prod: 41 of 300
      // promoted sales (13.7%) were rebound onto a DIFFERENT parallel —
      //
      //   mojo-refractor            -> refractor
      //   purple-prizm /149         -> premier-level-black-finite-prizms /1
      //   mini-diamond-refractor /99-> negative-refractor
      //   mojo-prizm /36            -> prizm-blue /199
      //
      // — each one a collector-distinct card at a different value, corrupting
      // both pools and the FMV computed from them, while reporting confidence
      // 0.72 so nothing downstream questioned it.
      //
      // Now: fetch the card's parallels deterministically and require the
      // candidate's parallel TOKEN SET to equal ours. That still absorbs what
      // this step is for — token order ("blue-refractor" vs "refractor-blue")
      // and printRun-suffix differences, which do not appear in parallelSlug —
      // while making it impossible to swap one specific parallel for another.
      //
      // A sale whose parallel we cannot find is NOT forced onto a neighbour: it
      // keeps its computed slug and seeds a checklist request, which is real
      // coverage demand and exactly what the seed queue exists to collect.
      // CF-MATCHER-QUERY-COST (Drew, 2026-08-14: "we need to do it faster").
      // Profiled at 2,666ms/row — 95.4% of promotion's entire cost. Fixing the
      // parallel bug I rewrote this as `SELECT TOP 300 * … ORDER BY c.id`,
      // which does three expensive things against a 25.5M-row container:
      // pulls FULL documents, fetches 30x the rows, and forces a
      // CROSS-PARTITION SORT. The ORDER BY existed only for determinism.
      //
      // Determinism does not require the database to sort. Project the three
      // fields actually read, drop the ORDER BY, and sort in memory — a card
      // has far fewer than 300 parallels, so we still receive the complete
      // candidate set and the in-memory sort is exactly as deterministic.
      // CF-MATCHER-QUERY-COST: the spellings are literals HERE, not a function
      // in SQL. UPPER() on the column defeats the index — measured 532.9 RU vs
      // 82.3 RU for an identical 49-row result set. CF-THE-ID-CARRIES-THE-
      // PRODUCT (D23, ruling d): the IN carries the hyphen-free and the
      // hyphenated spellings too, so BD152 finds the checklist's BD-152.
      const num = cardNumberInClause(components.cardNumber);
      const { resources } = await container.items.query({
        query: `SELECT c.id, c.parallelSlug, c.parallel, c.printRun FROM c WHERE c.sport = @s AND c.year = @y AND c.cardNumber IN (${num.sql}) AND c.isAuto = @a AND c.setKey = @sk OFFSET 0 LIMIT 300`,
        parameters: [
          { name: "@s", value: components.sport },
          { name: "@y", value: components.year },
          ...num.params,
          { name: "@a", value: components.isAuto },
          { name: "@sk", value: components.setKey },
        ],
      }).fetchAll();

      const want = parallelTokenSet(parallelSlug);
      // The pool: every candidate that survives the id / print-run / grade
      // discipline, BEFORE the parallel decides. Token equality (Step 2) and
      // the unique long-form rule (Step 2b) both draw from this one pool, so
      // the long-form rule inherits every guard equality has.
      const pool = (resources as Array<{ id: string; parallelSlug?: string; parallel?: string; printRun?: number | null }>)
        .filter((r) => typeof r?.id === "string" && r.id.startsWith("hiq:"))
        // CF-CANDIDATE-ID-IS-WHAT-WE-ADOPT (Drew, 2026-08-14). Check the
        // candidate's ID, not its parallel field. Catalog rows can disagree
        // with themselves — one has parallelSlug "speckle-refractor" while its
        // id encodes "base-sapphire-refractor" — and since we RETURN best.id,
        // validating the field let a mismatched id through anyway. Observed
        // post-fix on prod: "Speckle Refractor" still resolving to
        // base-sapphire-refractor at matchedBy=fuzzy-parallel, because the
        // field matched even though the slug we adopted did not.
        //
        // CF-THE-PRINT-RUN-IS-A-DISCRIMINATOR (Drew, 2026-08-24:
        // "2025 Bowman Draft Chrome Prospect Auto - Eli Willits Yellow
        // Refractor /75 ... This is the best format bc we can match to it
        // correctly").
        //
        // He is right, and the /75 was the half being thrown away. printRun is
        // parsed from the title, reaches canonicalize (:398) and is even part
        // of the cache key (:451) — then this step neither SELECTed it nor
        // ranked on it, so the one field that separates two same-coloured
        // parallels was discarded exactly where it would have settled the
        // answer.
        //
        // Live case: "2025 Bowman Draft Chrome MAX WILLIAMS 1/50 1st Auto Gold
        // Ref. #CPA-MWI PSA 9" carries printRun 50. The Gold Refractor row is
        // /50; the plain Refractor row is /499. That sale is currently filed
        // on :refractor:, which is why the gold pool holds zero comps for a
        // card that has demonstrably traded.
        //
        // Conservative on purpose: a print run only ever REJECTS, and only
        // when both sides state one. An unnumbered card, or a title that never
        // mentioned a serial, behaves exactly as before.
        .filter((r) => {
          const want = components.printRun;
          const got = typeof r.printRun === "number" ? r.printRun : null;
          if (typeof want !== "number" || want <= 0 || got === null) return true;
          return got === want;
        })
        // Prefer an ungraded row — grade variants share the card's identity
        // fields and would otherwise win arbitrarily. `id` breaks ties so the
        // choice is deterministic rather than dependent on scan order.
        .sort((a, b) => {
          const graded = (x: { id: string }) => (/:(raw|psa|bgs|sgc|cgc)(-|$)/.test(x.id) ? 1 : 0);
          return graded(a) - graded(b) || a.id.localeCompare(b.id);
        });
      // Step 2 proper: exact token equality — the candidate's ID is what we
      // adopt, so the id's own segment is what we compare (CF-CANDIDATE-ID-
      // IS-WHAT-WE-ADOPT, 2026-08-14).
      const ranked = pool.filter((r) =>
        sameParallelTokens(parallelTokenSet(parallelSegmentOf(r.id) ?? slugify(r.parallelSlug ?? r.parallel ?? "")), want));
      const best = ranked[0] ?? null;
      if (best) {
        return {
          slug: best.id,
          found: true,
          confidence: 0.72,
          matchedBy: "fuzzy-parallel",
          catalogId: best.id,
        };
      }
      // Step 2b — CF-LONG-FORM-IS-ONE-FAMILY-WORD (Drew, 2026-08-28). A sale
      // saying "Gold" and a ladder saying "Gold Refractor" are one card on
      // this card's own ladder, when and only when exactly ONE rung matches
      // after adding or removing a single family word. The unique-match guard
      // IS the Prizm safety: a card carrying both "gold" and "gold-refractor"
      // yields two candidates and refuses. Confidence 0.8 — above the rebind
      // gate, below equality's 0.72... no: equality stays 0.72 for
      // compatibility; long-form is deliberately 0.8-adjacent but marked with
      // its own matchedBy so telemetry can grade it separately before any
      // gate depends on the distinction.
      const lf = resolveLongFormRung(
        want,
        pool.map((r) => ({ id: r.id, seg: parallelSegmentOf(r.id) ?? slugify(r.parallelSlug ?? r.parallel ?? "") })),
      );
      if (lf) {
        return {
          slug: lf.id,
          found: true,
          confidence: 0.8,
          matchedBy: "long-form",
          catalogId: lf.id,
        };
      }
      // Step 2c — CF-VERIFIED-REFINEMENTS-ONLY (Drew, 2026-08-28). When the
      // exact setKey holds NO candidates for this card at all, the checklist
      // may key the same card under a verified refinement: topps comps whose
      // rows live under topps-series-1/2 or topps-update. One liberty at a
      // time: within the widened family only EXACT parallel-token equality
      // may adopt — no long-form, no fuzz, because a set change and a
      // parallel inference at once is two guesses stacked. Same print-run
      // rejection and ungraded preference as the exact pool.
      if (pool.length === 0) {
        const refinements = widenedSetKeys(components.setKey);
        if (refinements.length > 0) {
          const num = cardNumberInClause(components.cardNumber);
          const refParams = refinements.map((k, i) => ({ name: `@r${i}`, value: k }));
          const refIn = refParams.map((p) => p.name).join(", ");
          const { resources: widened } = await container.items.query({
            query: `SELECT c.id, c.parallelSlug, c.parallel, c.printRun FROM c WHERE c.sport = @s AND c.year = @y AND c.cardNumber IN (${num.sql}) AND c.isAuto = @a AND c.setKey IN (${refIn}) OFFSET 0 LIMIT 300`,
            parameters: [
              { name: "@s", value: components.sport },
              { name: "@y", value: components.year },
              ...num.params,
              { name: "@a", value: components.isAuto },
              ...refParams,
            ],
          }).fetchAll();
          const widenedBest = (widened as Array<{ id: string; parallelSlug?: string; parallel?: string; printRun?: number | null }>)
            .filter((r) => typeof r?.id === "string" && r.id.startsWith("hiq:"))
            .filter((r) => sameParallelTokens(parallelTokenSet(parallelSegmentOf(r.id) ?? slugify(r.parallelSlug ?? r.parallel ?? "")), want))
            .filter((r) => {
              const wantRun = components.printRun;
              const got = typeof r.printRun === "number" ? r.printRun : null;
              if (typeof wantRun !== "number" || wantRun <= 0 || got === null) return true;
              return got === wantRun;
            })
            .sort((a, b) => {
              const graded = (x: { id: string }) => (/:(raw|psa|bgs|sgc|cgc)(-|$)/.test(x.id) ? 1 : 0);
              return graded(a) - graded(b) || a.id.localeCompare(b.id);
            })[0] ?? null;
          if (widenedBest) {
            return {
              slug: widenedBest.id,
              found: true,
              confidence: 0.8,
              matchedBy: "family-refined",
              catalogId: widenedBest.id,
            };
          }
        }
      }
    } catch {
      // Query failure is non-fatal — fall through.
    }
  }

  // Step 3: family fallback — same year/cardNumber/isAuto but a
  // related setKey (bowman-chrome-updates → bowman-chrome). Only fires
  // when the table puts the incoming set inside a wider family
  // (CF-THE-ID-CARRIES-THE-PRODUCT: read from productSetKeys, never from
  // the first two segments — topps-series-1 → topps is a family, and
  // bowman-draft-1st-edition → nothing, because 1st Edition is another set).
  const familyKey = productFamilyOf(components.setKey);
  if (familyKey && familyKey !== components.setKey) {
    try {
      // CF-PARALLEL-IS-IDENTITY (Drew, 2026-08-13). This step legitimately
      // crosses SETS along the product-family ladder (bowman-chrome-updates ->
      // bowman-chrome), but it did not constrain the PARALLEL at all, and took
      // resources[0] from an unordered TOP 5. So a Mojo Refractor could land on
      // whichever parallel of that card number the scan happened to return
      // first — a set change and a parallel change at once.
      //
      // It is also the more dangerous of the two steps, because recordSoldComp
      // rebinds on `resolved.found` and never reads `confidence` — so this
      // 0.55 guess rewrote a sale's identity exactly as authoritatively as a
      // 0.98 exact match. Crossing the family ladder is defensible; silently
      // changing which card it is, is not.
      // Same projection + no cross-partition sort as Step 2 (CF-MATCHER-QUERY-COST).
      // CF-MATCHER-QUERY-COST: spellings as literals, never UPPER() on the
      // column (see Step 2); hyphen-insensitive per D23 ruling d.
      const num = cardNumberInClause(components.cardNumber);
      const { resources } = await container.items.query({
        query: `SELECT c.id, c.parallelSlug, c.parallel FROM c WHERE c.sport = @s AND c.year = @y AND c.cardNumber IN (${num.sql}) AND c.isAuto = @a AND c.setKey = @fk OFFSET 0 LIMIT 300`,
        parameters: [
          { name: "@s", value: components.sport },
          { name: "@y", value: components.year },
          ...num.params,
          { name: "@a", value: components.isAuto },
          { name: "@fk", value: familyKey },
        ],
      }).fetchAll();
      const wantFamily = parallelTokenSet(slugify(components.parallel));
      const familyRanked = (resources as Array<{ id: string; parallelSlug?: string; parallel?: string }>)
        .filter((r) => typeof r?.id === "string")
        .filter((r) => sameParallelTokens(parallelTokenSet(parallelSegmentOf(r.id) ?? slugify(r.parallelSlug ?? r.parallel ?? "")), wantFamily))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (familyRanked.length > 0) {
        const best = familyRanked[0];
        return {
          slug: best.id,
          found: true,
          confidence: 0.55,
          matchedBy: "family-fallback",
          catalogId: best.id,
        };
      }
    } catch { /* non-fatal */ }
  }

  // Step 4: seed a fresh row if the source is trusted.
  // CF-CATALOG-MATCH-ONLY (Drew, 2026-08-08). When CATALOG_MATCH_ONLY_ENABLED
  // is on, VENDOR sources never seed — catalog stays curated. But user-
  // flavored sources (add-card, eBay import, manual entry) ARE trusted to
  // grow catalog: the user owns the physical card. Those seeds land as
  // low-confidence with verificationStatus:'pending' so the admin review
  // surface can filter + verify against product checklists.
  const isUserSource = USER_SEED_ALLOWED_SOURCES.has(input.source);
  // CF-SALES-DO-NOT-MINT-CARDS (Drew, 2026-08-28: "CH shouldn't derive rows
  // either. we do with checklists"). This used to refuse vendor seeding only
  // while CATALOG_MATCH_ONLY_ENABLED was "true" — an env flag, which a
  // process can lower for one call (the one-pool emission did, and minted
  // rows through this path in the same window). Vendor sources now never
  // seed, regardless of environment: a checklist mints cards; a user's
  // physical card mints a card; a CardHedge or TCA sale never does.
  if (!isUserSource && input.source !== "checklist") {
    return {
      slug: canonicalSlug,
      found: false,
      confidence: 0.3,
      matchedBy: "not-found",
    };
  }
  if (TRUSTED_SOURCES.has(input.source)) {
    const now = new Date().toISOString();
    const parallelSlugField = slugify(components.parallel);
    const seedDoc: Record<string, unknown> = {
      id: canonicalSlug,
      cardId: canonicalSlug,
      hobbyiqCardId: canonicalSlug,
      sport: components.sport,
      year: components.year,
      setKey: components.setKey,
      cardNumber: components.cardNumber,
      parallel: components.parallel,
      parallelSlug: parallelSlugField,
      isAuto: components.isAuto,
      printRun: components.printRun ?? null,
      playerName: input.player ?? null,
      playerSlug: input.player ? slugify(input.player) : null,
      vendorIds: input.sourceExternalId ? { [input.source]: input.sourceExternalId } : {},
      source: input.source,
      confidence: input.source === "checklist" ? 0.95 : input.source === "user-verified" ? 0.9 : isUserSource ? 0.6 : 0.85,
      // CF-CATALOG-VERIFICATION-STATUS (Drew, 2026-08-08). User-seeded
      // entries land as 'pending' so the admin review surface can filter
      // to "cards users added that need checklist verification." Checklist
      // and user-verified seeds start 'verified' since those signals are
      // already curated.
      verificationStatus: isUserSource && input.source !== "user-verified" && input.source !== "checklist"
        ? "pending-review"
        : "verified",
      observedAt: now,
      lastSeenAt: now,
      searchText: [components.year, components.cardNumber, input.player ?? "", components.parallel].filter(Boolean).join(" ").toLowerCase(),
      searchTokens: Array.from(new Set([
        String(components.year),
        components.cardNumber.toLowerCase(),
        ...(input.player ? input.player.toLowerCase().split(/\s+/) : []),
        ...components.parallel.toLowerCase().split(/\s+/).filter(Boolean),
      ])),
    };
    try {
      await container.items.upsert(seedDoc);
      return {
        slug: canonicalSlug,
        found: true,
        confidence: 0.95,
        matchedBy: "seeded",
        catalogId: canonicalSlug,
      };
    } catch (err) {
      console.warn(JSON.stringify({
        event: "catalog_matcher_seed_error",
        source: "catalogMatcher.canonicalize",
        slug: canonicalSlug,
        error: (err as Error)?.message ?? String(err),
      }));
    }
  }

  // CF-NOT-FOUND-IS-THE-ACQUISITION-FEED (Drew, 2026-08-28). Every comp the
  // matcher cannot place names a checklist we do not hold. Sampled at 2% so
  // 500k daily comps cannot flood App Insights; the KQL GROUP BY (sport,
  // year, setKey) over these events IS the acquisition list, written by live
  // traffic instead of batch audits.
  if (Math.random() < 0.02) {
    console.log(JSON.stringify({
      event: "catalog_resolve_not_found",
      source: "catalogMatcher.canonicalize",
      sport: components.sport,
      year: components.year,
      setKey: components.setKey,
      parallel: components.parallel ?? null,
    }));
  }
  return {
    slug: canonicalSlug,
    found: false,
    confidence: 0.4,
    matchedBy: "not-found",
  };
}
