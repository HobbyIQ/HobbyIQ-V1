// CF-FILTER-CONSOLIDATION (2026-06-10) — neutral, dependency-free home
// for the parallel filter used by both the value path (fetchComps in
// compiqEstimate.service.ts) and the fact-pack path (buildMarketRead
// FactPack in marketRead.service.ts).
//
// Before this lift the two paths each had their own copy of the same
// function body — `filterRecordsByParallel` in compiqEstimate.service.ts
// and the local twin `filterByParallelHere` in marketRead.service.ts.
// The mirror was added prophylactically to avoid a marketRead →
// compiqEstimate import cycle (the reverse edge does not exist, but
// the codebase was being defensive). The cost of the twin pair was
// the drift risk: a future tightening of one helper could be missed
// in the other and the two pools would silently disagree.
//
// This module imports NOTHING from either parent file (or from
// anything else in src/), so it can be safely imported by both
// without re-creating a cycle. Pure data filter, generic over any
// record that has a `parallel_id` field.

/** CF-PARALLEL-AWARE-VALUE (2026-06-09): per-record parallel filter.
 *  Authoritative — applied at the sales[] layer right after grade
 *  selection so EVERY downstream pool (FMV, marketRead factPack,
 *  trajectory, recentComps, excludedComps) sees the parallel-scoped
 *  records only.
 *    - parallelId provided → keep only records whose parallel_id
 *      matches that id verbatim
 *    - parallelId NOT provided → keep only records WITHOUT a
 *      parallel_id (base/unnumbered only) — closes the parallel-bleed
 *      where Cognac Diamond / Gold / Blue Border records were
 *      contaminating raw FMV.
 *  Cardsight tags both raw + graded records (verified 0a). */
export function filterRecordsByParallel<T extends { parallel_id?: string | null }>(
  records: ReadonlyArray<T>,
  parallelId: string | null | undefined,
): T[] {
  if (parallelId) {
    // CF-CH-PARALLEL-FILTER-BYPASS (2026-06-27): Cardsight tagged every
    // sale with a `parallel_id` UUID and called this filter to subset
    // base+parallel records to the requested parallel. CardHedge (which
    // replaced Cardsight in the Wave 3 sweeps) does NOT carry parallel_id
    // — each parallel has its own card_id, so sales returned by
    // getCardSales(parallelCardId) are already parallel-scoped upstream.
    // The strict UUID equality below was dropping every CardHedge record
    // (`undefined === "uuid"` is false) → 0-comp fall-through → engine
    // forced into Build B base × multiplier math even when 6+ real direct
    // comps existed (e.g. Hartman Speckle Refractor /299 returning $22).
    //
    // Bypass: when NO record in the input carries parallel_id (the
    // CardHedge shape), return as-is — the caller fetched a
    // parallel-scoped card_id, the records are already correct. When ANY
    // record DOES carry parallel_id (Cardsight legacy / mixed source),
    // preserve the original strict filter so cross-parallel bleed stays
    // sealed.
    const anyHasParallelId = records.some(
      (r) => r.parallel_id !== undefined && r.parallel_id !== null,
    );
    if (!anyHasParallelId) {
      return [...records];
    }
    return records.filter((r) => r.parallel_id === parallelId);
  }
  return records.filter(
    (r) => r.parallel_id === null || r.parallel_id === undefined,
  );
}
