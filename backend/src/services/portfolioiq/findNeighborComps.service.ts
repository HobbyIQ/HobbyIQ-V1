// CF-FIND-NEIGHBOR-COMPS (Drew, 2026-07-30). Phase 5 of the composite
// parallel framework rollout. Query-side consumer that reads the
// 6-axis composite identity fields emitted by Phase 3 and walks the
// axis tree when a direct-slug pool is thin.
//
// Given a target composite (via cardId slug OR explicit 6-axis
// filter), returns comps ranked by axis-match distance:
//   distance 0 = exact slug match (all axes agree)
//   distance N = N axes had to be dropped/widened
//
// Fallback order (default; caller can override):
//   1. serialRun     — same tier, any serial
//   2. finishModifier — same color, any finish (WAVE ~ SPECKLE ~ base)
//   3. colorFamily   — any color in ladder
//   4. insertSet     — drop insert axis
//   5. edition       — drop edition (Sapphire pools with regular Chrome)
//   6. subLine       — walk up product family (Chrome → Bowman)
//
// Confidence downgrade per axis dropped so callers can weight nearer
// comps higher when interpolating FMV.

import type { Container } from "@azure/cosmos";
import { parseHobbyIqCardId } from "./hobbyIqCardId.service.js";

export interface CompositeFilter {
  sport?: string | null;
  cardYear?: number | null;
  playerName?: string | null;
  cardNumber?: string | null;       // CPA-BA / BCP-102 / 82 — anchor axis, never dropped
  parallelSlug?: string | null;     // "blue-refractor" / "bowman-logo-pattern" / "reptilian-refractor" — anchor axis, never dropped; captures the variant taxonomy that composite fields can't express
  productLine?: string | null;      // setKey slot from slug
  edition?: string | null;
  insertSet?: string | null;
  colorFamily?: string | null;
  finishModifier?: string | null;
  isRefractor?: boolean | null;
  isAuto?: boolean | null;
  serialRun?: number | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
}

export interface NeighborComp {
  doc: Record<string, unknown>;        // full sold_comps doc
  distance: number;                    // axes dropped from target
  droppedAxes: string[];               // human-readable list of what got widened
  matchScore: number;                  // 0-1, higher = closer
}

export interface NeighborLookupOptions {
  /** Max axes to drop before giving up. Default 6 (all axes optional).
   *  Lower to require tighter matches. */
  maxDistance?: number;
  /** Min comps to gather before returning. Once we have this many at
   *  distance N, we stop widening. Default 20. */
  minComps?: number;
  /** Max comps to return. Default 200. */
  maxComps?: number;
  /** If set, only consider comps sold within N days. Default 365. */
  recencyDays?: number;
  /** Ordered list of axes to drop as we widen. Default:
   *  ["serialRun", "finishModifier", "colorFamily", "insertSet",
   *   "edition", "subLine"]. Higher-index = kept longer. */
  axisDropOrder?: Array<keyof CompositeFilter>;
}

// Anchor axes never appear here: sport, cardYear, cardNumber, isAuto,
// parallelSlug identify WHICH CARD + WHICH VARIANT. They are always
// kept. Only the COMPOSITE variant axes (redundant classifications
// of the parallel like colorFamily / finishModifier / edition) are
// progressively dropped when needed.
const DEFAULT_AXIS_DROP: Array<keyof CompositeFilter> = [
  "serialRun",
  "finishModifier",
  "colorFamily",
  "insertSet",
  "edition",
  "productLine",  // last resort: any product for same cardNumber+year
];

/** Derive a CompositeFilter from a slug (hiq:...:...). Useful when
 *  callers only have the target cardId string. */
export function compositeFilterFromCardId(cardId: string): CompositeFilter {
  const parts = parseHobbyIqCardId(cardId);
  if (!parts) return {};
  return {
    sport: parts.sport,
    cardYear: parts.year,
    productLine: parts.setKey,
    cardNumber: parts.cardNumber ?? null,   // anchor axis — never dropped
    parallelSlug: parts.parallel ?? null,   // anchor axis — never dropped; captures Logo Pattern / Reptilian Refractor / Mini-Diamond / etc.
    isAuto: parts.isAuto,
    serialRun: parts.printRun ?? null,
    // colorFamily / edition / insertSet / finishModifier live in
    // /composite on the row, not in the legacy slug. Callers can
    // enrich this filter with the row's composite when available.
  };
}

/** Build a Cosmos SQL WHERE clause + parameter list from a filter.
 *  Only includes conditions for defined-and-non-null filter values —
 *  a null/undefined filter axis is a wildcard.
 *  Returns { where, parameters } that the caller stitches into a
 *  SELECT ... FROM c query. */
