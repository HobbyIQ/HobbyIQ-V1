// CF-PERSIST-VENDOR-CATALOG (Drew, 2026-07-23, issue #722 catalog).
// Every card the vendor's catalog search returns → our card_catalog
// container. Grows HobbyIQ's own catalog independent of CH/CS.
//
// Flag: PERSIST_VENDOR_CATALOG_ENABLED (default OFF).
// Container: card_catalog (partition /cardId).

import {
  getContainer,
  contentHashOf,
  runInBackground,
  logPersistEvent,
  isDomainEnabled,
} from "./vendorPersistenceCommon.service.js";
import { buildSearchIndex } from "./searchIndexing.service.js";

export interface VendorCatalogEntry {
  cardId: string;                  // vendor cardId (CH bubble.io id or CS uuid)
  title?: string | null;
  player?: string | null;
  set?: string | null;
  year?: string | number | null;
  number?: string | null;
  variant?: string | null;
  imageUrl?: string | null;
}

export interface VendorCatalogPersistResult {
  inserted: number;
  deduped: number;
  skipped: number;
}

export function isPersistVendorCatalogEnabled(): boolean {
  return isDomainEnabled("PERSIST_VENDOR_CATALOG_ENABLED");
}

/** Persist a batch of catalog entries from a vendor search response.
 *  Never throws. */
export async function persistVendorCatalog(
  source: "cardsight" | "cardhedge",
  entries: VendorCatalogEntry[],
): Promise<VendorCatalogPersistResult> {
  const result: VendorCatalogPersistResult = { inserted: 0, deduped: 0, skipped: 0 };
  if (!isPersistVendorCatalogEnabled()) return result;
  if (!Array.isArray(entries) || entries.length === 0) return result;
  const container = await getContainer("card_catalog");
  if (!container) return result;

  for (const e of entries) {
    const cardId = String(e.cardId ?? "").trim();
    if (!cardId) { result.skipped++; continue; }
    const contentHash = contentHashOf(
      source, cardId, e.title, e.player, e.set, e.year, e.number, e.variant,
    );
    try {
      // CF-DEDUP-CHECK-CANONICAL (Drew, 2026-08-01). After the
      // dedupe-catalog-by-hobbyiq merge, vendor rows are collapsed to
      // one canonical row per physical card, and the vendor cardId
      // lives in canonical.vendorMappings. If we only check the old
      // shape (c.cardId = @c AND c.contentHash = @h), every future CS/CH
      // search would miss the canonical row and re-insert a duplicate.
      // Second query covers the canonical shape by vendorMappings.
      const { resources: byLegacyKey } = await container.items.query({
        query: "SELECT c.id FROM c WHERE c.cardId = @c AND c.contentHash = @h",
        parameters: [{ name: "@c", value: cardId }, { name: "@h", value: contentHash }],
      }).fetchAll();
      if (byLegacyKey.length > 0) { result.deduped++; continue; }
      const { resources: byCanonicalMapping } = await container.items.query({
        query: "SELECT c.id FROM c WHERE c.source = 'canonical' AND EXISTS(SELECT VALUE 1 FROM m IN c.vendorMappings WHERE m.source = @s AND m.vendorCardId = @c)",
        parameters: [{ name: "@s", value: source }, { name: "@c", value: cardId }],
      }).fetchAll();
      if (byCanonicalMapping.length > 0) { result.deduped++; continue; }
      // CF-SEARCH-INDEX-AT-INSERT (Drew, 2026-07-25). Compute searchText
      // + searchTokens at insert time so newly-persisted vendor rows are
      // immediately searchable via /card-search — no dependency on the
      // nightly backfill catching up. recentSaleCount stays nightly (it
      // needs a sold_comps lookup that would double insert cost).
      const { searchText, searchTokens } = buildSearchIndex({
        title: e.title ?? null,
        player: e.player ?? null,
        set: e.set ?? null,
        year: e.year ?? null,
        number: e.number ?? null,
        variant: e.variant ?? null,
      });
      const doc = {
        id: `${source}::${cardId}::${contentHash.slice(0, 8)}`,
        cardId,
        source,
        contentHash,
        title: e.title ?? null,
        player: e.player ?? null,
        set: e.set ?? null,
        year: e.year ?? null,
        number: e.number ?? null,
        variant: e.variant ?? null,
        imageUrl: e.imageUrl ?? null,
        searchText,
        searchTokens,
        observedAt: new Date().toISOString(),
      };
      await container.items.upsert(doc);
      result.inserted++;
    } catch {
      result.skipped++;
    }
  }
  logPersistEvent("catalog", source, result);
  return result;
}

export function persistVendorCatalogInBackground(
  source: "cardsight" | "cardhedge",
  entries: VendorCatalogEntry[],
): void {
  runInBackground(() => persistVendorCatalog(source, entries).then(() => {}));
}
