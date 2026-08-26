// CF-CARD-CATALOG (Drew, 2026-07-28).
//
// The authoritative identity source. Every real card in existence
// gets ONE canonical entry in `card_catalog` keyed by the hobbyiqCardId
// slug. Comps reference a catalog entry; comps that don't get flagged
// as "catalog-missing" so the pool can never fork on unknown identities.
//
// Why:
//   - Slug fragmentation ("True Blue" vs "Blue Refractor" vs "Blue")
//     goes away when the catalog is the source of truth — every ingest
//     resolves to the same catalog entry regardless of title spelling.
//   - Vendor cross-reference (CH cardId ⇄ CS UUID ⇄ eBay item ID) lives
//     on the catalog entry, not scattered across comp rows.
//   - Reference image + phash lives here for the image-verify step.
//   - "99.9% catalog-matched" is a metric Drew can call out — it's the
//     substrate for the whole trust story.
//
// Container: `card_catalog`, partition **/cardId**.
//
// CORRECTION (2026-08-12): this comment previously said "partition /sport
// (small cardinality)". It is not. Verified against the live container:
// partitionKey.paths = ["/cardId"]. The wrong value was trusted and copied
// into other services, where it justified treating catalog reads as cheap
// single-partition lookups — they are cross-partition fan-outs unless the
// query pins cardId. Check the container, not this file, before relying on it.
//
// Doc id = hobbyiqCardId slug. Same slug is same catalog entry —
// upserts are deterministic + no dup risk.

import { CosmosClient, type Container } from "@azure/cosmos";
import { computeHobbyIqCardId } from "./hobbyIqCardId.service.js";

export interface CardCatalogEntry {
  id: string;                        // hobbyiqCardId slug (also the doc id)
  // PARTITION KEY. card_catalog partitions on /cardId — the comment here used
  // to say `sport`, and rows written without cardId went to the undefined
  // partition where point reads cannot reach them. Always equals `id` for
  // canonical rows. See CF-CATALOG-CARDID-PARTITION-KEY below.
  cardId: string;
  hobbyiqCardId: string;             // same slug; what downstream readers expect
  sport: string;
  year: number;
  setKey: string;                    // normalized set slug
  cardNumber: string;
  parallel: string;                  // canonical human form ("Blue Refractor")
  parallelSlug: string;              // slug form ("blue-refractor")
  isAuto: boolean;
  printRun: number | null;
  playerName: string;
  playerSlug: string;                // for player search
  // Vendor cross-reference. Keys are source names; values are the
  // vendor's opaque card id for this catalog entry. Populate as we
  // encounter each vendor.
  vendorIds: Record<string, string>;
  // Reference image — populated once Slice 4 (image verify) lands.
  referenceImage?: {
    url: string;
    phash?: string;
    verifiedAt: string;
  };
  // Provenance
  source: "seed" | "ch-catalog" | "cs-catalog" | "user-verified" | "auto-inferred";
  confidence: number;                // 0-1
  observedAt: string;
  lastSeenAt: string;
  // Live counter for how many sold_comps rows point at this entry
  compCount?: number;
}

let _cached: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_cached) return _cached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    _cached = db.container(process.env.COSMOS_CARD_CATALOG_CONTAINER ?? "card_catalog");
    return _cached;
  } catch {
    return null;
  }
}

/**
 * Look up a catalog entry by slug. Null when the entry genuinely does not
 * exist, or Cosmos is unavailable.
 *
 * CF-GETCATALOGENTRY-WAS-A-NULL-GENERATOR (Drew, 2026-08-26). This read
 * partitioned on SPORT, parsed out of the slug. card_catalog has not
 * partitioned on /sport since CF-CATALOG-CARDID-PARTITION-KEY — it partitions
 * on /cardId, which the comment 130 lines below this one already said. So every
 * call raised a partition-key mismatch, the bare `catch` swallowed it, and the
 * function returned null for EVERY row in the container.
 *
 * It is called by persistVendorSalesToPool — the live sales firehose. That path
 * has been asking "does the catalog have this card?", being told no about
 * everything, and proceeding as though nothing exists. A lookup that always
 * fails is worse than one that throws, because nothing downstream can tell the
 * difference between "no such card" and "I did not really look".
 *
 * Two reads, deliberately in this order:
 *   1. point read on (slug, slug) — ~1 RU, and correct for every row written
 *      through deriveCatalogEntry, which sets cardId = id.
 *   2. on a miss, ONE query by id. 16.4M rows still sit under a foreign
 *      partition key (a vendor id inherited from the grade explode) and cannot
 *      be point-read at all until the re-home reaches them. Without this
 *      fallback the fix would only work for rows that were never broken.
 *
 * The fallback is the expensive half and it disappears on its own: as rows are
 * re-homed, step 1 starts hitting and step 2 stops running.
 */
