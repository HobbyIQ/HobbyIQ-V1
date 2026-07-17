// CF-ATTRIBUTION-PHASE-1-DHASH (Drew, 2026-07-16). Per-card cluster
// assignment. Union-find on pairwise Hamming-distance-below-threshold.
//
// For N sales in a card, this is O(N²) which is fine at Phase 1 volumes
// (median card has < 50 sales in the 90-day window; even top cards
// like Trout '11 Update have < 500). If we hit cards with N > 2k, swap
// to an LSH-based approximation — a Phase 1.5 upgrade.

import { hammingHex } from "./phashCompute.service.js";

/** Default clustering threshold. 10 bits (~15% of 64) — will tune on
 *  real corpus during Phase 1 calibration. */
export const DEFAULT_HAMMING_THRESHOLD = 10;

export interface ClusterableRow {
  price_history_id: string;
  hash: string;
}

export interface ClusterAssignment {
  /** Same-order-as-input assignments; indices match rows[i]. */
  assignments: number[];
  /** Total clusters emitted (1..N). */
  clusterCount: number;
  /** cluster_id → count. */
  sizes: Map<number, number>;
}

/**
 * Union-find cluster over a list of hashes. Two hashes are in the same
 * cluster when their Hamming distance is <= threshold.
 *
 * cluster_id is a small integer starting at 0 in the order that clusters
 * are discovered — the id itself has no semantic meaning beyond
 * "same-cluster iff same id."
 *
 * Runtime: O(N²) Hamming comparisons + O(α(N)) union-find ops per pair.
 * For N=500 that's 125k Hamming comparisons; each is a 16-byte XOR +
 * popcount. Sub-second on a laptop. Way under the workflow budget.
 */
export function clusterByHamming(
  rows: ReadonlyArray<ClusterableRow>,
  threshold: number = DEFAULT_HAMMING_THRESHOLD,
): ClusterAssignment {
  const N = rows.length;
  if (N === 0) {
    return { assignments: [], clusterCount: 0, sizes: new Map() };
  }

  // Union-find (with path compression + union by size).
  const parent = new Int32Array(N);
  const size = new Int32Array(N);
  for (let i = 0; i < N; i++) { parent[i] = i; size[i] = 1; }
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    // Path compression.
    let cur = x;
    while (parent[cur] !== r) { const nxt = parent[cur]; parent[cur] = r; cur = nxt; }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (size[ra] < size[rb]) {
      parent[ra] = rb;
      size[rb] += size[ra];
    } else {
      parent[rb] = ra;
      size[ra] += size[rb];
    }
  };

  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const d = hammingHex(rows[i].hash, rows[j].hash);
      if (d >= 0 && d <= threshold) union(i, j);
    }
  }

  // Re-index roots to dense small integers.
  const rootToIdx = new Map<number, number>();
  const assignments: number[] = new Array(N);
  let nextIdx = 0;
  for (let i = 0; i < N; i++) {
    const r = find(i);
    let idx = rootToIdx.get(r);
    if (idx === undefined) { idx = nextIdx++; rootToIdx.set(r, idx); }
    assignments[i] = idx;
  }

  const sizes = new Map<number, number>();
  for (const a of assignments) sizes.set(a, (sizes.get(a) ?? 0) + 1);

  return { assignments, clusterCount: nextIdx, sizes };
}

/**
 * Given clustering output, produce the per-card attribution-stats
 * summary. Pure function — no I/O. Kept next to the cluster algo so
 * they evolve together.
 *
 * `suspect` = true when there are ≥ 2 clusters AND the smallest is less
 * than the largest. Single-cluster cards are clean (all sales look the
 * same). Two-cluster cards with equal sizes are still suspect because
 * they signal a systematic mis-attribution.
 */
export function summarizeAttribution(
  clusterOutput: ClusterAssignment,
): {
  total_hashed_sales: number;
  cluster_count: number;
  largest_cluster_size: number;
  smallest_cluster_size: number;
  suspect: boolean;
} {
  const total = clusterOutput.assignments.length;
  const cc = clusterOutput.clusterCount;
  if (cc === 0) {
    return {
      total_hashed_sales: 0,
      cluster_count: 0,
      largest_cluster_size: 0,
      smallest_cluster_size: 0,
      suspect: false,
    };
  }
  let largest = 0, smallest = Number.POSITIVE_INFINITY;
  for (const n of clusterOutput.sizes.values()) {
    if (n > largest) largest = n;
    if (n < smallest) smallest = n;
  }
  return {
    total_hashed_sales: total,
    cluster_count: cc,
    largest_cluster_size: largest,
    smallest_cluster_size: smallest === Number.POSITIVE_INFINITY ? 0 : smallest,
    suspect: cc >= 2 && smallest < largest,
  };
}
