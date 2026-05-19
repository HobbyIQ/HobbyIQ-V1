// ---------------------------------------------------------------------------
// peerPoolBuilder.ts — Issue #25 Phase 3
//
// Builds the same-player peer pool consumed by computeTierAnchoredRange().
// Operates over an EXISTING comp list (whatever Phase 2's pipeline already
// fetched from Card Hedge), parses each comp title to extract its parallel,
// and joins against the curated parallel_attributes tier lookup.
//
// Pool-composition rule (locked by owner 2026-05-16):
//   PRIMARY  — same player, same set, different parallel name than subject.
//   FALLBACK — same player, related sets (year + brand + sport heuristic),
//              merged into PRIMARY when PRIMARY < MIN_PEERS.
//   Returns { peerPool: [], nullReason } when combined pool still < MIN_PEERS.
//
// This module is pure relative to its `tierLookup` dependency: pass a
// Cosmos-backed lookup in production, an in-memory stub in tests.
// ---------------------------------------------------------------------------

import { parseCardQuery, type ParsedCardQuery } from "./cardQueryParser.js";
import {
  normalizeParallelKey,
  type ParallelAttributesLookup,
  type SetTierMap,
} from "./parallelAttributesLookup.js";
import type { TierAnchoredPeerComp } from "./predictedRangeTierAnchored.js";

// ─── Public types ───────────────────────────────────────────────────────────

export interface PeerPoolComp {
  /** Sale price in USD; required, must be > 0. */
  price: number;
  /** Sale title, used to extract parallel via `parseCardQuery`. */
  title: string;
  /** Optional Card Hedge / eBay sold date — currently unused for tiering. */
  soldDate?: string | null;
  /**
   * Optional explicit set name for this comp. When provided, it is used
   * verbatim for tier lookup. When omitted, the subject's set is assumed
   * (i.e., comps already fetched under the subject's identity).
   */
  set?: string | null;
}

export interface PeerPoolBuilderInput {
  subjectPlayer: string;
  subjectSet: string;
  subjectParallelName: string | null;
  subjectIsAutograph: boolean;
  /** Comps to consider — typically the Card Hedge `fetched.comps` array. */
  comps: ReadonlyArray<PeerPoolComp>;
  lookup: ParallelAttributesLookup;
  /** Optional override of the MIN_PEERS gate, defaults to 3. */
  minPeers?: number;
}

export type PeerPoolNullReason =
  | "subject_set_missing"
  | "subject_tier_uncurated"
  | "peer_pool_too_small";

export interface PeerPoolDropReasonCounts {
  unparseable: number;
  same_parallel_as_subject: number;
  uncurated_peer_parallel: number;
  invalid_price: number;
  missing_set: number;
}

export interface PeerPoolBuilderResult {
  subjectTier: number | null;
  peerPool: TierAnchoredPeerComp[];
  diagnostics: {
    primarySetCount: number;
    fallbackSetsUsed: string[];
    fallbackPeerCount: number;
    totalCompsConsidered: number;
    dropCounts: PeerPoolDropReasonCounts;
    nullReason: PeerPoolNullReason | null;
  };
}

// ─── Internals ──────────────────────────────────────────────────────────────

const DEFAULT_MIN_PEERS = 3;

function emptyDropCounts(): PeerPoolDropReasonCounts {
  return {
    unparseable: 0,
    same_parallel_as_subject: 0,
    uncurated_peer_parallel: 0,
    invalid_price: 0,
    missing_set: 0,
  };
}

/**
 * Resolve a parsed-comp parallel token (e.g., "Blue", "Gold", "Refractor",
 * or null for base) to a curated tier in `setMap`. The Bowman/Topps Chrome
 * family stores entries like "Blue Refractor" — when the parser returned a
 * bare color word, we try a small set of canonical suffix variants.
 *
 * Returns null when the parallel cannot be matched against the curated map.
 */
export function resolvePeerTier(
  parsedParallel: string | null,
  parsedIsAuto: boolean,
  setMap: SetTierMap,
): number | null {
  // Try keys in priority order. Each candidate goes through the same
  // normalizer so case/whitespace/auto-suffix logic stays consistent.
  const candidates: string[] = [];
  const p = (parsedParallel ?? "").trim();
  if (!p) {
    // Base card. Curators store it as "Base" or sometimes a CMYK-style label.
    candidates.push("Base");
  } else {
    candidates.push(p);
    // Bowman/Topps Chrome convention: parser often returns the color word
    // alone; curated table is "<Color> Refractor".
    if (!/refractor/i.test(p)) candidates.push(`${p} Refractor`);
  }
  for (const c of candidates) {
    const key = normalizeParallelKey(c, parsedIsAuto);
    const t = setMap.get(key);
    if (typeof t === "number") return t;
    // Also try non-auto variant if no auto-match exists (some sets share
    // tiers across parallels and curate only the non-auto record).
    if (parsedIsAuto) {
      const naKey = normalizeParallelKey(c, false);
      const naT = setMap.get(naKey);
      if (typeof naT === "number") return naT;
    }
  }
  return null;
}

/**
 * Returns true when `parsed.parallel` matches the subject's parallel name
 * (case/whitespace/auto-aware). Used to exclude subject's own comps from
 * the peer pool — Phase 3 requires DIFFERENT-parallel peers.
 */
function isSameParallelAsSubject(
  parsed: ParsedCardQuery,
  subjectParallelName: string | null,
  subjectIsAuto: boolean,
): boolean {
  const subjKey = normalizeParallelKey(subjectParallelName ?? "Base", subjectIsAuto);
  const peerKey = normalizeParallelKey(parsed.parallel ?? "Base", parsed.isAuto);
  return subjKey === peerKey;
}

