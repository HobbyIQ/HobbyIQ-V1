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
// CF-PARALLEL-AS-PLAYER-BLOCK (Drew, 2026-08-02). Vendor rows sometimes
// arrive with the parallel word stored as `player` (Superfractor,
// Sunflower Seeds, Pop Corn, Peanuts, Gum Ball, Sparkle, Red Lava,
// etc.). We can't safely accept those as player identity because they
// pollute search, FMV, and labeler surfaces. Block at ingest — the
// row still gets written, but with player=null so downstream code can
// treat it as an unknown-player row instead of a fake "player named
// Sparkle" card. The retroactive fix-catalog-parallel-as-player.cjs
// backfill re-assigns from sibling variants when possible.
const PARALLEL_WORDS_BLOCKLIST = new Set([
  "superfractor", "refractor", "sapphire", "mini diamond", "x-fractor", "xfractor",
  "speckle", "wave", "ray wave", "shimmer", "lava", "grass",
  "mojo refractor", "mojo", "lazer refractor", "lazer",
  "sunflower seeds", "pop corn", "popcorn", "peanuts", "gum ball", "gumball", "sparkle",
  "red lava", "blue lava", "green lava", "gold lava", "orange lava", "purple lava",
  "red shimmer", "blue shimmer", "green shimmer", "gold shimmer", "orange shimmer",
  "red wave", "blue wave", "green wave", "gold wave", "orange wave", "purple wave", "aqua wave",
  "red ray wave", "blue ray wave", "green ray wave", "gold ray wave", "orange ray wave",
  "red speckle", "blue speckle", "green speckle", "gold speckle", "orange speckle",
  "chrome", "autograph", "base", "rookie", "image variation", "sterling",
]);

function isParallelWord(name: string | null | undefined): boolean {
  if (!name || typeof name !== "string") return false;
  return PARALLEL_WORDS_BLOCKLIST.has(name.trim().toLowerCase());
}

export async function persistVendorCatalog(
  source: "cardsight" | "cardhedge",
  entries: VendorCatalogEntry[],
): Promise<VendorCatalogPersistResult> {
  const result: VendorCatalogPersistResult = { inserted: 0, deduped: 0, skipped: 0 };
  if (!Array.isArray(entries) || entries.length === 0) return result;
  // CF-VENDOR-NEVER-MINTS-A-CARD (Drew, 2026-08-28: "CH shouldn't derive rows
  // either. we do with checklists"). The catalog is minted by checklists; a
  // vendor search response is not an identity source. This path wrote 117
  // cardhedge:: rows on 2026-08-29 09:53Z from the post-deploy cache warm,
  // untouched by the sales gate (#1353). It now refuses regardless of the
  // PERSIST_VENDOR_CATALOG_ENABLED flag -- an env var is not a doctrine.
  // Every other vendor-persistence domain (sold comps, price series,
  // listings, query signals) is unaffected.
  result.skipped = entries.length;
  console.log(JSON.stringify({
    event: "vendor_catalog_persist_refused",
    source: "persistVendorCatalog",
    vendorSource: source,
    entries: entries.length,
    reason: "catalog rows are minted by checklists only",
  }));
  return result;
}

export function persistVendorCatalogInBackground(
  source: "cardsight" | "cardhedge",
  entries: VendorCatalogEntry[],
): void {
  runInBackground(() => persistVendorCatalog(source, entries).then(() => {}));
}
