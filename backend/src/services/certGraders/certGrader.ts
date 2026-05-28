// CF-UNIFIED-SEARCH-AND-CERT v1 W2 — cert-grader abstraction.
//
// Per design doc 23038d7 §1. Three artifacts here:
//
//   CertGrader              — interface every grader adapter implements
//   CertLookupResult        — grader-agnostic lookup return shape
//   CertGraderError         — common error class (mirrors PsaApiError pattern)
//
// The v1.5 forward-compat contract: a new grader = service file + adapter
// implementing this interface + one-line registration in
// certGraders/index.ts. Zero touches to dispatcher / endpoint / response
// shape / iOS / CardIdentity / schema. Get this interface right at v1 →
// every grader addition is a clean plug-in.

import type { CardIdentity } from "../../types/cardIdentity.js";

/**
 * Grader-agnostic cert lookup return shape. Each adapter normalizes
 * its vendor body into this shape before `toCardIdentity` consumes it.
 *
 * `cardRaw` is intentionally `unknown` — the adapter's `toCardIdentity`
 * is the only consumer that interprets it; the dispatcher and endpoint
 * never inspect it.
 */
export interface CertLookupResult {
  rawCertNumber: string;
  /**
   * Grader-specific certification class. PSA returns "PSA" | "DNA" |
   * "UNKNOWN"; BGS/SGC/CGC will populate their own enumerations.
   * Surface only — not used for dispatch decisions.
   */
  certificationType: string;
  cardRaw: unknown;
  totalPopulation: number | null;
  populationHigher: number | null;
}

/**
 * Grader adapter contract. Each grader (PSA, BGS, SGC, CGC, ...) provides
 * one of these. The registry wires them up; the dispatcher (W3) consults
 * `recognizes` to decide cert-vs-freetext mode and `lookup` to fetch.
 */
export interface CertGrader {
  /** Stable grader id used in registry keys + candidateIds. */
  readonly id: "psa" | "bgs" | "sgc" | "cgc" | string;
  /** Display name surfaced in UI. */
  readonly displayName: string;

  /**
   * Cheap predicate — runs before any HTTP. Used by the dispatcher to
   * decide cert vs free-text mode and which grader(s) to fan out to.
   * MUST NOT throw.
   */
  recognizes(input: string): boolean;

  /**
   * Performs the cert lookup. Returns CertLookupResult or throws a
   * CertGraderError. The dispatcher catches CertGraderError and surfaces
   * the failure as a warning on the unified response.
   */
  lookup(certNumber: string): Promise<CertLookupResult>;

  /**
   * Pure function. Maps grader-specific shape → canonical CardIdentity.
   * `attribution` MUST be "authoritative" and `confidence` MUST be 1.0
   * for cert-source candidates per §3 of the design.
   */
  toCardIdentity(result: CertLookupResult): CardIdentity;
}

/**
 * Error codes the dispatcher distinguishes. Each grader's adapter maps
 * its vendor-specific errors into this union so the dispatcher and
 * response shape don't need grader-specific switches.
 *
 *   TOKEN_MISSING    — credentials not configured on this deployment
 *   AUTH_FAILED      — credentials present but rejected (expired / wrong scope)
 *   QUOTA_EXCEEDED   — vendor rate limit hit
 *   NOT_FOUND        — cert number valid format but vendor has no record
 *   TIMEOUT          — request did not complete within configured timeout
 *   REQUEST_FAILED   — vendor returned non-2xx for any other reason
 *   UNKNOWN          — adapter could not classify; surfaces as generic failure
 */
export type CertGraderErrorCode =
  | "TOKEN_MISSING"
  | "AUTH_FAILED"
  | "QUOTA_EXCEEDED"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "REQUEST_FAILED"
  | "UNKNOWN";

export class CertGraderError extends Error {
  public readonly graderId: string;
  public readonly code: CertGraderErrorCode;
  public readonly status: number;

  constructor(
    message: string,
    graderId: string,
    code: CertGraderErrorCode,
    status: number = 502,
  ) {
    super(message);
    this.name = "CertGraderError";
    this.graderId = graderId;
    this.code = code;
    this.status = status;
  }
}
