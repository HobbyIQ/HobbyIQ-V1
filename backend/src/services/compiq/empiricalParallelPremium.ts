/**
 * CF-EMPIRICAL-PARALLEL-PREMIUM (D4 PR 5, 2026-08-29).
 *
 * The ONE source of a parallel-over-base multiplier: the calibration table
 * `backend/data/parallel-premiums-latest.json`, regenerated from paired
 * sales in our own pool. A premium is a measurement — (year, set,
 * parallel, isAuto) with a sample size and a provenance — or it does not
 * exist. There is no floor, no tier ladder, no hobby-consensus default
 * behind it: when this lookup returns null, the caller has no multiplier
 * and must price nothing for that parallel (empirical-only doctrine:
 * project_empirical_only_multiplier_doctrine).
 *
 * Extracted from siblingCardPriceFallback.service.ts so the legacy engine
 * (compiqEstimate) and Tier 6 (referenceCatalogBaseline) can read the same
 * measurement without a compiqEstimate <-> sibling import cycle.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface EmpiricalParallelEntry {
  year: number;
  set: string;
  parallel: string;
  printRun: string;
  isAuto?: boolean;
  baseRelativePremium: number | null;
  sampleSize: number;
  provenance?: string;
}

export interface EmpiricalParallelPremium {
  /** The measured parallel-over-base multiplier. */
  premium: number;
  /** The table row's set — the target's own set, or a same-brand-family
   *  proxy when the exact set had no measurement. */
  matchedSet: string;
  /** Paired observations behind the measurement. */
  sampleSize: number;
  /** True when matchedSet is not the requested set (brand-family proxy). */
  usedProxy: boolean;
}

/** A measurement needs this many paired observations to be used. */
export const MIN_EMPIRICAL_SAMPLE_SIZE = 5;

/** Cached table load. Reset via _resetEmpiricalParallelPremiumCacheForTesting. */
let _tableCache: EmpiricalParallelEntry[] | null | undefined = undefined;

function loadTable(): EmpiricalParallelEntry[] | null {
  if (_tableCache !== undefined) return _tableCache;
  try {
    const p = path.resolve(process.cwd(), "data/parallel-premiums-latest.json");
    if (!fs.existsSync(p)) {
      _tableCache = null;
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    _tableCache = entries as EmpiricalParallelEntry[];
    return _tableCache;
  } catch (err) {
    console.warn(
      `[empiricalParallelPremium] parallel-premiums load failed: ${(err as Error)?.message ?? err}`,
    );
    _tableCache = null;
    return null;
  }
}

/** Test hook — force a reload on the next lookup call. */
export function _resetEmpiricalParallelPremiumCacheForTesting(): void {
  _tableCache = undefined;
}

function normalizeToken(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Infer the brand family for a set name. Returns the canonical family
 * token (bowman/topps/panini) or null when no known family matches.
 * Constrains the proxy fallback to the target's own brand family — Bowman
 * auto premiums track across Bowman Chrome Prospects / Bowman Draft Chrome
 * / Bowman Draft, but not across Bowman -> Panini Prizm.
 */
function inferBrand(normalizedSet: string): string | null {
  if (normalizedSet.includes("bowman")) return "bowman";
  if (normalizedSet.includes("topps")) return "topps";
  if (normalizedSet.includes("panini") || normalizedSet.includes("prizm") ||
      normalizedSet.includes("select") || normalizedSet.includes("mosaic") ||
      normalizedSet.includes("optic")) return "panini";
  return null;
}

function usable(e: EmpiricalParallelEntry): boolean {
  return typeof e.baseRelativePremium === "number"
    && e.baseRelativePremium > 0
    && e.sampleSize >= MIN_EMPIRICAL_SAMPLE_SIZE;
}

/**
 * The measured parallel-over-base premium for (year, set, parallel, isAuto),
 * or null when nothing was measured. Exact set first; then the richest
 * same-year same-parallel same-isAuto measurement inside the same brand
 * family (CF-SIBLING-PROXY-BRAND-FAMILY, 2026-07-07 — the table indexes a
 * product under whichever set string the discovery script produced, so
 * 2025 Orange auto premiums can sit under "Bowman Draft" while the target
 * says "Bowman Draft Chrome").
 */
export function lookupEmpiricalParallelPremium(
  year: number,
  setName: string,
  parallel: string,
  isAuto: boolean,
): EmpiricalParallelPremium | null {
  if (!Number.isFinite(year) || !setName || !parallel) return null;
  const table = loadTable();
  if (!table) return null;

  const setNorm = normalizeToken(setName);
  const parallelNorm = normalizeToken(parallel);

  const exact = table.find(
    (e) =>
      e.year === year &&
      normalizeToken(e.set) === setNorm &&
      normalizeToken(e.parallel) === parallelNorm &&
      !!e.isAuto === isAuto &&
      usable(e),
  );
  if (exact) {
    return {
      premium: exact.baseRelativePremium as number,
      matchedSet: exact.set,
      sampleSize: exact.sampleSize,
      usedProxy: false,
    };
  }

  const targetBrand = inferBrand(setNorm);
  if (!targetBrand) return null;
  const candidates = table.filter(
    (e) =>
      e.year === year &&
      normalizeToken(e.parallel) === parallelNorm &&
      !!e.isAuto === isAuto &&
      usable(e) &&
      inferBrand(normalizeToken(e.set)) === targetBrand &&
      normalizeToken(e.set) !== setNorm,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.sampleSize - a.sampleSize);
  const best = candidates[0];
  return {
    premium: best.baseRelativePremium as number,
    matchedSet: best.set,
    sampleSize: best.sampleSize,
    usedProxy: true,
  };
}
