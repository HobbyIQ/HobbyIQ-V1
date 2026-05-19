/**
 * Cardsight response translator. Phase 1 of migration per ADR-cardsight-migration-2026-05-18.
 * NOT YET INTEGRATED with compiqEstimate.service.ts.
 *
 * Translates a CardsightPricingResponse to the TranslatedComp[] shape that
 * the pricing engine expects (matches RawComp + source tag).
 *
 * Grade filtering algorithm (per ADR section §5.3):
 *  - Raw-only:   gradeCompany null/empty → map response.raw.records
 *  - Graded-only: walk response.graded[], match company case-insensitively,
 *                 then find grade_value. DO NOT mix raw and graded.
 *  - Company not found → return [] + structured warning log
 *  - gradeValue not found within company → return [] + structured warning log
 *
 * Sort: all returned comps are sorted by soldDate descending (newest first).
 */

import type { CardsightPricingResponse } from "./cardsight.client.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("cardsight.translator");

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Shape returned by the translator.
 * Matches the engine's RawComp interface plus a source tag for shadow-mode
 * comparison. Never mix raw and graded in one result set.
 */
export interface TranslatedComp {
  price: number;
  title: string;
  soldDate: string;
  source: "cardsight";
}

// ─── Exported Function ───────────────────────────────────────────────────────

/**
 * Translate a CardsightPricingResponse to TranslatedComp[].
 *
 * @param response  Raw API response from getPricing()
 * @param opts      Optional grade filters; if gradeCompany is omitted, raw sales are returned
 * @returns         Comps sorted by soldDate descending; empty array on no match or missing grade
 */
export function translateResponse(
  response: CardsightPricingResponse,
  opts: { gradeCompany?: string; gradeValue?: string } = {},
): TranslatedComp[] {
  if ((response.raw?.records?.length ?? 0) === 0 && (response.graded?.length ?? 0) === 0) {
    log.warn("empty_response", {
      endpoint: "translateResponse",
      gradeCompany: opts.gradeCompany ?? null,
      gradeValue: opts.gradeValue ?? null,
    });
  }

  // ── Graded path ───────────────────────────────────────────────────────────
  if (opts.gradeCompany) {
    const companyName = opts.gradeCompany.trim();

    const company = response.graded?.find(
      (g) => g.company_name.toLowerCase() === companyName.toLowerCase(),
    );

    if (!company) {
      log.warn("grade_company_not_found", {
        endpoint: "translateResponse",
        requestedGradeCompany: companyName,
        requestedGradeValue: opts.gradeValue ?? null,
        availableCompanies: (response.graded ?? []).map((g) => g.company_name),
      });
      return [];
    }

    // If a specific grade value was requested, find it; otherwise return all grades
    const gradeEntries = opts.gradeValue
      ? company.grades.filter((g) => g.grade_value === String(opts.gradeValue).trim())
      : company.grades;

    if (opts.gradeValue && gradeEntries.length === 0) {
      log.warn("grade_value_not_found", {
        endpoint: "translateResponse",
        requestedGradeCompany: companyName,
        requestedGradeValue: String(opts.gradeValue).trim(),
        availableGrades: company.grades.map((g) => g.grade_value),
      });
      return [];
    }

    const comps: TranslatedComp[] = gradeEntries.flatMap((entry) =>
      entry.records.map((r) => ({
        price: r.price,
        title: r.title,
        soldDate: r.date ?? "",
        source: "cardsight" as const,
      })),
    );

    return sortByDateDesc(comps);
  }

  // ── Raw path ──────────────────────────────────────────────────────────────
  const records = response.raw?.records ?? [];
  if (records.length === 0) return [];

  const comps: TranslatedComp[] = records.map((r) => ({
    price: r.price,
    title: r.title,
    soldDate: r.date ?? "",
    source: "cardsight" as const,
  }));

  return sortByDateDesc(comps);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sortByDateDesc(comps: TranslatedComp[]): TranslatedComp[] {
  return [...comps].sort((a, b) => {
    // Lexicographic ISO date comparison works for YYYY-MM-DD strings
    if (!a.soldDate && !b.soldDate) return 0;
    if (!a.soldDate) return 1;   // empty dates sink to bottom
    if (!b.soldDate) return -1;
    return b.soldDate.localeCompare(a.soldDate);
  });
}
