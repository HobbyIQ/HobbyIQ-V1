// CF-UNIFIED-SEARCH-AND-CERT v1 W2 — PSA cert-grader adapter.
//
// Thin wrapper around the existing psaCert.service.ts. Implements the
// CertGrader contract so the dispatcher (W3) treats PSA identically to
// future BGS/SGC/CGC adapters. Per design doc 23038d7 §1 + §5.
//
// Reuses:
//   - lookupPsaCertByNumber / PsaApiError from psa/psaCert.service.ts
//     (no modification — adapter wraps and translates errors)
//   - tokenizeParallel from compiq/cardsight.mapper.ts (wrapper-strip
//     for "Limited Edition (Tiffany)" → ["tiffany"] pattern shipped in
//     4effbf4; single source of truth)
//   - parseGradeLabel from portfolioiq/gradeParser.ts (PSA descriptor
//     vernacular fallback when card.grade isn't a clean numeric)

import {
  lookupPsaCertByNumber,
  PsaApiError,
} from "../psa/psaCert.service.js";
import { tokenizeParallel } from "../compiq/parallelTokenizer.js";
import { parseGradeLabel } from "../portfolioiq/gradeParser.js";
import {
  CertGraderError,
  type CertGrader,
  type CertGraderErrorCode,
  type CertLookupResult,
} from "./certGrader.js";
import type { CardIdentity } from "../../types/cardIdentity.js";

// PSA cert numbers are all-digit. Historical 7-9 chars; accept 6-12
// to cover legacy/short formats and future expansion without revisiting
// this regex on every cert-number-length change.
const PSA_CERT_NUMBER_RE = /^\d{6,12}$/;

// Tokens that signal the AUTOGRAPH bit, not a parallel name. Mirrors
// the design doc §5 contract for canonicalParallelFromVariety + the
// detectAutoFromVariety helper.
const AUTO_TOKENS = new Set(["auto", "autograph", "signed", "signature"]);

// PSA card shape produced by lookupPsaCertByNumber. Mirrored here as
// a structural type so the adapter doesn't need to re-import the
// service's internal interface — keeps the adapter independent of
// psaCert.service.ts module surface area.
interface PsaCardShape {
  year: string | null;
  brand: string | null;
  category: string | null;
  cardNumber: string | null;
  subject: string | null;
  variety: string | null;
  grade: string | null;
  gradeDescription: string | null;
  specId: number | null;
  itemStatus: string | null;
  totalPopulation: number | null;
  populationHigher: number | null;
}

/**
 * Title-case helper for parallel display. `"tiffany"` → `"Tiffany"`,
 * `"blue refractor"` → `"Blue Refractor"`. Conservative: only the
 * first letter of each whitespace-separated word is upper-cased; the
 * rest of the token is preserved (so "RC" stays "RC" if it ever appears
 * mid-token, though tokenizeParallel currently lowercases first).
 */
function titleCaseTokens(tokens: string[]): string {
  return tokens
    .map((t) => (t.length === 0 ? t : t[0].toUpperCase() + t.slice(1)))
    .join(" ");
}

/**
 * Per design §5. Maps PSA's `variety` text into a canonical parallel
 * string via tokenizeParallel (wrapper-strip included). Drops auto
 * tokens — those become CardIdentity.isAuto, not parallel.
 *
 * Returns null when:
 *   - variety is empty / not a string
 *   - tokenizeParallel produced zero tokens
 *   - all tokens were auto-signal tokens (variety was JUST "autograph")
 */
export function canonicalParallelFromVariety(
  variety: string | null | undefined,
): string | null {
  if (!variety || typeof variety !== "string") return null;
  const tokens = tokenizeParallel(variety);
  if (tokens.length === 0) return null;
  const parallelTokens = tokens.filter((t) => !AUTO_TOKENS.has(t));
  if (parallelTokens.length === 0) return null;
  return titleCaseTokens(parallelTokens);
}

/**
 * Per design §5. PSA's `variety` field carries auto/autograph signals
 * mixed in with parallel tokens. Returns true when any token matches
 * the auto-signal set.
 */
export function detectAutoFromVariety(
  variety: string | null | undefined,
): boolean {
  if (!variety || typeof variety !== "string") return false;
  const tokens = tokenizeParallel(variety);
  return tokens.some((t) => AUTO_TOKENS.has(t));
}

/**
 * Primary path: PSA's `card.grade` is typically a clean numeric string
 * ("10", "9.5"). parseFloat lifts it directly.
 *
 * Fallback path: when grade is missing/unparseable, defer to
 * parseGradeLabel against `gradeDescription` ("GEM MT 10" → 10). This
 * is the same heuristic used by the autoprice backfill — reusing it
 * keeps PSA's vernacular handling consistent across the codebase.
 *
 * Returns null when both paths fail. Adapter never throws on
 * unparseable grades.
 */