export async function getCatalogEntry(slug: string): Promise<CardCatalogEntry | null> {
  if (!slug || !slug.startsWith("hiq:")) return null;
  const c = await getContainer();
  if (!c) return null;

  try {
    const { resource } = await c.item(slug, slug).read<CardCatalogEntry>();
    if (resource) return resource;
  } catch (err) {
    // 404 is "not at its own address", which is a real possibility here and
    // means fall through. Anything else is a fault worth surfacing rather than
    // silently reporting the card as missing.
    const code = (err as { code?: number })?.code;
    if (code !== undefined && code !== 404) {
      console.warn(JSON.stringify({
        event: "catalog.point_read_failed", source: "cardCatalog.service", slug, code,
      }));
      return null;
    }
  }

  try {
    const { resources } = await c.items.query<CardCatalogEntry>({
      query: "SELECT TOP 1 * FROM c WHERE c.id = @id",
      parameters: [{ name: "@id", value: slug }],
    }).fetchAll();
    return resources[0] ?? null;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "catalog.fallback_query_failed", source: "cardCatalog.service", slug,
      message: (err as Error)?.message,
    }));
    return null;
  }
}

/**
 * Upsert a catalog entry. Idempotent: same slug → same doc id, so
 * repeated calls with identical facts are no-ops. When the incoming
 * entry has higher confidence than the existing, the higher wins.
 * Returns the resulting entry (either the incoming or the pre-existing).
 */
export async function upsertCatalogEntry(entry: Omit<CardCatalogEntry, "observedAt" | "lastSeenAt">): Promise<CardCatalogEntry | null> {
  const c = await getContainer();
  if (!c) return null;
  const now = new Date().toISOString();
  const existing = await getCatalogEntry(entry.id);
  // Merge vendor IDs so we never lose a cross-reference. Keep the
  // higher-confidence source's canonical parallel + printRun.
  const winnerIsIncoming = !existing || entry.confidence > existing.confidence;
  const merged: CardCatalogEntry = winnerIsIncoming
    ? {
        ...entry,
        vendorIds: { ...(existing?.vendorIds ?? {}), ...entry.vendorIds },
        observedAt: existing?.observedAt ?? now,
        lastSeenAt: now,
      }
    : {
        ...existing!,
        vendorIds: { ...existing!.vendorIds, ...entry.vendorIds },
        lastSeenAt: now,
      };
  try {
    await c.items.upsert(merged as unknown as Record<string, unknown>);
    return merged;
  } catch (err) {
    console.warn(JSON.stringify({
      event: "card_catalog_upsert_failed",
      source: "cardCatalog.service",
      slug: entry.id,
      error: (err as Error)?.message ?? String(err),
    }));
    return null;
  }
}

/**
 * Derive a canonical catalog entry from raw fields. Used by the seed
 * script + the persist-time hook. Returns null when identity is
 * insufficient (missing year / setKey / cardNumber / playerName).
 */
