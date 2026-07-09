// CF-SEARCH-ALIAS-STORE (2026-07-08, Drew):
// Cosmos-backed store for search alias mappings. Replaces the static
// PARALLEL_SYNONYMS / SET_NAME_SYNONYMS / GRADE_COMPANY_SYNONYMS maps
// as the runtime source of truth so aliases can be added, corrected,
// and LLM-generated without a code deploy.
//
// Container: search_aliases, partition key /category.
// Doc shape: SearchAliasDocument (below).
//
// The static maps in normalizationDictionary.service.ts remain as the
// SEED corpus and as a fallback when Cosmos is unavailable — see
// aliasStore.service.ts for the fallback plumbing.

import { CosmosClient, Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

/** Alias category. Drives partitioning + surfaces separate admin
 *  namespaces so a bad "player" alias can't corrupt "parallel" lookups. */
export type SearchAliasCategory =
  | "parallel"
  | "set"
  | "player"
  | "grader"
  | "general";

/** Provenance of the alias — helps ops trace where entries came from
 *  and lets the learning loop safely auto-promote without stomping on
 *  admin/manual edits. */
export type SearchAliasSource = "static" | "llm" | "admin" | "learned";

export interface SearchAliasEntry {
  category: SearchAliasCategory;
  canonical: string;
  aliases: string[];
  source: SearchAliasSource;
  /** 0.0 to 1.0. 1.0 = admin-confirmed / static seed; 0.7 = LLM
   *  suggestion; 0.85 = learned from user selections. */
  confidence: number;
  lastConfirmedAt: string;   // ISO
  sampleCardId?: string;
  notes?: string;
  /** Soft-delete marker. Aliases retain history so the learning loop
   *  can re-promote if the vocab re-emerges. */
  deletedAt?: string;
}

interface SearchAliasDocument extends SearchAliasEntry {
  id: string;         // hash of (category, canonical) — deterministic upsert
  docType: "search_alias";
}

let _container: Container | null = null;
let _initPromise: Promise<Container | null> | null = null;

async function getContainer(): Promise<Container | null> {
  if (_container) return _container;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const connStr = process.env.COSMOS_CONNECTION_STRING;
      const dbName = process.env.COSMOS_DATABASE ?? "hobbyiq";
      const containerName = process.env.COSMOS_SEARCH_ALIASES_CONTAINER ?? "search_aliases";

      if (!endpoint && !connStr) {
        console.warn("[searchAliases.repository] COSMOS not configured — repository disabled");
        return null;
      }

      let client: CosmosClient;
      if (connStr) {
        client = new CosmosClient(connStr);
      } else if (key) {
        client = new CosmosClient({ endpoint: endpoint!, key });
      } else {
        client = new CosmosClient({ endpoint: endpoint!, aadCredentials: new DefaultAzureCredential() });
      }

      const { database } = await client.databases.createIfNotExists({ id: dbName });
      const { container } = await database.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ["/category"] },
      });
      _container = container;
      console.log(`[searchAliases.repository] Cosmos container ready: ${dbName}/${containerName}`);
      return container;
    } catch (err: any) {
      console.error("[searchAliases.repository] init failed:", err?.message ?? err);
      return null;
    }
  })();
  return _initPromise;
}

/**
 * Deterministic id generator so upserts collide correctly on
 * (category, canonical). Uses a simple normalization + slug so
 * the ids are also human-inspectable in Cosmos Data Explorer.
 */