export function parseGradeValue(
  grade: string | null | undefined,
  gradeDescription: string | null | undefined,
): number | null {
  if (typeof grade === "string" && grade.trim().length > 0) {
    const parsed = Number(grade.trim());
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10) {
      return parsed;
    }
  }
  if (typeof gradeDescription === "string" && gradeDescription.trim().length > 0) {
    const parsed = parseGradeLabel(gradeDescription);
    if (parsed && Number.isFinite(parsed.gradeValue)) {
      return parsed.gradeValue;
    }
  }
  return null;
}

/**
 * Display title for the PSA candidate. Used by VerifyView and results
 * list. Concatenates the populated PSA fields in human-reading order
 * with single-space separation.
 *
 * Examples:
 *   "1987 Topps Traded #70T Greg Maddux RC Tiffany — PSA 10"
 *   "1989 Upper Deck #1 Ken Griffey Jr. RC — PSA 9"
 */
export function buildPsaTitle(card: PsaCardShape): string {
  const parts: string[] = [];
  if (card.year) parts.push(card.year);
  if (card.brand) parts.push(card.brand);
  if (card.cardNumber) parts.push(`#${card.cardNumber}`);
  if (card.subject) parts.push(card.subject);
  if (card.variety) parts.push(card.variety);
  const left = parts.filter((p) => p.length > 0).join(" ");

  const gradeValue = parseGradeValue(card.grade, card.gradeDescription);
  const gradePart = gradeValue !== null ? ` — PSA ${gradeValue}` : "";

  return `${left}${gradePart}`.trim();
}

function mapPsaErrorCode(code: string | null | undefined): CertGraderErrorCode {
  switch (code) {
    case "PSA_TOKEN_MISSING":
      return "TOKEN_MISSING";
    case "PSA_AUTH_FAILED":
      return "AUTH_FAILED";
    case "PSA_QUOTA_EXCEEDED":
      return "QUOTA_EXCEEDED";
    case "PSA_TIMEOUT":
      return "TIMEOUT";
    case "PSA_REQUEST_FAILED":
    case "PSA_REQUEST_ERROR":
    case "PSA_CERT_MISSING":
    case "PSA_API_ERROR":
      return "REQUEST_FAILED";
    default:
      return "UNKNOWN";
  }
}

export const psaCertGrader: CertGrader = {
  id: "psa",
  displayName: "PSA",

  recognizes(input) {
    if (typeof input !== "string") return false;
    return PSA_CERT_NUMBER_RE.test(input.trim());
  },

  async lookup(certNumber) {
    try {
      const r = await lookupPsaCertByNumber(certNumber);
      return {
        rawCertNumber: r.certNumber,
        certificationType: r.certificationType,
        cardRaw: r.card,
        totalPopulation: r.card?.totalPopulation ?? null,
        populationHigher: r.card?.populationHigher ?? null,
      };
    } catch (err) {
      if (err instanceof PsaApiError) {
        throw new CertGraderError(
          err.message,
          "psa",
          mapPsaErrorCode(err.code),
          err.status,
        );
      }
      const message = err instanceof Error ? err.message : "PSA lookup failed";
      throw new CertGraderError(message, "psa", "UNKNOWN", 502);
    }
  },

  toCardIdentity(result) {
    const card = (result.cardRaw ?? null) as PsaCardShape | null;
    const yearStr = card?.year ?? null;
    const yearNumber =
      yearStr && /^\d{4}$/.test(yearStr.trim()) ? Number(yearStr.trim()) : null;

    const gradeValue = card
      ? parseGradeValue(card.grade, card.gradeDescription)
      : null;
    const parallel = card ? canonicalParallelFromVariety(card.variety) : null;
    const isAuto = card ? detectAutoFromVariety(card.variety) : false;
    const title = card ? buildPsaTitle(card) : `PSA ${result.rawCertNumber}`;

    const identity: CardIdentity = {
      candidateId: `psa:${result.rawCertNumber}`,
      source: "psa-cert",
      attribution: "authoritative",
      confidence: 1.0,

      player: card?.subject ?? null,
      year: yearNumber,
      brand: card?.brand ?? null,
      // PSA's response doesn't separate brand vs set — `brand` is the
      // closest single-field analog. setName stays null until/unless
      // a future PSA schema change splits them.
      setName: null,
      cardNumber: card?.cardNumber ?? null,
      parallel,
      // PSA's `variety` is collapsed into parallel + isAuto; no separate
      // variation surface today.
      variation: null,
      isAuto,
      serialNumber: null,

      grade: card?.grade ?? null,
      gradeCompany: "PSA",
      gradeValue,
      certNumber: result.rawCertNumber,
      totalPopulation: result.totalPopulation,
      populationHigher: result.populationHigher,

      title,
      imageUrl: null,

      raw: card ?? undefined,
    };

    return identity;
  },
};
