// CF-CARDSIGHT-GRADE-ID-PATTERN -- Cardsight grades taxonomy resolver.
//
// Maps HobbyIQ's (gradeCompany, gradeValue, isAuto) holding fields to
// Cardsight's leaf `gradeId` UUID via the 3-step taxonomy tree:
//
//   GET /v1/grades/companies
//     -> [{ id, name, description }] -- 17 graders enumerated
//   GET /v1/grades/companies/{companyId}/types
//     -> [{ id, name }] -- "Autograph" or "Card" for PSA + BGS
//        (other graders may differ; resolver returns null on mismatch)
//   GET /v1/grades/companies/{companyId}/types/{typeId}/grades
//     -> [{ id, grade, condition }] -- leaf gradeIds with grade strings
//
// R2 pattern per InventoryIQ design (06a5d4e) Section 2.3 + per
// CF-CARDSIGHT-GRADES-ENDPOINT-EVAL (006176d) Finding 2 GREEN:
// `gradeId` is a SUPPLEMENTARY aggregation FK on
// PortfolioHolding alongside existing text grade fields. Null is a
// permanent valid state. Resolver returns null on every miss path
// (unknown grader, unknown type, unknown grade value, network failure,
// 4xx/5xx, parse error) -- never throws. The text grade fields remain
// authoritative for cert paths + iOS display; the gradeId FK enables
// Cardsight per-grade pricing/marketplace/population queries.
//
// v1 limitations (documented per Phase 1.5 + 1.6 empirical probes):
//   - PSA + BGS confirmed to use {Autograph, Card} type axis. Other
//     15 graders unprobed; resolver returns null for graders whose
//     types don't include "Autograph" or "Card".
//   - BGS Autograph type has only 6 grades (5, 6, 7, 8, 9, 10).
//     ("BGS", 9.5, isAuto=true) returns null -- no entry exists.
//     BGS Card type expected to have half grades but is unverified.
//   - PSA "Authentic" grade is non-numeric and unaddressable via
//     gradeValue: number; resolver returns null when gradeValue is
//     not finite or doesn't string-match.
//   - BGS Black Label sub-tier is NOT distinguished in Cardsight's
//     taxonomy. "BGS 10 Black Label" holdings resolve to the same
//     Pristine 10 UUID as regular Pristine 10s. Acceptable v1 gap
//     (Black Label is <1% of BGS 10s; rare in production data).
//   - Cardsight upstream failures (4xx, 5xx, network) return null
//     gracefully -- caller treats null as "no FK available", which
//     is the same valid state as legitimate unknowns.

import { cacheWrap } from "../shared/cache.service.js";

const BASE_URL = "https://api.cardsight.ai/v1";
const TIMEOUT_MS = 10_000;
const TAXONOMY_TTL_SEC = 24 * 3600; // 24h -- taxonomy is stable reference data.

interface CardsightGradingCompany {
  id: string;
  name: string;
  description: string;
}

interface CardsightGradingType {
  id: string;
  gradingCompanyId: string;
  gradingCompanyName: string;
  name: string;
  description: string;
}

interface CardsightGradingGrade {
  id: string;
  gradingTypeId: string;
  gradingTypeName: string;
  gradingCompanyId: string;
  gradingCompanyName: string;
  grade: string;
  condition: string;
}

interface CompaniesListResponse {
  companies?: CardsightGradingCompany[];
  total?: number;
}

interface TypesListResponse {
  types?: CardsightGradingType[];
  total?: number;
}

interface GradesListResponse {
  grades?: CardsightGradingGrade[];
  total?: number;
}

/**
 * Internal fetcher. Returns null on any failure (network, non-2xx,
 * parse). Caller decides what to do with null (resolver collapses
 * to top-level null return).
 */