export function aliasDocId(category: SearchAliasCategory, canonical: string): string {
  const slug = canonical
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${category}:${slug}`;
}

/** Fetch every non-deleted alias entry. Used by the in-memory
 *  aliasStore service on boot + on scheduled refresh. */
export async function listAllActiveAliases(): Promise<SearchAliasEntry[]> {
  const container = await getContainer();
  if (!container) return [];
  try {
    const query = "SELECT * FROM c WHERE NOT IS_DEFINED(c.deletedAt) OR c.deletedAt = null";
    const { resources } = await container.items
      .query<SearchAliasDocument>(query)
      .fetchAll();
    return resources.map(stripDocMeta);
  } catch (err: any) {
    console.error("[searchAliases.repository] listAllActiveAliases failed:", err?.message ?? err);
    return [];
  }
}

/** Fetch a single alias entry by (category, canonical). */
export async function getAlias(
  category: SearchAliasCategory,
  canonical: string,
): Promise<SearchAliasEntry | null> {
  const container = await getContainer();
  if (!container) return null;
  try {
    const { resource } = await container
      .item(aliasDocId(category, canonical), category)
      .read<SearchAliasDocument>();
    if (!resource) return null;
    if (resource.deletedAt) return null;
    return stripDocMeta(resource);
  } catch (err: any) {
    if (err?.code === 404) return null;
    console.error("[searchAliases.repository] getAlias failed:", err?.message ?? err);
    return null;
  }
}

/**
 * Idempotent upsert. When an entry already exists at (category, canonical):
 *  - static/admin sources always win over llm/learned (never overwrite
 *    a hand-curated entry with a generated one)
 *  - aliases arrays are MERGED (deduped, case-insensitive on the merge key)
 *  - source/confidence take the incoming value only when it's at least
 *    as trustworthy as what's there
 */
export async function upsertAlias(entry: SearchAliasEntry): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  const id = aliasDocId(entry.category, entry.canonical);
  let existing: SearchAliasDocument | null = null;
  try {
    const { resource } = await container.item(id, entry.category).read<SearchAliasDocument>();
    existing = resource ?? null;
  } catch (err: any) {
    if (err?.code !== 404) throw err;
  }

  const merged = mergeAliasEntries(existing, entry);
  const doc: SearchAliasDocument = {
    id,
    docType: "search_alias",
    ...merged,
  };
  await container.items.upsert(doc, { disableAutomaticIdGeneration: true });
}

/** Soft-delete — retain history for the learning-loop re-promote path. */
export async function softDeleteAlias(
  category: SearchAliasCategory,
  canonical: string,
): Promise<void> {
  const container = await getContainer();
  if (!container) return;
  const id = aliasDocId(category, canonical);
  try {
    const { resource } = await container.item(id, category).read<SearchAliasDocument>();
    if (!resource) return;
    resource.deletedAt = new Date().toISOString();
    await container.items.upsert(resource, { disableAutomaticIdGeneration: true });
  } catch (err: any) {
    if (err?.code === 404) return;
    console.error("[searchAliases.repository] softDeleteAlias failed:", err?.message ?? err);
  }
}

// ─── merge helpers ─────────────────────────────────────────────────

const SOURCE_TRUST: Record<SearchAliasSource, number> = {
  static: 4,     // seeded from hand-curated code — highest trust
  admin: 4,     // manual add/correct
  learned: 3,   // user-selection signal
  llm: 2,       // LLM-generated candidate
};

function mergeAliasEntries(
  existing: SearchAliasDocument | null,
  incoming: SearchAliasEntry,
): SearchAliasEntry {
  if (!existing) return { ...incoming };
  const incomingTrust = SOURCE_TRUST[incoming.source] ?? 0;
  const existingTrust = SOURCE_TRUST[existing.source] ?? 0;

  // Union of aliases, case-insensitive on the merge key. Preserve the
  // ORIGINAL case-preserved spelling from whichever source contributed
  // it first — that's the display-friendly form.
  const seen = new Map<string, string>();
  for (const a of existing.aliases ?? []) seen.set(a.toLowerCase().trim(), a.trim());
  for (const a of incoming.aliases ?? []) {
    const key = a.toLowerCase().trim();
    if (!seen.has(key)) seen.set(key, a.trim());
  }
  const aliases = Array.from(seen.values()).filter(Boolean);

  // Source/confidence: take incoming when it's at least as trusted;
  // otherwise preserve existing (guard against LLM stomping on admin).
  const useIncoming = incomingTrust >= existingTrust;
  const source = useIncoming ? incoming.source : existing.source;
  const confidence = useIncoming
    ? Math.max(existing.confidence, incoming.confidence)
    : existing.confidence;

  return {
    category: existing.category,
    canonical: existing.canonical,
    aliases,
    source,
    confidence,
    lastConfirmedAt: new Date().toISOString(),
    sampleCardId: incoming.sampleCardId ?? existing.sampleCardId,
    notes: incoming.notes ?? existing.notes,
    // Un-delete on any incoming upsert — the vocab re-emerged.
    deletedAt: undefined,
  };
}

function stripDocMeta(doc: SearchAliasDocument): SearchAliasEntry {
  const { id: _id, docType: _docType, ...entry } = doc;
  return entry;
}

/** Test hook — reset the container singleton so tests can mock. */
export function _resetSearchAliasesRepositoryForTesting(): void {
  _container = null;
  _initPromise = null;
}