function buildFilterClause(f: CompositeFilter): { where: string; parameters: Array<{ name: string; value: string | number | boolean | null }> } {
  const conds: string[] = [];
  const params: Array<{ name: string; value: string | number | boolean | null }> = [];
  const add = (col: string, val: string | number | boolean | null) => {
    const pname = `@p${params.length}`;
    conds.push(`${col} = ${pname}`);
    params.push({ name: pname, value: val });
  };
  if (f.sport != null) add("c.sport", f.sport);
  if (f.cardYear != null) add("c.cardYear", f.cardYear);
  if (f.playerName != null) add("c.playerName", f.playerName);
  if (f.cardNumber != null) {
    // cardNumber slugs are lowercased in hobbiqCardId but stored as
    // vendor-provided casing on the doc's c.cardNumber field. Compare
    // uppercased both sides.
    const pname = `@p${params.length}`;
    conds.push(`UPPER(c.cardNumber) = ${pname}`);
    params.push({ name: pname, value: String(f.cardNumber).toUpperCase() });
  }
  if (f.parallelSlug != null) {
    // Filter on slug segment 5 (":parallelSlug:autoFlag" boundary). Using
    // slug CONTAINS is safe: parallelSlug is well-delimited by `:`
    // colons on both sides in the canonical form.
    const pname = `@p${params.length}`;
    conds.push(`CONTAINS(c.hobbyiqCardId, ${pname})`);
    params.push({ name: pname, value: `:${f.parallelSlug}:` });
  }
  if (f.isAuto != null) add("c.isAuto", f.isAuto);
  if (f.gradeCompany != null) add("c.gradeCompany", f.gradeCompany);
  if (f.gradeValue != null) add("c.gradeValue", f.gradeValue);
  if (f.serialRun != null) add("c.printRun", f.serialRun);
  if (f.productLine != null) {
    // productLine lives in slug slot 3 — string-match the slug segment.
    // Use CONTAINS with delimiters so we don't false-match subLine
    // fragments (bowman-chrome vs bowman).
    const pname = `@p${params.length}`;
    conds.push(`CONTAINS(c.hobbyiqCardId, ${pname})`);
    params.push({ name: pname, value: `:${f.productLine}:` });
  }
  if (f.edition != null) add("c.composite.edition", f.edition);
  if (f.insertSet != null) add("c.composite.insertSet", f.insertSet);
  if (f.colorFamily != null) add("c.composite.colorFamily", f.colorFamily);
  if (f.finishModifier != null) add("c.composite.finishModifier", f.finishModifier);
  if (f.isRefractor != null) add("c.composite.isRefractor", f.isRefractor);
  return {
    where: conds.length > 0 ? conds.join(" AND ") : "true",
    parameters: params,
  };
}

/** Progressive widening: start with the full filter, run a query;
 *  if we don't have enough comps yet, drop the next axis in
 *  axisDropOrder and requery. Collect ALL comps found across passes
 *  with their distance = number of axes dropped when found. */
export async function findNeighborComps(
  container: Container,
  target: CompositeFilter,
  opts: NeighborLookupOptions = {},
): Promise<NeighborComp[]> {
  const maxDist = opts.maxDistance ?? 6;
  const minComps = opts.minComps ?? 20;
  const maxComps = opts.maxComps ?? 200;
  const recencyDays = opts.recencyDays ?? 365;
  const dropOrder = opts.axisDropOrder ?? DEFAULT_AXIS_DROP;

  const cutoff = new Date(Date.now() - recencyDays * 24 * 60 * 60 * 1000).toISOString();
  const results: NeighborComp[] = [];
  const seenIds = new Set<string>();
  const currentFilter: CompositeFilter = { ...target };

  for (let distance = 0; distance <= maxDist; distance++) {
    const clause = buildFilterClause(currentFilter);
    const params = [...clause.parameters, { name: "@cutoff", value: cutoff }];
    const query = `
      SELECT TOP ${maxComps}
        c.id, c.cardId, c.hobbyiqCardId, c.playerName, c.cardYear, c.setName,
        c.cardNumber, c.parallel, c.isAuto, c.autoStyle, c.printRun,
        c.gradeCompany, c.gradeValue, c.price, c.soldAt, c.source,
        c.composite
      FROM c
      WHERE ${clause.where}
        AND c.soldAt >= @cutoff
        AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)
    `;
    let pageDocs: Array<Record<string, unknown>> = [];
    try {
      const { resources } = await container.items.query({ query, parameters: params }).fetchAll();
      pageDocs = resources as Array<Record<string, unknown>>;
    } catch { pageDocs = []; }

    const droppedForThisPass = dropOrder.slice(0, distance);
    for (const doc of pageDocs) {
      const id = String(doc.id ?? "");
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      results.push({
        doc,
        distance,
        droppedAxes: droppedForThisPass.map(String),
        matchScore: 1 - distance / (maxDist + 1),
      });
    }
    if (results.length >= minComps) break;
    if (distance >= dropOrder.length) break;
    // Drop the next axis for the next pass.
    const axisToDrop = dropOrder[distance];
    currentFilter[axisToDrop] = null;
  }

  results.sort((a, b) => a.distance - b.distance || Number(b.doc.soldAt ?? 0) - Number(a.doc.soldAt ?? 0));
  return results.slice(0, maxComps);
}

/** Given a NeighborComp array, group by distance for reporting. */
export function summarizeByDistance(comps: NeighborComp[]): Array<{ distance: number; count: number; droppedAxes: string[] }> {
  const buckets = new Map<number, { count: number; droppedAxes: string[] }>();
  for (const c of comps) {
    const b = buckets.get(c.distance);
    if (b) { b.count++; }
    else { buckets.set(c.distance, { count: 1, droppedAxes: c.droppedAxes }); }
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([distance, v]) => ({ distance, count: v.count, droppedAxes: v.droppedAxes }));
}