/**
 * Walk `comps`, attempting to convert each into a {price, tier} peer for the
 * tier-anchored math. Filters out: same-parallel-as-subject, unparseable,
 * invalid price, and uncurated-parallel comps. Returns a stats object
 * alongside the resulting peer array.
 */
async function buildPeersForSet(
  set: string,
  comps: ReadonlyArray<PeerPoolComp>,
  subjectParallelName: string | null,
  subjectIsAuto: boolean,
  lookup: ParallelAttributesLookup,
  drop: PeerPoolDropReasonCounts,
): Promise<TierAnchoredPeerComp[]> {
  if (comps.length === 0) return [];
  // Pre-load the full set map by issuing one probing call. The Cosmos
  // implementation internally caches the whole set on the first hit. The
  // signature is awkward (single-parallel query) so we use a dummy parallel
  // to warm the cache; subsequent calls in the same lookup loop are cheap.
  await lookup.getTier(set, "Base", false);

  const peers: TierAnchoredPeerComp[] = [];
  for (const comp of comps) {
    if (!comp || typeof comp.price !== "number" || !Number.isFinite(comp.price) || comp.price <= 0) {
      drop.invalid_price += 1;
      continue;
    }
    if (!comp.title || typeof comp.title !== "string") {
      drop.unparseable += 1;
      continue;
    }
    const parsed = parseCardQuery(comp.title);
    if (isSameParallelAsSubject(parsed, subjectParallelName, subjectIsAuto)) {
      drop.same_parallel_as_subject += 1;
      continue;
    }
    const peerSet = (comp.set && comp.set.trim()) || set;
    if (!peerSet) {
      drop.missing_set += 1;
      continue;
    }
    const tierResult = await lookup.getTier(peerSet, parsed.parallel ?? "Base", parsed.isAuto);
    if (tierResult.tier === null) {
      drop.uncurated_peer_parallel += 1;
      continue;
    }
    peers.push({ price: comp.price, tier: tierResult.tier });
  }
  return peers;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the Phase-3 peer pool. Strict locked rules:
 *   1. Primary pool = comps whose `set === subjectSet` AND parallel differs.
 *   2. If primary < minPeers, augment with comps from related sets (same
 *      year/brand/sport heuristic via `lookup.inferRelatedSets()`).
 *   3. If combined < minPeers, return null pool with `peer_pool_too_small`.
 *
 * Also resolves the subject's own tier from the curated table so the
 * downstream engine can reject "subject_tier_uncurated" cleanly.
 *
 * Side-effect-free apart from Cosmos reads via the injected lookup.
 */
export async function buildPeerPool(
  input: PeerPoolBuilderInput,
): Promise<PeerPoolBuilderResult> {
  const minPeers = input.minPeers ?? DEFAULT_MIN_PEERS;
  const drop = emptyDropCounts();
  const diagnostics = {
    primarySetCount: 0,
    fallbackSetsUsed: [] as string[],
    fallbackPeerCount: 0,
    totalCompsConsidered: input.comps.length,
    dropCounts: drop,
    nullReason: null as PeerPoolNullReason | null,
  };

  const subjectSet = (input.subjectSet ?? "").trim();
  if (!subjectSet) {
    diagnostics.nullReason = "subject_set_missing";
    return { subjectTier: null, peerPool: [], diagnostics };
  }

  // Resolve subject's own tier first. If the subject parallel is uncurated,
  // the engine will short-circuit on subject_tier_unknown_multiplier anyway,
  // but emitting a clearer reason here helps debugging.
  const subjectTierResult = await input.lookup.getTier(
    subjectSet,
    input.subjectParallelName ?? "Base",
    input.subjectIsAutograph,
  );
  const subjectTier = subjectTierResult.tier;

  // PRIMARY: same-set comps (or comps without explicit set, which the
  // pipeline implicitly treats as belonging to the subject's set).
  const primaryComps = input.comps.filter((c) => {
    const cset = (c.set && c.set.trim()) || subjectSet;
    return cset.toLowerCase() === subjectSet.toLowerCase();
  });
  const primaryPool = await buildPeersForSet(
    subjectSet,
    primaryComps,
    input.subjectParallelName,
    input.subjectIsAutograph,
    input.lookup,
    drop,
  );
  diagnostics.primarySetCount = primaryPool.length;

  let combined: TierAnchoredPeerComp[] = primaryPool;

  // FALLBACK: same-player related sets, only when primary is insufficient.
  if (combined.length < minPeers) {
    const relatedSets = input.lookup.inferRelatedSets(subjectSet);
    for (const relSet of relatedSets) {
      const relComps = input.comps.filter((c) => {
        const cset = (c.set && c.set.trim()) || "";
        return cset.toLowerCase() === relSet.toLowerCase();
      });
      if (relComps.length === 0) continue;
      const relPool = await buildPeersForSet(
        relSet,
        relComps,
        input.subjectParallelName,
        input.subjectIsAutograph,
        input.lookup,
        drop,
      );
      if (relPool.length > 0) {
        diagnostics.fallbackSetsUsed.push(relSet);
        diagnostics.fallbackPeerCount += relPool.length;
        combined = combined.concat(relPool);
      }
      if (combined.length >= minPeers) break;
    }
  }

  if (combined.length < minPeers) {
    diagnostics.nullReason = "peer_pool_too_small";
    return { subjectTier, peerPool: combined, diagnostics };
  }

  // Surface subject_tier_uncurated as a diagnostic (engine will still
  // short-circuit cleanly) — but only when we WOULD have had enough peers.
  if (subjectTier === null) {
    diagnostics.nullReason = "subject_tier_uncurated";
  }

  return { subjectTier, peerPool: combined, diagnostics };
}