export function deriveCatalogEntry(input: {
  sport: string;
  year: number | null | undefined;
  setKey: string | null | undefined;
  cardNumber: string | null | undefined;
  parallel: string | null | undefined;
  isAuto: boolean;
  printRun: number | null | undefined;
  playerName: string;
  source: CardCatalogEntry["source"];
  confidence: number;
  vendorIds?: Record<string, string>;
  /** Set when the caller knows the product for certain — a published
   *  checklist. Suppresses the cardNumber-prefix repair meant for untrusted
   *  vendor text, which would otherwise collapse 2026 Bowman CPA-AG
   *  (Adrian Gil) onto 2026 Bowman Chrome CPA-AG (Angeibel Gomez).
   *  See CF-AUTHORITATIVE-SETKEY. */
  authoritativeSetKey?: boolean;
}): Omit<CardCatalogEntry, "observedAt" | "lastSeenAt"> | null {
  const year = typeof input.year === "number" && Number.isFinite(input.year) ? input.year : null;
  const setKey = String(input.setKey ?? "").trim();
  const cardNumber = String(input.cardNumber ?? "").trim();
  const playerName = String(input.playerName ?? "").trim();
  if (!year || !setKey || !cardNumber || !playerName) return null;

  const slug = computeHobbyIqCardId({
    sport: input.sport,
    year,
    setKey,
    cardNumber,
    parallel: input.parallel ?? "Base",
    isAuto: input.isAuto,
    printRun: input.printRun ?? null,
    authoritativeSetKey: input.authoritativeSetKey === true,
  });
  if (!slug || !slug.startsWith("hiq:")) return null;

  // Slug layout: hiq:sport:year:setKey:cardNumber:parallelSlug:autoFlag[:printRunPart]
  //              0   1     2    3      4          5             6         7
  const parsedSlug = slug.split(":");
  const parallelSlug = parsedSlug[5] ?? "base";

  // CF-YEAR-CARDYEAR-DUAL-WRITE (Drew, 2026-08-11). Schema drift: some
  // legacy code paths wrote catalog rows with field name `cardYear`
  // (6.4M rows), others with `year` (9.26M rows). Explode + other
  // scripts filtering on `c.cardYear` skipped the `year`-only rows —
  // e.g., 2023 Topps Chrome Titans CT-10 Adley Rutschman never got its
  // refractor rainbow, so a user pick of Green Refractor /99 returned
  // no comps. Write BOTH going forward so every downstream filter
  // works regardless of which name it checks.
  // CF-CATALOG-CARDID-PARTITION-KEY (Drew, 2026-08-12). card_catalog
  // partitions on /cardId — NOT /sport, whatever the interface comment used to
  // claim. Entries built here carried no cardId at all, so every row this path
  // wrote landed in the UNDEFINED partition. Cosmos allows the same `id` in a
  // different partition, so a checklist ingest silently created a SECOND doc
  // beside the canonical one instead of updating it:
  //
  //   id=hiq:baseball:2026:bowman-chrome:1:base:no-auto cardId=undefined Konnor Griffin
  //   id=hiq:baseball:2026:bowman-chrome:1:base:no-auto cardId=<set>     Aaron Judge
  //
  // Both "wrote" successfully. Neither point read could see the new one, and
  // catalogVerify — which reads by partition — never found it. Setting cardId
  // puts canonical rows back in their own single-document partition, which is
  // what makes the ~1 RU point read work.
  return {
    id: slug,
    cardId: slug,
    hobbyiqCardId: slug,
    sport: input.sport,
    year,
    cardYear: year,
    setKey,
    cardNumber: cardNumber.toUpperCase(),
    parallel: String(input.parallel ?? "Base"),
    parallelSlug,
    isAuto: input.isAuto,
    printRun: input.printRun ?? null,
    playerName,
    playerSlug: playerSlugify(playerName),
    vendorIds: input.vendorIds ?? {},
    source: input.source,
    confidence: input.confidence,
  } as Omit<CardCatalogEntry, "observedAt" | "lastSeenAt"> & { cardYear: number };
}

function playerSlugify(name: string): string {
  return String(name).trim().toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Cheap count for the data-quality report. Cross-partition — the
 * result includes every catalog entry across every sport. Cached at
 * the caller.
 */
export async function countCatalogEntries(): Promise<number> {
  const c = await getContainer();
  if (!c) return 0;
  try {
    const { resources } = await c.items.query<number>("SELECT VALUE COUNT(1) FROM c").fetchAll();
    return resources[0] ?? 0;
  } catch {
    return 0;
  }
}
