// CF-AUTOCOMPLETE (Drew, 2026-07-25). Fast prefix-match endpoints for
// iOS typeahead. Backed by card_catalog. Returns just names (not full
// card records) so the response is tiny and fits keystroke UX.

import { CosmosClient, type Container } from "@azure/cosmos";

export interface AutocompleteHit {
  name: string;
  count: number;       // how many cards match this name in the catalog
  sport?: string;
}

export interface AutocompleteResult {
  q: string;
  hits: AutocompleteHit[];
  computedAt: string;
  cachedFromMemory: boolean;
}

let cachedCatalog: Container | null = null;
async function getCatalog(): Promise<Container | null> {
  if (cachedCatalog) return cachedCatalog;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    cachedCatalog = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq").container("card_catalog");
    return cachedCatalog;
  } catch { return null; }
}

// Per-process in-memory index: field name → { name → count }. Rebuilt
// every INDEX_TTL_MS (10 min). Fine at ~50k distinct names each.
interface FieldIndex { byNorm: Map<string, { name: string; count: number; sport?: string }> }
const indexes = new Map<string, { at: number; idx: FieldIndex }>();
const INDEX_TTL_MS = 10 * 60 * 1000;

async function buildIndex(field: "player" | "releaseName", sport?: string): Promise<FieldIndex> {
  const container = await getCatalog();
  if (!container) return { byNorm: new Map() };
  const params: Array<{ name: string; value: string }> = [];
  let where = `IS_DEFINED(c.${field}) AND c.${field} != null AND c.${field} != ''`;
  if (sport) { where += " AND c.sport = @sp"; params.push({ name: "@sp", value: sport }); }
  const q = `SELECT c.${field}, c.sport FROM c WHERE ${where}`;
  const byNorm = new Map<string, { name: string; count: number; sport?: string }>();
  try {
    const it = container.items.query({ query: q, parameters: params }, { maxItemCount: 5000 });
    while (it.hasMoreResults()) {
      const { resources } = await it.fetchNext();
      if (!Array.isArray(resources)) continue;
      for (const r of resources) {
        const raw = String(r[field] ?? "").trim();
        if (!raw) continue;
        const norm = raw.toLowerCase();
        const existing = byNorm.get(norm);
        if (existing) existing.count++;
        else byNorm.set(norm, { name: raw, count: 1, sport: r.sport });
      }
    }
  } catch { /* return partial */ }
  return { byNorm };
}

async function getIndex(field: "player" | "releaseName", sport?: string): Promise<FieldIndex> {
  const key = `${field}::${sport ?? "all"}`;
  const cached = indexes.get(key);
  if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.idx;
  const idx = await buildIndex(field, sport);
  indexes.set(key, { at: Date.now(), idx });
  return idx;
}

export async function autocomplete(field: "player" | "releaseName", opts: { q: string; sport?: string; limit?: number }): Promise<AutocompleteResult> {
  const q = String(opts.q ?? "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(20, opts.limit ?? 10));
  const now = new Date();
  if (q.length < 1) return { q: opts.q ?? "", hits: [], computedAt: now.toISOString(), cachedFromMemory: false };

  const idx = await getIndex(field, opts.sport);
  const wasCached = indexes.has(`${field}::${opts.sport ?? "all"}`);

  const prefixHits: Array<{ name: string; count: number; sport?: string }> = [];
  const containsHits: Array<{ name: string; count: number; sport?: string }> = [];
  for (const [norm, entry] of idx.byNorm.entries()) {
    if (norm.startsWith(q)) prefixHits.push(entry);
    else if (norm.includes(q)) containsHits.push(entry);
    if (prefixHits.length >= limit * 3) break;
  }
  const ranked = [...prefixHits, ...containsHits]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((e) => ({ name: e.name, count: e.count, sport: e.sport }));

  return { q: opts.q, hits: ranked, computedAt: now.toISOString(), cachedFromMemory: wasCached };
}
