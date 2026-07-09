// CF-SEARCH-ALIAS-STORE-SERVICE (2026-07-08, Drew):
// In-memory alias index backed by the Cosmos search_aliases container.
// Loads all aliases at server boot into a Map<alias_lower, canonical>
// for O(1) query-time lookups. Refreshes every 6h. When Cosmos is
// unavailable, falls back to the static PARALLEL_SYNONYMS /
// SET_NAME_SYNONYMS / GRADE_COMPANY_SYNONYMS constants so search
// still works with the code-embedded seed corpus.
//
// This is the ONE service other code should call for alias lookups.
// `normalizeParallel`/`normalizeSetName`/`normalizeGradeCompany` in
// normalizationDictionary.service.ts remain as caller-facing helpers
// but their implementation now delegates to this store.

import {
  listAllActiveAliases,
  type SearchAliasCategory,
  type SearchAliasEntry,
} from "../../repositories/searchAliases.repository.js";
import { getNormalizationDictionary } from "../compiq/normalizationDictionary.service.js";

interface AliasEntry {
  canonical: string;
  category: SearchAliasCategory;
  confidence: number;
}

interface AliasIndex {
  /** Lowercased alias → entry. Fast lookup at query time. */
  byAlias: Map<string, AliasEntry>;
  /** Canonical → aliases[] (for admin surfaces + expansion). */
  byCanonical: Map<string, { category: SearchAliasCategory; aliases: string[] }>;
  /** Timestamp of the last successful load — surfaced in health checks. */
  loadedAt: Date;
  /** How the index was populated so ops can tell "loaded from Cosmos"
   *  vs "fell back to static seed". */
  source: "cosmos" | "static-fallback";
}

let _index: AliasIndex | null = null;
let _initPromise: Promise<AliasIndex> | null = null;
let _refreshTimer: NodeJS.Timeout | null = null;

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Get the (memoized) alias index. Boots once on first call. Callers
 * that need certainty the index is loaded (e.g. warm-up scripts) can
 * await this at startup; hot-path callers can safely await it repeatedly
 * because the Promise is memoized.
 */
export async function getAliasIndex(): Promise<AliasIndex> {
  if (_index) return _index;
  if (_initPromise) return _initPromise;
  _initPromise = loadAliasIndex();
  const idx = await _initPromise;
  _index = idx;
  scheduleRefresh();
  return idx;
}

/**
 * Look up an alias. Returns the canonical + metadata when the alias
 * is known, undefined otherwise. Case-insensitive.
 */
export async function lookupAlias(
  alias: string,
  category?: SearchAliasCategory,
): Promise<AliasEntry | undefined> {
  if (!alias) return undefined;
  const idx = await getAliasIndex();
  const entry = idx.byAlias.get(alias.trim().toLowerCase());
  if (!entry) return undefined;
  if (category && entry.category !== category) return undefined;
  return entry;
}

/**
 * Get all aliases (in stored order) for a given canonical name.
 * Returns empty array when the canonical isn't in the index.
 */
export async function getAliasesForCanonical(
  category: SearchAliasCategory,
  canonical: string,
): Promise<string[]> {
  const idx = await getAliasIndex();
  const entry = idx.byCanonical.get(`${category}:${canonical.trim().toLowerCase()}`);
  return entry?.aliases ?? [];
}

/**
 * Force an index reload. Callers: admin `POST /admin/aliases/reload`,
 * scheduled refresh, and test hooks. Never throws — degrades to the
 * previous index if the reload fails.
 */
export async function reloadAliasIndex(): Promise<AliasIndex> {
  const idx = await loadAliasIndex();
  _index = idx;
  return idx;
}

async function loadAliasIndex(): Promise<AliasIndex> {
  const byAlias = new Map<string, AliasEntry>();
  const byCanonical = new Map<string, { category: SearchAliasCategory; aliases: string[] }>();

  let entries: SearchAliasEntry[] = [];
  let source: AliasIndex["source"] = "cosmos";
  try {
    entries = await listAllActiveAliases();
  } catch (err: any) {
    console.warn("[aliasStore] Cosmos load failed:", err?.message ?? err);
    entries = [];
  }

  // If Cosmos returned nothing, seed from the static in-code maps so
  // search doesn't fall dead on a cold Cosmos or misconfig.
  if (entries.length === 0) {
    source = "static-fallback";
    entries = staticSeedAliases();
    console.log(`[aliasStore] using static seed (${entries.length} entries) — Cosmos empty or unavailable`);
  }

  for (const e of entries) {
    // canonical → aliases index
    const canonKey = `${e.category}:${e.canonical.trim().toLowerCase()}`;
    byCanonical.set(canonKey, {
      category: e.category,
      aliases: [...e.aliases],
    });
    // alias → canonical index; also make the canonical itself a self-lookup
    for (const alias of [e.canonical, ...e.aliases]) {
      const key = alias.trim().toLowerCase();
      if (!key) continue;
      // Higher-confidence entry wins on collision (e.g. "silver" appears
      // in both Panini Prizm and Bowman contexts — trust higher-conf).
      const existing = byAlias.get(key);
      if (!existing || e.confidence > existing.confidence) {
        byAlias.set(key, {
          canonical: e.canonical,
          category: e.category,
          confidence: e.confidence,
        });
      }
    }
  }

  const idx: AliasIndex = {
    byAlias,
    byCanonical,
    loadedAt: new Date(),
    source,
  };
  console.log(`[aliasStore] loaded ${byAlias.size} alias keys / ${byCanonical.size} canonicals from ${source}`);
  return idx;
}

/**
 * Seed corpus from the in-code static maps. Used when Cosmos is
 * unavailable, and by the migration script for initial Cosmos seed.
 * Exported so the seed migration can call it without touching the
 * hot-path.
 */
export function staticSeedAliases(): SearchAliasEntry[] {
  const dict = getNormalizationDictionary() as {
    parallel: Record<string, string[]>;
    gradeCompanies: Record<string, string[]>;
    setNames?: Record<string, string[]>;
  };
  const now = new Date().toISOString();
  const seed: SearchAliasEntry[] = [];

  const emit = (
    category: SearchAliasCategory,
    dictionary: Record<string, string[]>,
  ) => {
    for (const [canonical, aliases] of Object.entries(dictionary)) {
      seed.push({
        category,
        canonical,
        aliases: aliases.filter((a) => a.trim() !== canonical.trim()),
        source: "static",
        confidence: 1.0,
        lastConfirmedAt: now,
        notes: "Seeded from normalizationDictionary.service.ts static map",
      });
    }
  };

  emit("parallel", dict.parallel);
  emit("grader", dict.gradeCompanies);
  if (dict.setNames) emit("set", dict.setNames);

  return seed;
}

function scheduleRefresh(): void {
  if (_refreshTimer) return;
  _refreshTimer = setInterval(() => {
    reloadAliasIndex().catch((err) => {
      console.warn("[aliasStore] scheduled refresh failed:", err?.message ?? err);
    });
  }, REFRESH_INTERVAL_MS);
  // Never keep the event loop alive just for this timer.
  _refreshTimer.unref?.();
}

/** Test hook — reset internal state between test runs. */
export function _resetAliasStoreForTesting(): void {
  _index = null;
  _initPromise = null;
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}
