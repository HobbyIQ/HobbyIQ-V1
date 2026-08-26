// CF-INGEST-CATALOG-AUTO-SEED (Drew, 2026-08-05).
//
// Fires after every successful sold_comp upsert to make sure the
// canonical catalog row (id = hobbyiqCardId) exists in card_catalog.
// If already present → no-op. If missing → upsert a minimal doc so
// the catalog auto-grows with every new comp.
//
// Fire-and-forget from the caller. Silent-safe: any failure is
// logged (sampled) and never blocks the ingest write path.
//
// Once the row exists, downstream jobs (attach-sales-summary,
// match-catalog-to-bccp, flag-price-anomalies) automatically pick
// it up on their next pass.

import { CosmosClient, type Container, type JSONObject } from "@azure/cosmos";
import { deriveBrand, deriveParentSetKey, normalizeSetKey, slugify } from "../portfolioiq/hobbyIqCardId.service.js";
import { upsertCatalogEntry, type CardCatalogEntry } from "../portfolioiq/cardCatalog.service.js";

let _container: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _container = new CosmosClient(conn)
      .database(process.env.COSMOS_DATABASE ?? "hobbyiq")
      .container("card_catalog");
    return _container;
  } catch { return null; }
}

// Small LRU-ish set to skip Cosmos reads for slugs we've already
// confirmed exist THIS process. 5-min TTL keyed by process start —
// warm restart re-verifies. Bounded to 50K entries to keep memory
// negligible; oldest evict when full.
const KNOWN_SLUGS = new Map<string, number>();
const KNOWN_TTL_MS = 5 * 60 * 1000;
const KNOWN_MAX = 50_000;

function markKnown(slug: string): void {
  if (KNOWN_SLUGS.size >= KNOWN_MAX) {
    const first = KNOWN_SLUGS.keys().next().value;
    if (first) KNOWN_SLUGS.delete(first);
  }
  KNOWN_SLUGS.set(slug, Date.now());
}
function isKnown(slug: string): boolean {
  const t = KNOWN_SLUGS.get(slug);
  if (!t) return false;
  if (Date.now() - t > KNOWN_TTL_MS) { KNOWN_SLUGS.delete(slug); return false; }
  return true;
}

export interface EnsureCatalogRowInput {
  slug: string;                    // canonical hobbyiqCardId
  sport: string;
  year: number;
  setName: string | null | undefined;
  cardNumber: string | null | undefined;
  parallel: string | null | undefined;
  isAuto: boolean | null | undefined;
  printRun: number | null | undefined;
  playerName: string | null | undefined;
}

/**
 * Idempotent: no-op if catalog already has a row at this slug.
 * Otherwise upserts a minimal doc with source="ingest-auto-seed" so
 * downstream jobs can identify auto-seeded rows vs bulk-built ones.
 */
export async function ensureCatalogRow(input: EnsureCatalogRowInput): Promise<void> {
  if (!input.slug || !input.year) return;
  if (isKnown(input.slug)) return;
  const container = await getContainer();
  if (!container) return;

  // Existence check via point read — cheap (1-2 RU per hit).
  try {
    const { resource } = await container.item(input.slug, input.slug).read();
    if (resource) { markKnown(input.slug); return; }
  } catch { /* 404 falls through to create */ }

  // Build a minimal-but-searchable doc mirroring bulk-build-catalog.ts
  // shape so downstream jobs (search, salesSummary, match) work as-is.
  const setKey = normalizeSetKey(input.setName ?? "");
  const brand = deriveBrand(setKey);
  const parentSetKey = deriveParentSetKey(setKey);
  const parallel = input.parallel ?? "Base";
  const cardNumber = String(input.cardNumber ?? "").trim().toUpperCase();
  if (!cardNumber || !setKey) return;
  const now = new Date().toISOString();
  const doc: Omit<CardCatalogEntry, "observedAt" | "lastSeenAt"> = {
    id: input.slug,
    cardId: input.slug,
    hobbyiqCardId: input.slug,
    sport: input.sport,
    year: input.year,
    brand,
    setKey,
    parentSetKey,
    setName: input.setName ?? setKey,
    cardNumber,
    parallel,
    parallelSlug: slugify(parallel),
    isAuto: input.isAuto === true,
    printRun: input.printRun ?? null,
    playerName: input.playerName ?? null,
    playerSlug: input.playerName ? slugify(input.playerName) : null,
    source: "ingest-auto-seed",
    confidence: 0.85,
    observedCompCount: 1,
    firstSeenAt: now,
    vendorIds: {},
    searchText: [input.year, cardNumber, input.playerName ?? "", parallel].filter(Boolean).join(" ").toLowerCase(),
    searchTokens: Array.from(new Set([
      String(input.year), cardNumber.toLowerCase(), brand,
      ...(input.playerName ? input.playerName.toLowerCase().split(/\s+/) : []),
      ...parallel.toLowerCase().split(/\s+/).filter(Boolean),
      ...setKey.split("-").filter(Boolean),
    ])),
  };

  try {
    // CF-ONE-WAY-TO-BUILD-A-CATALOG-ROW. This used to call
    // container.items.upsert directly, which is why it sat on the BYPASSING
    // debt list. It could not do otherwise until now: CardCatalogEntry could
    // express neither this row's source ("ingest-auto-seed" was not in the
    // five-value union) nor its searchTokens/setName, so routing through the
    // canonical path would have dropped the fields search depends on.
    //
    // With the type able to express a real row, this goes through the one
    // write path and gains its merge semantics -- vendorIds union, and a
    // 0.85-confidence auto-seed can no longer overwrite a checklist row that
    // arrived between the read above and this write.
    await upsertCatalogEntry(doc);
    markKnown(input.slug);
  } catch (err) {
    // Silent — sample-log so we can see the rate without spamming.
    if (Math.random() < 0.01) {
      console.warn(JSON.stringify({
        event: "ensureCatalogRow_upsert_failed",
        slug: input.slug,
        error: (err as Error)?.message ?? "unknown",
        sampled: true,
      }));
    }
  }
}
