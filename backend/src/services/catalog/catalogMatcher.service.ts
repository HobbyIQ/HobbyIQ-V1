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
  computeHobbyIqCardId,
  normalizeSetKey,
  slugify,
  type HobbyIqCardIdComponents,
} from "../portfolioiq/hobbyIqCardId.service.js";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const CATALOG_CONTAINER = process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog";

let _container: Container | null = null;

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
  matchedBy: "exact" | "fuzzy-parallel" | "family-fallback" | "seeded" | "not-found";
  catalogId?: string;
}

/** CF-MARKET-LANGUAGE-NORMALIZATION (memory rule). Canonicalize parallel
 *  labels that trade under multiple names in the wild. Applied BEFORE
 *  the slug is computed so all downstream paths agree on one form. */
const PARALLEL_ALIAS_MAP: Record<string, string> = {
  // "True {Color}" → "{Color} Refractor" per Drew's memory
  "true blue": "Blue Refractor",
  "true green": "Green Refractor",
  "true red": "Red Refractor",
  "true orange": "Orange Refractor",
  "true gold": "Gold Refractor",
  "true purple": "Purple Refractor",
  "true black": "Black Refractor",
  "true yellow": "Yellow Refractor",
  "true pink": "Pink Refractor",
  // "Mega" → "Mojo" in some Panini contexts (project_market_language_normalization)
  "mega mojo": "Mojo Refractor",
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

/** Parallel segment of a canonical `hiq:` slug, or null if not one.
 *  Used to validate a catalog candidate by the id we would actually adopt. */
export function parallelSegmentOf(id: string): string | null {
  const p = String(id ?? "").split(":");
  return p.length >= 7 && p[0] === "hiq" ? (p[5] ?? "") : null;
}

export function canonicalizeParallelName(raw: string | null): string {
  if (!raw) return "Base";
  const trimmed = String(raw).trim();
  if (!trimmed) return "Base";
  const lower = trimmed.toLowerCase();
  if (PARALLEL_ALIAS_MAP[lower]) return PARALLEL_ALIAS_MAP[lower];
  return trimmed;
}

/** Build a canonical HobbyIqCardIdComponents from arbitrary input. */
export function buildComponents(input: CatalogMatchInput): HobbyIqCardIdComponents {
  return {
    sport: String(input.sport ?? "").trim().toLowerCase(),
    year: input.year,
    setKey: normalizeSetKey(input.setName ?? ""),
    cardNumber: String(input.cardNumber ?? "").trim(),
    parallel: canonicalizeParallelName(input.parallel),
    isAuto: !!input.isAuto,
    printRun: typeof input.printRun === "number" ? input.printRun : null,
  };
}

/** The main entry point — resolve an identity claim to a canonical
 *  catalog slug. */
export async function canonicalize(input: CatalogMatchInput): Promise<CatalogMatchResult> {
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
      const { resources } = await container.items.query({
        query: "SELECT TOP 300 * FROM c WHERE c.sport = @s AND c.year = @y AND UPPER(c.cardNumber ?? '') = UPPER(@n) AND c.isAuto = @a AND c.setKey = @sk ORDER BY c.id",
        parameters: [
          { name: "@s", value: components.sport },
          { name: "@y", value: components.year },
          { name: "@n", value: components.cardNumber },
          { name: "@a", value: components.isAuto },
          { name: "@sk", value: components.setKey },
        ],
      }).fetchAll();

      const want = parallelTokenSet(parallelSlug);
      const ranked = (resources as Array<{ id: string; parallelSlug?: string; parallel?: string }>)
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
        // The id is authoritative here precisely because it is the thing being
        // adopted. The field is kept only as a fallback for non-slug ids.
        .filter((r) => sameParallelTokens(parallelTokenSet(parallelSegmentOf(r.id) ?? slugify(r.parallelSlug ?? r.parallel ?? "")), want))
        // Prefer an ungraded row — grade variants share the card's identity
        // fields and would otherwise win arbitrarily. `id` breaks ties so the
        // choice is deterministic rather than dependent on scan order.
        .sort((a, b) => {
          const graded = (x: { id: string }) => (/:(raw|psa|bgs|sgc|cgc)(-|$)/.test(x.id) ? 1 : 0);
          return graded(a) - graded(b) || a.id.localeCompare(b.id);
        });
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
    } catch {
      // Query failure is non-fatal — fall through.
    }
  }

  // Step 3: family fallback — same year/cardNumber/isAuto but a
  // related setKey (bowman-chrome-updates → bowman-chrome). Only fires
  // when the incoming set has a `-` hierarchy.
  const familyKey = components.setKey.includes("-")
    ? components.setKey.split("-").slice(0, 2).join("-")
    : components.setKey;
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
      const { resources } = await container.items.query({
        query: "SELECT TOP 300 * FROM c WHERE c.sport = @s AND c.year = @y AND UPPER(c.cardNumber ?? '') = UPPER(@n) AND c.isAuto = @a AND c.setKey = @fk ORDER BY c.id",
        parameters: [
          { name: "@s", value: components.sport },
          { name: "@y", value: components.year },
          { name: "@n", value: components.cardNumber },
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
  if (process.env.CATALOG_MATCH_ONLY_ENABLED === "true" && !isUserSource) {
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

  return {
    slug: canonicalSlug,
    found: false,
    confidence: 0.4,
    matchedBy: "not-found",
  };
}
