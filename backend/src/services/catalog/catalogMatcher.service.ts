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

  // Step 2: fuzzy-parallel match — same year/set/cardNumber/isAuto,
  // any parallel that shares a token with our canonical parallel.
  const parallelSlug = slugify(components.parallel);
  const parallelToken = parallelSlug.split("-").filter(Boolean).slice(-1)[0]; // last token — usually the color
  if (parallelToken) {
    try {
      const { resources } = await container.items.query({
        query: "SELECT TOP 5 * FROM c WHERE c.sport = @s AND c.year = @y AND UPPER(c.cardNumber ?? '') = UPPER(@n) AND c.isAuto = @a AND CONTAINS(LOWER(c.parallelSlug ?? c.parallel ?? ''), @tok)",
        parameters: [
          { name: "@s", value: components.sport },
          { name: "@y", value: components.year },
          { name: "@n", value: components.cardNumber },
          { name: "@a", value: components.isAuto },
          { name: "@tok", value: parallelToken },
        ],
      }).fetchAll();
      if (resources.length > 0) {
        const best = resources[0];
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
      const { resources } = await container.items.query({
        query: "SELECT TOP 5 * FROM c WHERE c.sport = @s AND c.year = @y AND UPPER(c.cardNumber ?? '') = UPPER(@n) AND c.isAuto = @a AND c.setKey = @fk",
        parameters: [
          { name: "@s", value: components.sport },
          { name: "@y", value: components.year },
          { name: "@n", value: components.cardNumber },
          { name: "@a", value: components.isAuto },
          { name: "@fk", value: familyKey },
        ],
      }).fetchAll();
      if (resources.length > 0) {
        const best = resources[0];
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