async function fetchJsonOrNull<T>(path: string): Promise<T | null> {
  const apiKey = process.env.CARDSIGHT_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch(`${BASE_URL}${path}`, {
      method: "GET",
      headers: { "X-API-Key": apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Cached list of grading companies. 24h TTL.
 * Cache key: cs:grades:companies
 */
async function getCompaniesList(): Promise<CardsightGradingCompany[]> {
  const result = await cacheWrap<CompaniesListResponse | null>(
    "cs:grades:companies",
    () => fetchJsonOrNull<CompaniesListResponse>("/grades/companies"),
    TAXONOMY_TTL_SEC,
  );
  return Array.isArray(result?.companies) ? result.companies : [];
}

/**
 * Cached list of types for a specific company. 24h TTL.
 * Cache key: cs:grades:companies:{companyId}:types
 */
async function getTypesList(companyId: string): Promise<CardsightGradingType[]> {
  const result = await cacheWrap<TypesListResponse | null>(
    `cs:grades:companies:${companyId}:types`,
    () => fetchJsonOrNull<TypesListResponse>(`/grades/companies/${companyId}/types`),
    TAXONOMY_TTL_SEC,
  );
  return Array.isArray(result?.types) ? result.types : [];
}

/**
 * Cached list of leaf grades for a (company, type) pair. 24h TTL.
 * Cache key: cs:grades:companies:{companyId}:types:{typeId}:grades
 */
async function getGradesList(
  companyId: string,
  typeId: string,
): Promise<CardsightGradingGrade[]> {
  const result = await cacheWrap<GradesListResponse | null>(
    `cs:grades:companies:${companyId}:types:${typeId}:grades`,
    () =>
      fetchJsonOrNull<GradesListResponse>(
        `/grades/companies/${companyId}/types/${typeId}/grades`,
      ),
    TAXONOMY_TTL_SEC,
  );
  return Array.isArray(result?.grades) ? result.grades : [];
}

/**
 * Maps HobbyIQ's PortfolioHolding grade fields to Cardsight's leaf
 * gradeId UUID. Returns null on every miss path (unknown grader,
 * unknown type, unknown grade value, fetch failure). Never throws.
 *
 * @param gradeCompany e.g. "PSA", "BGS", "SGC", "CGC" -- string match
 *                     against Cardsight company `name` field. Case-
 *                     sensitive per Cardsight's convention.
 * @param gradeValue   numeric grade. Stringified for comparison
 *                     against Cardsight's `grade` field (e.g. 10 -> "10",
 *                     9.5 -> "9.5"). Non-finite values return null.
 * @param isAuto       maps to type axis. true -> "Autograph" type;
 *                     false (or undefined coerced) -> "Card" type.
 *
 * @returns Promise resolving to Cardsight gradeId UUID, or null on miss.
 */
export async function resolveCardsightGradeId(
  gradeCompany: string | null | undefined,
  gradeValue: number | null | undefined,
  isAuto: boolean | null | undefined,
): Promise<string | null> {
  // CF-CARDSIGHT-TAXONOMY-DISABLED-BY-DEFAULT (2026-07-08, Drew):
  // Cardsight was decommissioned; the taxonomy API sits behind an
  // IP-allowlisted key that may or may not still be provisioned. Every
  // holding write was still calling this resolver — burning egress
  // requests to an endpoint the app doesn't need. Gate behind an
  // opt-in env flag so the default posture is "don't call at all".
  //
  // The existing null-return contract is preserved — callers already
  // treat null as a valid state (see portfolioStore.service.ts:1360-63
  // and CardsightGradesTaxonomy top-comment). Enabling the flag
  // restores the prior behavior for anyone who still wants the FK.
  if (process.env.CARDSIGHT_TAXONOMY_ENABLED !== "true") {
    return null;
  }
  if (typeof gradeCompany !== "string" || gradeCompany.trim().length === 0) {
    return null;
  }
  if (typeof gradeValue !== "number" || !Number.isFinite(gradeValue)) {
    return null;
  }
  const trimmedCompany = gradeCompany.trim();
  const desiredTypeName = isAuto ? "Autograph" : "Card";
  const gradeString = String(gradeValue);

  try {
    const companies = await getCompaniesList();
    const companyEntry = companies.find((c) => c.name === trimmedCompany);
    if (!companyEntry) return null;

    const types = await getTypesList(companyEntry.id);
    const typeEntry = types.find((t) => t.name === desiredTypeName);
    if (!typeEntry) return null;

    const grades = await getGradesList(companyEntry.id, typeEntry.id);
    const gradeEntry = grades.find((g) => g.grade === gradeString);
    if (!gradeEntry) return null;

    return gradeEntry.id;
  } catch {
    // Defensive -- cacheWrap shouldn't throw, but if it does the
    // resolver still returns null per the "never throws" contract.
    return null;
  }
}
